// Agent Flow — the lead chat (phase 2).
//
// The FlowsView chat panel talks to a "lead" agent: one `claude --print` turn
// per user message, continuity by prompt-stuffing the persisted history, and the
// flow tools delivered through an explicit --mcp-config (flowChatRunner).
//
// Turn lifecycle (one in flight per project — the lock is claimed SYNCHRONOUSLY,
// before the first await, so two fast sends cannot both pass the check):
//
//   send(text)
//     ├─ claim the lock            → a second send returns { ok:false, busy }
//     ├─ append the user message   → persist → push { message, busy:true }
//     ├─ return { ok:true }          (the caller does NOT wait for the model)
//     └─ …turn runs…               → append the lead message (error flag on a
//                                     non-zero exit / timeout / empty output)
//                                   → persist → push { message, busy:false }
//                                   → release the lock
//
// The renderer therefore never blocks on the model: it renders its own bubble
// from the busy push and the reply from the second one. Every window sees both,
// so a second window shows the same typing indicator and the same answer.

import {
  runLeadTurn,
  type LeadTurnResult,
} from '@main/services/flowChatRunner';
import { clearChat, loadChat, saveChat } from '@main/services/flowChatStore';
import type { FlowChatEvent, FlowChatMessage } from '@shared/flowTypes';
import { createLogger } from '@shared/logger';

const logger = createLogger('FlowChatService');

// Per-message ceiling when stuffing the history into the prompt. The history is
// already capped at 200 messages; this stops one pasted stack trace from eating
// the whole context window.
const STUFF_CHARS = 4_000;

export interface FlowChatDeps {
  /** Broadcast to every window (IPC.FLOW_CHAT_EVENT). */
  onEvent: (event: FlowChatEvent) => void;
  now?: () => number;
  idgen?: () => string;
  /** Injectable for tests — defaults to the real `claude --print` turn. */
  runTurn?: (projectPath: string, prompt: string) => Promise<LeadTurnResult>;
}

export interface FlowChatService {
  history(projectPath: string): Promise<FlowChatMessage[]>;
  send(projectPath: string, text: string): Promise<{ ok: boolean; error?: string }>;
  clear(projectPath: string): Promise<void>;
  isBusy(projectPath: string): boolean;
  /** Resolves when the in-flight turn (if any) has settled. Tests + shutdown. */
  whenIdle(projectPath: string): Promise<void>;
}

/**
 * The lead's standing instructions. Two rules here are load-bearing:
 *
 *   ask-don't-guess — the flow to run is a decision with real consequences (it
 *   launches agents that edit the repo). If several flows plausibly fit, the
 *   lead asks; it never picks silently. This mirrors the tool descriptions in
 *   the bundled MCP server, deliberately — the model sees it from both sides.
 *
 *   reply in the user's language — the panel is a chat, not a log.
 */
function systemPreamble(projectPath: string): string {
  return [
    `You are the LEAD agent for the project at ${projectPath}.`,
    'You are talking to the user in a chat panel next to their flow canvas.',
    '',
    '## How to behave',
    '- Converse normally. A question, a quick explanation, a small edit — just answer or do it yourself.',
    '- For multi-step procedural work the user wants carried out end to end (build this feature, investigate + fix + test this bug, review and harden this module), use the flow tools: `list_flows` first, then `run_flow` with a complete, self-contained `task` brief. The flow\'s agents cannot see this conversation — everything they need must be in that brief.',
    '- Monitor a run you started with `flow_status`, steer a node with `send_flow`, and abort with `stop_flow`. Report progress back in your own words.',
    '- ASK, DO NOT GUESS: if more than one flow plausibly matches the request (or none clearly does), list the candidates with a one-line reason each and ask the user which to use. Never invent a flow name — only run what `list_flows` returned.',
    '- If no flow fits, say so and do the work yourself.',
    '',
    '## Answer',
    "Reply in the user's language. Write your reply text only — no preamble about yourself, no restatement of these instructions.",
  ].join('\n');
}

