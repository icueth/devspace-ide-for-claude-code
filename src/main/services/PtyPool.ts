import type { WebContents } from 'electron';
import type { IPty } from 'node-pty';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

import {
  claudeCliTmuxSessionName,
  resolveTmuxBinary,
  shellTmuxSessionName,
  tmuxSocketArgs,
} from '@main/services/ClaudeCliLauncher';
import {
  ApprovalDetector,
  type ApprovalRequest,
} from '@main/services/ClaudeToolApprovalParser';
import { resolveInteractiveShellEnv } from '@main/utils/shellEnv';
import { IPC } from '@shared/ipc-channels';
import { createLogger } from '@shared/logger';
import type { PtyCreateOptions, PtySession, PtySessionKind } from '@shared/types';

const execFileP = promisify(execFile);

const logger = createLogger('PtyPool');

// node-pty is a native addon — load it via CommonJS require so electron-vite
// bundler doesn't try to resolve its .node binaries.
const nodeRequire = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ptyModule: any = null;
function loadPty(): any {
  if (ptyModule) return ptyModule;
  try {
    ptyModule = nodeRequire('node-pty');
  } catch (err) {
    logger.error('node-pty unavailable:', (err as Error).message);
    throw err;
  }
  return ptyModule;
}

const BUFFER_CAP = 256 * 1024; // 256KB rolling buffer per session
const BATCH_MS = 16; // Coalesce up to one frame of PTY output per flush.
const BATCH_BYTES_CAP = 64 * 1024; // Force-flush if we hit this many bytes.

// Programmatic data listener — used by main-side services (e.g.
// DevServerService) that need to react to PTY output without going
// through the WebContents/IPC fan-out. Listeners fire on every chunk
// AND on PTY exit (with `exitCode` set, `data` empty).
export type PtyDataListener = (chunk: string) => void;
export type PtyExitListener = (exitCode: number) => void;

interface PoolEntry {
  session: PtySession;
  pty: IPty;
  subscribers: Set<WebContents>;
  dataListeners: Set<PtyDataListener>;
  exitListeners: Set<PtyExitListener>;
  // Rolling output buffer — returned by subscribeAndReplay so a remounted
  // pane can restore xterm scrollback. NOT pushed at create time: the
  // renderer's data listener attaches only after PTY_CREATE resolves, so a
  // create-time push always raced the listener and was silently dropped.
  buffer: string;
  pending: string;
  flushTimer: NodeJS.Timeout | null;
  // Synchronously drain `pending` to current subscribers. Stored on the
  // entry so subscribeAndReplay can flush BEFORE snapshotting the buffer —
  // pending bytes are already part of `buffer` (onData appends to both), so
  // without the pre-flush a new subscriber would receive them twice: once in
  // the snapshot, once when the batched flush timer fires.
  flush: () => void;
  // v0.36.0: ms-epoch of the last observed I/O activity on this PTY —
  // either incoming data from the child OR a write() from the renderer.
  // The idle reaper reads this to decide which claude-cli sessions have
  // been forgotten by the user and can be reclaimed.
  lastActivityAt: number;
  // Phase 4a: lazily-created per-session detector for Claude's tool
  // approval prompts. Null for non-claude-cli sessions — we skip the
  // regex sweep entirely on shell / dev-server PTYs where it would only
  // waste cycles. Reset on every writeToPty() so a user-typed `y` doesn't
  // leave the detector waiting for ITS own response.
  approvals: ApprovalDetector | null;
}

const entries = new Map<string, PoolEntry>();

// In-flight createPty calls keyed by pool key. Closes the TOCTOU window
// between the entries.get() check and entries.set() — doCreatePty awaits
// resolveInteractiveShellEnv() in between, so two concurrent PTY_CREATEs
// for the same key ("Reload tab" during the initial create is the concrete
// trigger) would both spawn, and the leaked first child's onExit would
// later delete the LIVE entry.
const pendingCreates = new Map<string, Promise<PtySession>>();

const DEFAULT_TAB_ID = 'default';

function sessionKey(projectId: string, kind: string, tabId: string): string {
  return `${projectId}:${kind}:${tabId}`;
}

