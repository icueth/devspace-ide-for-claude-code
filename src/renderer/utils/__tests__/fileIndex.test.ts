import { describe, expect, it } from 'vitest';

import { basename, buildFileIndex } from '@renderer/utils/fileIndex';

describe('basename', () => {
  it('returns the segment after the last slash', () => {
    expect(basename('src/renderer/foo.ts')).toBe('foo.ts');
  });

  it('returns the whole string when there is no slash', () => {
    expect(basename('README.md')).toBe('README.md');
  });

  it('handles a trailing slash by returning empty', () => {
    expect(basename('src/dir/')).toBe('');
  });
});

describe('buildFileIndex', () => {
  it('precomputes lowercase rel + name fields, preserving original case', () => {
    const idx = buildFileIndex(['src/Foo/Bar.TS']);
    expect(idx).toHaveLength(1);
    expect(idx[0]).toEqual({
      rel: 'src/Foo/Bar.TS',
      name: 'Bar.TS',
      relLower: 'src/foo/bar.ts',
      nameLower: 'bar.ts',
    });
  });

  it('preserves input order', () => {
    const files = ['b.ts', 'a.ts', 'c.ts'];
    const idx = buildFileIndex(files);
    expect(idx.map((f) => f.rel)).toEqual(files);
  });

  it('returns an empty array for an empty file list', () => {
    expect(buildFileIndex([])).toEqual([]);
  });

  it('computes lowercase exactly once per file (idempotent fields)', () => {
    const idx = buildFileIndex(['MiXeD/Case.JSX']);
    // relLower / nameLower should already be fully lowercased.
    expect(idx[0]!.relLower).toBe(idx[0]!.relLower.toLowerCase());
    expect(idx[0]!.nameLower).toBe(idx[0]!.nameLower.toLowerCase());
  });
});
