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
 * SEC-MED-1 hardening (v0.30.7): drop stale entries from FOLDED dirs on
 * cache restore. A folded dir's `entries` may be hours stale; if the user
 * right-clicks an old entry to trigger destructive ops (rename / delete /
 * duplicate), we'd hit the filesystem with paths that may no longer exist.
 *
 * Expanded dirs keep their entries (caller refreshes them via background
 * load) so visible content stays instant on switch. Folded dirs keep their
 * `expanded: false` flag (preserving collapsed/expanded UI state) but lose
 * the listings — next expand triggers a fresh load() rather than render
 * stale data.
 *
 * Pure helper for unit testing.
 */
export function sanitizeForRestore(
  snap: FileTreeSnapshot,
): FileTreeSnapshot {
  const out: FileTreeSnapshot = {};
  for (const [dir, node] of Object.entries(snap)) {
    if (node.expanded) {
      out[dir] = node;
    } else {
      out[dir] = { expanded: false, entries: null, loading: false };
    }
  }
  return out;
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