// Deliberately NOT async: the key must be computed and the pending promise
// registered synchronously, before any await, so a concurrent caller for
// the same key joins the in-flight create instead of spawning a second PTY.
// This guard covers every caller (launchClaudeCli / launchShell / direct).
export function createPty(opts: PtyCreateOptions): Promise<PtySession> {
  const tabId = opts.tabId ?? DEFAULT_TAB_ID;
  const key = sessionKey(opts.projectId, opts.kind, tabId);
  const existing = entries.get(key);
  if (existing) return Promise.resolve(existing.session);
  const pending = pendingCreates.get(key);
  if (pending) return pending;
  // .finally() so a FAILED spawn also clears the slot — otherwise one bad
  // create would poison the key and every retry would get the stale
  // rejection forever.
  const create = doCreatePty(key, tabId, opts).finally(() => {
    pendingCreates.delete(key);
  });
  pendingCreates.set(key, create);
  return create;
}

async function doCreatePty(
  key: string,
  tabId: string,
  opts: PtyCreateOptions,
): Promise<PtySession> {
  const shellEnv = await resolveInteractiveShellEnv();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...shellEnv,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    DEVSPACE_PROJECT_ID: opts.projectId,
  };
  // Enable Claude CLI's native tmux-based agent teams for claude-cli PTYs.
  // The user's shell rc doesn't export these, so without this the CLI falls
  // back to in-process subagents (Task tool / parallel-dispatch skill) and
  // no tmux panes spawn — which means the devspace Agents rail has nothing
  // to show. Respecting pre-set values so the user can override at will.
  if (opts.kind === 'claude-cli') {
    env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS ??= '1';
    env.CLAUDE_CODE_SPAWN_BACKEND ??= 'tmux';
  }

  const command = opts.command ?? env.SHELL ?? '/bin/zsh';
  const args = opts.args ?? [];

  const pty = loadPty();
  const proc: IPty = pty.spawn(command, args, {
    name: 'xterm-256color',
    cols: opts.cols ?? 120,
    rows: opts.rows ?? 32,
    cwd: opts.cwd,
    env,
  });

  const session: PtySession = {
    sessionId: key,
    projectId: opts.projectId,
    kind: opts.kind,
    tabId,
    pid: proc.pid,
  };

  const entry: PoolEntry = {
    session,
    pty: proc,
    subscribers: new Set(),
    dataListeners: new Set(),
    exitListeners: new Set(),
    buffer: '',
    pending: '',
    flushTimer: null,
    lastActivityAt: Date.now(),
    // Only claude-cli PTYs print approval prompts. Allocating the detector
    // for unrelated sessions would mean running the regex sweep on every
    // shell keystroke for no benefit.
    approvals: opts.kind === 'claude-cli' ? new ApprovalDetector() : null,
    // Placeholder — replaced just below once the real closure (which needs
    // `entry` in scope) exists.
    flush: () => undefined,
  };
  entries.set(key, entry);

  const flush = () => {
    if (entry.flushTimer) {
      clearTimeout(entry.flushTimer);
      entry.flushTimer = null;
    }
    if (!entry.pending) return;
    const payload = entry.pending;
    entry.pending = '';
    for (const wc of entry.subscribers) {
      if (!wc.isDestroyed()) wc.send(`${IPC.PTY_DATA}:${key}`, payload);
    }
  };
  entry.flush = flush;

  proc.onData((data) => {
    // v0.36.0: any output from the PTY counts as activity — even a single
    // prompt redraw or spinner tick keeps the reaper at bay. We update here
    // BEFORE batching so a session that's producing data but whose flush is
    // throttled still looks "live".
    entry.lastActivityAt = Date.now();
    entry.buffer += data;
    if (entry.buffer.length > BUFFER_CAP) {
      entry.buffer = entry.buffer.slice(entry.buffer.length - BUFFER_CAP);
    }
    entry.pending += data;
    if (entry.pending.length >= BATCH_BYTES_CAP) {
      flush();
    } else if (!entry.flushTimer) {
      entry.flushTimer = setTimeout(flush, BATCH_MS);
    }
    // Phase 4a: scan claude-cli output for a fresh tool-approval prompt.
    // The detector is cheap (regex array over a 1024 B rolling buffer) and
    // we run it BEFORE the broadcast so the banner can race the terminal
    // repaint — both arrive in the same IPC frame.
    if (entry.approvals) {
      let hit: ApprovalRequest | null = null;
      try {
        hit = entry.approvals.feed(data);
      } catch (err) {
        logger.warn(
          `approval detector threw on ${key}: ${(err as Error).message}`,
        );
      }
      if (hit) {
        for (const wc of entry.subscribers) {
          if (!wc.isDestroyed()) {
            wc.send(`${IPC.PTY_TOOL_APPROVAL}:${key}`, {
              sessionId: key,
              request: hit,
            });
          }
        }
      }
    }
    // Programmatic listeners get every chunk immediately (no batching) —
    // they're used for line-oriented parsing (URL extraction) where
    // latency matters more than IPC throughput.
    for (const fn of entry.dataListeners) {
      try {
        fn(data);
      } catch (err) {
        logger.warn(`data listener threw on ${key}: ${(err as Error).message}`);
      }
    }
  });
  proc.onExit(({ exitCode }) => {
    flush();
    for (const wc of entry.subscribers) {
      if (!wc.isDestroyed()) wc.send(`${IPC.PTY_EXIT}:${key}`, exitCode);
    }
    for (const fn of entry.exitListeners) {
      try {
        fn(exitCode);
      } catch (err) {
        logger.warn(`exit listener threw on ${key}: ${(err as Error).message}`);
      }
    }
    // Identity check: only delete if WE still own the slot. A stale exit
    // from a superseded PTY (e.g. killed mid-create, then recreated) must
    // not delete the live entry that replaced it under the same key.
    if (entries.get(key) === entry) entries.delete(key);
    logger.info(`session ${key} exited (code=${exitCode})`);

    // Native learning (sub-project 3): when a claude-cli session ends, kick a
    // throttled, fire-and-forget auto-distill of THIS project's recent activity
    // into durable learnings. Resolve the project path from the PTY's `cwd`
    // (the absolute project root the session ran in) — NOT the projectId hash,
    // which DistillationService can't map back to an abspath. Lazy-import the
    // service to avoid a circular import (DistillationService → MemoryService;
    // PtyPool stays out of that graph at module load). Fully detached: never
    // awaited, never throws into the exit path, .catch swallows any rejection.
    if (opts.kind === 'claude-cli' && typeof opts.cwd === 'string' && opts.cwd) {
      const projectPath = opts.cwd;
      void (async () => {
        try {
          const { maybeAutoDistill } = await import('./DistillationService');
          await maybeAutoDistill(projectPath);
        } catch {
          /* never let auto-distill disturb PTY teardown */
        }
      })().catch(() => {});
    }
  });

  logger.info(`session ${key} spawned pid=${proc.pid} cmd=${command}`);
  return session;
}

