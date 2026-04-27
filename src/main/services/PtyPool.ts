import type { WebContents } from 'electron';
import type { IPty } from 'node-pty';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

import { claudeCliTmuxSessionName } from '@main/services/ClaudeCliLauncher';
import { resolveInteractiveShellEnv } from '@main/utils/shellEnv';
import { IPC } from '@shared/ipc-channels';
import { createLogger } from '@shared/logger';
import type { PtyCreateOptions, PtySession } from '@shared/types';

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

interface PoolEntry {
  session: PtySession;
  pty: IPty;
  subscribers: Set<WebContents>;
  // Rolling output buffer — replayed to new subscribers so remounted panes
  // don't show an empty terminal when the PTY already wrote its prompt.
  buffer: string;
  pending: string;
  flushTimer: NodeJS.Timeout | null;
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
    buffer: '',
    pending: '',
    flushTimer: null,
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
  });
  proc.onExit(({ exitCode }) => {
    flush();
    for (const wc of entry.subscribers) {
      if (!wc.isDestroyed()) wc.send(`${IPC.PTY_EXIT}:${key}`, exitCode);
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
  entries.get(key)?.pty.write(data);
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

export function killPty(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  if (entry.flushTimer) clearTimeout(entry.flushTimer);
  try {
    entry.pty.kill('SIGKILL');
  } catch (err) {
    logger.warn(`kill failed on ${key}:`, (err as Error).message);
  }
  entries.delete(key);
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
 */
export function killProjectSessions(projectId: string): void {
  const prefix = `${projectId}:`;
  for (const key of Array.from(entries.keys())) {
    if (key.startsWith(prefix)) killPty(key);
  }
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
  const entry = entries.get(key);
  if (entry) {
    if (entry.flushTimer) clearTimeout(entry.flushTimer);
    try {
      entry.pty.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    entries.delete(key);
  }
  const tmuxSession = claudeCliTmuxSessionName(projectId, tabId);
  try {
    await execFileP('tmux', ['kill-session', '-t', tmuxSession]);
    logger.info(`killed tmux session ${tmuxSession}`);
  } catch (err) {
    // Session may not exist — silent is fine, otherwise log.
    const msg = (err as Error).message;
    if (!msg.includes('no such session') && !msg.includes('session not found')) {
      logger.warn(`tmux kill-session ${tmuxSession} failed: ${msg}`);
    }
  }
}

/** Kill all sessions — called on app quit. */
export function shutdownAll(): void {
  for (const key of entries.keys()) killPty(key);
}
