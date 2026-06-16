import { app } from 'electron';
import * as os from 'node:os';
import * as path from 'node:path';

import { getClaudeDir, getClaudeSettingsFile } from './mempalacePaths';

/**
 * Common path helpers for the Setup wizard. Mirrors the structure of
 * mempalacePaths.ts so the renderer can render absolute paths the same way
 * (~/.claude/..., ~/Code/..., etc.).
 */

// Single source of truth lives in mempalacePaths.ts — re-exported here so
// existing setupPaths importers keep their import path.
export { getClaudeDir, getClaudeSettingsFile };

function resourcesRoot(): string {
  return app.isPackaged
    ? process.resourcesPath
    : path.join(app.getAppPath(), 'resources');
}

export function getBundledSetupHooksDir(): string {
  return path.join(resourcesRoot(), 'setup-hooks');
}

export function getBundledRtkHookFile(): string {
  return path.join(getBundledSetupHooksDir(), 'rtk-rewrite.sh');
}

/**
 * Source dir for the native-learning hook scripts. Mirrors the mempalace /
 * setup-hooks resolution: packaged build reads from process.resourcesPath
 * (mapped via electron-builder extraResources `to: "learning-hooks"`), dev
 * reads from the repo's resources/learning-hooks/.
 */
export function getBundledLearningHooksDir(): string {
  return path.join(resourcesRoot(), 'learning-hooks');
}

/** Bundled SessionStart hook — injects distilled learnings into each session. */
export function getBundledLearningsHookFile(): string {
  return path.join(getBundledLearningHooksDir(), 'devspace-learnings.mjs');
}

/** Bundled Stop hook — auto-distills learnings on terminal session end. */
export function getBundledDistillHookFile(): string {
  return path.join(getBundledLearningHooksDir(), 'devspace-distill-stop.mjs');
}

export function getClaudeHooksDir(): string {
  return path.join(getClaudeDir(), 'hooks');
}

export function getInstalledRtkHookFile(): string {
  return path.join(getClaudeHooksDir(), 'rtk-rewrite.sh');
}

export function getInstalledLearningsHookFile(): string {
  return path.join(getClaudeHooksDir(), 'devspace-learnings.mjs');
}

export function getInstalledDistillHookFile(): string {
  return path.join(getClaudeHooksDir(), 'devspace-distill-stop.mjs');
}

/**
 * Common PATH segments where the tools we detect live, in priority order.
 * Used both for `which`-style detection and to enrich the env when spawning
 * `brew install`-style children that may have been launched outside a login
 * shell (Electron's default).
 */
export function commonBinPaths(): string[] {
  const home = os.homedir();
  return [
    '/opt/homebrew/bin', // Apple Silicon Homebrew
    '/opt/homebrew/sbin',
    '/usr/local/bin', // Intel Homebrew + curl/install.sh default
    '/usr/local/sbin',
    path.join(home, '.local', 'bin'), // Claude installer, uv tool entry points
    path.join(home, '.cargo', 'bin'),
    '/usr/bin',
    '/bin',
  ];
}

export function enrichedPath(): string {
  const existing = process.env.PATH ?? '';
  const segments = commonBinPaths();
  const have = new Set(existing.split(':').filter(Boolean));
  const extras = segments.filter((s) => !have.has(s));
  return [existing, ...extras].filter(Boolean).join(':');
}