// Track which WebContents already have a destroy listener registered so we
// don't attach one per subscribe() call (which leaks listeners under HMR).
const wcDestroyHooks = new WeakSet<WebContents>();

function addSubscriber(entry: PoolEntry, wc: WebContents): void {
  entry.subscribers.add(wc);
  if (!wcDestroyHooks.has(wc)) {
    wcDestroyHooks.add(wc);
    wc.once('destroyed', () => {
      for (const e of entries.values()) e.subscribers.delete(wc);
    });
  }
}

/**
 * Create-flow subscriber add: live streaming starts immediately, but NO
 * buffer replay happens here. The renderer's `pty:data:<key>` listener only
 * attaches after PTY_CREATE resolves (plus the lazy xterm chunk + layout
 * rAFs), so anything sent from inside the create handler is delivered before
 * a listener exists and dropped. Scrollback replay is renderer-PULLED via
 * PTY_SUBSCRIBE → subscribeAndReplay() once the listener is armed.
 */
export function subscribe(key: string, wc: WebContents): void {
  const entry = entries.get(key);
  if (!entry) return;
  addSubscriber(entry, wc);
}

/**
 * Renderer-pulled replay: add `wc` as a subscriber and return the current
 * rolling-buffer contents, both in the SAME synchronous turn. Idempotent and
 * deliberately WITHOUT a has(wc) early-return — the create flow already
 * subscribed this wc and nothing unsubscribes a live one, so a remounted
 * pane re-invoking this MUST still get the replay (the old early-return is
 * exactly what made scrollback restore dead code).
 *
 * Atomicity contract: `pending` is drained to existing subscribers first, so
 * the returned snapshot covers everything emitted up to this instant and any
 * chunk emitted afterwards arrives only as a PTY_DATA event — no gap. (The
 * renderer dedups the narrow window where a chunk was evented to an
 * already-subscribed wc before this snapshot was taken.) Returns '' when the
 * session doesn't exist.
 */
