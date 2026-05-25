import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// fs.ts imports electron (ipcMain/shell) at module top and subscribes to
// FileWatcherService.onAnyChange at import time. We stub both so the module
// loads without an Electron app context, and capture the change callback the
// list cache registers so we can simulate a filesystem-watcher notification.
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, fn);
    },
  },
  shell: { trashItem: vi.fn(), showItemInFolder: vi.fn() },
}));

// Keep FS_READ_FILE inside the tmp workspace without standing up
// WorkspaceService: assertInWorkspace just resolves + scope-checks the path.
let workspaceRoot = '';
vi.mock('@main/utils/pathScope', async () => {
  const nodePath = await import('node:path');
  const nodeFs = await import('node:fs');
  return {
    assertInWorkspace: async (p: string) => {
      const resolved = nodePath.resolve(p);
      if (
        resolved !== workspaceRoot &&
        !resolved.startsWith(workspaceRoot + nodePath.sep)
      ) {
        throw new Error(`path outside workspace: ${p}`);
      }
      return resolved;
    },
    assertRegularFile: async (p: string) => {
      const lst = await nodeFs.promises.lstat(p);
      if (!lst.isFile()) throw new Error(`refusing non-regular file: ${p}`);
      return lst;
    },
  };
});

const watcherRef = vi.hoisted(() => ({
  cb: null as ((rootKey: string) => void) | null,
}));
vi.mock('@main/services/FileWatcherService', () => ({
  onAnyChange: (cb: (rootKey: string) => void) => {
    watcherRef.cb = cb;
    return () => {
      watcherRef.cb = null;
    };
  },
  subscribeWatch: vi.fn(),
  unsubscribeWatch: vi.fn(),
}));

import { IPC } from '@shared/ipc-channels';

import {
  __getFsListWalkCountForTests,
  __invalidateFsListCacheForTests,
  __resetFsListCacheForTests,
  listFilesCached,
  registerFsIpc,
} from '@main/ipc/fs';

let tmp = '';

async function seedTree(root: string): Promise<void> {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a.ts'), 'a');
  await writeFile(path.join(root, 'src', 'b.ts'), 'b');
  await writeFile(path.join(root, 'README.md'), '# readme');
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'fs-list-cache-'));
  workspaceRoot = path.resolve(tmp);
  await seedTree(tmp);
  __resetFsListCacheForTests();
});

afterEach(async () => {
  __resetFsListCacheForTests();
  await rm(tmp, { recursive: true, force: true });
});

describe('FS_LIST_FILES walk cache', () => {
  it('returns identical results on first and cached calls', async () => {
    const first = await listFilesCached(tmp);
    const second = await listFilesCached(tmp);
    expect(second).toEqual(first);
    expect(first.sort()).toEqual(['README.md', 'src/a.ts', 'src/b.ts']);
  });

  it('second call within TTL reuses the cache without re-walking', async () => {
    await listFilesCached(tmp);
    expect(__getFsListWalkCountForTests()).toBe(1);
    await listFilesCached(tmp);
    // No second walk — served from cache.
    expect(__getFsListWalkCountForTests()).toBe(1);
  });

  it('a filesystem mutation invalidates the cache and forces a re-walk', async () => {
    await listFilesCached(tmp);
    expect(__getFsListWalkCountForTests()).toBe(1);

    // Simulate what the FS write/create/rename/delete/duplicate handlers do.
    await writeFile(path.join(tmp, 'src', 'c.ts'), 'c');
    __invalidateFsListCacheForTests(path.join(tmp, 'src', 'c.ts'));

    const after = await listFilesCached(tmp);
    expect(__getFsListWalkCountForTests()).toBe(2);
    expect(after.sort()).toEqual([
      'README.md',
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
    ]);
  });

  it('a FileWatcher change notification invalidates the cache', async () => {
    await listFilesCached(tmp);
    expect(__getFsListWalkCountForTests()).toBe(1);
    expect(watcherRef.cb).toBeTypeOf('function');

    // The watcher reports the resolved root key on each debounced flush.
    watcherRef.cb!(path.resolve(tmp));

    await listFilesCached(tmp);
    expect(__getFsListWalkCountForTests()).toBe(2);
  });

  it('TTL expiry forces a re-walk', async () => {
    vi.useFakeTimers();
    try {
      await listFilesCached(tmp);
      expect(__getFsListWalkCountForTests()).toBe(1);
      // Within TTL — cached.
      vi.advanceTimersByTime(3000);
      await listFilesCached(tmp);
      expect(__getFsListWalkCountForTests()).toBe(1);
      // Past the 4000ms TTL — re-walk.
      vi.advanceTimersByTime(2000);
      await listFilesCached(tmp);
      expect(__getFsListWalkCountForTests()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('FS_READ_FILE size cap raised to 25 MB (FIX 2)', () => {
  const CAP = 25 * 1024 * 1024;

  async function readViaHandler(filePath: string): Promise<string> {
    registerFsIpc();
    const handler = ipcHandlers.get(IPC.FS_READ_FILE);
    if (!handler) throw new Error('FS_READ_FILE handler not registered');
    return (await handler({}, filePath)) as string;
  }

  it('reads a file exactly at the 25 MB cap', async () => {
    const big = path.join(tmp, 'at-cap.txt');
    // Fill with a single byte repeated to exactly CAP bytes.
    await writeFile(big, Buffer.alloc(CAP, 0x61));
    const text = await readViaHandler(big);
    expect(text.length).toBe(CAP);
  });

  it('throws above the cap with a message stating the 25 MB limit', async () => {
    const tooBig = path.join(tmp, 'over-cap.txt');
    await writeFile(tooBig, Buffer.alloc(CAP + 1, 0x62));
    await expect(readViaHandler(tooBig)).rejects.toThrow(/25 MB/);
  });
});
