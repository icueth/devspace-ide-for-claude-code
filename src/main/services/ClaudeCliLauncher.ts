import { resolveAuthEnvPairs } from '@main/services/ClaudeAuthService';
import { getCliProfile } from '@main/services/CliProfileService';
import { ensureCodexParity, ensureGeminiParity } from '@main/services/cliMcpSetup';
import { ensureOpenCodeConfig } from '@main/services/openCodeConfig';
import { createPty, getSession } from '@main/services/PtyPool';
import {
  getTmuxConfigSync,
  loadTmuxConfig,
} from '@main/services/TmuxConfigService';
import { ensureFolderTrusted } from '@main/utils/claudeTrust';
import { resolveInteractiveShellEnv } from '@main/utils/shellEnv';
import { createLogger } from '@shared/logger';
import type { PtySession, PtySessionKind, TmuxConfig } from '@shared/types';

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
  /** Initial brief, delivered as claude's first message (task agents). */
  initialPrompt?: string;
  /** Claude auth profile id — selects the credentials (env) for this session. */
  authProfileId?: string;
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

  // Pre-accept Claude Code's "trust this folder" dialog for this cwd so a fresh
  // launch (especially a brand-new task worktree) doesn't block the agent on
  // it. Best-effort; never throws (see ensureFolderTrusted).
  await ensureFolderTrusted(opts.cwd);

  const claudeBin = await findClaudeBinary();
  const cfg = await loadTmuxConfig();
  const tmuxBin = cfg.enabled ? await resolveTmuxBinary() : null;
  const env = await resolveInteractiveShellEnv();
  const shell = env.SHELL ?? process.env.SHELL ?? '/bin/zsh';

  // --dangerously-skip-permissions: user-requested default for interactive
  // CLI panes so claude can edit files / run tools without prompting every
  // turn. The interactive pane is already a trust boundary (user types the
  // commands themselves) so a global skip matches the workflow expectation.
  // NOTE: only applied here — claude -p sites (Design generation) still pass
  // --disallowed-tools to keep the sandbox tight.
  // An initialPrompt (a task brief) rides as claude's positional arg so the
  // agent starts on the work immediately instead of sitting idle. tmux execs
  // via execvp (no shell) so a multi-word prompt needs no quoting; and on a
  // `new-session -A` reattach the trailing command is ignored, so the brief is
  // delivered exactly once — on first launch.
  const claudeArgs = [
    '--dangerously-skip-permissions',
    ...(opts.initialPrompt ? [opts.initialPrompt] : []),
  ];

  // Per-session auth: ANTHROPIC_* env pairs for the chosen profile (empty for
  // subscription). Injected into the session's env wrapper so different tabs can
  // run on different credentials at once. Applied on first launch only (tmux
  // ignores the wrapper on -A reattach), so switching a tab's auth needs a reload.
  const authPairs = await resolveAuthEnvPairs(opts.authProfileId);
  // Clean ANTHROPIC_* slate first so a key in the user's global shell env can't
  // leak into every tab — each tab then gets exactly its profile's creds
  // (subscription = none → login). `env -u` on an unset var is a harmless no-op.
  const ANTHROPIC_UNSET = [
    '-u',
    'ANTHROPIC_API_KEY',
    '-u',
    'ANTHROPIC_BASE_URL',
    '-u',
    'ANTHROPIC_AUTH_TOKEN',
    '-u',
    'ANTHROPIC_MODEL',
  ];

  // Prefer tmux so the CLI session survives app restarts / pane remounts.
  // `new-session -A` attaches to an existing session with the same name or
  // creates it — which gives us free resume-on-reopen.
  if (tmuxBin && claudeBin) {
    const sessionName = tmuxSessionName(cfg, 'cli', opts.projectId, tabId);
    // Same precedence PtyPool uses for the client env (shell env, then
    // process env, then default) so a user override still wins. These must
    // ALSO ride inside the session command: when the tmux SERVER is already
    // running, the command spawned by `new-session` inherits the server's
    // env, not the client's — so in steady state claude would launch
    // without agent teams and with a stale DEVSPACE_PROJECT_ID.
    const teams =
      env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS ??
      process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS ??
      '1';
    const backend =
      env.CLAUDE_CODE_SPAWN_BACKEND ??
      process.env.CLAUDE_CODE_SPAWN_BACKEND ??
      'tmux';
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
        // `env VAR=… claude` instead of `new-session -e` — `-e` is missing
        // on older tmux and we have no version detection. tmux execs this
        // multi-arg command via execvp (no shell), so no quoting needed,
        // and when -A attaches to an existing session the trailing command
        // (wrapper included) is ignored entirely.
        'env',
        ...ANTHROPIC_UNSET,
        `DEVSPACE_PROJECT_ID=${opts.projectId}`,
        `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=${teams}`,
        `CLAUDE_CODE_SPAWN_BACKEND=${backend}`,
        ...authPairs,
        claudeBin,
        ...claudeArgs,
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
      // Always `env`-wrap (even subscription) to clear inherited ANTHROPIC_*
      // first, then apply the profile's vars — no tmux wrapper to ride on here.
      command: '/usr/bin/env',
      args: [...ANTHROPIC_UNSET, ...authPairs, claudeBin, ...claudeArgs],
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

export interface OpenCodeLaunchOptions {
  projectId: string;
  tabId?: string;
  cwd: string;
  cols?: number;
  rows?: number;
  /** CliProfile id for a custom provider config (omit = the user's own config). */
  cliProfileId?: string;
}

/**
 * Start (or reuse) an OpenCode TUI PTY session for a project tab. OpenCode runs
 * as an interactive terminal app, so this mirrors launchClaudeCli's tmux-backed
 * approach (resume-on-reopen) but spawns the `opencode` binary. Falls back to a
 * shell hint if opencode isn't installed.
 */
export async function launchOpenCodeCli(
  opts: OpenCodeLaunchOptions,
): Promise<PtySession> {
  const tabId = opts.tabId ?? 'default';
  const existing = getSession(opts.projectId, 'opencode-cli', tabId);
  if (existing) return existing;

  const ocBin = await findOnPath('opencode');
  const cfg = await loadTmuxConfig();
  const tmuxBin = cfg.enabled ? await resolveTmuxBinary() : null;
  const env = await resolveInteractiveShellEnv();
  const shell = env.SHELL ?? process.env.SHELL ?? '/bin/zsh';

  // Always materialize a DevSpace opencode config (merged over the user's own):
  // injects the MemPalace MCP brain, plus a custom provider when one is chosen.
  // Re-materialized each launch (idempotent) so edits take effect.
  const profile = opts.cliProfileId
    ? await getCliProfile(opts.cliProfileId)
    : null;
  const { configDir } = await ensureOpenCodeConfig(
    profile && profile.cliId === 'opencode' ? profile : null,
    opts.cwd,
  );
  const configEnv = ['env', `OPENCODE_CONFIG_DIR=${configDir}`];

  if (tmuxBin && ocBin) {
    const sessionName = tmuxSessionName(cfg, 'oc', opts.projectId, tabId);
    logger.info(
      `tmux-backed opencode for project=${opts.projectId} tab=${tabId} (${sessionName})`,
    );
    return createPty({
      projectId: opts.projectId,
      kind: 'opencode-cli',
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
        ...configEnv,
        ocBin,
      ],
      cols: opts.cols,
      rows: opts.rows,
    });
  }

  if (ocBin) {
    logger.info(`spawning opencode (${ocBin}) without tmux`);
    return createPty({
      projectId: opts.projectId,
      kind: 'opencode-cli',
      tabId,
      cwd: opts.cwd,
      command: '/usr/bin/env',
      args: [`OPENCODE_CONFIG_DIR=${configDir}`, ocBin],
      cols: opts.cols,
      rows: opts.rows,
    });
  }

  logger.warn('opencode binary not found on PATH — starting shell with a hint');
  const hintCmd = `echo "⚠️  'opencode' not found on PATH. Install OpenCode: https://opencode.ai" && exec ${shell} -l`;
  return createPty({
    projectId: opts.projectId,
    kind: 'opencode-cli',
    tabId,
    cwd: opts.cwd,
    command: shell,
    args: ['-l', '-c', hintCmd],
    cols: opts.cols,
    rows: opts.rows,
  });
}

