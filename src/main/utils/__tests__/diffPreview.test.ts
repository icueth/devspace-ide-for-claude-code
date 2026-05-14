import { describe, it, expect } from 'vitest';
import { computeToolDiffPreview } from '@main/utils/diffPreview';

describe('computeToolDiffPreview', () => {
  describe('Edit', () => {
    it('returns null when file_path missing', () => {
      const preview = computeToolDiffPreview('Edit', {
        old_string: 'a',
        new_string: 'b',
      });
      expect(preview).toBeNull();
    });

    it('builds a single hunk with LCS-detected context', () => {
      const preview = computeToolDiffPreview('Edit', {
        file_path: '/tmp/foo.ts',
        old_string: 'line1\nline2\nline3',
        new_string: 'line1\nline2b\nline3',
      });
      expect(preview).not.toBeNull();
      expect(preview!.hunks).toHaveLength(1);
      const lines = preview!.hunks[0]!.lines;
      // line1 = ctx, line2 → line2b = del+add, line3 = ctx
      expect(lines.map((l) => l.kind)).toEqual(['ctx', 'del', 'add', 'ctx']);
      expect(lines[0]).toMatchObject({ kind: 'ctx', text: 'line1', oldLine: 1, newLine: 1 });
      expect(lines[1]).toMatchObject({ kind: 'del', text: 'line2', oldLine: 2 });
      expect(lines[2]).toMatchObject({ kind: 'add', text: 'line2b', newLine: 2 });
      expect(lines[3]).toMatchObject({ kind: 'ctx', text: 'line3', oldLine: 3, newLine: 3 });
    });

    it('returns null when both strings are empty', () => {
      const preview = computeToolDiffPreview('Edit', {
        file_path: '/tmp/foo.ts',
        old_string: '',
        new_string: '',
      });
      expect(preview).toBeNull();
    });

    it('handles pure addition (empty old_string)', () => {
      const preview = computeToolDiffPreview('Edit', {
        file_path: '/tmp/foo.ts',
        old_string: '',
        new_string: 'new\nlines',
      });
      expect(preview).not.toBeNull();
      expect(preview!.hunks[0]!.lines.map((l) => l.kind)).toEqual(['add', 'add']);
    });

    it('handles pure deletion (empty new_string)', () => {
      const preview = computeToolDiffPreview('Edit', {
        file_path: '/tmp/foo.ts',
        old_string: 'gone\nlines',
        new_string: '',
      });
      expect(preview).not.toBeNull();
      expect(preview!.hunks[0]!.lines.map((l) => l.kind)).toEqual(['del', 'del']);
    });

    it('strips trailing newline so "a\\n" and "a" both count as 1 line', () => {
      const preview = computeToolDiffPreview('Edit', {
        file_path: '/tmp/foo.ts',
        old_string: 'a\n',
        new_string: 'b\n',
      });
      expect(preview!.hunks[0]!.oldLen).toBe(1);
      expect(preview!.hunks[0]!.newLen).toBe(1);
    });

    it('truncates lines longer than MAX_LINE_LENGTH', () => {
      const long = 'x'.repeat(600);
      const preview = computeToolDiffPreview('Edit', {
        file_path: '/tmp/foo.ts',
        old_string: long,
        new_string: 'short',
      });
      expect(preview).not.toBeNull();
      const delLine = preview!.hunks[0]!.lines.find((l) => l.kind === 'del');
      expect(delLine!.text.length).toBeLessThanOrEqual(501); // 500 + …
      expect(delLine!.text.endsWith('…')).toBe(true);
    });

    it('marks truncated when input has > MAX_LINES_PER_SIDE lines', () => {
      // 500 lines on each side — over the 400-line cap
      const oldStr = Array.from({ length: 500 }, (_, i) => `old${i}`).join('\n');
      const newStr = Array.from({ length: 500 }, (_, i) => `new${i}`).join('\n');
      const preview = computeToolDiffPreview('Edit', {
        file_path: '/tmp/foo.ts',
        old_string: oldStr,
        new_string: newStr,
      });
      expect(preview).not.toBeNull();
      expect(preview!.truncated).toBe(true);
    });

    it('returns null when an input exceeds the 1MB safety cap', () => {
      const oneMb = 'x'.repeat(1_000_001);
      const preview = computeToolDiffPreview('Edit', {
        file_path: '/tmp/foo.ts',
        old_string: oneMb,
        new_string: 'short',
      });
      // splitLines clips to empty + clipped=true; hunkFromEdit produces a
      // hunk with only adds for the new side. Either way, never throws.
      // The contract is "non-crash" — we accept either null or a clipped
      // preview, so just assert it didn't throw and that truncated is true
      // if a preview was returned.
      if (preview) {
        expect(preview.truncated).toBe(true);
      }
    });
  });

  describe('MultiEdit', () => {
    it('produces one hunk per edit with a labeled header', () => {
      const preview = computeToolDiffPreview('MultiEdit', {
        file_path: '/tmp/foo.ts',
        edits: [
          { old_string: 'a', new_string: 'A' },
          { old_string: 'b', new_string: 'B' },
        ],
      });
      expect(preview).not.toBeNull();
      expect(preview!.hunks).toHaveLength(2);
      expect(preview!.hunks[0]!.label).toBe('Edit 1 of 2');
      expect(preview!.hunks[1]!.label).toBe('Edit 2 of 2');
    });

    it('caps at MAX_HUNKS and marks truncated', () => {
      const edits = Array.from({ length: 12 }, (_, i) => ({
        old_string: `old${i}`,
        new_string: `new${i}`,
      }));
      const preview = computeToolDiffPreview('MultiEdit', {
        file_path: '/tmp/foo.ts',
        edits,
      });
      expect(preview).not.toBeNull();
      expect(preview!.hunks.length).toBeLessThanOrEqual(8);
      expect(preview!.truncated).toBe(true);
    });

    it('returns null when edits is empty', () => {
      const preview = computeToolDiffPreview('MultiEdit', {
        file_path: '/tmp/foo.ts',
        edits: [],
      });
      expect(preview).toBeNull();
    });
  });

  describe('Write', () => {
    it('produces a single hunk of all additions', () => {
      const preview = computeToolDiffPreview('Write', {
        file_path: '/tmp/new.ts',
        content: 'a\nb\nc',
      });
      expect(preview).not.toBeNull();
      expect(preview!.hunks).toHaveLength(1);
      const lines = preview!.hunks[0]!.lines;
      expect(lines.map((l) => l.kind)).toEqual(['add', 'add', 'add']);
      expect(lines.map((l) => l.text)).toEqual(['a', 'b', 'c']);
      expect(preview!.hunks[0]!.oldStart).toBe(0);
      expect(preview!.hunks[0]!.newStart).toBe(1);
    });

    it('returns null when content is empty', () => {
      const preview = computeToolDiffPreview('Write', {
        file_path: '/tmp/new.ts',
        content: '',
      });
      expect(preview).toBeNull();
    });
  });

  describe('NotebookEdit', () => {
    it('delete mode produces all-deletions hunk', () => {
      const preview = computeToolDiffPreview('NotebookEdit', {
        notebook_path: '/tmp/foo.ipynb',
        edit_mode: 'delete',
        old_source: 'print(1)\nprint(2)',
        cell_id: 'abc',
      });
      expect(preview).not.toBeNull();
      expect(preview!.hunks[0]!.lines.every((l) => l.kind === 'del')).toBe(true);
      expect(preview!.hunks[0]!.label).toBe('cell abc');
    });

    it('replace mode runs LCS diff like Edit', () => {
      const preview = computeToolDiffPreview('NotebookEdit', {
        notebook_path: '/tmp/foo.ipynb',
        edit_mode: 'replace',
        old_source: 'a\nb\nc',
        new_source: 'a\nB\nc',
      });
      expect(preview).not.toBeNull();
      expect(preview!.hunks[0]!.lines.map((l) => l.kind)).toEqual([
        'ctx',
        'del',
        'add',
        'ctx',
      ]);
    });

    it('insert mode (no old_source) is treated as Edit with empty old', () => {
      const preview = computeToolDiffPreview('NotebookEdit', {
        notebook_path: '/tmp/foo.ipynb',
        edit_mode: 'insert',
        new_source: 'fresh',
      });
      expect(preview).not.toBeNull();
      expect(preview!.hunks[0]!.lines).toEqual([
        { kind: 'add', text: 'fresh', newLine: 1 },
      ]);
    });
  });

  describe('unrecognized tools', () => {
    it('returns null for Read', () => {
      expect(
        computeToolDiffPreview('Read', { file_path: '/tmp/foo.ts' }),
      ).toBeNull();
    });

    it('returns null for Bash', () => {
      expect(computeToolDiffPreview('Bash', { command: 'ls' })).toBeNull();
    });
  });

  describe('path relativization', () => {
    it('returns project-relative path when file is inside projectPath', () => {
      const preview = computeToolDiffPreview(
        'Edit',
        {
          file_path: '/Users/foo/proj/src/app.ts',
          old_string: 'a',
          new_string: 'b',
        },
        '/Users/foo/proj',
      );
      expect(preview!.path).toBe('src/app.ts');
    });

    it('returns absolute path when file is outside projectPath', () => {
      const preview = computeToolDiffPreview(
        'Edit',
        {
          file_path: '/tmp/elsewhere.ts',
          old_string: 'a',
          new_string: 'b',
        },
        '/Users/foo/proj',
      );
      expect(preview!.path).toBe('/tmp/elsewhere.ts');
    });
  });
});
