import { describe, expect, it } from 'vitest';

import {
  computeToolDiffStats,
  countLines,
  maybeRelativize,
} from '@main/utils/diffStats';

describe('countLines', () => {
  it('returns 0 for empty string', () => {
    expect(countLines('')).toBe(0);
  });

  it('returns 1 for a single line with no newline', () => {
    expect(countLines('a')).toBe(1);
  });

  it('returns 2 for two lines separated by newline', () => {
    expect(countLines('a\nb')).toBe(2);
  });

  it('returns 1 when string ends in single trailing newline', () => {
    expect(countLines('a\n')).toBe(1);
  });

  it('returns 2 for "a\\nb\\n" (trailing newline does not add a phantom line)', () => {
    expect(countLines('a\nb\n')).toBe(2);
  });

  it('counts blank lines in the middle', () => {
    expect(countLines('a\n\nb')).toBe(3);
  });
});

describe('maybeRelativize', () => {
  it('returns the file path unchanged when no project path is provided', () => {
    expect(maybeRelativize('/abs/path/file.ts')).toBe('/abs/path/file.ts');
  });

  it('relativizes paths inside the project root', () => {
    expect(maybeRelativize('/proj/src/foo.ts', '/proj')).toBe('src/foo.ts');
  });

  it('returns absolute path when file is outside the project root', () => {
    expect(maybeRelativize('/elsewhere/file.ts', '/proj')).toBe(
      '/elsewhere/file.ts',
    );
  });

  it('returns absolute path when file IS the project root itself', () => {
    expect(maybeRelativize('/proj', '/proj')).toBe('/proj');
  });
});

describe('computeToolDiffStats — unrecognized tools', () => {
  it('returns null for Read', () => {
    expect(computeToolDiffStats('Read', { file_path: '/x' })).toBeNull();
  });

  it('returns null for Bash', () => {
    expect(computeToolDiffStats('Bash', { command: 'ls' })).toBeNull();
  });

  it('returns null for custom MCP tool names', () => {
    expect(computeToolDiffStats('mcp__foo__bar', { x: 1 })).toBeNull();
  });
});

describe('computeToolDiffStats — Edit', () => {
  it('counts 5-line old → 7-line new as +7 -5', () => {
    const stats = computeToolDiffStats('Edit', {
      file_path: '/proj/src/foo.ts',
      old_string: 'a\nb\nc\nd\ne',
      new_string: 'a\nb\nc\nd\ne\nf\ng',
    });
    expect(stats).toEqual({
      additions: 7,
      deletions: 5,
      path: '/proj/src/foo.ts',
    });
  });

  it('counts empty old → "abc" as +1 -0', () => {
    const stats = computeToolDiffStats('Edit', {
      file_path: '/proj/x.ts',
      old_string: '',
      new_string: 'abc',
    });
    expect(stats).toEqual({ additions: 1, deletions: 0, path: '/proj/x.ts' });
  });

  it('relativizes path when project root supplied', () => {
    const stats = computeToolDiffStats(
      'Edit',
      {
        file_path: '/proj/src/foo.ts',
        old_string: 'old',
        new_string: 'new',
      },
      '/proj',
    );
    expect(stats?.path).toBe('src/foo.ts');
  });

  it('returns null when file_path is missing', () => {
    expect(
      computeToolDiffStats('Edit', { old_string: 'a', new_string: 'b' }),
    ).toBeNull();
  });
});

describe('computeToolDiffStats — Write', () => {
  it('counts a 10-line content as +10 -0', () => {
    const content = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
    const stats = computeToolDiffStats('Write', {
      file_path: '/proj/new.ts',
      content,
    });
    expect(stats).toEqual({
      additions: 10,
      deletions: 0,
      path: '/proj/new.ts',
    });
  });

  it('returns null for empty content (no chip to show)', () => {
    expect(
      computeToolDiffStats('Write', { file_path: '/proj/x.ts', content: '' }),
    ).toBeNull();
  });

  it('returns null when file_path is missing', () => {
    expect(computeToolDiffStats('Write', { content: 'a' })).toBeNull();
  });
});

