/**
 * Shared types for the environment Setup wizard (Settings → Setup tab).
 *
 * Covers the developer-tools devspace orchestrates:
 *   • Homebrew  — package-manager prerequisite on macOS
 *   • Claude Code CLI — the actual AI agent
 *   • tmux      — used by team / multi-agent runners
 *   • rtk       — token-saving Bash-rewrite proxy
 *   • jq        — required by the rtk Claude Code hook
 *   • rtkHook   — ~/.claude/hooks/rtk-rewrite.sh + matching PreToolUse entry
 *   • learningHooks — ~/.claude/hooks/devspace-learnings.mjs (SessionStart)
 *                     + devspace-distill-stop.mjs (Stop) + matching entries
 *   • mempalace — checked via MemPalaceService.getStatus (no duplicate logic)
 */

export type SetupToolId =
  | 'brew'
  | 'claude'
  | 'tmux'
  | 'rtk'
  | 'jq'
  | 'rtkHook'
  | 'learningHooks'
  | 'mempalace'
  | 'opencode'
  | 'codex'
  | 'gemini'
  | 'antigravity';

export type SetupCheckState =
  /** Installed and verified. */
  | 'ok'
  /** Not installed — installer button enabled. */
  | 'missing'
  /** Detected on host but a known prerequisite is missing (e.g. brew). */
  | 'blocked'
  /** Platform not supported (e.g. brew on Windows). */
  | 'unsupported';

export interface SetupCheck {
  id: SetupToolId;
  label: string;
  description: string;
  state: SetupCheckState;
  /** Human-readable version string when detected. */
  version?: string;
  /** Absolute path to the detected binary or file (for display). */
  path?: string;
  /** True when this tool has a working in-app installer (button enabled). */
  installable: boolean;
  /** When state is 'blocked', the id of the missing prerequisite. */
  blockedBy?: SetupToolId;
  /** Optional extra (e.g. a non-Claude CLI) — excluded from setup 'complete'. */
  optional?: boolean;
}

export interface SetupStatus {
  /** True when every required tool is 'ok'. */
  complete: boolean;
  /** macOS, win32, linux. Currently only darwin has full installer support. */
  platform: NodeJS.Platform;
  checks: SetupCheck[];
}

export type SetupStage =
  | 'preflight'
  | 'install'
  | 'configure'
  | 'verify'
  | 'done'
  | 'error';

export interface SetupProgressEvent {
  toolId: SetupToolId | 'all';
  stage: SetupStage;
  message: string;
  done: boolean;
  error?: string;
}

export interface SetupInstallResult {
  ok: boolean;
  status: SetupStatus;
  error?: string;
}

/**
 * Result of starting a Claude-driven setup session. The renderer attaches
 * an xterm to `sessionId` via the regular PTY IPC channels (pty:data,
 * pty:write, pty:resize, pty:kill). When the user is signed-in and Claude
 * isn't installed, `ok` is false and `error` explains why.
 */
export interface SetupClaudeRunResult {
  ok: boolean;
  sessionId?: string;
  error?: string;
}