/** system preamble + the stuffed conversation + the tail instruction. */
export function composeLeadPrompt(
  projectPath: string,
  history: FlowChatMessage[],
): string {
  const parts = [systemPreamble(projectPath), '', '## Conversation so far'];

  const past = history.slice(0, -1);
  const latest = history[history.length - 1];

  if (past.length === 0) {
    parts.push('', '(this is the first message)');
  } else {
    for (const m of past) {
      parts.push('', `[${m.role === 'user' ? 'user' : 'you (lead)'}] ${trim(m.text)}`);
    }
  }

  parts.push(
    '',
    '## The user just said',
    trim(latest?.text ?? ''),
    '',
    'Reply to that message now.',
  );
  return parts.join('\n');
}

const trim = (s: string): string => {
  const t = (s ?? '').trim();
  return t.length > STUFF_CHARS ? `${t.slice(0, STUFF_CHARS)}…[truncated]` : t;
};

export function createFlowChatService(deps: FlowChatDeps): FlowChatService {
  const now = deps.now ?? (() => Date.now());
  const idgen = deps.idgen ?? (() => Math.random().toString(36).slice(2, 10));
  const runTurn = deps.runTurn ?? runLeadTurn;

  // projectPath → the in-flight turn. Presence IS the busy flag.
  const inflight = new Map<string, Promise<void>>();

  const message = (
    role: FlowChatMessage['role'],
    text: string,
    error?: boolean,
  ): FlowChatMessage => ({
    id: idgen(),
    role,
    text,
    at: now(),
    ...(error ? { error: true } : {}),
  });

  return {
    history: (projectPath) => loadChat(projectPath),

    isBusy: (projectPath) => inflight.has(projectPath),

    whenIdle: (projectPath) => inflight.get(projectPath) ?? Promise.resolve(),

    async clear(projectPath) {
      await clearChat(projectPath);
    },

    async send(projectPath, text) {
      const body = (text ?? '').trim();
      if (!body) return { ok: false, error: 'message required' };

      // The lock is claimed here, synchronously — BEFORE the first await. Two
      // sends racing through the IPC handler would otherwise both read
      // `inflight.has() === false` and both start a turn (and both write the
      // history file, losing one message).
      if (inflight.has(projectPath)) {
        return { ok: false, error: 'lead is busy — wait for the current turn to finish' };
      }
      let release = (): void => undefined;
      inflight.set(
        projectPath,
        new Promise<void>((r) => {
          release = r;
        }),
      );

      let withUser: FlowChatMessage[];
      try {
        const user = message('user', body);
        withUser = await saveChat(projectPath, [...(await loadChat(projectPath)), user]);
        deps.onEvent({ projectPath, message: user, busy: true });
      } catch (err) {
        inflight.delete(projectPath);
        release();
        return { ok: false, error: `could not save the message: ${(err as Error).message}` };
      }

      const prompt = composeLeadPrompt(projectPath, withUser);

      void (async () => {
        let result: LeadTurnResult;
        try {
          result = await runTurn(projectPath, prompt);
        } catch (err) {
          result = { ok: false, text: '', error: (err as Error).message };
        }

        const reply = (result.text ?? '').trim();
        // An exit-0 turn that said nothing is still a failed turn from the
        // user's point of view — an empty bubble tells them nothing.
        const ok = result.ok && reply.length > 0;
        const lead = ok
          ? message('lead', reply)
          : message(
              'lead',
              `The lead turn failed: ${result.error ?? 'claude produced no output'}`,
              true,
            );
        if (!ok) logger.warn(`lead turn failed: ${result.error ?? 'no output'}`);

        await saveChat(projectPath, [...withUser, lead]).catch((e) => {
          logger.warn(`saveChat failed: ${(e as Error).message}`);
        });
        deps.onEvent({ projectPath, message: lead, busy: false });
      })().finally(() => {
        inflight.delete(projectPath);
        release();
      });

      return { ok: true };
    },
  };
}