export function subscribeAndReplay(key: string, wc: WebContents): string {
  const entry = entries.get(key);
  if (!entry) return '';
  // Drain BEFORE adding wc: pending bytes are already in `buffer`, so
  // flushing after the add would send them to wc twice (snapshot + event).
  entry.flush();
  addSubscriber(entry, wc);
  return entry.buffer;
}

export function unsubscribe(key: string, wc: WebContents): void {
  const entry = entries.get(key);
  entry?.subscribers.delete(wc);
}

export function writeToPty(key: string, data: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  // v0.36.0: any keystroke / paste from the renderer is the strongest
  // possible "user is still here" signal. Stamp activity BEFORE writing
  // so a reaper tick racing with the write can't kill the session.
  entry.lastActivityAt = Date.now();
  // Phase 4a: the user (or our own banner) just typed into the PTY. Either
  // way, the detector's "waiting for response" assumption is now stale —
  // reset so the next approval prompt fires cleanly. Cheap (clears 4 fields).
  entry.approvals?.reset();
  entry.pty.write(data);
}

/**
 * Register a programmatic listener for PTY stdout/stderr chunks. Returns an
 * unsubscribe function. Used by main-process services (e.g. DevServerService)
 * that need to parse PTY output without involving the renderer. Returns a
 * no-op if the session doesn't exist.
 */
export function subscribeData(key: string, fn: PtyDataListener): () => void {
  const entry = entries.get(key);
  if (!entry) return () => undefined;
  entry.dataListeners.add(fn);
  return () => {
    entries.get(key)?.dataListeners.delete(fn);
  };
}

/**
 * Register a programmatic listener for PTY exit. Returns an unsubscribe
 * function. Fires once with the exit code, then the listener is removed
 * automatically when the entry is deleted.
 */
export function subscribeExit(key: string, fn: PtyExitListener): () => void {
  const entry = entries.get(key);
  if (!entry) return () => undefined;
  entry.exitListeners.add(fn);
  return () => {
    entries.get(key)?.exitListeners.delete(fn);
  };
}

export function resizePty(key: string, cols: number, rows: number): void {
  const entry = entries.get(key);
  if (!entry) return;
  try {
    entry.pty.resize(cols, rows);
  } catch (err) {
    logger.warn(`resize failed on ${key}:`, (err as Error).message);
  }
}

// Grace period between SIGTERM (graceful) and SIGKILL (force) on the
// process group. Vite/Next/etc need a few hundred ms to tear down their
// own child workers cleanly; without the grace they leak orphan workers.
const KILL_GRACE_MS = 800;

// Cap on the overall awaitable kill — if the child ignores both signals
// we still want shutdownAll() to return so the app can exit.
const KILL_TIMEOUT_MS = 2500;

/**
 * Send a POSIX signal to the entire process group (`-pgid`). node-pty's
 * `pty.kill(sig)` only signals the direct child shell — when that shell
 * has spawned `pnpm → node → vite`, the deeper processes survive and
 * become reparented to PID 1. Signalling the group nukes the whole
 * subtree in one syscall.
 *
 * Best-effort: we never throw out of here. ESRCH (already-dead) is the
 * normal happy-path; EPERM only happens if we somehow forked across
 * users, which we don't.
 */
function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(-pid, signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ESRCH = no such process (already dead). EPERM = wrong user; we'd
    // hit this only in an exotic setuid scenario, so log + move on.
    if (code !== 'ESRCH' && code !== 'EPERM') {
      logger.warn(`killpg(${pid}, ${signal}) failed: ${(err as Error).message}`);
    }
  }
}

