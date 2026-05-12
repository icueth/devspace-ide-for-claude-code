import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Resolves the absolute path to the bundled `design-packs/` directory.
 *
 * - In a packaged Electron app, the bundle is placed under
 *   `process.resourcesPath` by electron-builder's `extraResources` config
 *   (on macOS that maps to `<App>.app/Contents/Resources/design-packs`).
 * - In development (`pnpm dev`), the bundle is read from the repo at
 *   `<appPath>/resources/design-packs`.
 *
 * The resolved path is cached on first call.
 */
let cachedDesignPacksDir: string | null = null;

export function getBuiltinDesignPacksDir(): string {
  if (cachedDesignPacksDir !== null) {
    return cachedDesignPacksDir;
  }

  cachedDesignPacksDir = app.isPackaged
    ? path.join(process.resourcesPath, 'design-packs')
    : path.join(app.getAppPath(), 'resources', 'design-packs');

  return cachedDesignPacksDir;
}

/**
 * Returns true if the bundled design-packs directory is present on disk.
 *
 * Does not throw — returns false on ENOENT (or any other access error) so
 * callers can degrade gracefully when the bundle is missing.
 */
export async function designPacksExist(): Promise<boolean> {
  const dir = getBuiltinDesignPacksDir();
  try {
    await fs.promises.access(dir, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
