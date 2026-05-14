// gitLineDiff — LCS-based line diff that yields per-line markers for the
// "new" side of the comparison. Used by the CodeMirror git-diff gutter so
// each line gets a colored bar matching its change kind.
//
// Returns a Map keyed by 1-based line number in the new file. Lines not
// in the map are unchanged. Deletions are attached to the line BELOW the
// deletion site (or to line 0 if the file starts with a deletion) so the
// gutter can render a "deletion marker" at that boundary.

export type LineChangeKind = 'add' | 'mod' | 'del';

export interface LineMarker {
  kind: LineChangeKind;
  // For 'del' markers, how many old-side lines were removed at this
  // boundary. The gutter draws a small triangle whose size scales with
  // this count (clamped visually).
  deletedCount?: number;
}

// A deletion attached to a boundary (i.e. anchored above this new-side
// line number). Includes the actual deleted text so the editor can show
// a phantom widget previewing what was removed. `anchorLine` is 1-based
// on the NEW side; `anchorLine === 0` means "above line 1", a sentinel
// past the end means "after EOF".
export interface DeletedBlock {
  anchorLine: number;
  lines: string[];
}

// Same bounds as main-process diffPreview — 400 lines per side keeps the
// O(m·n) LCS table under 160k cells. Files over the cap fall back to
// "everything is mod" so the gutter still shows *something* useful.
const MAX_LINES = 400;
const MAX_BYTES = 1_000_000;

// Per-line truncation for the deletion widget — long minified lines
// would blow up the rendered phantom. The marker still records the full
// LCS result; only the displayed text is cropped.
const MAX_DEL_LINE_CHARS = 240;

export interface LineDiffResult {
  markers: Map<number, LineMarker>;
  // Boundaries → contents of deleted lines for inline phantom rendering.
  // Multiple deletions at the same boundary collapse into one block.
  deletions: Map<number, DeletedBlock>;
  truncated: boolean;
}

export function computeLineDiff(oldText: string, newText: string): LineDiffResult {
  if (oldText === newText) {
    return { markers: new Map(), deletions: new Map(), truncated: false };
  }

  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  // Quick degenerate cases — no LCS needed.
  if (oldLines.length === 0) {
    const markers = new Map<number, LineMarker>();
    for (let i = 0; i < newLines.length; i++) {
      markers.set(i + 1, { kind: 'add' });
    }
    return { markers, deletions: new Map(), truncated: false };
  }
  if (newLines.length === 0) {
    // Whole file deleted — the gutter has nothing to anchor to. Return
    // empty; this case usually means the file isn't being viewed anyway.
    return { markers: new Map(), deletions: new Map(), truncated: false };
  }

  // Bound the LCS table. If either side blows past the cap, treat the
  // whole new file as "modified" — better than freezing main thread or
  // showing nothing at all.
  if (
    oldLines.length > MAX_LINES ||
    newLines.length > MAX_LINES ||
    oldText.length > MAX_BYTES ||
    newText.length > MAX_BYTES
  ) {
    const markers = new Map<number, LineMarker>();
    for (let i = 0; i < newLines.length; i++) {
      markers.set(i + 1, { kind: 'mod' });
    }
    return { markers, deletions: new Map(), truncated: true };
  }

  // Standard LCS table + backtrack. Collapses adjacent add+del into 'mod'
  // markers since CM gutters want a single category per line.
  const ops = lcsOps(oldLines, newLines, oldLines);
  const markers = new Map<number, LineMarker>();
  const deletions = new Map<number, DeletedBlock>();
  let pendingDel: string[] = [];

  for (const op of ops) {
    if (op.kind === 'ctx') {
      // A deletion immediately before this line attaches as 'del' here.
      if (pendingDel.length > 0) {
        flushDelMarker(markers, deletions, op.newLine, pendingDel);
        pendingDel = [];
      }
    } else if (op.kind === 'add') {
      // If there were pending dels right before this add, the add becomes
      // a "mod" line. Subsequent adds in the same change block stay as
      // 'add' so the user can tell at a glance: replaced lines = yellow,
      // pure additions = green. The deleted content for the 1:1 replaced
      // line is recorded as a phantom anchored at this line so the user
      // sees the OLD source struck through right above the new one.
      if (pendingDel.length > 0) {
        markers.set(op.newLine, { kind: 'mod' });
        const removed = pendingDel.shift()!;
        appendDeletion(deletions, op.newLine, [removed]);
      } else {
        markers.set(op.newLine, { kind: 'add' });
      }
    } else {
      pendingDel.push(op.text ?? '');
    }
  }

  // Trailing deletions: attach to a sentinel slot just past the end so
  // the gutter can render the "deleted at EOF" marker.
  if (pendingDel.length > 0) {
    flushDelMarker(markers, deletions, newLines.length + 1, pendingDel);
  }

  return { markers, deletions, truncated: false };
}

function flushDelMarker(
  map: Map<number, LineMarker>,
  deletions: Map<number, DeletedBlock>,
  newLine: number,
  removed: string[],
): void {
  appendDeletion(deletions, newLine, removed);
  // If there's already an 'add' or 'mod' here, the upstream loop already
  // collapsed dels into mods — leave the marker alone but still record
  // the deleted contents (they'll render above the mod line).
  if (map.has(newLine)) return;
  map.set(newLine, { kind: 'del', deletedCount: removed.length });
}

function appendDeletion(
  deletions: Map<number, DeletedBlock>,
  anchorLine: number,
  removed: string[],
): void {
  if (removed.length === 0) return;
  const capped = removed.map((l) =>
    l.length > MAX_DEL_LINE_CHARS ? l.slice(0, MAX_DEL_LINE_CHARS) + '…' : l,
  );
  const existing = deletions.get(anchorLine);
  if (existing) {
    existing.lines.push(...capped);
  } else {
    deletions.set(anchorLine, { anchorLine, lines: capped });
  }
}

interface Op {
  kind: 'ctx' | 'add' | 'del';
  newLine: number;
  // For 'del' ops, the actual line text on the OLD side. Carried through
  // backtrack so the phantom widget can show what was removed.
  text?: string;
}

function lcsOps(a: string[], b: string[], oldSide: string[]): Op[] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      if (a[i] === b[j]) dp[i + 1]![j + 1] = dp[i]![j]! + 1;
      else dp[i + 1]![j + 1] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: Op[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      out.push({ kind: 'ctx', newLine: j });
      i--;
      j--;
    } else if (dp[i - 1]![j]! > dp[i]![j - 1]!) {
      out.push({ kind: 'del', newLine: j, text: oldSide[i - 1] });
      i--;
    } else {
      out.push({ kind: 'add', newLine: j });
      j--;
    }
  }
  while (i > 0) {
    out.push({ kind: 'del', newLine: 0, text: oldSide[i - 1] });
    i--;
  }
  while (j > 0) {
    out.push({ kind: 'add', newLine: j });
    j--;
  }
  return out.reverse();
}

function splitLines(s: string): string[] {
  if (s.length === 0) return [];
  const trimmed = s.endsWith('\n') ? s.slice(0, -1) : s;
  return trimmed.length === 0 ? [] : trimmed.split('\n');
}
