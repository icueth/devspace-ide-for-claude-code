import chokidar, { type FSWatcher } from 'chokidar';
import type { WebContents } from 'electron';
import * as path from 'node:path';

import { markStale as markCodeflowStale } from '@main/services/CodeflowService';
import { IPC } from '@shared/ipc-channels';
import { createLogger } from '@shared/logger';

const logger = createLogger('FileWatcher');

const IGNORED = [
  /(^|[\\/])\.git([\\/]|$)/,
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])\.DS_Store$/,
  /(^|[\\/])dist([\\/]|$)/,
  /(^|[\\/])dist-electron([\\/]|$)/,
  /(^|[\\/])out([\\/]|$)/,
  /(^|[\\/])build([\\/]|$)/,
  /(^|[\\/])target([\\/]|$)/,
  /(^|[\\/])\.next([\\/]|$)/,
  /(^|[\\/])\.turbo([\\/]|$)/,
  /(^|[\\/])\.cache([\\/]|$)/,
  /(^|[\\/])coverage([\\/]|$)/,
  /(^|[\\/])\.venv([\\/]|$)/,
];

interface Entry {
  watcher: FSWatcher;
  subscribers: Set<WebContents>;
  pending: Set<string>;
  flushTimer: NodeJS.Timeout | null;
}

const watchers = new Map<string, Entry>();

function keyFor(root: string): string {
  return path.resolve(root);
}

export function subscribeWatch(root: string, wc: WebContents): void {
  const key = keyFor(root);
  let entry = watchers.get(key);
  if (!entry) {
    const watcher = chokidar.watch(key, {
      ignored: IGNORED,
      ignoreInitial: true,
      persistent: true,
      // Cap recursion so a workspace root containing thousands of nested
      // folders doesn't stall the main process during chokidar's initial
      // readdir sweep. 8 levels is well past the depth of any realistic
      // project layout — monorepo packages sit at 2-3, deep feature modules
      // rarely exceed 6.
      depth: 8,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 100 },
    });

    entry = { watcher, subscribers: new Set(), pending: new Set(), flushTimer: null };
    watchers.set(key, entry);

    const flush = () => {
      if (!entry) return;
      entry.flushTimer = null;
      if (entry.pending.size === 0) return;
      const dirs = Array.from(entry.pending);
      entry.pending.clear();
      for (const wc2 of entry.subscribers) {
        if (!wc2.isDestroyed()) {
          wc2.send(IPC.FS_WATCH_EVENT, { root: key, dirs });
        }
      }
      // Best-effort: tell codeflow that this project's analysis is now stale.
      // Codeflow's per-project state ignores the call when no analysis exists.
      try {
        markCodeflowStale(key);
      } catch {
        /* never let an observer crash the watcher */
      }
    };

    const queue = (changedPath: string) => {
      if (!entry) return;
      const dir = path.dirname(changedPath);
      entry.pending.add(dir);
      if (!entry.flushTimer) {
        entry.flushTimer = setTimeout(flush, 150);
      }
    };

    watcher.on('all', (event: string, changedPath: string) => {
      if (
        event === 'add' ||
        event === 'addDir' ||
        event === 'unlink' ||
        event === 'unlinkDir'
      ) {
        queue(changedPath);
      }
    });

    watcher.on('error', (err) => {
      logger.warn(`watcher error for ${key}:`, (err as Error).message);
    });

    logger.info(`watching ${key}`);
  }

  entry.subscribers.add(wc);
  const cleanup = () => unsubscribeWatch(root, wc);
  wc.once('destroyed', cleanup);
}

export function unsubscribeWatch(root: string, wc: WebContents): void {
  const key = keyFor(root);
  const entry = watchers.get(key);
  if (!entry) return;
  entry.subscribers.delete(wc);
  if (entry.subscribers.size === 0) {
    if (entry.flushTimer) clearTimeout(entry.flushTimer);
    void entry.watcher.close().catch(() => undefined);
    watchers.delete(key);
    logger.info(`stopped watching ${key}`);
  }
}

export function shutdownWatchers(): void {
  for (const [, e] of watchers) {
    if (e.flushTimer) clearTimeout(e.flushTimer);
    void e.watcher.close().catch(() => undefined);
  }
  watchers.clear();
}
