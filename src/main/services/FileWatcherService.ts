import { watch, type FSWatcher } from 'node:fs';
import type { WebContents } from 'electron';
import * as path from 'node:path';

import { isWatcherIgnored } from '@main/utils/watchIgnore';
import { IPC } from '@shared/ipc-channels';
import { createLogger } from '@shared/logger';

const logger = createLogger('FileWatcher');

// Native fs.watch(root, { recursive: true }) — exactly ONE uv_fs_event handle
// per watched root. chokidar v4 (no fsevents backend) opened one handle PER
// DIRECTORY, and libuv on macOS tears down and recreates its single shared
// FSEventStream on EVERY handle add/remove: with several projects restored at
// boot that is thousands of stream rebuilds (each a blocking fseventsd RPC +
// a fresh copy of the whole path list). Symptoms: main thread stuck in
// uv_fs_event_stop for 20s+ at launch, memory ballooning to OOM.
//
// The ignore policy (shared with the tree-listing skip logic) now filters
// EVENTS instead of pruning the scan — recursive FSEvents is kernel-side, so
// watching node_modules costs nothing until it churns, and churn is debounced.
// We deliberately do NOT ignore `.claude/` or `.devspace/` — watching them
// refreshes the sidebar when codeflow drops docs.

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
    const scheduleFlush = () => {
      if (!entry || entry.flushTimer) return;
      entry.flushTimer = setTimeout(() => {
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
        // Tell generic observers (e.g. FS_LIST_FILES walk cache) that this
        // root changed so they can drop any cached snapshot of it.
        notifyChange(key);
      }, 150);
    };

    const watcher = watch(key, { recursive: true, persistent: true }, (eventType, filename) => {
      if (!entry) return;
      // 'change' = content-only edits; the sidebar tree only cares about
      // structure (add/remove/rename), which fs.watch reports as 'rename'.
      if (eventType !== 'rename') return;
      if (filename === null) {
        // Event queue overflow / unknown path — refresh the root itself.
        entry.pending.add(key);
        scheduleFlush();
        return;
      }
      const abs = path.join(key, filename.toString());
      if (isWatcherIgnored(abs)) return;
      entry.pending.add(path.dirname(abs));
      scheduleFlush();
    });

    watcher.on('error', (err) => {
      logger.warn(`watcher error for ${key}:`, (err as Error).message);
    });

    entry = { watcher, subscribers: new Set(), pending: new Set(), flushTimer: null };
    watchers.set(key, entry);

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
            e.watcher.close();
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
  entry.watcher.close();
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
    entry.watcher.close();
    watchers.delete(key);
    logger.info(`stopped watching ${key}`);
  }
}

export function shutdownWatchers(): void {
  for (const [, e] of watchers) {
    if (e.flushTimer) clearTimeout(e.flushTimer);
    e.watcher.close();
  }
  watchers.clear();
}