/**
 * Async kill: signals the process group with SIGTERM, waits up to
 * KILL_GRACE_MS for a clean exit, then escalates to SIGKILL on the
 * group. Resolves when the PTY reports exit (via onExit), or when the
 * outer KILL_TIMEOUT_MS lapses.
 *
 * Idempotent and best-effort — calling on an unknown key resolves
 * immediately. The pool entry is removed exactly once (in the onExit
 * handler that the spawn site wired up).
 */
export async function killPty(key: string): Promise<void> {
  // Kill-during-create becomes wait-then-kill: if a create for this key is
  // still in flight, await it so we signal the real PTY instead of racing
  // entries.set() and missing it entirely. A failed spawn is fine — there
  // is nothing to kill then.
  const pending = pendingCreates.get(key);
  if (pending) await pending.catch(() => undefined);
  const entry = entries.get(key);
  if (!entry) return;
  if (entry.flushTimer) clearTimeout(entry.flushTimer);
  const pid = entry.pty.pid;
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(graceTimer);
      clearTimeout(overallTimer);
      detach();
      // Drop the entry defensively in case onExit never fires — but only
      // if WE still own the slot, so a kill that timed out after the key
      // was recreated can't delete the fresh live entry.
      if (entries.get(key) === entry) entries.delete(key);
      resolve();
    };
    // Listen for the PTY's own exit signal — that's the source of truth
    // for "the process group is gone". Falls back to timeouts below.
    const detach = subscribeExit(key, () => finish());
    // 1. SIGTERM on the group — gives Vite/Next time to release ports.
    killProcessGroup(pid, 'SIGTERM');
    try {
      // Belt-and-suspenders: also signal the direct child via node-pty
      // in case the leader trapped SIGTERM (some shells do). The group
      // signal usually wins; this just covers the lone-process case.
      entry.pty.kill('SIGTERM');
    } catch {
      /* already dead */
    }
    // 2. After grace, escalate to SIGKILL on the group.
    const graceTimer = setTimeout(() => {
      if (settled) return;
      killProcessGroup(pid, 'SIGKILL');
      try {
        entry.pty.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    }, KILL_GRACE_MS);
    // 3. Hard ceiling — never block forever during shutdown.
    const overallTimer = setTimeout(() => {
      if (!settled) {
        logger.warn(`killPty(${key}): exit never observed within ${KILL_TIMEOUT_MS}ms`);
        finish();
      }
    }, KILL_TIMEOUT_MS);
  });
}

export function listSessions(): PtySession[] {
  return Array.from(entries.values()).map((e) => e.session);
}

export function getSession(
  projectId: string,
  kind: string,
  tabId: string = DEFAULT_TAB_ID,
): PtySession | null {
  return entries.get(sessionKey(projectId, kind, tabId))?.session ?? null;
}

/** Kill one tmux session on our socket by name. Best-effort: "no such
 * session" is the normal already-gone case and stays silent; anything else
 * is logged but never thrown. */
async function killTmuxSessionByName(name: string): Promise<void> {
  const tmuxBin = (await resolveTmuxBinary()) ?? 'tmux';
  try {
    await execFileP(tmuxBin, [...tmuxSocketArgs(), 'kill-session', '-t', name]);
    logger.info(`killed tmux session ${name}`);
  } catch (err) {
    // Session may not exist — silent is fine, otherwise log.
    const msg = (err as Error).message;
    if (!msg.includes('no such session') && !msg.includes('session not found')) {
      logger.warn(`tmux kill-session ${name} failed: ${msg}`);
    }
  }
}

/**
 * Kill a claude-cli tab's FULL session tree. With tmux enabled the PTY
 * child is only the `tmux new-session -A` attach CLIENT — killPty alone
 * leaves claude + its MCP server children running detached on the tmux
 * server. The follow-up kill-session is what actually frees them. Works
 * even when the pool entry is already gone (PTY exited but the detached
 * session persists): killPty on an unknown key is a no-op and the
 * kill-session still runs.
 *
 * Ordering matters: use the awaitable killPty so we know the client
 * process tree is actually gone before we tear down the tmux session —
 * otherwise tmux can race with a still-attached pty and refuse to clean up.
 */
export async function killClaudeCliSessionTree(
  projectId: string,
  tabId: string = DEFAULT_TAB_ID,
): Promise<void> {
  await killPty(sessionKey(projectId, 'claude-cli', tabId));
  await killTmuxSessionByName(claudeCliTmuxSessionName(projectId, tabId));
}

