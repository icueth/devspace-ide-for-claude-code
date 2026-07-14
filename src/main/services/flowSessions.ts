// Agent Flow — interactive node sessions.
//
// An interactive node is a real, dockable CLI agent (the same tmux-backed PTY
// the user gets when they open a CLI tab), launched with tabId
// `flow-<runId>-<nodeId>` so the renderer can attach a pane to the live session
// and boot reconcile can protect it. This module owns the CLI-specific bits —
// which launcher, which PtySessionKind, how to deliver the brief, how to kill —
// so FlowService stays engine logic.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  launchAntigravityCli,
  launchClaudeCli,
  launchCodexCli,
  launchGeminiCli,
  launchOpenCodeCli,
  resolveTmuxBinary,
  tmuxSocketArgs,
} from '@main/services/ClaudeCliLauncher';
import {
  killClaudeCliSessionTree,
  killPty,
  subscribeData,
  writeToPty,
} from '@main/services/PtyPool';
import { getTmuxConfigSync } from '@main/services/TmuxConfigService';
import type { FlowNode } from '@shared/flowTypes';
import { createLogger } from '@shared/logger';
import type { CliId, PtySessionKind } from '@shared/types';

const pexec = promisify(execFile);
const logger = createLogger('FlowSessions');

/** Per-node captured-output cap (FlowNodeRun.output) — shared with the headless path. */
export const OUTPUT_CAP = 20_000;

const KIND_BY_CLI: Record<CliId, PtySessionKind> = {
  claude: 'claude-cli',
  opencode: 'opencode-cli',
  codex: 'codex-cli',
  gemini: 'gemini-cli',
  antigravity: 'antigravity-cli',
};

// tmux session-name prefix per CLI (mirrors ClaudeCliLauncher's tmuxSessionName).
const TMUX_PREFIX_BY_CLI: Record<CliId, string> = {
  claude: 'cli',
  opencode: 'oc',
  codex: 'cx',
  gemini: 'gm',
  antigravity: 'ag',
};

// Non-claude TUIs take no initial-prompt argument, so the brief is typed into
// the session once the TUI has drawn its input. A fixed delay is crude, but the
// alternative (parsing five different TUI ready-banners) is far more brittle.
const TUI_BOOT_MS = 6_000;

// codex (and gemini) self-update on launch when a new release is out — via
// `npm install -g`, which is NOT concurrency-safe. A fan-out that spawns three
// codex nodes at once races the same global install and two crash with exit
// 190 (observed live, run dzuqwx). Serializing same-CLI launches with a small
// gap lets the first launch do the update once; the rest see the new binary.
const LAUNCH_GAP_MS = 2_500;
const launchChains = new Map<CliId, Promise<void>>();

function serializedLaunch<T>(cliId: CliId, launch: () => Promise<T>): Promise<T> {
  const prev = launchChains.get(cliId) ?? Promise.resolve();
  const run = prev.then(launch);
  const settle = (): Promise<void> =>
    new Promise((r) => {
      const t = setTimeout(r, LAUNCH_GAP_MS);
      t.unref?.();
    });
  // The chain must survive a failed launch — later nodes still get their turn.
  launchChains.set(
    cliId,
    run.then(settle, settle),
  );
  return run;
}

export function flowTabId(runId: string, nodeId: string): string {
  return `flow-${runId}-${nodeId}`;
}

export function flowSessionKey(
  projectId: string,
  cliId: CliId,
  runId: string,
  nodeId: string,
): string {
  return `${projectId}:${KIND_BY_CLI[cliId]}:${flowTabId(runId, nodeId)}`;
}

// CSI / OSC escape sequences (ESC 0x1B, single-shift CSI 0x9B). Terminal
// output is a redraw stream, not a transcript: unstripped, a node's "output" is
// mostly cursor moves and colour codes, which would poison the downstream node's
// prompt and burn its context. Carriage returns go too, so a redrawn line reads
// as one line.
// eslint-disable-next-line no-control-regex
const ANSI_RE =
  /[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nqry=><~]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '').replace(/\r/g, '');
}

/**
 * Launch the node's CLI in a tmux-backed PTY and return its PtyPool session key.
 * Claude, codex, and gemini take the brief through their own argv (positional /
 * -i) — delivered exactly once, on first launch. Only the CLIs with no such
 * argument (opencode, antigravity) fall back to typing it in after the TUI
 * boots; the first real E2E run proved a typed multi-line brief is fragile
 * (it sat unsubmitted in codex's composer and the idle heuristic declared the
 * node done), so argv delivery is used wherever the CLI allows it.
 */