export interface PlainTuiLaunchOptions {
  projectId: string;
  tabId?: string;
  cwd: string;
  cols?: number;
  rows?: number;
}

/**
 * Start (or reuse) a plain TUI CLI (Codex, Gemini) in a tmux-backed PTY. These
 * run interactively against their own config/auth — no DevSpace per-profile
 * config injection (unlike OpenCode/Claude). Falls back to a shell hint when the
 * binary isn't installed, so the pane stays usable.
 */
async function launchPlainTuiCli(
  kind: PtySessionKind,
  binName: string,
  tmuxPrefix: string,
  installUrl: string,
  extraArgs: string[],
  opts: PlainTuiLaunchOptions,
): Promise<PtySession> {
  const tabId = opts.tabId ?? 'default';
  const existing = getSession(opts.projectId, kind, tabId);
  if (existing) return existing;

  const bin = await findOnPath(binName);
  const cfg = await loadTmuxConfig();
  const tmuxBin = cfg.enabled ? await resolveTmuxBinary() : null;
  const env = await resolveInteractiveShellEnv();
  const shell = env.SHELL ?? process.env.SHELL ?? '/bin/zsh';

  if (tmuxBin && bin) {
    const sessionName = tmuxSessionName(cfg, tmuxPrefix, opts.projectId, tabId);
    logger.info(
      `tmux-backed ${binName} for project=${opts.projectId} tab=${tabId} (${sessionName})`,
    );
    return createPty({
      projectId: opts.projectId,
      kind,
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
        bin,
        ...extraArgs,
      ],
      cols: opts.cols,
      rows: opts.rows,
    });
  }

  if (bin) {
    logger.info(`spawning ${binName} (${bin}) without tmux`);
    return createPty({
      projectId: opts.projectId,
      kind,
      tabId,
      cwd: opts.cwd,
      command: bin,
      args: extraArgs,
      cols: opts.cols,
      rows: opts.rows,
    });
  }

  logger.warn(`${binName} not found on PATH — starting shell with a hint`);
  const hintCmd = `echo "⚠️  '${binName}' not found on PATH. Install: ${installUrl}" && exec ${shell} -l`;
  return createPty({
    projectId: opts.projectId,
    kind,
    tabId,
    cwd: opts.cwd,
    command: shell,
    args: ['-l', '-c', hintCmd],
    cols: opts.cols,
    rows: opts.rows,
  });
}

export async function launchCodexCli(
  opts: PlainTuiLaunchOptions,
): Promise<PtySession> {
  // MemPalace brain (config) + global guidance (auto-memory + rtk) before launch.
  await ensureCodexParity();
  return launchPlainTuiCli(
    'codex-cli',
    'codex',
    'cx',
    'https://github.com/openai/codex',
    [],
    opts,
  );
}

export async function launchGeminiCli(
  opts: PlainTuiLaunchOptions,
): Promise<PtySession> {
  await ensureGeminiParity();
  // --skip-trust trusts this project for the session so the MemPalace MCP is
  // enabled (Gemini disables MCP in untrusted folders). Same trust boundary as
  // Claude's --dangerously-skip-permissions — the user chose to open it here.
  return launchPlainTuiCli(
    'gemini-cli',
    'gemini',
    'gm',
    'https://github.com/google-gemini/gemini-cli',
    ['--skip-trust'],
    opts,
  );
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
        // Same env-wrapper rationale as launchClaudeCli: against a running
        // tmux server the session command inherits the SERVER env, so
        // DEVSPACE_PROJECT_ID would be stale/missing without this.
        'env',
        `DEVSPACE_PROJECT_ID=${opts.projectId}`,
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
