/**
 * Shared types for the MemPalace installer (Memory tab in Settings).
 * Used by main service, IPC layer, preload bridge, and renderer UI.
 */

export type MemPalaceCheck =
  | 'uv'
  | 'mempalacePackage'
  | 'vault'
  | 'hooks'
  | 'plugin';

export type MemPalaceCheckState = 'ok' | 'missing' | 'unsupported';

export interface MemPalaceStatus {
  /** True only when every check above is 'ok'. */
  installed: boolean;
  checks: Record<MemPalaceCheck, MemPalaceCheckState>;
  /** Resolved paths for display (read-only — set by the user via install). */
  vaultPath: string;
  hooksDir: string;
  settingsFile: string;
  /** Platform support summary — false on hosts without a bundled uv binary. */
  hostSupported: boolean;
  /**
   * Where the `mempalace` executable was detected, when `checks.mempalacePackage === 'ok'`.
   * Surfaces the actual install (venv / pipx / uv tool / brew / pip --user) so the
   * Memory tab can show users that an existing install was respected.
   */
  mempalacePackagePath?: string;
}

export interface MemPalaceInstallInput {
  /** Optional override for the vault directory. */
  vaultPath?: string;
}

export interface MemPalaceUninstallInput {
  /** When false, also deletes the vault directory. Default true. */
  keepVault?: boolean;
}

export type MemPalaceStage =
  | 'preflight'
  | 'install-package'
  | 'vault'
  | 'hooks'
  | 'settings'
  | 'done'
  | 'error';

export interface MemPalaceProgressEvent {
  stage: MemPalaceStage;
  message: string;
  /** True when this is the final event for the in-flight job. */
  done: boolean;
  /** Set only when stage === 'error'. */
  error?: string;
}

export interface MemPalaceInstallResult {
  ok: boolean;
  status: MemPalaceStatus;
  error?: string;
}

export type CliMempalaceCliId = 'opencode' | 'codex' | 'gemini' | 'antigravity';

/** Per-CLI MemPalace wiring status, shown in Settings → Memory. */
export interface CliMempalaceWiring {
  cliId: CliMempalaceCliId;
  label: string;
  installed: boolean;
  /** MemPalace present in this CLI's config (OpenCode is auto on launch). */
  wired: boolean;
  detail: string;
}
