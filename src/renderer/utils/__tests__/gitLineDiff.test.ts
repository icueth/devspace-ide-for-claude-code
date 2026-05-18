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

  it('renders no markers when over the line cap (truncated flag set)', () => {
    // v0.24.3: MAX_LINES is 4000 — anything above that returns empty
    // markers so the gutter stays clean instead of misleading "all amber".
    const big = Array.from({ length: 4500 }, (_, i) => `line ${i}`).join('\n');
    const bigPlus = `${big}\nextra`;
    const { markers, truncated } = computeLineDiff(big, bigPlus);
    expect(truncated).toBe(true);
    expect(markers.size).toBe(0);
  });

  it('does NOT truncate at 500 lines (below new MAX_LINES cap)', () => {
    // Regression for v0.18.0 behavior where MAX_LINES=400 caused most
    // real source files to render as "all amber" — common files 500-2000
    // lines should now diff properly line-by-line.
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
    const oldText = lines.join('\n');
    lines[100] = 'changed';
    const newText = lines.join('\n');
    const { markers, truncated } = computeLineDiff(oldText, newText);
    expect(truncated).toBe(false);
    expect(markers.get(101)?.kind).toBe('mod');
    expect(markers.has(100)).toBe(false);
    expect(markers.has(102)).toBe(false);
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

  // v0.18.2 — deletion content is now preserved so the editor can show
  // a phantom widget of the removed lines (Cursor-style inline diff).
  it('records deleted-line content at the boundary', () => {
    const { deletions } = computeLineDiff('a\nGONE\nc', 'a\nc');
    // Removal of "GONE" anchors at the new-side line that now sits where
    // it used to be, which is line 2 ("c").
    const block = deletions.get(2);
    expect(block).toBeDefined();
    expect(block!.lines).toEqual(['GONE']);
  });

  it('records replaced-line content as a deletion paired with the mod line', () => {
    const { markers, deletions } = computeLineDiff('a\nOLD\nc', 'a\nNEW\nc');
    expect(markers.get(2)?.kind).toBe('mod');
    // The OLD line surfaces as a deletion anchored at the same mod row.
    expect(deletions.get(2)?.lines).toEqual(['OLD']);
  });

  it('records trailing deletions past EOF', () => {
    const { deletions } = computeLineDiff('a\nb\nc\nd\ne', 'a\nb');
    // Three lines (c, d, e) removed past EOF → anchor at newLines+1 (=3).
    const block = deletions.get(3);
    expect(block).toBeDefined();
    expect(block!.lines).toEqual(['c', 'd', 'e']);
  });

  it('truncates excessively long deleted lines for the phantom display', () => {
    const long = 'x'.repeat(500);
    const { deletions } = computeLineDiff(`a\n${long}\nc`, 'a\nc');
    const block = deletions.get(2);
    expect(block).toBeDefined();
    // Capped at 240 chars + ellipsis sentinel.
    expect(block!.lines[0]!.length).toBeLessThanOrEqual(241);
    expect(block!.lines[0]!.endsWith('…')).toBe(true);
  });

  it('returns empty deletions map for unchanged content', () => {
    const { deletions } = computeLineDiff('a\nb\nc', 'a\nb\nc');
    expect(deletions.size).toBe(0);
  });
});
