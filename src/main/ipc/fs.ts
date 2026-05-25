import { ipcMain, shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  onAnyChange,
  subscribeWatch,
  unsubscribeWatch,
} from '@main/services/FileWatcherService';
import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { capDirEntries } from '@main/utils/dirEntries';
import {
  assertInWorkspace,
  assertRegularFile,
} from '@main/utils/pathScope';
import { IPC } from '@shared/ipc-channels';
import { createLogger } from '@shared/logger';
import type { DirEntry } from '@shared/types';

const logger = createLogger('IPC:fs');

// 25MB cap for text reads — CodeMirror 6 handles documents this size. Binary
// has its own larger cap below. (Streaming / head-load for >25MB is a deferred
// feature.)
const MAX_READ_BYTES = 25 * 1024 * 1024;
const MAX_BINARY_BYTES = 50 * 1024 * 1024; // 50MB for images / PDFs.

// Always hide — noisy/huge and never useful to open from the tree.
const ALWAYS_HIDE = new Set(['.git', '.DS_Store', 'Thumbs.db']);

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  heic: 'image/heic',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  pdf: 'application/pdf',
};

function mimeForPath(p: string): string {
  const ext = p.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

function isIgnored(name: string): boolean {
  return ALWAYS_HIDE.has(name);
}

export function registerFsIpc(): void {
  ipcMain.handle(IPC.FS_READ_DIR, async (_e, absPath: string): Promise<DirEntry[]> => {
    const safe = await assertInWorkspace(absPath);
    const entries = await fs.promises.readdir(safe, { withFileTypes: true });
    const mapped = entries
      .filter((e) => !isIgnored(e.name))
      .map((e) => ({
        name: e.name,
        path: path.join(safe, e.name),
        isDirectory: e.isDirectory(),
        isSymlink: e.isSymbolicLink(),
      }))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    // Bound the listing — a non-virtualized tree freezes the renderer past a few
    // thousand rows (e.g. expanding node_modules/.pnpm). Browsable, not hidden.
    return capDirEntries(mapped, safe);
  });

  ipcMain.handle(IPC.FS_READ_FILE, async (_e, absPath: string): Promise<string> => {
    const safe = await assertInWorkspace(absPath);
    const stat = await assertRegularFile(safe);
    if (stat.size > MAX_READ_BYTES) {
      throw new Error(
        `File too large to open: ${stat.size} bytes exceeds the ${MAX_READ_BYTES}-byte (25 MB) text-editor limit.`,
      );
    }
    return fs.promises.readFile(safe, 'utf8');
  });

  ipcMain.handle(
    IPC.FS_READ_BINARY,
    async (_e, absPath: string): Promise<{ mime: string; base64: string; size: number }> => {
      const safe = await assertInWorkspace(absPath);
      const stat = await assertRegularFile(safe);
      if (stat.size > MAX_BINARY_BYTES) {
        throw new Error(
          `File too large (${stat.size} bytes > ${MAX_BINARY_BYTES}).`,
        );
      }
      const buf = await fs.promises.readFile(safe);
      const mime = mimeForPath(safe);
      return { mime, base64: buf.toString('base64'), size: stat.size };
    },
  );

  ipcMain.handle(IPC.FS_WRITE_FILE, async (_e, absPath: string, data: string) => {
    if (typeof data !== 'string') {
      throw new Error('FS_WRITE_FILE expects UTF-8 string data');
    }
    const safe = await assertInWorkspace(absPath);
    try {
      await atomicWriteAsync(safe, data);
    } catch (err) {
      logger.error(`write failed for ${safe}:`, (err as Error).message);
      throw err;
    }
    invalidateListCacheFor(safe);
    return true;
  });

  ipcMain.handle(
    IPC.FS_LIST_FILES,
    async (_e, cwd: string): Promise<string[]> => {
      const safe = await assertInWorkspace(cwd);
      return listFilesCached(safe);
    },
  );

  ipcMain.handle(
    IPC.FS_CREATE,
    async (_e, absPath: string, kind: 'file' | 'folder'): Promise<string> => {
      const safe = await assertInWorkspace(absPath);
      if (kind === 'folder') {
        await fs.promises.mkdir(safe, { recursive: false });
      } else {
        await fs.promises.mkdir(path.dirname(safe), { recursive: true });
        // Fail if it exists so the UI can surface a clear error.
        const fh = await fs.promises.open(safe, 'wx');
        await fh.close();
      }
      invalidateListCacheFor(safe);
      return safe;
    },
  );

  ipcMain.handle(
    IPC.FS_RENAME,
    async (_e, src: string, dest: string): Promise<string> => {
      const safeSrc = await assertInWorkspace(src);
      const safeDest = await assertInWorkspace(dest);
      await fs.promises.rename(safeSrc, safeDest);
      invalidateListCacheFor(safeSrc);
      invalidateListCacheFor(safeDest);
      return safeDest;
    },
  );

  ipcMain.handle(IPC.FS_DELETE, async (_e, absPath: string): Promise<void> => {
    const safe = await assertInWorkspace(absPath);
    try {
      await shell.trashItem(safe);
    } catch (err) {
      logger.warn(`trashItem failed, falling back to rm -rf: ${(err as Error).message}`);
      await fs.promises.rm(safe, { recursive: true, force: true });
    }
    invalidateListCacheFor(safe);
  });

  ipcMain.handle(
    IPC.FS_DUPLICATE,
    async (_e, absPath: string): Promise<string> => {
      const safe = await assertInWorkspace(absPath);
      const dir = path.dirname(safe);
      const base = path.basename(safe);
      const dot = base.indexOf('.');
      const stem = dot > 0 ? base.slice(0, dot) : base;
      const extOnly = dot > 0 ? base.slice(dot) : '';
      let candidate = `${stem} copy${extOnly}`;
      let n = 2;
      while (fs.existsSync(path.join(dir, candidate))) {
        candidate = `${stem} copy ${n++}${extOnly}`;
        if (n > 100) break;
      }
      const dest = path.join(dir, candidate);
      await fs.promises.cp(safe, dest, { recursive: true });
      invalidateListCacheFor(dest);
      return dest;
    },
  );

  ipcMain.handle(IPC.FS_REVEAL, async (_e, absPath: string): Promise<void> => {
    const safe = await assertInWorkspace(absPath);
    shell.showItemInFolder(safe);
  });

  ipcMain.handle(IPC.FS_WATCH, async (event, root: string, enable: boolean) => {
    const safe = await assertInWorkspace(root);
    if (enable) subscribeWatch(safe, event.sender);
    else unsubscribeWatch(safe, event.sender);
  });
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-electron',
  'out',
  'build',
  'target',
  '.next',
  '.turbo',
  '.cache',
  '.idea',
  '.vscode',
  'release',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
]);

