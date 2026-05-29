/**
 * Shared types for per-project Ruflo init (Settings → Setup tab).
 *
 * Phase 0 (global install) already lives in `setup.ts` as the `ruflo`
 * SetupCheck. This file covers the per-project layer: detecting whether
 * `npx ruflo init` has been run inside a given project, and driving the
 * init via a streaming progress channel.
 */

export interface RufloProjectStatus {
  projectPath: string;
  /** True when `.claude-flow/` exists at the project root. */
  initialized: boolean;
  /** Absolute path to `.claude-flow/` when found. */
  configDir?: string;
  /** True when `CLAUDE.md` exists at the project root. */
  hasClaudeMd?: boolean;
  /** True when `.claude/` exists at the project root. */
  hasClaudeDir?: boolean;
}

export type RufloInitStage = 'preflight' | 'install' | 'verify' | 'done' | 'error';

export interface RufloInitProgressEvent {
  projectPath: string;
  stage: RufloInitStage;
  message: string;
  done: boolean;
  error?: string;
}

export interface RufloInitResult {
  ok: boolean;
  status: RufloProjectStatus;
  error?: string;
}
