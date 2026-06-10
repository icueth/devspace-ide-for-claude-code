import { describe, expect, it } from 'vitest';

import {
  FileTreeCache,
  FILE_TREE_CACHE_CAP,
  fileTreeCache,
  restoreRootOnly,
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

describe('restoreRootOnly (v0.38 — open project at root)', () => {
  it('keeps only the root node and drops every cached subfolder', () => {
    const snap: FileTreeSnapshot = {
      '/p/root': {
        entries: [{ name: 'src', isDirectory: true }] as unknown[],
        loading: false,
        expanded: true,
      },
      '/p/root/src': {
        entries: [{ name: 'index.ts', isDirectory: false }] as unknown[],
        loading: false,
        expanded: true,
      },
      '/p/root/src/deep': {
        entries: [] as unknown[],
        loading: false,
        expanded: true,
      },
    };
    const out = restoreRootOnly(snap, '/p/root');
    expect(out).not.toBeNull();
    expect(Object.keys(out!)).toEqual(['/p/root']);
    expect(out!['/p/root'].entries).toHaveLength(1);
    expect(out!['/p/root'].expanded).toBe(true);
  });

  it('returns null when the root listing is missing (cache miss → fresh load)', () => {
    expect(restoreRootOnly({}, '/p/root')).toBeNull();
    expect(
      restoreRootOnly(
        { '/p/root': { entries: null, loading: true, expanded: true } },
        '/p/root',
      ),
    ).toBeNull();
  });

  it('forces the restored root expanded + settled even if cached mid-state', () => {
    const snap: FileTreeSnapshot = {
      '/p/root': {
        entries: [] as unknown[],
        loading: true,
        expanded: false,
      },
    };
    const out = restoreRootOnly(snap, '/p/root');
    expect(out!['/p/root'].expanded).toBe(true);
    expect(out!['/p/root'].loading).toBe(false);
  });

  it('does not mutate the input snapshot', () => {
    const snap: FileTreeSnapshot = {
      '/p/root': { entries: [], loading: false, expanded: true },
      '/p/root/src': { entries: [], loading: false, expanded: true },
    };
    restoreRootOnly(snap, '/p/root');
    expect(Object.keys(snap)).toHaveLength(2); // input untouched
  });
});
