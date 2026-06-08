import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Resolves absolute paths into the bundled `graphify/<platform>/` directory.
 * Same shape as mempalacePaths.ts (uv): packaged build reads from
 * process.resourcesPath (mapped via electron-builder extraResources), dev
 * reads from resources/. The binary is a PyInstaller --onedir tree:
 *   resources/graphify/<platform>/graphify[.exe]  +  _internal/
 */

let cachedDir: string | null = null;

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
  return `${p}-${a}`;
}

export function getBundledGraphifyDir(): string {
  if (cachedDir !== null) return cachedDir;
  cachedDir = path.join(resourcesRoot(), 'graphify', platformKey());
  return cachedDir;
}

export function getBundledGraphifyBinary(): string {
  const exe = process.platform === 'win32' ? 'graphify.exe' : 'graphify';
  return path.join(getBundledGraphifyDir(), exe);
}

export function bundledGraphifyExists(): boolean {
  try {
    return fs.statSync(getBundledGraphifyBinary()).isFile();
  } catch {
    return false;
  }
}