/** Shell-tab counterpart of killClaudeCliSessionTree — same client-then-
 * session ordering, same already-gone semantics. */
export async function killShellSessionTree(
  projectId: string,
  tabId: string = DEFAULT_TAB_ID,
): Promise<void> {
  await killPty(sessionKey(projectId, 'shell', tabId));
  await killTmuxSessionByName(shellTmuxSessionName(projectId, tabId));
}

/**
 * Kill every PTY belonging to a project (every kind, every tab). Used when a
 * project is closed/evicted so claude/shell processes don't linger.
 * Resolves when every session has reported exit (or hit its kill timeout).
 * tmux-backed kinds (claude-cli / shell) get the full session-tree kill so
 * claude + MCP children don't leak detached; other kinds (dev-server etc.)
 * are not tmux-backed, so plain killPty is the whole teardown.
 */
export async function killProjectSessions(projectId: string): Promise<void> {
  const prefix = `${projectId}:`;
  const kills: Array<Promise<void>> = [];
  for (const [key, entry] of Array.from(entries.entries())) {
    if (!key.startsWith(prefix)) continue;
    // Snapshot kind/tabId BEFORE any await — the entry is deleted from the
    // map when the PTY exits, so reading it after killPty would miss. Use
    // session fields rather than parsing the key (projectId may contain ':').
    const { kind, tabId, projectId: pid } = entry.session;
    if (kind === 'claude-cli') {
      kills.push(killClaudeCliSessionTree(pid, tabId));
    } else if (kind === 'shell') {
      kills.push(killShellSessionTree(pid, tabId));
    } else {
      kills.push(killPty(key));
    }
  }
  await Promise.all(kills);
}

/**
 * Kill the Claude CLI tmux session AND the pty for one tab so the next
 * subscribe spawns a brand-new claude process — necessary for picking up
 * freshly written `.mcp.json` or environment changes.
 */
export async function restartClaudeCli(
  projectId: string,
  tabId: string = DEFAULT_TAB_ID,
): Promise<void> {
  await killClaudeCliSessionTree(projectId, tabId);
}

/**
 * Kill all sessions — called on app quit. Returns a promise that
 * resolves when every PTY has exited (or hit its kill timeout). The
 * `before-quit` hook should `await` this before calling `app.exit()` so
 * we don't orphan node/vite children with the app already gone.
 *
 * Deliberately detach-only for tmux-backed sessions: killPty kills the
 * attach client, so claude/shell keep running on the tmux server and
 * survive app restart (the persistence feature). The opt-in kill-server
 * at quit (killSessionsOnQuit) lives in main/index.ts.
 */
export async function shutdownAll(): Promise<void> {
  const kills: Array<Promise<void>> = [];
  for (const key of Array.from(entries.keys())) {
    kills.push(killPty(key));
  }
  await Promise.all(kills);
}

// ─── v0.36.0 — Idle CLI-tab reaper ─────────────────────────────────────────
//
// Each `claude` CLI process pulls in ~245 MB plus an MCP server tree (the
// Playwright MCP commonly adds ~165 MB) — with 13 idle tabs the dock alone
// holds ~5 GB the user can't easily reclaim. This reaper walks every claude-
// cli PTY on a 60s tick and kills any whose lastActivityAt is older than the
// configured threshold. Each victim goes through killClaudeCliSessionTree
// (killPty + tmux kill-session): with tmux enabled the PTY child is only the
// attach client, so killPty alone would leave claude + its MCP children
// running detached and the memory would never actually be reclaimed.
//
// Scoped narrowly to kind === 'claude-cli'. Shell tabs, dev-server PTYs, the
// AskUserQuestion-aware chat-run reaper, and setup-claude flows are off
// limits — they have their own lifecycle expectations.

const IDLE_REAPER_TICK_MS = 60_000;

