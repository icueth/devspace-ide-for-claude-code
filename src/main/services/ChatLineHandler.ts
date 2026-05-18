// ChatLineHandler — JSONL line parsers for `claude --output-format
// stream-json`. Both factories return a single (line: string) => void
// closure that mutates either a ChatMessage (solo) or a TeamStep (one
// member of a sequential pipeline), and broadcasts a normalized
// ChatEvent to every subscribed renderer.
//
// Split out of ChatService so the parsing/mutation logic can be tested
// in isolation without spinning up tmux. Pure-ish — depends only on
// the shared ProjectState + broadcast helper from ChatTranscript.

import { randomUUID } from 'node:crypto';

import { broadcast, type ProjectState } from '@main/services/ChatTranscript';
import { proposeFromTurn } from '@main/services/MemoryService';
import { computeToolDiffStats } from '@main/utils/diffStats';
import { computeToolDiffPreview } from '@main/utils/diffPreview';
import { createLogger } from '@shared/logger';
import type {
  ChatMessage,
  ChatMessageSegment,
  ChatThread,
  TeamStep,
} from '@shared/types';

const logger = createLogger('ChatLineHandler');

// Auto-capture the just-finished user/assistant pair into the memory
// inbox. Fire-and-forget — failures must never break the chat finalize
// path, so we swallow rejections at the boundary. Settings gating (smart
// vs manual vs off) happens inside MemoryService.proposeFromTurn.
function dispatchAutoCapture(
  state: ProjectState,
  thread: ChatThread,
  assistantContent: string,
): void {
  const lastUser = [...thread.messages]
    .reverse()
    .find((m) => m.role === 'user');
  if (!lastUser || !lastUser.content) return;
  proposeFromTurn({
    projectPath: state.projectPath,
    threadId: thread.id,
    userMessage: lastUser.content,
    assistantMessage: assistantContent,
  }).catch((err) => {
    logger.warn(`auto-capture failed: ${(err as Error).message}`);
  });
}

