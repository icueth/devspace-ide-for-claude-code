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
//
// Two things survive the turn's own lifetime:
//   • the RESUME MARKER — the turn's tmux coordinates, persisted next to the
//     transcript. The claude process is detached, so an app quit mid-turn does
//     not kill it; history() re-attaches and lands the reply it wrote while we
//     were gone (flowChatRunner.resumeLeadTurn).
//   • the EPOCH — clear() bumps it, and a turn that answers into a bumped epoch
//     lands nothing: its snapshot of the transcript is exactly what the user
//     just deleted.

import {
  beginLeadTurn,
  resumeLeadTurn,
  type LeadTurnHandle,
  type LeadTurnResult,
} from '@main/services/flowChatRunner';
import {
  clearChat,
  loadActiveRun,
  loadChat,
  saveActiveRun,
  saveChat,
  type ActiveRun,
} from '@main/services/flowChatStore';
import type { FlowChatEvent, FlowChatMessage } from '@shared/flowTypes';
import { createLogger } from '@shared/logger';

const logger = createLogger('FlowChatService');

// Per-message ceiling when stuffing the history into the prompt. The history is
// already capped at 200 messages; this stops one pasted stack trace from eating
// the whole context window.
const STUFF_CHARS = 4_000;
// …and a ceiling on the WHOLE stuffed conversation. 200 messages × 4k is 800k
// characters — far past any context window, so a long-lived chat would start
// failing every turn with no way back except deleting the file. Newest turns are
// what continuity actually needs, so the oldest are dropped first.
const TOTAL_STUFF_CHARS = 60_000;

/** Shown when a turn was in flight at quit and could not be recovered on boot. */
const LOST_REPLY =
  'The app restarted before the lead finished — the reply was lost. Ask again.';

