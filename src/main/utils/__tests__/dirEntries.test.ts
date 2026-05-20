import { describe, expect, it } from 'vitest';

import type { DirEntry } from '@shared/types';

import { capDirEntries, MAX_DIR_ENTRIES } from '../dirEntries';

function makeEntries(n: number): DirEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `f${i}`,
    path: `/p/f${i}`,
    isDirectory: false,
  }));
}

describe('capDirEntries', () => {
  it('returns the list unchanged when under or at the cap', () => {
    const under = makeEntries(MAX_DIR_ENTRIES - 1);
    expect(capDirEntries(under, '/p')).toBe(under);
    const exact = makeEntries(MAX_DIR_ENTRIES);
    expect(capDirEntries(exact, '/p')).toBe(exact);
  });

  it('truncates and appends exactly one sentinel when over the cap', () => {
    const out = capDirEntries(makeEntries(MAX_DIR_ENTRIES + 500), '/p');
    expect(out).toHaveLength(MAX_DIR_ENTRIES + 1);
    const sentinel = out[out.length - 1];
    expect(sentinel.truncated).toBe(true);
    expect(sentinel.isDirectory).toBe(false);
    expect(sentinel.name).toContain('500 more');
    // Real entries carry no truncated flag.
    expect(out.slice(0, MAX_DIR_ENTRIES).every((e) => !e.truncated)).toBe(true);
  });

  it('keeps the first `max` entries in order (dirs-first sort is preserved upstream)', () => {
    const out = capDirEntries(makeEntries(MAX_DIR_ENTRIES + 10), '/p', MAX_DIR_ENTRIES);
    expect(out[0].name).toBe('f0');
    expect(out[MAX_DIR_ENTRIES - 1].name).toBe(`f${MAX_DIR_ENTRIES - 1}`);
  });

  it('sentinel key cannot collide with a real child path', () => {
    const out = capDirEntries(makeEntries(MAX_DIR_ENTRIES + 1), '/p', MAX_DIR_ENTRIES);
    const paths = out.map((e) => e.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('honors a custom max and singularizes "1 more item"', () => {
    const out = capDirEntries(makeEntries(4), '/p', 3);
    expect(out).toHaveLength(4);
    expect(out[3].name).toContain('1 more item');
    expect(out[3].name).not.toContain('items');
  });
});
