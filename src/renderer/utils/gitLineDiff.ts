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

// Same bounds as main-process diffPreview — 400 lines per side keeps the
// O(m·n) LCS table under 160k cells. Files over the cap fall back to
// "everything is mod" so the gutter still shows *something* useful.
const MAX_LINES = 400;
const MAX_BYTES = 1_000_000;

export interface LineDiffResult {
  markers: Map<number, LineMarker>;
  truncated: boolean;
}

export function computeLineDiff(oldText: string, newText: string): LineDiffResult {
  if (oldText === newText) {
    return { markers: new Map(), truncated: false };
  }

  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  // Quick degenerate cases — no LCS needed.
  if (oldLines.length === 0) {
    const markers = new Map<number, LineMarker>();
    for (let i = 0; i < newLines.length; i++) {
      markers.set(i + 1, { kind: 'add' });
    }
    return { markers, truncated: false };
  }
  if (newLines.length === 0) {
    // Whole file deleted — the gutter has nothing to anchor to. Return
    // empty; this case usually means the file isn't being viewed anyway.
    return { markers: new Map(), truncated: false };
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
    return { markers, truncated: true };
  }

  // Standard LCS table + backtrack. Collapses adjacent add+del into 'mod'
  // markers since CM gutters want a single category per line.
  const ops = lcsOps(oldLines, newLines);
  const markers = new Map<number, LineMarker>();
  let pendingDel = 0;

  for (const op of ops) {
    if (op.kind === 'ctx') {
      // A deletion immediately before this line attaches as 'del' here.
      if (pendingDel > 0) {
        flushDelMarker(markers, op.newLine, pendingDel);
        pendingDel = 0;
      }
    } else if (op.kind === 'add') {
      // If there were pending dels right before this add, the add becomes
      // a "mod" line. Subsequent adds in the same change block stay as
      // 'add' so the user can tell at a glance: replaced lines = yellow,
      // pure additions = green.
      if (pendingDel > 0) {
        markers.set(op.newLine, { kind: 'mod' });
        pendingDel -= 1;
      } else {
        markers.set(op.newLine, { kind: 'add' });
      }
    } else {
      pendingDel += 1;
    }
  }

  // Trailing deletions: attach to a sentinel slot just past the end so
  // the gutter can render the "deleted at EOF" marker.
  if (pendingDel > 0) {
    flushDelMarker(markers, newLines.length + 1, pendingDel);
  }

  return { markers, truncated: false };
}

function flushDelMarker(
  map: Map<number, LineMarker>,
  newLine: number,
  count: number,
): void {
  // If there's already an 'add' or 'mod' here, the upstream loop already
  // collapsed dels into mods — nothing to do.
  if (map.has(newLine)) return;
  map.set(newLine, { kind: 'del', deletedCount: count });
}

interface Op {
  kind: 'ctx' | 'add' | 'del';
  newLine: number;
}

function lcsOps(a: string[], b: string[]): Op[] {
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
      out.push({ kind: 'del', newLine: j });
      i--;
    } else {
      out.push({ kind: 'add', newLine: j });
      j--;
    }
  }
  while (i > 0) {
    out.push({ kind: 'del', newLine: 0 });
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
