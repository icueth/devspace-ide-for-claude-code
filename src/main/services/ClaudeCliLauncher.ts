import { createPty, getSession } from '@main/services/PtyPool';
import {
  getTmuxConfigSync,
  loadTmuxConfig,
} from '@main/services/TmuxConfigService';
import { resolveInteractiveShellEnv } from '@main/utils/shellEnv';
import { createLogger } from '@shared/logger';
import type { PtySession, TmuxConfig } from '@shared/types';

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

/**
 * Resolve the tmux binary that DevSpace should spawn. Honors the user's
 * configured override (`config.binaryPath`) when it points at an existing
 * file, otherwise falls back to PATH lookup. Returns null on Windows or when
 * tmux can't be located.
 */
export async function resolveTmuxBinary(): Promise<string | null> {
  if (process.platform === 'win32') return null;
  const cfg = await loadTmuxConfig();
  if (cfg.binaryPath) {
    const { existsSync } = await import('node:fs');
    if (existsSync(cfg.binaryPath)) return cfg.binaryPath;
    logger.warn(`configured binaryPath missing: ${cfg.binaryPath} — falling back to PATH`);
  }
  return findOnPath('tmux');
}

function tmuxSessionName(
  cfg: TmuxConfig,
  prefix: string,
  projectId: string,
  tabId: string,
): string {
  return tabId === 'default'
    ? `${cfg.sessionPrefix}-${prefix}-${projectId}`
    : `${cfg.sessionPrefix}-${prefix}-${projectId}-${tabId}`;
}

export function claudeCliTmuxSessionName(projectId: string, tabId = 'default'): string {
  return tmuxSessionName(getTmuxConfigSync(), 'cli', projectId, tabId);
}

export function shellTmuxSessionName(projectId: string, tabId = 'default'): string {
  return tmuxSessionName(getTmuxConfigSync(), 'shell', projectId, tabId);
}

/** `tmux -L <socketName>` prefix args, used by every direct tmux invocation. */
export function tmuxSocketArgs(): string[] {
  const cfg = getTmuxConfigSync();
  return ['-L', cfg.socketName];
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
  const cfg = await loadTmuxConfig();
  const tmuxBin = cfg.enabled ? await resolveTmuxBinary() : null;
  const env = await resolveInteractiveShellEnv();
  const shell = env.SHELL ?? process.env.SHELL ?? '/bin/zsh';

  // Prefer tmux so the CLI session survives app restarts / pane remounts.
  // `new-session -A` attaches to an existing session with the same name or
  // creates it — which gives us free resume-on-reopen.
  if (tmuxBin && claudeBin) {
    const sessionName = tmuxSessionName(cfg, 'cli', opts.projectId, tabId);
    logger.info(
      `tmux-backed claude for project=${opts.projectId} tab=${tabId} (${sessionName}) socket=${cfg.socketName}`,
    );
    return createPty({
      projectId: opts.projectId,
      kind: 'claude-cli',
      tabId,
      cwd: opts.cwd,
      command: tmuxBin,
      args: [
        '-L',
        cfg.socketName,
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
      `spawning claude (${claudeBin}) without tmux — ${cfg.enabled ? 'install tmux for persistence' : 'tmux disabled in settings'}`,
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

  const cfg = await loadTmuxConfig();
  const tmuxBin = cfg.enabled ? await resolveTmuxBinary() : null;
  const env = await resolveInteractiveShellEnv();
  const shell = env.SHELL ?? process.env.SHELL ?? '/bin/zsh';

  if (tmuxBin) {
    const sessionName = tmuxSessionName(cfg, 'shell', opts.projectId, 'default');
    logger.info(
      `tmux-backed shell for project=${opts.projectId} (${sessionName}) socket=${cfg.socketName}`,
    );
    return createPty({
      projectId: opts.projectId,
      kind: 'shell',
      cwd: opts.cwd,
      command: tmuxBin,
      args: [
        '-L',
        cfg.socketName,
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
