/**
 * CodeflowGraphLive — live-sync service for the Codeflow graph (v0.33).
 *
 * Mirrors the subscribe/broadcast/WeakSet-destroy-hook/disposeProject patterns
 * from CodeflowService.ts. One module-level Map holds per-project state.
 * A single onAnyChange listener (registered lazily on first subscribe) triggers
 * a debounced rebuild (~400ms on top of the watcher's own 150ms debounce) and
 * broadcasts CODEFLOW_GRAPH_UPDATED to all live subscribers.
 */

import * as path from 'node:path';

import { buildGraph } from '@main/services/CodeflowGraphAnalyzer';
import { onAnyChange } from '@main/services/FileWatcherService';
import { IPC } from '@shared/ipc-channels';
import { createLogger } from '@shared/logger';
import type { CodeflowGraph } from '@shared/types';

const logger = createLogger('CodeflowGraphLive');

// ─── Per-project live state ───────────────────────────────────────────────────

interface LiveState {
  /** Resolved (absolute) project path — same as the map key. */
  projectPath: string;
  /** Last successfully built graph, or null if not yet built. */
  graph: CodeflowGraph | null;
  /** Renderer windows subscribed to live updates for this project. */
  subscribers: Set<Electron.WebContents>;
  /** True while a buildGraph() call is in progress. */
  building: boolean;
  /** Non-null when a change arrived mid-build — triggers one more rebuild. */
  pendingRebuild: boolean;
  /** Debounce timer handle for the incoming watcher event. */
  rebuildTimer: NodeJS.Timeout | null;
}

const liveStates = new Map<string, LiveState>();

// ─── Watcher integration ──────────────────────────────────────────────────────

// Only register ONE onAnyChange listener for the entire module (lazy, on first
// subscribe). Captured unsubscribe function for potential cleanup.
let watcherUnsubscribe: (() => void) | null = null;

function ensureWatcherRegistered(): void {
  if (watcherUnsubscribe !== null) return;
  watcherUnsubscribe = onAnyChange((rootKey: string) => {
    const state = liveStates.get(rootKey);
    if (!state || state.subscribers.size === 0) return;

    // Debounce: coalesce rapid changes with a 400ms window on top of the
    // watcher's own 150ms debounce, so a sequence of saves triggers one rebuild.
    if (state.rebuildTimer !== null) {
      clearTimeout(state.rebuildTimer);
    }
    state.rebuildTimer = setTimeout(() => {
      state.rebuildTimer = null;
      void triggerRebuild(state);
    }, 400);
  });
  logger.info('registered global onAnyChange listener');
}

// ─── Rebuild logic ────────────────────────────────────────────────────────────

async function triggerRebuild(state: LiveState): Promise<void> {
  if (state.building) {
    // A build is already running. Flag that another rebuild is needed after.
    state.pendingRebuild = true;
    return;
  }
  state.building = true;
  state.pendingRebuild = false;
  try {
    logger.info(`rebuilding graph for ${state.projectPath} (watch)`);
    const graph = await buildGraph(state.projectPath);
    state.graph = graph;
    broadcastUpdate(state, graph, 'watch');
  } catch (err) {
    logger.error(`rebuild failed for ${state.projectPath}:`, (err as Error).message);
  } finally {
    state.building = false;
    if (state.pendingRebuild) {
      state.pendingRebuild = false;
      void triggerRebuild(state);
    }
  }
}

function broadcastUpdate(
  state: LiveState,
  graph: CodeflowGraph,
  reason: 'watch' | 'manual',
): void {
  const payload = { projectPath: state.projectPath, graph, reason };
  for (const wc of state.subscribers) {
    if (!wc.isDestroyed()) {
      wc.send(IPC.CODEFLOW_GRAPH_UPDATED, payload);
    }
  }
}

// ─── WeakSet destroy-hook (single-shot per WebContents) ──────────────────────

const wcDestroyHooks = new WeakSet<Electron.WebContents>();

function attachDestroyHook(wc: Electron.WebContents): void {
  if (wcDestroyHooks.has(wc)) return;
  wcDestroyHooks.add(wc);
  wc.once('destroyed', () => {
    // Remove wc from all live state subscriber sets.
    for (const state of liveStates.values()) {
      state.subscribers.delete(wc);
    }
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Subscribe `wc` to live graph updates for `projectPath`.
 * Builds the graph on first call (or returns cached). Returns the current graph.
 */
export async function subscribeGraph(
  projectPath: string,
  wc: Electron.WebContents,
): Promise<CodeflowGraph> {
  ensureWatcherRegistered();

  const key = path.resolve(projectPath);
  let state = liveStates.get(key);
  if (!state) {
    state = {
      projectPath: key,
      graph: null,
      subscribers: new Set(),
      building: false,
      pendingRebuild: false,
      rebuildTimer: null,
    };
    liveStates.set(key, state);
  }

  state.subscribers.add(wc);
  attachDestroyHook(wc);

  if (state.graph !== null) {
    logger.info(`subscribeGraph: returning cached graph for ${key}`);
    return state.graph;
  }

  // Build the graph for the first subscriber (or if a prior build failed).
  if (!state.building) {
    state.building = true;
    try {
      logger.info(`subscribeGraph: building graph for ${key}`);
      const graph = await buildGraph(key);
      state.graph = graph;
      return graph;
    } catch (err) {
      logger.error(`subscribeGraph: build failed for ${key}:`, (err as Error).message);
      throw err;
    } finally {
      state.building = false;
      if (state.pendingRebuild) {
        state.pendingRebuild = false;
        void triggerRebuild(state);
      }
    }
  }

  // Concurrent subscription while a build is already running — wait for it.
  return new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      const st = liveStates.get(key);
      if (!st) {
        clearInterval(poll);
        reject(new Error('live state was disposed during build'));
        return;
      }
      if (st.graph !== null) {
        clearInterval(poll);
        resolve(st.graph);
        return;
      }
      // Build finished (building flipped false) but produced no graph ⇒ it
      // threw. Reject instead of polling forever — otherwise the renderer's
      // invoke() hangs for the window lifetime and the interval leaks.
      if (!st.building) {
        clearInterval(poll);
        reject(new Error('codeflow graph build failed'));
      }
    }, 50);
  });
}

/**
 * Unsubscribe `wc` from live updates for `projectPath`.
 */
export function unsubscribeGraph(
  projectPath: string,
  wc: Electron.WebContents,
): void {
  const key = path.resolve(projectPath);
  const state = liveStates.get(key);
  if (state) state.subscribers.delete(wc);
}

/**
 * Workspace close/eviction teardown.
 * Clears the debounce timer, drops all subscribers, and removes the state entry.
 */
export function disposeProject(projectPath: string): void {
  const key = path.resolve(projectPath);
  const state = liveStates.get(key);
  if (!state) return;
  if (state.rebuildTimer !== null) {
    clearTimeout(state.rebuildTimer);
    state.rebuildTimer = null;
  }
  state.subscribers.clear();
  liveStates.delete(key);
  logger.info(`disposed live graph state for ${key}`);
}

/**
 * Module teardown — unregister the global onAnyChange listener, clear every
 * project's debounce timer, and drop all state. Used by tests (afterEach) and
 * available for an app-quit hook so the singleton listener can't leak a stale
 * closure over the old liveStates map on module reload.
 */
export function teardown(): void {
  if (watcherUnsubscribe) {
    watcherUnsubscribe();
    watcherUnsubscribe = null;
  }
  for (const state of liveStates.values()) {
    if (state.rebuildTimer !== null) clearTimeout(state.rebuildTimer);
  }
  liveStates.clear();
}