export interface FlowChatDeps {
  /** Broadcast to every window (IPC.FLOW_CHAT_EVENT). */
  onEvent: (event: FlowChatEvent) => void;
  now?: () => number;
  idgen?: () => string;
  /** Injectable for tests — defaults to the real `claude --print` turn. */
  beginTurn?: (projectPath: string, prompt: string) => Promise<LeadTurnHandle>;
  /** Injectable for tests — defaults to re-attaching to a detached turn. */
  resumeTurn?: (sessionName: string, runDir: string) => Promise<LeadTurnResult>;
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

/**
 * system preamble + the stuffed conversation + the tail instruction.
 *
 * The conversation is stuffed NEWEST-FIRST under a total character budget: the
 * turns nearest the question are the ones continuity depends on, and the ones
 * that fall off the far end are marked as omitted rather than silently dropped
 * (the lead should know the chat has a horizon, and say so if it matters). The
 * user's latest message is never subject to the budget — it is the question.
 */
export function composeLeadPrompt(
  projectPath: string,
  history: FlowChatMessage[],
): string {
  const parts = [systemPreamble(projectPath), '', '## Conversation so far'];

  const past = history.slice(0, -1);
  const latest = history[history.length - 1];

  const kept: string[] = [];
  let budget = TOTAL_STUFF_CHARS;
  let omitted = false;
  for (let i = past.length - 1; i >= 0; i--) {
    const m = past[i];
    const line = `[${m.role === 'user' ? 'user' : 'you (lead)'}] ${trim(m.text)}`;
    if (line.length > budget) {
      omitted = true; // everything older than this is out too — stop here
      break;
    }
    budget -= line.length;
    kept.push(line);
  }
  kept.reverse();

  if (past.length === 0) {
    parts.push('', '(this is the first message)');
  } else {
    if (omitted) parts.push('', '(earlier conversation omitted)');
    for (const line of kept) parts.push('', line);
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
  const beginTurn = deps.beginTurn ?? beginLeadTurn;
  const resumeTurn = deps.resumeTurn ?? resumeLeadTurn;

  // projectPath → the in-flight turn. Presence IS the busy flag.
  const inflight = new Map<string, Promise<void>>();
  // projectPath → how many times the transcript has been cleared. A turn carries
  // the epoch it started in; if the epoch moved on by the time it answers, the
  // conversation that turn belongs to no longer exists.
  const epochs = new Map<string, number>();

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

  /**
   * Claim the per-project turn lock SYNCHRONOUSLY — before the caller's first
   * await. Two sends racing through the IPC handler would otherwise both read
   * `inflight.has() === false`, both start a turn, and both write the history
   * file (losing one message). Returns null when a turn is already in flight.
   */
  const claim = (
    projectPath: string,
  ): { epoch: number; release: () => void } | null => {
    if (inflight.has(projectPath)) return null;
    let done = (): void => undefined;
    inflight.set(
      projectPath,
      new Promise<void>((r) => {
        done = r;
      }),
    );
    return {
      epoch: epochs.get(projectPath) ?? 0,
      release: () => {
        inflight.delete(projectPath);
        done();
      },
    };
  };

  const stale = (projectPath: string, epoch: number): boolean =>
    (epochs.get(projectPath) ?? 0) !== epoch;

  // Every write to a project's chat file runs HERE, in call order: the user
  // message, the resume marker, the reply, and clear()'s delete all target the
  // same file. A marker write that began before a clear() must not land after it
  // and recreate the file the user just emptied — and because the epoch is
  // bumped synchronously by clear() but re-read INSIDE the queued write, a clear
  // that arrives mid-queue cancels the writes behind it instead of racing them.
  const queued = new Map<string, Promise<unknown>>();
  const enqueue = <T>(projectPath: string, op: () => Promise<T>): Promise<T> => {
    const prev = queued.get(projectPath) ?? Promise.resolve();
    const next = prev.then(op, op);
    queued.set(
      projectPath,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  };

  /**
   * Land a finished turn: append the lead's message to the snapshot the turn
   * started from, persist it, clear the resume marker (one atomic write), push.
   *
   * A turn whose transcript was CLEARED while it ran lands nothing at all. Not
   * the reply — a reply with no question in front of it is noise — and above all
   * not the snapshot, which still holds every message the user just deleted and
   * would write them all back. The panel still gets `busy:false`, or it would
   * type-indicate forever.
   */
  const complete = async (
    projectPath: string,
    base: FlowChatMessage[],
    result: LeadTurnResult,
    epoch: number,
    lostText?: string,
  ): Promise<void> => {
    const landed = await enqueue(projectPath, async (): Promise<FlowChatMessage | null> => {
      if (stale(projectPath, epoch)) return null;

      const reply = (result.text ?? '').trim();
      // An exit-0 turn that said nothing is still a failed turn from the user's
      // point of view — an empty bubble tells them nothing.
      const ok = result.ok && reply.length > 0;
      const lead = ok
        ? message('lead', reply)
        : message(
            'lead',
            lostText ??
              `The lead turn failed: ${result.error ?? 'claude produced no output'}`,
            true,
          );
      if (!ok) logger.warn(`lead turn failed: ${result.error ?? 'no output'}`);

      await saveChat(projectPath, [...base, lead], null).catch((e) => {
        logger.warn(`saveChat failed: ${(e as Error).message}`);
      });
      return lead;
    });

    if (!landed) {
      logger.info('lead turn answered into a cleared transcript — dropped');
      deps.onEvent({ projectPath, busy: false });
      return;
    }
    deps.onEvent({ projectPath, message: landed, busy: false });
  };

  /**
   * Re-attach to a turn that was in flight when the app went away. The claude
   * process is detached (tmux), so it kept running — and out.jsonl kept filling.
   * Nobody was reading it, which is the whole bug: the reply was not lost, it was
   * unclaimed. From here on the turn lands exactly like a live one.
   */
  const resume = (
    projectPath: string,
    marker: ActiveRun,
    base: FlowChatMessage[],
  ): void => {
    const claimed = claim(projectPath);
    if (!claimed) return; // a live turn owns this project — nothing to recover
    const { epoch, release } = claimed;

    logger.info(`resuming lead turn (${marker.sessionName})`);
    deps.onEvent({ projectPath, busy: true });

    void (async () => {
      let result: LeadTurnResult;
      try {
        result = await resumeTurn(marker.sessionName, marker.runDir);
      } catch (err) {
        result = { ok: false, text: '', error: (err as Error).message };
      }
      await complete(projectPath, base, result, epoch, LOST_REPLY);
    })().finally(release);
  };

  return {
    async history(projectPath) {
      const messages = await loadChat(projectPath);
      const marker = await loadActiveRun(projectPath);
      // A marker with no live turn behind it = the app quit mid-turn.
      if (marker && !inflight.has(projectPath)) resume(projectPath, marker, messages);
      return messages;
    },

    isBusy: (projectPath) => inflight.has(projectPath),

    whenIdle: (projectPath) => inflight.get(projectPath) ?? Promise.resolve(),

    async clear(projectPath) {
      // Bump BEFORE the delete — synchronously, so every write already queued
      // behind this one sees a moved epoch and cancels itself. A turn running
      // right now belongs to the conversation being deleted.
      epochs.set(projectPath, (epochs.get(projectPath) ?? 0) + 1);
      await enqueue(projectPath, () => clearChat(projectPath));
    },

    async send(projectPath, text) {
      const body = (text ?? '').trim();
      if (!body) return { ok: false, error: 'message required' };

      const claimed = claim(projectPath);
      if (!claimed) {
        return { ok: false, error: 'lead is busy — wait for the current turn to finish' };
      }
      const { epoch, release } = claimed;

      const user = message('user', body);
      let withUser: FlowChatMessage[];
      try {
        withUser = await enqueue(projectPath, async () =>
          saveChat(projectPath, [...(await loadChat(projectPath)), user]),
        );
        deps.onEvent({ projectPath, message: user, busy: true });
      } catch (err) {
        release();
        return { ok: false, error: `could not save the message: ${(err as Error).message}` };
      }

      const prompt = composeLeadPrompt(projectPath, withUser);

      void (async () => {
        let result: LeadTurnResult;
        try {
          const handle = await beginTurn(projectPath, prompt);
          // The claude process outlives this app run (detached tmux). Persist
          // WHERE it lives before waiting on it, so a quit mid-turn can re-attach
          // on the next boot instead of dropping the answer on the floor. The
          // write no-ops if the transcript was cleared meanwhile: there is
          // nothing left to resume into.
          if (handle.sessionName && handle.runDir) {
            await enqueue(projectPath, async () => {
              if (stale(projectPath, epoch)) return;
              await saveActiveRun(projectPath, {
                sessionName: handle.sessionName,
                runDir: handle.runDir,
              });
            }).catch((e) => {
              logger.warn(`could not record the in-flight turn: ${(e as Error).message}`);
            });
          }
          result = await handle.result;
        } catch (err) {
          result = { ok: false, text: '', error: (err as Error).message };
        }
        await complete(projectPath, withUser, result, epoch);
      })().finally(release);

      return { ok: true };
    },
  };
}
