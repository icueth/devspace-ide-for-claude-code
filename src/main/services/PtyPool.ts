import type { WebContents } from 'electron';
import type { IPty } from 'node-pty';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

import {
  claudeCliTmuxSessionName,
  resolveTmuxBinary,
  tmuxSocketArgs,
} from '@main/services/ClaudeCliLauncher';
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
  // Rolling output buffer — replayed to new subscribers so remounted panes
  // don't show an empty terminal when the PTY already wrote its prompt.
  buffer: string;
  pending: string;
  flushTimer: NodeJS.Timeout | null;
  // v0.36.0: ms-epoch of the last observed I/O activity on this PTY —
  // either incoming data from the child OR a write() from the renderer.
  // The idle reaper reads this to decide which claude-cli sessions have
  // been forgotten by the user and can be reclaimed.
  lastActivityAt: number;
}

const entries = new Map<string, PoolEntry>();

const DEFAULT_TAB_ID = 'default';

function sessionKey(projectId: string, kind: string, tabId: string): string {
  return `${projectId}:${kind}:${tabId}`;
}

export async function createPty(opts: PtyCreateOptions): Promise<PtySession> {
  const tabId = opts.tabId ?? DEFAULT_TAB_ID;
  const key = sessionKey(opts.projectId, opts.kind, tabId);
  const existing = entries.get(key);
  if (existing) return existing.session;

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
    entries.delete(key);
    logger.info(`session ${key} exited (code=${exitCode})`);
  });

  logger.info(`session ${key} spawned pid=${proc.pid} cmd=${command}`);
  return session;
}

// Track which WebContents already have a destroy listener registered so we
// don't attach one per subscribe() call (which leaks listeners under HMR).
const wcDestroyHooks = new WeakSet<WebContents>();

