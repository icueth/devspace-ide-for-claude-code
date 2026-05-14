import { describe, expect, it } from 'vitest';

import { computeLineDiff } from '@renderer/utils/gitLineDiff';

describe('computeLineDiff', () => {
  it('returns empty markers when content is unchanged', () => {
    const { markers, truncated } = computeLineDiff('a\nb\nc', 'a\nb\nc');
    expect(markers.size).toBe(0);
    expect(truncated).toBe(false);
  });

  it('marks pure additions as add', () => {
    const { markers } = computeLineDiff('a\nb', 'a\nb\nc\nd');
    expect(markers.get(3)?.kind).toBe('add');
    expect(markers.get(4)?.kind).toBe('add');
    expect(markers.get(1)).toBeUndefined();
  });

  it('marks replacements as mod', () => {
    const { markers } = computeLineDiff('a\nOLD\nc', 'a\nNEW\nc');
    expect(markers.get(2)?.kind).toBe('mod');
  });

  it('attaches deletion marker to the line below the deletion', () => {
    const { markers } = computeLineDiff('a\nGONE\nc', 'a\nc');
    // After removing line 2, the next new-side line is "c" at line 2.
    expect(markers.get(2)?.kind).toBe('del');
    expect(markers.get(2)?.deletedCount).toBeGreaterThanOrEqual(1);
  });

  it('marks every line as add when baseline is empty', () => {
    const { markers } = computeLineDiff('', 'a\nb\nc');
    expect(markers.get(1)?.kind).toBe('add');
    expect(markers.get(2)?.kind).toBe('add');
    expect(markers.get(3)?.kind).toBe('add');
  });

  it('falls back to all-mod with truncated flag when over the line cap', () => {
    const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const bigPlus = `${big}\nextra`;
    const { markers, truncated } = computeLineDiff(big, bigPlus);
    expect(truncated).toBe(true);
    expect(markers.size).toBeGreaterThan(0);
  });

  it('returns empty when newText is empty (whole-file delete)', () => {
    const { markers } = computeLineDiff('a\nb\nc', '');
    expect(markers.size).toBe(0);
  });

  it('handles a typical edit (add lines + mod one line)', () => {
    const before = 'import a;\n\nfn main() {\n  log("old")\n}';
    const after = 'import a;\nimport b;\n\nfn main() {\n  log("new")\n}';
    const { markers } = computeLineDiff(before, after);
    // line 2 = new import → add
    expect(markers.get(2)?.kind).toBe('add');
    // the changed log call → mod
    expect([...markers.values()].some((m) => m.kind === 'mod')).toBe(true);
  });
});