let _idleReaperTimer: NodeJS.Timeout | null = null;
// v0.38.0-beta.15: off until configureIdleReaper runs with the loaded config.
// Auto-close is now opt-in (DEFAULT_TMUX_CONFIG.autoCloseIdleCliTabs = false),
// so the safe initial state is disabled — a boot path that starts the reaper
// before configuring it must never reap on the stale built-in default.
let _idleReaperEnabled = false;
let _idleThresholdMinutes = 120;
// v0.36.1: dual-tier reaper. Tabs not present in any dock column close much
// faster — they're the chips the user can't see. Renderer pushes the pinned
// set whenever its `columns` array changes; main starts with an empty set so
// nothing is treated as pinned until that arrives.
let _unpinnedThresholdMinutes = 10;
const _pinnedSessionIds: Set<string> = new Set();

const IDLE_THRESHOLD_MIN_MINUTES = 15;
const IDLE_THRESHOLD_MAX_MINUTES = 720;
const UNPINNED_THRESHOLD_MIN_MINUTES = 1;
const UNPINNED_THRESHOLD_MAX_MINUTES = 60;

/** Read-only stats snapshot — used by the reaper + tests. Cheap to compute
 * (one pass over the map) so callers can poll without worrying about cost. */
export function getSessionStats(): Array<{
  id: string;
  kind: PtySessionKind;
  lastActivityAt: number;
}> {
  const out: Array<{ id: string; kind: PtySessionKind; lastActivityAt: number }> = [];
  for (const [id, entry] of entries) {
    out.push({
      id,
      kind: entry.session.kind,
      lastActivityAt: entry.lastActivityAt,
    });
  }
  return out;
}

/**
 * Pure helper: given a snapshot of session stats, the current time, and the
 * two idle thresholds in ms, return the set of claude-cli session ids that
 * the reaper should kill. Dual-tier as of v0.36.1: pinned tabs (visible in
 * some dock column) get the longer threshold; unpinned tabs (dock chips the
 * user hasn't surfaced) close much faster. A non-finite or non-positive
 * threshold disables kills for THAT tier only, not both.
 */
export function selectIdleClaudeCliVictims(
  sessions: Array<{ id: string; kind: PtySessionKind; lastActivityAt: number }>,
  nowMs: number,
  pinnedThresholdMs: number,
  unpinnedThresholdMs: number,
  pinnedIds: ReadonlySet<string>,
): string[] {
  const pinnedOk =
    Number.isFinite(pinnedThresholdMs) && pinnedThresholdMs > 0;
  const unpinnedOk =
    Number.isFinite(unpinnedThresholdMs) && unpinnedThresholdMs > 0;
  if (!pinnedOk && !unpinnedOk) return [];
  const victims: string[] = [];
  for (const s of sessions) {
    if (s.kind !== 'claude-cli') continue;
    const idleMs = nowMs - s.lastActivityAt;
    if (pinnedIds.has(s.id)) {
      if (pinnedOk && idleMs > pinnedThresholdMs) victims.push(s.id);
    } else {
      if (unpinnedOk && idleMs > unpinnedThresholdMs) victims.push(s.id);
    }
  }
  return victims;
}

/**
 * Replace the set of session ids treated as "pinned" (visible in some dock
 * column). Pushed from the renderer whenever its columns layout changes.
 * Non-string entries are silently dropped so a misbehaving caller can't
 * poison the set.
 */
export function setPinnedSessions(ids: string[]): void {
  if (!Array.isArray(ids)) {
    logger.debug('setPinnedSessions: ignoring non-array payload');
    return;
  }
  _pinnedSessionIds.clear();
  for (const id of ids) {
    if (typeof id === 'string') _pinnedSessionIds.add(id);
  }
  logger.debug(`pinned set updated: ${_pinnedSessionIds.size} session(s)`);
}

/** Test-only getter — lets unit tests confirm setPinnedSessions wired the
 * private set without exporting the mutable state directly. */
export function getPinnedSessionsForTest(): ReadonlySet<string> {
  return _pinnedSessionIds;
}

/** Apply a new enabled/threshold config to the running reaper. Clamps the
 * pinned threshold into [15, 720] minutes and the unpinned threshold into
 * [1, 60] minutes so a misconfigured renderer can't disable either tier by
 * stealth (threshold of 0 / negative / Infinity). Either threshold may be
 * omitted — missing fields keep their current value, so callers can pass
 * partial updates without re-reading state. */