export function subscribe(key: string, wc: WebContents): void {
  const entry = entries.get(key);
  if (!entry) return;
  if (entry.subscribers.has(wc)) return;
  entry.subscribers.add(wc);
  if (!wcDestroyHooks.has(wc)) {
    wcDestroyHooks.add(wc);
    wc.once('destroyed', () => {
      for (const e of entries.values()) e.subscribers.delete(wc);
    });
  }
  // Replay the rolling buffer so a freshly-mounted xterm doesn't show blank.
  if (entry.buffer && !wc.isDestroyed()) {
    wc.send(`${IPC.PTY_DATA}:${key}`, entry.buffer);
  }
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
export function killPty(key: string): Promise<void> {
  const entry = entries.get(key);
  if (!entry) return Promise.resolve();
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
      // Drop the entry defensively in case onExit never fires — the
      // spawn-site onExit handler will also call delete(), which is a
      // no-op the second time.
      entries.delete(key);
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

/**
 * Kill every PTY belonging to a project (every kind, every tab). Used when a
 * project is closed/evicted so claude/shell processes don't linger.
 * Resolves when every session has reported exit (or hit its kill timeout).
 */
export async function killProjectSessions(projectId: string): Promise<void> {
  const prefix = `${projectId}:`;
  const kills: Array<Promise<void>> = [];
  for (const key of Array.from(entries.keys())) {
    if (key.startsWith(prefix)) kills.push(killPty(key));
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
  const key = sessionKey(projectId, 'claude-cli', tabId);
  // Use the awaitable killPty so we know the process tree is actually
  // gone before we tear down the tmux session — otherwise tmux can
  // race with a still-attached pty and refuse to clean up.
  await killPty(key);
  const tmuxSession = claudeCliTmuxSessionName(projectId, tabId);
  const tmuxBin = (await resolveTmuxBinary()) ?? 'tmux';
  try {
    await execFileP(tmuxBin, [...tmuxSocketArgs(), 'kill-session', '-t', tmuxSession]);
    logger.info(`killed tmux session ${tmuxSession}`);
  } catch (err) {
    // Session may not exist — silent is fine, otherwise log.
    const msg = (err as Error).message;
    if (!msg.includes('no such session') && !msg.includes('session not found')) {
      logger.warn(`tmux kill-session ${tmuxSession} failed: ${msg}`);
    }
  }
}

/**
 * Kill all sessions — called on app quit. Returns a promise that
 * resolves when every PTY has exited (or hit its kill timeout). The
 * `before-quit` hook should `await` this before calling `app.exit()` so
 * we don't orphan node/vite/claude children with the app already gone.
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
// configured threshold. Killing the PTY goes through killPty → process-group
// kill, so claude + its MCP children die together.
//
// Scoped narrowly to kind === 'claude-cli'. Shell tabs, dev-server PTYs, the
// AskUserQuestion-aware chat-run reaper, and setup-claude flows are off
// limits — they have their own lifecycle expectations.

const IDLE_REAPER_TICK_MS = 60_000;

let _idleReaperTimer: NodeJS.Timeout | null = null;
let _idleReaperEnabled = true;
let _idleThresholdMinutes = 120;

const IDLE_THRESHOLD_MIN_MINUTES = 15;
const IDLE_THRESHOLD_MAX_MINUTES = 720;

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
 * Pure helper: given a snapshot of session stats, the current time, and an
 * idle threshold in ms, return the set of claude-cli session ids that the
 * reaper should kill. Extracted so tests can exercise the decision logic
 * without spinning up actual ptys or fake-timing the interval.
 */
export function selectIdleClaudeCliVictims(
  sessions: Array<{ id: string; kind: PtySessionKind; lastActivityAt: number }>,
  nowMs: number,
  thresholdMs: number,
): string[] {
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) return [];
  const victims: string[] = [];
  for (const s of sessions) {
    if (s.kind !== 'claude-cli') continue;
    if (nowMs - s.lastActivityAt > thresholdMs) victims.push(s.id);
  }
  return victims;
}

/** Apply a new enabled/threshold config to the running reaper. Clamps the
 * threshold into [15, 720] minutes so a misconfigured renderer can't disable
 * the reaper by stealth (threshold of 0 / negative / Infinity). */
export function configureIdleReaper(opts: {
  enabled: boolean;
  thresholdMinutes: number;
}): void {
  _idleReaperEnabled = !!opts.enabled;
  const raw = Number(opts.thresholdMinutes);
  if (Number.isFinite(raw)) {
    _idleThresholdMinutes = Math.max(
      IDLE_THRESHOLD_MIN_MINUTES,
      Math.min(IDLE_THRESHOLD_MAX_MINUTES, Math.floor(raw)),
    );
  }
  logger.info(
    `idle reaper configured: enabled=${_idleReaperEnabled} threshold=${_idleThresholdMinutes}m`,
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
    if (!_idleReaperEnabled || _idleThresholdMinutes <= 0) return;
    const thresholdMs = _idleThresholdMinutes * 60 * 1000;
    const victims = selectIdleClaudeCliVictims(
      getSessionStats(),
      Date.now(),
      thresholdMs,
    );
    if (victims.length === 0) return;
    logger.info(
      `idle reaper: closing ${victims.length} idle claude-cli session(s) (threshold=${_idleThresholdMinutes}m)`,
    );
    for (const id of victims) {
      killPty(id).catch(() => undefined);
    }
    try {
      broadcast(victims, _idleThresholdMinutes);
    } catch (err) {
      logger.warn(`idle reaper broadcast threw: ${(err as Error).message}`);
    }
  }, IDLE_REAPER_TICK_MS);
  // Don't keep the event loop alive solely for this interval — Electron's
  // main process has its own keepalive (uv_run with active handles), so
  // unref() is safe and makes the reaper invisible to graceful-exit logic.
  _idleReaperTimer.unref?.();
  logger.info(
    `idle reaper started (tick=${IDLE_REAPER_TICK_MS}ms threshold=${_idleThresholdMinutes}m enabled=${_idleReaperEnabled})`,
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
