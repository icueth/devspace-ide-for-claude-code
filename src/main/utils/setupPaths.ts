import { app } from 'electron';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

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
    path.join(home, '.local', 'bin'), // Claude installer, uv tool entry points, agy
    path.join(home, '.opencode', 'bin'), // OpenCode curl installer
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

const execFileP = promisify(execFile);

/**
 * Find an executable by name, robustly — independent of the GUI process's
 * minimal launchd PATH (which a bare `which` inherits, so it misses CLIs in
 * /opt/homebrew/bin, ~/.local/bin, ~/.opencode/bin, …). Checks the well-known
 * install dirs first (instant), then `which`/`where` with an enriched PATH
 * (covers nvm/custom dirs). Returns the absolute path or null.
 */
export async function findExecutable(name: string): Promise<string | null> {
  for (const dir of commonBinPaths()) {
    const full = path.join(dir, name);
    try {
      if (fs.statSync(full).isFile()) return full;
    } catch {
      // try the next dir
    }
  }
  try {
    const { stdout } = await execFileP(
      process.platform === 'win32' ? 'where' : 'which',
      [name],
      {
        timeout: 3000,
        env: { ...process.env, PATH: enrichedPath() },
        maxBuffer: 16 * 1024,
      },
    );
    return stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? null;
  } catch {
    return null;
  }
}