export function configureIdleReaper(opts: {
  enabled: boolean;
  thresholdMinutes: number;
  unpinnedThresholdMinutes?: number;
}): void {
  _idleReaperEnabled = !!opts.enabled;
  const raw = Number(opts.thresholdMinutes);
  if (Number.isFinite(raw)) {
    _idleThresholdMinutes = Math.max(
      IDLE_THRESHOLD_MIN_MINUTES,
      Math.min(IDLE_THRESHOLD_MAX_MINUTES, Math.floor(raw)),
    );
  }
  if (opts.unpinnedThresholdMinutes !== undefined) {
    const rawUnpinned = Number(opts.unpinnedThresholdMinutes);
    if (Number.isFinite(rawUnpinned)) {
      _unpinnedThresholdMinutes = Math.max(
        UNPINNED_THRESHOLD_MIN_MINUTES,
        Math.min(UNPINNED_THRESHOLD_MAX_MINUTES, Math.floor(rawUnpinned)),
      );
    }
  }
  logger.info(
    `idle reaper configured: enabled=${_idleReaperEnabled} pinned=${_idleThresholdMinutes}m unpinned=${_unpinnedThresholdMinutes}m`,
  );
}

/**
 * Start the idle-reaper interval. Idempotent — calling twice replaces the
 * previous interval. `broadcast` is invoked whenever the reaper kills one
 * or more claude-cli sessions, with the killed ids + the threshold (so the
 * renderer toast can say "Closed N idle CLI tabs · ~M MB freed").
 */
export function startIdleReaper(
  broadcast: (ids: string[], thresholdMinutes: number) => void,
): void {
  if (_idleReaperTimer) {
    clearInterval(_idleReaperTimer);
    _idleReaperTimer = null;
  }
  _idleReaperTimer = setInterval(() => {
    if (!_idleReaperEnabled) return;
    const pinnedMs = _idleThresholdMinutes * 60 * 1000;
    const unpinnedMs = _unpinnedThresholdMinutes * 60 * 1000;
    const victims = selectIdleClaudeCliVictims(
      getSessionStats(),
      Date.now(),
      pinnedMs,
      unpinnedMs,
      _pinnedSessionIds,
    );
    if (victims.length === 0) return;
    logger.info(
      `idle reaper: closing ${victims.length} idle claude-cli session(s) (pinned=${_idleThresholdMinutes}m unpinned=${_unpinnedThresholdMinutes}m)`,
    );
    for (const id of victims) {
      // Read identity from the live entry BEFORE killPty deletes it on
      // exit. Never string-parse the pool key — projectId may contain ':'.
      const sess = entries.get(id)?.session;
      if (sess) {
        // Full session-tree kill: the PTY child is only the tmux attach
        // client; without the kill-session claude + MCP children would
        // linger detached and no memory would be freed.
        killClaudeCliSessionTree(sess.projectId, sess.tabId).catch(
          () => undefined,
        );
      } else {
        killPty(id).catch(() => undefined);
      }
    }
    try {
      // Report the smaller threshold to the renderer toast. The exact
      // number doesn't matter to users — they want to know "~M MB freed",
      // and the smaller threshold is the worst case for "this could have
      // been kept open longer". Keeps the broadcast contract unchanged.
      broadcast(victims, Math.min(_idleThresholdMinutes, _unpinnedThresholdMinutes));
    } catch (err) {
      logger.warn(`idle reaper broadcast threw: ${(err as Error).message}`);
    }
  }, IDLE_REAPER_TICK_MS);
  // Don't keep the event loop alive solely for this interval — Electron's
  // main process has its own keepalive (uv_run with active handles), so
  // unref() is safe and makes the reaper invisible to graceful-exit logic.
  _idleReaperTimer.unref?.();
  logger.info(
    `idle reaper started (tick=${IDLE_REAPER_TICK_MS}ms pinned=${_idleThresholdMinutes}m unpinned=${_unpinnedThresholdMinutes}m enabled=${_idleReaperEnabled})`,
  );
}

/** Stop the idle reaper. Idempotent — safe to call from before-quit even
 * when start was never reached (e.g. boot-time crash before whenReady). */
export function stopIdleReaper(): void {
  if (_idleReaperTimer) {
    clearInterval(_idleReaperTimer);
    _idleReaperTimer = null;
  }
}