// ─── FS_LIST_FILES walk cache ───────────────────────────────────────────────
//
// listFiles recursively walks the whole project tree (capped at 20k entries)
// and the renderer re-runs it UNCACHED on every Cmd+P / Cmd+K / @-mention open.
// On large repos that floods the libuv pool and makes concurrent reads sluggish.
// We cache the walk result per resolved root and invalidate on BOTH:
//   (a) a short TTL (LIST_CACHE_TTL_MS), and
//   (b) filesystem mutations — the FS write/create/rename/delete/duplicate
//       handlers above call invalidateListCacheFor(), and FileWatcherService's
//       onAnyChange hook clears the entry for any root reporting a change.
const LIST_CACHE_TTL_MS = 4000;

interface ListCacheEntry {
  result: string[];
  expires: number;
}

const listCache = new Map<string, ListCacheEntry>();

function listCacheKey(root: string): string {
  return path.resolve(root);
}

// Drop any cached walk whose root contains (or equals) the mutated path.
// We can't know which root a mutated file belongs to without scanning the
// cache, so clear every cached root that is an ancestor of (or equal to) the
// mutated path. Cheap: the cache holds at most a handful of open workspaces.
function invalidateListCacheFor(mutatedPath: string): void {
  const resolved = path.resolve(mutatedPath);
  for (const key of Array.from(listCache.keys())) {
    if (resolved === key || resolved.startsWith(key + path.sep)) {
      listCache.delete(key);
    }
  }
}

// FileWatcher reports the resolved root key directly — drop that exact entry.
const unsubscribeListCacheWatch = onAnyChange((rootKey) => {
  listCache.delete(path.resolve(rootKey));
});
// Referenced so lint/tsc don't flag it as unused; the subscription lives for
// the process lifetime, but exposing the unsubscribe keeps the API symmetric.
void unsubscribeListCacheWatch;

// Exported for unit tests; the IPC handler is the production caller.
export async function listFilesCached(cwd: string): Promise<string[]> {
  const key = listCacheKey(cwd);
  const now = Date.now();
  const hit = listCache.get(key);
  if (hit && hit.expires > now) {
    return hit.result;
  }
  const result = await listFiles(cwd);
  listCache.set(key, { result, expires: now + LIST_CACHE_TTL_MS });
  return result;
}

// Test-observable counter: incremented once per *actual* tree walk (cache
// miss). A cache hit returns without bumping it, so tests can assert that a
// second call within the TTL did not re-walk.
let listWalkCount = 0;

/** Test-only: clear the FS_LIST_FILES walk cache + walk counter between cases. */
export function __resetFsListCacheForTests(): void {
  listCache.clear();
  listWalkCount = 0;
}

/** Test-only: number of real tree walks performed since the last reset. */
export function __getFsListWalkCountForTests(): number {
  return listWalkCount;
}

/** Test-only: exercise the same cache-invalidation path the FS mutation
 *  handlers (write/create/rename/delete/duplicate) use. */
export function __invalidateFsListCacheForTests(mutatedPath: string): void {
  invalidateListCacheFor(mutatedPath);
}

async function listFiles(cwd: string, maxFiles = 20_000): Promise<string[]> {
  listWalkCount += 1;
  const results: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    if (results.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      if (entry.name.startsWith('.') && entry.name !== '.env' && entry.name !== '.gitignore') {
        if (entry.isDirectory()) continue;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(`${dir}/${entry.name}`, rel ? `${rel}/${entry.name}` : entry.name);
      } else if (entry.isFile()) {
        results.push(rel ? `${rel}/${entry.name}` : entry.name);
      }
    }
  }
  await walk(cwd, '');
  return results;
}
