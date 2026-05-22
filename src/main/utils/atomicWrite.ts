import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const EPERM_MAX_RETRIES = 3;
const EPERM_RETRY_DELAY_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renameWithRetry(src: string, dest: string): Promise<void> {
  for (let attempt = 0; attempt <= EPERM_MAX_RETRIES; attempt++) {
    try {
      await fs.promises.rename(src, dest);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EXDEV') {
        await fs.promises.copyFile(src, dest);
        await fs.promises.unlink(src).catch(() => undefined);
        return;
      }
      if (code === 'EPERM' && attempt < EPERM_MAX_RETRIES) {
        await sleep(EPERM_RETRY_DELAY_MS * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
}

export interface AtomicWriteOpts {
  /**
   * File mode bits applied to the tmp write (inherited by the target on
   * rename). Pass `0o600` for credentials-bearing files so they're not
   * world-readable on shared systems.
   */
  mode?: number;
  /**
   * Directory mode bits applied to the parent mkdir. Pass `0o700` for
   * directories that should only be reachable by the owner.
   */
  dirMode?: number;
}

/**
 * Async atomic write: write to a tmp sibling then rename over the target.
 * Uses best-effort fsync and tolerates EXDEV/EPERM transient errors.
 *
 * Pass `mode: 0o600` for credential files (API keys, tokens). Default
 * mode is 0o666 & ~umask (typically 0o644 — world-readable).
 */
export async function atomicWriteAsync(
  targetPath: string,
  data: string,
  opts: AtomicWriteOpts = {},
): Promise<void> {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(dir, `.tmp.${randomUUID()}`);

  try {
    await fs.promises.mkdir(dir, {
      recursive: true,
      ...(opts.dirMode !== undefined ? { mode: opts.dirMode } : {}),
    });
    await fs.promises.writeFile(tmpPath, data, {
      encoding: 'utf8',
      ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
    });

    let fd: fs.promises.FileHandle | null = null;
    try {
      fd = await fs.promises.open(tmpPath, 'r+');
      await fd.sync();
    } catch {
      // fsync is best-effort.
    } finally {
      await fd?.close();
    }

    await renameWithRetry(tmpPath, targetPath);
  } catch (error) {
    await fs.promises.unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}
