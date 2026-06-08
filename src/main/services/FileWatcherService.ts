import chokidar, { type FSWatcher } from 'chokidar';
import type { WebContents } from 'electron';
import * as path from 'node:path';

import { WATCH_IGNORED } from '@main/utils/watchIgnore';
import { IPC } from '@shared/ipc-channels';
import { createLogger } from '@shared/logger';

const logger = createLogger('FileWatcher');

// Ignore policy lives in a pure module (testable without electron) and is shared
// with the tree-listing skip logic. We deliberately do NOT ignore `.claude/` or
// `.devspace/` — watching them refreshes the sidebar when codeflow drops docs.
const IGNORED = WATCH_IGNORED;

interface Entry {
  watcher: FSWatcher;
  subscribers: Set<WebContents>;
  pending: Set<string>;
  flushTimer: NodeJS.Timeout | null;
}

const watchers = new Map<string, Entry>();

// Lightweight observer hook so other main-process modules (e.g. the
// FS_LIST_FILES walk cache in ipc/fs.ts) can invalidate per-root state when
// the filesystem under a watched root changes. Intentionally minimal — does
// NOT alter the watch config or the renderer broadcast. Each callback receives
// the resolved root key whose contents changed.
type ChangeListener = (rootKey: string) => void;
const changeListeners = new Set<ChangeListener>();

/** Subscribe to "something under a watched root changed" notifications. Fires
 *  with the resolved root key on each debounced flush. Returns an unsubscribe
 *  function. Never throws into the watcher loop — observers are isolated. */
export function onAnyChange(cb: ChangeListener): () => void {
  changeListeners.add(cb);
  return () => changeListeners.delete(cb);
}

function notifyChange(rootKey: string): void {
  for (const cb of changeListeners) {
    try {
      cb(rootKey);
    } catch {
      /* never let an observer crash the watcher */
    }
  }
}

// Single-shot destroy hook per WebContents — avoids the previous behavior
// where every subscribeWatch call attached a fresh `wc.once('destroyed')`,
// stacking N listeners and (worse) firing cleanup() N times so the SECOND
// invocation could tear down a watcher another window still needed.
const wcDestroyHooks = new WeakSet<WebContents>();

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
      // Tell generic observers (e.g. FS_LIST_FILES walk cache) that this root
      // changed so they can drop any cached snapshot of it.
      notifyChange(key);
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
  if (!wcDestroyHooks.has(wc)) {
    wcDestroyHooks.add(wc);
    wc.once('destroyed', () => {
      // Iterate a snapshot — unsubscribeWatch can delete entries from the map.
      for (const [k, e] of Array.from(watchers)) {
        if (e.subscribers.has(wc)) {
          e.subscribers.delete(wc);
          if (e.subscribers.size === 0) {
            if (e.flushTimer) clearTimeout(e.flushTimer);
            void e.watcher.close().catch(() => undefined);
            watchers.delete(k);
            logger.info(`stopped watching ${k}`);
          }
        }
      }
    });
  }
}

/** Tear down every watcher subscribed by a particular root, regardless of
 *  which WebContents subscribed. Called from workspace-close cleanup. */
export function closeWatchersForRoot(root: string): void {
  const key = keyFor(root);
  const entry = watchers.get(key);
  if (!entry) return;
  if (entry.flushTimer) clearTimeout(entry.flushTimer);
  void entry.watcher.close().catch(() => undefined);
  watchers.delete(key);
  logger.info(`force-stopped watching ${key}`);
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