export async function launchFlowSession(
  node: FlowNode,
  opts: { projectId: string; projectPath: string; runId: string; prompt: string },
): Promise<string> {
  const tabId = flowTabId(opts.runId, node.id);
  const base = { projectId: opts.projectId, tabId, cwd: opts.projectPath };
  const key = flowSessionKey(opts.projectId, node.cliId, opts.runId, node.id);

  switch (node.cliId) {
    case 'claude':
      await launchClaudeCli({
        ...base,
        initialPrompt: opts.prompt,
        authProfileId: node.authProfileId,
        // Per-node `--model` (works on subscription logins, unlike ANTHROPIC_MODEL).
        model: node.model,
      });
      return key;
    case 'codex':
      await serializedLaunch(node.cliId, () =>
        launchCodexCli({
          ...base,
          cliProfileId: node.cliProfileId,
          initialPrompt: opts.prompt,
          // Per-node model, on top of the profile's default (codex --model).
          model: node.model,
        }),
      );
      return key;
    case 'gemini':
      await serializedLaunch(node.cliId, () =>
        launchGeminiCli({
          ...base,
          cliProfileId: node.cliProfileId,
          initialPrompt: opts.prompt,
          model: node.model,
        }),
      );
      return key;
    case 'opencode':
      await serializedLaunch(node.cliId, () =>
        launchOpenCodeCli({ ...base, cliProfileId: node.cliProfileId }),
      );
      break;
    case 'antigravity':
      await serializedLaunch(node.cliId, () =>
        launchAntigravityCli({ ...base, cliProfileId: node.cliProfileId }),
      );
      break;
  }

  // Typed fallback for the CLIs with no initial-prompt argv. Detached on
  // purpose: the engine tick must not block for six seconds waiting on a TUI.
  const timer = setTimeout(() => sendToFlowSession(key, opts.prompt), TUI_BOOT_MS);
  timer.unref?.();
  return key;
}

// The composer submits a typed brief far more reliably when Enter arrives as
// its own keypress a beat after the paste — glued to the text it is treated as
// part of the paste and the brief just sits there.
const ENTER_DELAY_MS = 400;

/** Type text into a live flow session (send_flow, and the typed fallback). */
export function sendToFlowSession(key: string, text: string): void {
  // TUI composers treat raw newlines as submits/line-breaks mid-paste —
  // flatten to spaces; the brief's markdown structure matters less than the
  // agent actually receiving one complete message.
  writeToPty(key, text.replace(/\s*[\r\n]+\s*/g, ' ').trim());
  const timer = setTimeout(() => writeToPty(key, '\r'), ENTER_DELAY_MS);
  timer.unref?.();
}

/**
 * Accumulate a node's terminal output, ANSI-stripped and capped. Returns the
 * PtyPool unsubscribe. `onFirstData` fires once — the engine's idle heuristic
 * only means "finished" *after* the agent has actually produced something (a
 * session that has never spoken is booting, not done).
 */
export function captureFlowOutput(
  key: string,
  sink: { append: (text: string) => void; onFirstData: () => void },
): () => void {
  let seen = false;
  return subscribeData(key, (chunk) => {
    if (!seen) {
      seen = true;
      sink.onFirstData();
    }
    sink.append(stripAnsi(chunk));
  });
}

/**
 * Kill an interactive flow session. For claude we reuse PtyPool's full
 * session-tree kill (PTY client + tmux session + MCP children). The other CLIs
 * have no such helper — but their tmux session name is fully derivable from
 * (prefix, projectId, tabId), so we kill the PTY and then the tmux session by
 * name. Best-effort throughout: an already-gone session is the normal case.
 *
 * NOTE: the PTY kill-session IPC only supports claude-cli/shell — deliberately
 * not used here.
 */
export async function killFlowSession(
  projectId: string,
  cliId: CliId,
  runId: string,
  nodeId: string,
): Promise<void> {
  const tabId = flowTabId(runId, nodeId);
  if (cliId === 'claude') {
    await killClaudeCliSessionTree(projectId, tabId).catch(() => undefined);
    return;
  }

  await killPty(flowSessionKey(projectId, cliId, runId, nodeId)).catch(() => undefined);

  const cfg = getTmuxConfigSync();
  const name = `${cfg.sessionPrefix}-${TMUX_PREFIX_BY_CLI[cliId]}-${projectId}-${tabId}`;
  const tmuxBin = await resolveTmuxBinary();
  if (!tmuxBin) return; // tmux disabled/absent — killPty above was the whole teardown
  try {
    await pexec(tmuxBin, [...tmuxSocketArgs(), 'kill-session', '-t', name]);
  } catch (err) {
    const msg = (err as Error).message;
    if (!msg.includes('no such session') && !msg.includes('session not found')) {
      logger.warn(`tmux kill-session ${name} failed: ${msg}`);
    }
  }
}
