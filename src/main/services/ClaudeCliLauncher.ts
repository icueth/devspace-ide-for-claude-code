import { createPty, getSession } from '@main/services/PtyPool';
import { resolveInteractiveShellEnv } from '@main/utils/shellEnv';
import { createLogger } from '@shared/logger';
import type { PtySession } from '@shared/types';

const logger = createLogger('ClaudeCliLauncher');

async function findOnPath(name: string): Promise<string | null> {
  const env = await resolveInteractiveShellEnv();
  const path = env.PATH ?? process.env.PATH ?? '';
  if (!path) return null;

  const { existsSync } = await import('node:fs');
  const pathSep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32' ? ['.cmd', '.exe'] : [''];

  for (const dir of path.split(pathSep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = `${dir}/${name}${ext}`;
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

async function findClaudeBinary(): Promise<string | null> {
  return findOnPath('claude');
}

export async function resolveClaudeBinary(): Promise<string | null> {
  return findClaudeBinary();
}

async function findTmuxBinary(): Promise<string | null> {
  if (process.platform === 'win32') return null;
  return findOnPath('tmux');
}

function tmuxSessionName(prefix: string, projectId: string, tabId: string): string {
  // tmux allows alphanumeric + _ -. Our projectId is a 12-char hex hash;
  // tabId is short slug ('default', 'a3f9k2', etc.).
  return tabId === 'default'
    ? `devspace-${prefix}-${projectId}`
    : `devspace-${prefix}-${projectId}-${tabId}`;
}

export function claudeCliTmuxSessionName(projectId: string, tabId = 'default'): string {
  return tmuxSessionName('cli', projectId, tabId);
}

export interface ClaudeLaunchOptions {
  projectId: string;
  tabId?: string;
  cwd: string;
  cols?: number;
  rows?: number;
}

/**
 * Start (or reuse) a Claude Code CLI PTY session for the given project.
 * Falls back to an interactive shell with a friendly message if `claude` is
 * not installed, so the pane is still usable.
 */
export async function launchClaudeCli(
  opts: ClaudeLaunchOptions,
): Promise<PtySession> {
  const tabId = opts.tabId ?? 'default';
  const existing = getSession(opts.projectId, 'claude-cli', tabId);
  if (existing) return existing;

  const claudeBin = await findClaudeBinary();
  const tmuxBin = await findTmuxBinary();
  const env = await resolveInteractiveShellEnv();
  const shell = env.SHELL ?? process.env.SHELL ?? '/bin/zsh';

  // Prefer tmux so the CLI session survives app restarts / pane remounts.
  // `new-session -A` attaches to an existing session with the same name or
  // creates it — which gives us free resume-on-reopen.
  if (tmuxBin && claudeBin) {
    const sessionName = tmuxSessionName('cli', opts.projectId, tabId);
    logger.info(
      `tmux-backed claude for project=${opts.projectId} tab=${tabId} (${sessionName})`,
    );
    return createPty({
      projectId: opts.projectId,
      kind: 'claude-cli',
      tabId,
      cwd: opts.cwd,
      command: tmuxBin,
      args: [
        'new-session',
        '-A',
        '-s',
        sessionName,
        '-c',
        opts.cwd,
        claudeBin,
      ],
      cols: opts.cols,
      rows: opts.rows,
    });
  }

  if (claudeBin) {
    logger.info(
      `spawning claude (${claudeBin}) without tmux — install tmux for persistence`,
    );
    return createPty({
      projectId: opts.projectId,
      kind: 'claude-cli',
      tabId,
      cwd: opts.cwd,
      command: claudeBin,
      args: [],
      cols: opts.cols,
      rows: opts.rows,
    });
  }

  logger.warn('claude binary not found on PATH — starting shell with a hint');
  const hintCmd = `echo "⚠️  'claude' binary not found on PATH. Install Claude Code CLI: https://docs.anthropic.com/claude-code" && exec ${shell} -l`;
  return createPty({
    projectId: opts.projectId,
    kind: 'claude-cli',
    tabId,
    cwd: opts.cwd,
    command: shell,
    args: ['-l', '-c', hintCmd],
    cols: opts.cols,
    rows: opts.rows,
  });
}

export interface ShellLaunchOptions {
  projectId: string;
  cwd: string;
  cols?: number;
  rows?: number;
}

/**
 * Start or resume the per-project integrated shell. Uses tmux so history +
 * running processes survive app restart, same as the Claude CLI pane.
 */
export async function launchShell(opts: ShellLaunchOptions): Promise<PtySession> {
  const existing = getSession(opts.projectId, 'shell');
  if (existing) return existing;

  const tmuxBin = await findTmuxBinary();
  const env = await resolveInteractiveShellEnv();
  const shell = env.SHELL ?? process.env.SHELL ?? '/bin/zsh';

  if (tmuxBin) {
    const sessionName = tmuxSessionName('shell', opts.projectId, 'default');
    logger.info(`tmux-backed shell for project=${opts.projectId} (${sessionName})`);
    return createPty({
      projectId: opts.projectId,
      kind: 'shell',
      cwd: opts.cwd,
      command: tmuxBin,
      args: [
        'new-session',
        '-A',
        '-s',
        sessionName,
        '-c',
        opts.cwd,
        shell,
        '-l',
      ],
      cols: opts.cols,
      rows: opts.rows,
    });
  }

  return createPty({
    projectId: opts.projectId,
    kind: 'shell',
    cwd: opts.cwd,
    command: shell,
    args: ['-l'],
    cols: opts.cols,
    rows: opts.rows,
  });
}