describe('computeToolDiffStats — MultiEdit', () => {
  it('sums additions and deletions across all edits', () => {
    const stats = computeToolDiffStats('MultiEdit', {
      file_path: '/proj/m.ts',
      edits: [
        { old_string: 'a', new_string: 'a\nb' }, // +2 -1
        { old_string: 'x\ny\nz', new_string: 'x' }, // +1 -3
        { old_string: '', new_string: 'p\nq\nr\ns' }, // +4 -0
      ],
    });
    expect(stats).toEqual({
      additions: 7,
      deletions: 4,
      path: '/proj/m.ts',
    });
  });

  it('handles empty edits array', () => {
    const stats = computeToolDiffStats('MultiEdit', {
      file_path: '/proj/m.ts',
      edits: [],
    });
    expect(stats).toEqual({ additions: 0, deletions: 0, path: '/proj/m.ts' });
  });
});

describe('computeToolDiffStats — NotebookEdit', () => {
  it('counts new_source as additions on insert/replace', () => {
    const stats = computeToolDiffStats('NotebookEdit', {
      notebook_path: '/proj/n.ipynb',
      new_source: 'import x\nprint(x)',
    });
    expect(stats).toEqual({
      additions: 2,
      deletions: 0,
      path: '/proj/n.ipynb',
    });
  });

  it('counts old_source as deletions on delete_mode', () => {
    const stats = computeToolDiffStats('NotebookEdit', {
      notebook_path: '/proj/n.ipynb',
      edit_mode: 'delete',
      old_source: 'a\nb\nc',
    });
    expect(stats).toEqual({
      additions: 0,
      deletions: 3,
      path: '/proj/n.ipynb',
    });
  });

  it('returns null on delete_mode with no source captured', () => {
    expect(
      computeToolDiffStats('NotebookEdit', {
        notebook_path: '/proj/n.ipynb',
        edit_mode: 'delete',
      }),
    ).toBeNull();
  });
});

describe('computeToolDiffStats — malformed input', () => {
  it('never throws on null-ish input fields', () => {
    expect(() =>
      computeToolDiffStats('Edit', {
        file_path: '/x',
        old_string: null as unknown as string,
        new_string: undefined as unknown as string,
      }),
    ).not.toThrow();
  });

  it('treats non-string old/new_string as empty', () => {
    const stats = computeToolDiffStats('Edit', {
      file_path: '/x',
      old_string: 42 as unknown as string,
      new_string: 'a\nb',
    });
    expect(stats).toEqual({ additions: 2, deletions: 0, path: '/x' });
  });

  // v0.16.0 review-fix M3 regression — over-cap strings used to walk the
  // whole buffer. countLines now returns -1 and computeToolDiffStats
  // drops the chip entirely rather than render misleading numbers.
  it('countLines returns -1 for over-cap input (DoS guard)', () => {
    const huge = 'a'.repeat(1_500_000);
    expect(countLines(huge)).toBe(-1);
  });

  it('computeToolDiffStats returns null when Edit input exceeds the size cap', () => {
    const huge = 'a'.repeat(1_500_000);
    const stats = computeToolDiffStats('Edit', {
      file_path: '/x',
      old_string: huge,
      new_string: 'small',
    });
    expect(stats).toBeNull();
  });

  it('computeToolDiffStats returns null when MultiEdit has one over-cap edit', () => {
    const huge = 'a'.repeat(1_500_000);
    const stats = computeToolDiffStats('MultiEdit', {
      file_path: '/x',
      edits: [
        { old_string: 'one\n', new_string: 'one!\n' },
        { old_string: huge, new_string: 'replacement' },
      ],
    });
    expect(stats).toBeNull();
  });
});