// Shape of one JSONL event emitted by `claude --output-format stream-json`.
export interface ClaudeStreamEvent {
  type?: string;
  subtype?: string;
  message?: {
    content?: Array<
      | { type: 'text'; text?: string }
      | { type: 'thinking'; thinking?: string }
      | {
          type: 'tool_use';
          id?: string;
          name?: string;
          input?: Record<string, unknown>;
        }
      | {
          type: 'tool_result';
          tool_use_id?: string;
          content?: string | { type?: string; text?: string }[];
          is_error?: boolean;
        }
    >;
  };
  result?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function parseStreamLine(raw: string): ClaudeStreamEvent | null {
  try {
    return JSON.parse(raw) as ClaudeStreamEvent;
  } catch {
    return null;
  }
}

// Shared segment accumulators. Both makeSoloLineHandler and
// makeStepLineHandler need the SAME chronological segmentation rule —
// text deltas extend the current text segment, tool_use blocks extend
// the current tool_group segment, thinking blocks are passthrough. The
// helpers mutate the target's `segments` array in place and lazily
// allocate it on the first relevant block so messages that never
// receive any text/tool_use stay segments-free (back-compat with
// v0.10.x persisted shapes).

type SegmentTarget = { segments?: ChatMessageSegment[] };

function appendTextToSegments(target: SegmentTarget, text: string): void {
  target.segments ??= [];
  const last = target.segments[target.segments.length - 1];
  if (last && last.kind === 'text') {
    last.text += text;
  } else {
    target.segments.push({ kind: 'text', id: randomUUID(), text });
  }
}

function appendToolUseToSegments(target: SegmentTarget, toolUseId: string): void {
  target.segments ??= [];
  const last = target.segments[target.segments.length - 1];
  if (last && last.kind === 'tool_group') {
    last.toolUseIds.push(toolUseId);
  } else {
    target.segments.push({
      kind: 'tool_group',
      id: randomUUID(),
      toolUseIds: [toolUseId],
    });
  }
}

// Build a line-handler that mutates the given assistant message + emits
// solo-turn events (no stepIndex). The same factory drives both fresh
// spawns and resume-on-boot tails.
//
// `onAskUserQuestion` is called the first time an AskUserQuestion
// tool_use is observed in the stream. ChatService passes the run's
// kill() so the tmux session is torn down early — otherwise claude
// hangs waiting for a tool_result that DevSpace can't provide in
// --print mode and the "Working…" indicator stays stuck.
// Callback fired exactly once per Task() tool_use when the matching
// tool_result arrives. Used by DevlogService auto-capture — the
// handler doesn't import DevlogService directly so this module stays
// testable in isolation (and so chat finalize can never throw from a
// devlog write).
export interface TaskCompleteEvent {
  toolUseId: string;
  subagentType: string;
  description: string;
  durationMs: number;
  isError: boolean;
  output: string;
  threadId: string;
}

export function makeSoloLineHandler(
  state: ProjectState,
  thread: ChatThread,
  assistant: ChatMessage,
  onAskUserQuestion?: () => void,
  onTaskComplete?: (ev: TaskCompleteEvent) => void,
): (raw: string) => void {
  let askUserQuestionFired = false;
  // toolUseId → { dispatchedAt, subagentType, description } for
  // outstanding Task() calls. Populated on tool_use, drained on the
  // matching tool_result so we can compute durationMs.
  const pendingTasks = new Map<
    string,
    { dispatchedAt: number; subagentType: string; description: string }
  >();
  return (raw) => {
    const e = parseStreamLine(raw);
    if (!e) return;
    if (e.type === 'assistant' && e.message?.content) {
      for (const block of e.message.content) {
        if (block.type === 'text' && block.text) {
          assistant.content += block.text;
          appendTextToSegments(assistant, block.text);
          broadcast(state, thread.id, {
            kind: 'text_delta',
            text: block.text,
            ts: Date.now(),
          });
        } else if (block.type === 'thinking' && block.thinking) {
          assistant.thinking = (assistant.thinking ?? '') + block.thinking;
          broadcast(state, thread.id, {
            kind: 'thinking_delta',
            text: block.thinking,
            ts: Date.now(),
          });
        } else if (block.type === 'tool_use') {
          const id = block.id ?? randomUUID();
          const toolName = block.name ?? 'tool';
          const toolInput = block.input ?? {};
          const diffStats =
            computeToolDiffStats(toolName, toolInput, state.projectPath) ??
            undefined;
          const diffPreview =
            computeToolDiffPreview(toolName, toolInput, state.projectPath) ??
            undefined;
          assistant.toolCalls.push({
            id,
            name: toolName,
            input: toolInput,
            diffStats,
            diffPreview,
          });
          appendToolUseToSegments(assistant, id);
          broadcast(state, thread.id, {
            kind: 'tool_use',
            toolUseId: id,
            toolName: block.name,
            toolInput: block.input,
            diffStats,
            diffPreview,
            ts: Date.now(),
          });
          if (toolName === 'AskUserQuestion' && !askUserQuestionFired) {
            askUserQuestionFired = true;
            assistant.awaitingUserAnswer = true;
            broadcast(state, thread.id, {
              kind: 'awaiting_user_answer',
              ts: Date.now(),
            });
            try {
              onAskUserQuestion?.();
            } catch (err) {
              logger.warn(
                `onAskUserQuestion callback threw: ${(err as Error).message}`,
              );
            }
          }
          // Track Task() dispatches for devlog auto-capture. Only when
          // a `subagent_type` arg is present — Claude always supplies it
          // for the Task tool, but a hostile/malformed stream might not.
          if (toolName === 'Task' && onTaskComplete) {
            const subagentType =
              typeof toolInput.subagent_type === 'string'
                ? toolInput.subagent_type
                : '';
            const description =
              typeof toolInput.description === 'string'
                ? toolInput.description
                : '';
            if (subagentType) {
              pendingTasks.set(id, {
                dispatchedAt: Date.now(),
                subagentType,
                description,
              });
            }
          }
        }
      }
    } else if (e.type === 'user' && e.message?.content) {
      for (const block of e.message.content) {
        if (block.type === 'tool_result') {
          const text = flattenToolResult(block.content);
          const tu = assistant.toolCalls.find(
            (c) => c.id === block.tool_use_id,
          );
          if (tu) {
            tu.result = text;
            tu.isError = !!block.is_error;
          }
          broadcast(state, thread.id, {
            kind: 'tool_result',
            toolUseId: block.tool_use_id,
            toolResult: text,
            toolIsError: !!block.is_error,
            ts: Date.now(),
          });
          // Drain pending Task dispatches → emit devlog auto-capture
          // event. Wrap in try/catch — chat finalize MUST NOT throw
          // from a downstream devlog write.
          const useId = block.tool_use_id;
          if (useId && pendingTasks.has(useId) && onTaskComplete) {
            const pending = pendingTasks.get(useId)!;
            pendingTasks.delete(useId);
            try {
              onTaskComplete({
                toolUseId: useId,
                subagentType: pending.subagentType,
                description: pending.description,
                durationMs: Math.max(0, Date.now() - pending.dispatchedAt),
                isError: !!block.is_error,
                output: text,
                threadId: thread.id,
              });
            } catch (err) {
              logger.warn(
                `onTaskComplete threw: ${(err as Error).message}`,
              );
            }
          }
        }
      }
    } else if (e.type === 'result' && e.usage) {
      assistant.usage = {
        input: e.usage.input_tokens ?? 0,
        output: e.usage.output_tokens ?? 0,
      };
      broadcast(state, thread.id, {
        kind: 'usage',
        inputTokens: e.usage.input_tokens,
        outputTokens: e.usage.output_tokens,
        ts: Date.now(),
      });
      // Turn complete — best-effort auto-capture into the memory inbox.
      // No-op when MemorySettings.autoCapture !== 'smart'. Never blocks.
      dispatchAutoCapture(state, thread, assistant.content);
    }
  };
}

// Same shape as the solo handler but writes into a team step + tags
// every broadcast event with the step index so the renderer can route
// it into the right step bubble.
export function makeStepLineHandler(
  state: ProjectState,
  thread: ChatThread,
  stepTarget: TeamStep,
  stepIndex: number,
): (raw: string) => void {
  return (raw) => {
    const e = parseStreamLine(raw);
    if (!e) return;
    if (e.type === 'assistant' && e.message?.content) {
      for (const block of e.message.content) {
        if (block.type === 'text' && block.text) {
          stepTarget.content += block.text;
          appendTextToSegments(stepTarget, block.text);
          broadcast(state, thread.id, {
            kind: 'text_delta',
            text: block.text,
            stepIndex,
            ts: Date.now(),
          });
        } else if (block.type === 'thinking' && block.thinking) {
          stepTarget.thinking = (stepTarget.thinking ?? '') + block.thinking;
          broadcast(state, thread.id, {
            kind: 'thinking_delta',
            text: block.thinking,
            stepIndex,
            ts: Date.now(),
          });
        } else if (block.type === 'tool_use') {
          const id = block.id ?? randomUUID();
          const toolName = block.name ?? 'tool';
          const toolInput = block.input ?? {};
          const diffStats =
            computeToolDiffStats(toolName, toolInput, state.projectPath) ??
            undefined;
          const diffPreview =
            computeToolDiffPreview(toolName, toolInput, state.projectPath) ??
            undefined;
          stepTarget.toolCalls.push({
            id,
            name: toolName,
            input: toolInput,
            diffStats,
            diffPreview,
          });
          appendToolUseToSegments(stepTarget, id);
          broadcast(state, thread.id, {
            kind: 'tool_use',
            toolUseId: id,
            toolName: block.name,
            toolInput: block.input,
            diffStats,
            diffPreview,
            stepIndex,
            ts: Date.now(),
          });
        }
      }
    } else if (e.type === 'user' && e.message?.content) {
      for (const block of e.message.content) {
        if (block.type === 'tool_result') {
          const text = flattenToolResult(block.content);
          const tu = stepTarget.toolCalls.find(
            (c) => c.id === block.tool_use_id,
          );
          if (tu) {
            tu.result = text;
            tu.isError = !!block.is_error;
          }
          broadcast(state, thread.id, {
            kind: 'tool_result',
            toolUseId: block.tool_use_id,
            toolResult: text,
            toolIsError: !!block.is_error,
            stepIndex,
            ts: Date.now(),
          });
        }
      }
    } else if (e.type === 'result' && e.usage) {
      stepTarget.usage = {
        input: e.usage.input_tokens ?? 0,
        output: e.usage.output_tokens ?? 0,
      };
      broadcast(state, thread.id, {
        kind: 'usage',
        inputTokens: e.usage.input_tokens,
        outputTokens: e.usage.output_tokens,
        stepIndex,
        ts: Date.now(),
      });
      // Team-step auto-capture: each step's output is a distinct
      // assistant turn from the user's POV. Use the step's content as
      // the assistant message so corrections/decisions per-step still
      // land in the inbox. No-op when settings disable smart capture.
      dispatchAutoCapture(state, thread, stepTarget.content);
    }
  };
}

// tool_result.content is either a string or an array of {type, text}.
// Flatten to plain text. Non-text parts are dropped silently — claude
// only emits text + image, and we don't surface image tool results in
// the UI yet.
function flattenToolResult(
  content: string | { type?: string; text?: string }[] | undefined,
): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'object' && c?.type === 'text' ? (c.text ?? '') : ''))
      .join('');
  }
  return '';
}
