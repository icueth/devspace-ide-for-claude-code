import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Resolves absolute paths into the bundled `builtin-packs/` directory that
// ships agents (30+) and skills (180+) inside the .app so a fresh install
// is never empty. Same pattern as designResourcePaths.ts — packaged build
// reads from process.resourcesPath (mapped by electron-builder
// extraResources), dev reads from the repo's resources/ dir.

let cachedBuiltinPacksDir: string | null = null;

export function getBuiltinPacksDir(): string {
  if (cachedBuiltinPacksDir !== null) {
    return cachedBuiltinPacksDir;
  }
  cachedBuiltinPacksDir = app.isPackaged
    ? path.join(process.resourcesPath, 'builtin-packs')
    : path.join(app.getAppPath(), 'resources', 'builtin-packs');
  return cachedBuiltinPacksDir;
}

export function getBuiltinAgentsDir(): string {
  return path.join(getBuiltinPacksDir(), 'agents');
}

export function getBuiltinSkillsDir(): string {
  return path.join(getBuiltinPacksDir(), 'skills');
}

// Best-effort existence check — packaged builds always have it (the dmg
// would not build without resources/builtin-packs/), but in dev a fresh
// clone may not have run the curation step yet. Callers degrade by
// skipping the builtin scope entirely when this returns false.
export async function builtinPacksExist(): Promise<boolean> {
  const dir = getBuiltinPacksDir();
  try {
    await fs.promises.access(dir, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
