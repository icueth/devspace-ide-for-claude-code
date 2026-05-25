import { describe, expect, it } from 'vitest';

import {
  FileTreeCache,
  FILE_TREE_CACHE_CAP,
  fileTreeCache,
  sanitizeForRestore,
  type FileTreeSnapshot,
} from '../fileTreeCache';

function snapshot(label: string): FileTreeSnapshot {
  // Each test snapshot carries an identifiable marker so cache identity
  // assertions are easy to read. Mirrors the production NodeState shape
  // closely enough that the cache is exercised with realistic data.
  return {
    [`/marker/${label}`]: {
      entries: [],
      loading: false,
      expanded: true,
    },
  };
}

describe('FileTreeCache', () => {
  it('starts empty and reports cap from the constant', () => {
    const c = new FileTreeCache();
    expect(c.size).toBe(0);
    expect(FILE_TREE_CACHE_CAP).toBe(8);
  });

  it('set + get round-trips the same snapshot reference', () => {
    const c = new FileTreeCache();
    const snap = snapshot('a');
    c.set('/proj/a', snap);
    expect(c.get('/proj/a')).toBe(snap);
    expect(c.has('/proj/a')).toBe(true);
  });

  it('get on a missing key returns undefined and does not insert', () => {
    const c = new FileTreeCache();
    expect(c.get('/nope')).toBeUndefined();
    expect(c.size).toBe(0);
  });

  it('set on an existing key replaces and refreshes recency', () => {
    const c = new FileTreeCache(3);
    const v1 = snapshot('v1');
    const v2 = snapshot('v2');
    c.set('/p/a', v1);
    c.set('/p/b', snapshot('b'));
    c.set('/p/a', v2);
    // Latest value wins.
    expect(c.get('/p/a')).toBe(v2);
    // /p/a should now be most recent (last position in iteration order).
    const keys = c.keys();
    expect(keys[keys.length - 1]).toBe('/p/a');
  });

  it('evicts the least-recently-used entry once over cap', () => {
    const c = new FileTreeCache(3);
    c.set('/p/a', snapshot('a'));
    c.set('/p/b', snapshot('b'));
    c.set('/p/c', snapshot('c'));
    c.set('/p/d', snapshot('d')); // pushes /p/a out
    expect(c.size).toBe(3);
    expect(c.has('/p/a')).toBe(false);
    expect(c.keys()).toEqual(['/p/b', '/p/c', '/p/d']);
  });

  it('get() promotes an entry so it survives the next eviction', () => {
    const c = new FileTreeCache(3);
    c.set('/p/a', snapshot('a'));
    c.set('/p/b', snapshot('b'));
    c.set('/p/c', snapshot('c'));
    // Touch /p/a → /p/a becomes most recent, /p/b is now LRU.
    c.get('/p/a');
    c.set('/p/d', snapshot('d'));
    expect(c.has('/p/a')).toBe(true);
    expect(c.has('/p/b')).toBe(false);
    expect(c.keys()).toEqual(['/p/c', '/p/a', '/p/d']);
  });

  it('respects the default cap of 8', () => {
    const c = new FileTreeCache();
    for (let i = 0; i < 10; i++) {
      c.set(`/p/${i}`, snapshot(String(i)));
    }
    expect(c.size).toBe(8);
    // First two should have been evicted.
    expect(c.has('/p/0')).toBe(false);
    expect(c.has('/p/1')).toBe(false);
    expect(c.has('/p/9')).toBe(true);
  });

  it('delete removes the entry without touching others', () => {
    const c = new FileTreeCache(3);
    c.set('/p/a', snapshot('a'));
    c.set('/p/b', snapshot('b'));
    expect(c.delete('/p/a')).toBe(true);
    expect(c.delete('/p/a')).toBe(false);
    expect(c.has('/p/b')).toBe(true);
    expect(c.size).toBe(1);
  });

  it('clear wipes the entire cache', () => {
    const c = new FileTreeCache(3);
    c.set('/p/a', snapshot('a'));
    c.set('/p/b', snapshot('b'));
    c.clear();
    expect(c.size).toBe(0);
    expect(c.keys()).toEqual([]);
  });

  it('exposes the module-level singleton with the production cap', () => {
    // The shared singleton FileTree.tsx imports. We reset it for isolation
    // because vitest shares module state across tests in this file, and
    // other suites might rely on the singleton being empty.
    fileTreeCache.clear();
    fileTreeCache.set('/p/singleton', snapshot('singleton'));
    expect(fileTreeCache.has('/p/singleton')).toBe(true);
    fileTreeCache.clear();
  });
});

describe('sanitizeForRestore (SEC-MED-1, v0.30.7)', () => {
  it('keeps expanded dirs with their entries intact', () => {
    const snap: FileTreeSnapshot = {
      '/p/root': {
        entries: [{ name: 'file.ts', isDirectory: false }] as unknown[],
        loading: false,
        expanded: true,
      },
    };
    const out = sanitizeForRestore(snap);
    expect(out['/p/root']).toBe(snap['/p/root']); // identity preserved
    expect(out['/p/root'].entries).toHaveLength(1);
  });

  it('drops entries from folded dirs but keeps the expanded:false flag', () => {
    // Without sanitization, a folded dir's stale entries could be presented
    // via right-click context menu and trigger destructive ops on paths
    // that may no longer exist on disk.
    const snap: FileTreeSnapshot = {
      '/p/folded': {
        entries: [
          { name: 'deleted-file.ts', isDirectory: false },
          { name: 'renamed.txt', isDirectory: false },
        ] as unknown[],
        loading: false,
        expanded: false,
      },
    };
    const out = sanitizeForRestore(snap);
    expect(out['/p/folded']).toEqual({
      expanded: false,
      entries: null,
      loading: false,
    });
    // Crucially: NOT the same identity, so React.memo on rows will see the change.
    expect(out['/p/folded']).not.toBe(snap['/p/folded']);
  });

  it('handles mixed expanded + folded dirs in a single snapshot', () => {
    const snap: FileTreeSnapshot = {
      '/p/expanded': {
        entries: [] as unknown[],
        loading: false,
        expanded: true,
      },
      '/p/folded': {
        entries: [{ name: 'stale.ts', isDirectory: false }] as unknown[],
        loading: false,
        expanded: false,
      },
    };
    const out = sanitizeForRestore(snap);
    expect(out['/p/expanded'].entries).toEqual([]);
    expect(out['/p/folded'].entries).toBeNull();
  });

  it('returns a new top-level object (does not mutate input)', () => {
    const snap: FileTreeSnapshot = {
      '/p/dir': { entries: null, loading: false, expanded: false },
    };
    const out = sanitizeForRestore(snap);
    expect(out).not.toBe(snap);
    expect(snap['/p/dir'].entries).toBeNull(); // input unchanged
  });
});
