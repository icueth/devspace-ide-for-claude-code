import { app } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Resolves absolute paths into the bundled `mempalace-uv/<platform>/` and
 * `mempalace-hooks/` directories. Same shape as builtinPackPaths.ts —
 * packaged build reads from process.resourcesPath (mapped via
 * electron-builder extraResources), dev reads from resources/.
 */

let cachedUvDir: string | null = null;
let cachedHooksSrcDir: string | null = null;

function resourcesRoot(): string {
  return app.isPackaged
    ? process.resourcesPath
    : path.join(app.getAppPath(), 'resources');
}

function platformKey(): string {
  const p = process.platform;
  const a = process.arch;
  if (p === 'darwin' && a === 'arm64') return 'darwin-arm64';
  if (p === 'darwin' && a === 'x64') return 'darwin-x64';
  if (p === 'linux' && a === 'x64') return 'linux-x64';
  if (p === 'win32' && a === 'x64') return 'win32-x64';
  // Unsupported host — return a slug that will fail the existence check below
  // with a clear message instead of a binary launch error.
  return `${p}-${a}`;
}

export function getBundledUvDir(): string {
  if (cachedUvDir !== null) return cachedUvDir;
  cachedUvDir = path.join(resourcesRoot(), 'mempalace-uv', platformKey());
  return cachedUvDir;
}

export function getBundledUvBinary(): string {
  const exe = process.platform === 'win32' ? 'uv.exe' : 'uv';
  return path.join(getBundledUvDir(), exe);
}

export function bundledUvExists(): boolean {
  try {
    return fs.statSync(getBundledUvBinary()).isFile();
  } catch {
    return false;
  }
}

export function getBundledHooksDir(): string {
  if (cachedHooksSrcDir !== null) return cachedHooksSrcDir;
  cachedHooksSrcDir = path.join(resourcesRoot(), 'mempalace-hooks');
  return cachedHooksSrcDir;
}

/**
 * Where the installed `mempalace` console script ends up after
 * `uv tool install mempalace`. uv puts tool entry-points under
 * `~/.local/bin` on Unix and `%APPDATA%\\uv\\tools\\bin` (or
 * `%USERPROFILE%\\.local\\bin` since 0.5.x) on Windows.
 */
export function getUvToolBinDir(): string {
  if (process.platform === 'win32') {
    // uv on Windows installs tool entry-points to %USERPROFILE%\.local\bin
    // as of 0.5.x. The legacy %APPDATA%\\uv\\bin path is also supported by
    // uv's PATH integration; we point at the modern location.
    return path.join(os.homedir(), '.local', 'bin');
  }
  return path.join(os.homedir(), '.local', 'bin');
}

export function getClaudeDir(): string {
  return path.join(os.homedir(), '.claude');
}

export function getClaudeSettingsFile(): string {
  return path.join(getClaudeDir(), 'settings.json');
}

export function getInstalledHooksDir(): string {
  return path.join(getClaudeDir(), 'hooks');
}

export function getDefaultVaultDir(): string {
  // Mirrors the user's existing setup: ~/Code/AI/memory_vault. Falls back
  // to ~/.devspace/memory_vault on platforms where ~/Code is unlikely to
  // exist (Windows). The Memory tab UI exposes this as the default; the
  // user can override before pressing Install.
  if (process.platform === 'darwin' || process.platform === 'linux') {
    return path.join(os.homedir(), 'Code', 'AI', 'memory_vault');
  }
  return path.join(os.homedir(), '.devspace', 'memory_vault');
}
