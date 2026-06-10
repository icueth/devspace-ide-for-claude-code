import { useEffect, useRef } from 'react';

import { api } from '@renderer/lib/api';
import type { Project } from '@shared/types';

// Deferral for BACKGROUND project watchers, plus a small per-root stagger.
// Each subscription triggers chokidar's initial depth-8 recursive readdir
// sweep in main, so a restored session with 8 open projects would otherwise
// front-load 8 sweeps at launch — competing with first paint, the active
// project's own sweep, and the initial git status. ~1.5s is past the
// launch-critical window but early enough that background trees are live
// well before the user plausibly switches to them.
const BACKGROUND_SUBSCRIBE_BASE_MS = 1500;
const BACKGROUND_SUBSCRIBE_STAGGER_MS = 300;

// This hook owns watcher LIFECYCLE only; event consumers (FileTree) listen
// via api.fs.onWatchEvent. Main broadcasts to the whole WebContents, so the
// per-subscription callback has nothing to do.
const noop = (): void => undefined;

/**
 * Keep ONE main-process fs watcher subscription alive per OPEN project for
 * the lifetime of the app shell (mounted once in AppInner).
 *
 * Why: FileTree used to own the api.fs.watch subscription, keyed on the
 * ACTIVE rootPath. With a single un-keyed FileTree instance, every project
 * switch unsubscribed (FileWatcherService closes the chokidar watcher at
 * zero subscribers) then resubscribed — paying a brand-new depth-8 recursive
 * sweep on EVERY switch, including A→B→A — while background projects got no
 * FS events at all, so their cached trees went stale.
 *
 * Diff-based on purpose: subscribe only newly-added roots, unsubscribe only
 * removed roots. A naive cleanup-and-resubscribe-all effect would tear down
 * and recreate every watcher per openedProjectIds/projects change — the
 * original bug in a new shape.
 *
 * Teardown stays leak-free without main-process changes: closeProject /
 * eviction already force-close via WORKSPACE_CLOSE → closeWatchersForRoot,
 * and unsubscribeWatch no-ops on missing entries, so the double-teardown
 * (force-close then our off()) is safe.
 */
export function useProjectWatchers(
  openedProjectIds: ReadonlyArray<string>,
  projects: ReadonlyArray<Pick<Project, 'id' | 'path'>>,
  activeProjectId: string | null,
): void {
  // Live api.fs.watch unsubscribers, keyed by absolute project root path.
  const subsRef = useRef(new Map<string, () => void>());
  // Pending deferred background subscriptions, keyed the same way.
  const timersRef = useRef(new Map<string, number>());

  useEffect(() => {
    const subs = subsRef.current;
    const timers = timersRef.current;

    // Project paths are absolute (main resolves them on scan), matching the
    // path.resolve()'d keys FileWatcherService uses — no normalization here.
    const desired = new Set<string>();
    for (const id of openedProjectIds) {
      const p = projects.find((x) => x.id === id);
      if (p) desired.add(p.path);
    }
    const activeRoot =
      projects.find((x) => x.id === activeProjectId)?.path ?? null;

    // Drop roots that are no longer open. Iterate snapshots — we mutate the
    // maps inside the loops.
    for (const [root, off] of Array.from(subs)) {
      if (!desired.has(root)) {
        off();
        subs.delete(root);
      }
    }
    for (const [root, timer] of Array.from(timers)) {
      if (!desired.has(root)) {
        window.clearTimeout(timer);
        timers.delete(root);
      }
    }

    // Subscribe newly-added roots. The ACTIVE project's root goes live
    // immediately (its tree is on screen and needs events now); background
    // roots are deferred + staggered (see constants above).
    let staggerIndex = 0;
    for (const root of desired) {
      if (subs.has(root)) continue;
      if (root === activeRoot) {
        // Promote a pending background timer: the user landed on this
        // project before its deferred turn came up.
        const pending = timers.get(root);
        if (pending !== undefined) {
          window.clearTimeout(pending);
          timers.delete(root);
        }
        subs.set(root, api.fs.watch(root, noop));
      } else if (!timers.has(root)) {
        const delay =
          BACKGROUND_SUBSCRIBE_BASE_MS +
          staggerIndex * BACKGROUND_SUBSCRIBE_STAGGER_MS;
        staggerIndex += 1;
        const timer = window.setTimeout(() => {
          timers.delete(root);
          // Re-check: an effect pass may have subscribed this root already
          // (e.g. it became active and was promoted above).
          if (!subs.has(root)) subs.set(root, api.fs.watch(root, noop));
        }, delay);
        timers.set(root, timer);
      }
    }
    // Deliberately NO cleanup returned here — the diff above IS the cleanup.
  }, [openedProjectIds, projects, activeProjectId]);

  // Unmount only: cancel pending timers and release every subscription.
  useEffect(() => {
    const subs = subsRef.current;
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
      for (const off of subs.values()) off();
      subs.clear();
    };
  }, []);
}
