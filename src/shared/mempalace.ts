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
