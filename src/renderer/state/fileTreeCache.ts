/**
 * Per-project FileTree state cache.
 *
 * Perf R3 (v0.30.7): switching back to a previously-viewed project used to
 * re-fetch every directory via IPC because the FileTree mounted with
 * `tree = {}` on every `rootPath` change. With this LRU, a return visit
 * restores the cached `tree` snapshot instantly and only fires a background
 * refresh of the root + previously-expanded dirs to catch external changes.
 *
 * Capacity is fixed at 8 to match `MAX_OPEN` in workspace.ts — we cache at
 * most as many project trees as the workspace will hold open.
 *
 * NOTE: this module is intentionally tiny and frozen. Callers should never
 * mutate the returned snapshot — copy it into local state.
 */
export interface FileTreeCacheNode {
  entries: unknown[] | null;
  loading: boolean;
  expanded: boolean;
  error?: string;
}

export type FileTreeSnapshot = Record<string, FileTreeCacheNode>;

/** Max number of project snapshots to retain in memory. */
export const FILE_TREE_CACHE_CAP = 8;

/**
 * Restore ONLY the root level of a cached snapshot.
 *
 * v0.38: re-opening a project used to pop open every subfolder the user had
 * drilled into in a previous visit (the restore kept each node's `expanded`
 * flag). Users found that noisy — a project should open at its root every
 * time, like a fresh visit. We still reuse the cached ROOT entries so the top
 * level paints instantly on switch-back (no IPC flash); the caller
 * background-refreshes the root to catch external changes, and subfolders
 * start collapsed and load on demand when expanded.
 *
 * Returns null when the snapshot has no usable root listing (root never
 * loaded, or was stored mid-load) so the caller falls back to a fresh load().
 * Restoring only the root also subsumes the old SEC-MED-1 concern — we no
 * longer surface any folded dir's hours-stale entries to context menus.
 *
 * Pure helper for unit testing.
 */
export function restoreRootOnly(
  snap: FileTreeSnapshot,
  rootPath: string,
): FileTreeSnapshot | null {
  const root = snap[rootPath];
  if (!root || !root.entries) return null;
  return { [rootPath]: { ...root, expanded: true, loading: false } };
}

/**
 * LRU keyed by absolute project root path.
 *
 * Implementation uses a Map's insertion-order iteration to implement LRU:
 *   • set/get always re-inserts so the touched key moves to "most recent"
 *   • eviction removes the oldest (first iteration) key once size > cap
 *
 * Why not a fancier LRU lib: this only ever holds ≤ 8 entries, the value is
 * a Record<string, NodeState>, and we want zero runtime deps for a cache
 * this small. The Map insertion-order LRU is a well-known idiom and easy to
 * audit.
 */
export class FileTreeCache {
  private readonly map = new Map<string, FileTreeSnapshot>();

  constructor(private readonly cap: number = FILE_TREE_CACHE_CAP) {}

  /** Store a snapshot, evicting the oldest entry if cap is exceeded. */
  set(rootPath: string, snapshot: FileTreeSnapshot): void {
    // Remove first so re-set moves the key to the most-recent position.
    if (this.map.has(rootPath)) this.map.delete(rootPath);
    this.map.set(rootPath, snapshot);
    while (this.map.size > this.cap) {
      // Map iteration order is insertion order; first key = least recently set.
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  /**
   * Read a snapshot. Touching an entry promotes it to "most recent" so the
   * LRU stays accurate against real usage.
   */
  get(rootPath: string): FileTreeSnapshot | undefined {
    const snap = this.map.get(rootPath);
    if (snap === undefined) return undefined;
    // Touch: re-insert to refresh recency.
    this.map.delete(rootPath);
    this.map.set(rootPath, snap);
    return snap;
  }

  has(rootPath: string): boolean {
    return this.map.has(rootPath);
  }

  /** Drop a specific project, e.g. when the workspace removes it. */
  delete(rootPath: string): boolean {
    return this.map.delete(rootPath);
  }

  /** Wipe the cache entirely. Used by tests and by full reloads. */
  clear(): void {
    this.map.clear();
  }

  /** Current entry count — useful for tests and debug overlays. */
  get size(): number {
    return this.map.size;
  }

  /**
   * Snapshot of keys ordered from oldest → newest. Tests assert eviction
   * order through this; production code should not depend on it.
   */
  keys(): string[] {
    return Array.from(this.map.keys());
  }
}

/**
 * Module-level singleton. FileTree imports this directly. A single cache
 * across the renderer is correct because there is only ever one workspace
 * loaded at a time.
 */
export const fileTreeCache = new FileTreeCache(FILE_TREE_CACHE_CAP);
