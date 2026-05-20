// Pure chat-stream reducer extracted from ChatPanel so it can be unit-tested
// without importing the whole component (CSS, lucide, zustand, etc.) and so
// its identity invariants are pinned by tests:
//
//   • The returned thread + messages array are always fresh references.
//   • The LAST message gets a fresh object identity on every mutating event
//     (so `memo(MessageBubble)` re-renders only the streaming bubble).
//   • Prior (finalized) messages keep their identity (so they skip re-render).
//   • segments[] / toolCalls[] entries that change get fresh identities too.
//
// Reverting any of these to in-place mutation would silently reintroduce the
// per-token whole-transcript re-render storm — the tests guard against that.

import type {
  ChatEvent,
  ChatMessage,
  ChatMessageSegment,
  ChatThread,
  TeamStep,
} from '@shared/types';

// Stable-ish identifier for a freshly-created segment. crypto.randomUUID is
// available in modern Electron's renderer context (Chromium 90+), but fall
// back to a timestamp+random combo to keep this defensive — the id only needs
// to be unique within one assistant turn for React keying.
export function newSegmentId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `seg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function applyEvent(
  thread: ChatThread,
  threadId: string,
  event: ChatEvent,
): ChatThread {
  if (thread.id !== threadId) return thread;
  const messages = [...thread.messages];
  const lastIndex = messages.length - 1;
  const original = messages[lastIndex];
  if (!original || original.role !== 'assistant') return thread;
  // Clone the last message so its object identity changes on every event.
  // segments[] and toolCalls[] already get fresh identities below; cloning
  // the message itself is what lets `memo(MessageBubble)` skip every
  // *finalized* bubble and re-render only the streaming one — eliminating the
  // per-token whole-transcript re-render storm. All mutations below run on
  // this clone (team-step targets mutate the shared teamRun, which is fine
  // because the cloned message identity still forces its bubble to repaint).
  const last = { ...original };
  messages[lastIndex] = last;

  // Team-step lifecycle events update the step's status only.
  if (event.kind === 'team_step_start' && last.teamRun && event.stepIndex !== undefined) {
    const step = last.teamRun.steps[event.stepIndex];
    if (step) {
      step.status = 'running';
      step.startedAt = event.ts;
    }
    return { ...thread, messages };
  }
  if (event.kind === 'team_step_end' && last.teamRun && event.stepIndex !== undefined) {
    const step = last.teamRun.steps[event.stepIndex];
    if (step) {
      step.finishedAt = event.ts;
      if (event.message) {
        step.status = 'error';
        step.error = event.message;
      } else if (step.status === 'running') {
        step.status = 'done';
      }
    }
    return { ...thread, messages };
  }

  // Pick the target — either a team step or the message itself.
  const target: TeamStep | ChatMessage =
    last.teamRun && event.stepIndex !== undefined
      ? (last.teamRun.steps[event.stepIndex] ?? last)
      : last;

  if (event.kind === 'text_delta' && event.text) {
    target.content += event.text;
    // Mirror onto segments[] so the renderer can paint each text /
    // tool_group chunk as its own card in chronological order. If the
    // last segment is already text, extend it; otherwise push a new one.
    //
    // Important: when extending an existing segment we REPLACE it with a
    // new object (not mutate `lastSeg.text += ...`). That gives each
    // event a fresh segment identity so any downstream `memo` on
    // segment-keyed children can safely fast-path. Same goes for
    // `target.segments = [...]` — we rebuild the array reference per
    // event rather than `.push()` so memoized children re-render.
    const prev = target.segments ?? [];
    const lastSeg = prev[prev.length - 1];
    if (lastSeg && lastSeg.kind === 'text') {
      const updated: ChatMessageSegment = {
        kind: 'text',
        id: lastSeg.id,
        text: lastSeg.text + event.text,
      };
      target.segments = [...prev.slice(0, -1), updated];
    } else {
      target.segments = [
        ...prev,
        { kind: 'text', id: newSegmentId(), text: event.text },
      ];
    }
  } else if (event.kind === 'thinking_delta' && event.text) {
    target.thinking = (target.thinking ?? '') + event.text;
  } else if (event.kind === 'tool_use') {
    const toolUseId = event.toolUseId ?? `tu-${Date.now()}`;
    target.toolCalls = [
      ...target.toolCalls,
      {
        id: toolUseId,
        name: event.toolName ?? 'tool',
        input: event.toolInput ?? {},
        diffStats: event.diffStats,
        diffPreview: event.diffPreview,
      },
    ];
    // Same immutable replace-not-mutate pattern as text_delta.
    const prev = target.segments ?? [];
    const lastSeg = prev[prev.length - 1];
    if (lastSeg && lastSeg.kind === 'tool_group') {
      const updated: ChatMessageSegment = {
        kind: 'tool_group',
        id: lastSeg.id,
        toolUseIds: [...lastSeg.toolUseIds, toolUseId],
      };
      target.segments = [...prev.slice(0, -1), updated];
    } else {
      target.segments = [
        ...prev,
        { kind: 'tool_group', id: newSegmentId(), toolUseIds: [toolUseId] },
      ];
    }
  } else if (event.kind === 'tool_result') {
    target.toolCalls = target.toolCalls.map((c) =>
      c.id === event.toolUseId
        ? { ...c, result: event.toolResult ?? '', isError: event.toolIsError }
        : c,
    );
  } else if (event.kind === 'usage') {
    target.usage = {
      input: event.inputTokens ?? 0,
      output: event.outputTokens ?? 0,
    };
  } else if (event.kind === 'error') {
    last.status = 'error';
    last.error = event.message;
  } else if (event.kind === 'done') {
    // Backend already persisted the terminal state to disk. We mirror it
    // here so the renderer's Stop / Send button reflects reality without
    // waiting for the next listThreads refresh. If an earlier `error`
    // event already flipped status to 'error', leave it; otherwise the
    // turn ended cleanly.
    if (last.status === 'streaming') {
      last.status = 'done';
    }
  } else if (event.kind === 'awaiting_user_answer') {
    // Claude called AskUserQuestion — backend will early-finalize the
    // run and emit `done` next, but we set the flag now so the footer
    // shows "Waiting for your answer" instead of "Working…" the moment
    // the question UI appears.
    last.awaitingUserAnswer = true;
  }

  return { ...thread, messages };
}
