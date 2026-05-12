import { ipcMain, shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  subscribeWatch,
  unsubscribeWatch,
} from '@main/services/FileWatcherService';
import { atomicWriteAsync } from '@main/utils/atomicWrite';
import {
  assertInWorkspace,
  assertRegularFile,
} from '@main/utils/pathScope';
import { IPC } from '@shared/ipc-channels';
import { createLogger } from '@shared/logger';
import type { DirEntry } from '@shared/types';

const logger = createLogger('IPC:fs');

const MAX_READ_BYTES = 5 * 1024 * 1024; // 5MB cap for text reads — binary has a larger cap.
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
    return entries
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
  });

  ipcMain.handle(IPC.FS_READ_FILE, async (_e, absPath: string): Promise<string> => {
    const safe = await assertInWorkspace(absPath);
    const stat = await assertRegularFile(safe);
    if (stat.size > MAX_READ_BYTES) {
      throw new Error(
        `File too large (${stat.size} bytes > ${MAX_READ_BYTES}). Large-file support is a later milestone.`,
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
    return true;
  });

  ipcMain.handle(
    IPC.FS_LIST_FILES,
    async (_e, cwd: string): Promise<string[]> => {
      const safe = await assertInWorkspace(cwd);
      return listFiles(safe);
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
      return safe;
    },
  );

  ipcMain.handle(
    IPC.FS_RENAME,
    async (_e, src: string, dest: string): Promise<string> => {
      const safeSrc = await assertInWorkspace(src);
      const safeDest = await assertInWorkspace(dest);
      await fs.promises.rename(safeSrc, safeDest);
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

async function listFiles(cwd: string, maxFiles = 20_000): Promise<string[]> {
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
