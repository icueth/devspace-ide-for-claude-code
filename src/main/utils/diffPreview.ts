// diffPreview — produces a Cursor-style unified diff hunk from a tool_use
// input so the renderer can render inline +/-/context rows under the
// diffStats chip. Sibling of diffStats.ts; both feed off the same
// tool_use inputs, but diffStats returns aggregate counts and diffPreview
// returns the actual line-by-line picture. Never throws — malformed input
// returns null so the chat stream keeps flowing.
//
// Computation:
//   Edit         — LCS-based diff of old_string vs new_string (one hunk)
//   MultiEdit    — one hunk per edits[] entry
//   Write        — all new content as additions (no prior content here)
//   NotebookEdit — insert/replace = LCS diff; delete = all old_source as deletions
//
// Caps (defense against pathological inputs without freezing main):
//   MAX_LINES_PER_SIDE — cap LCS to bounded O(m·n)
//   MAX_HUNKS          — cap MultiEdit
//   MAX_LINE_LENGTH    — truncate long lines (visual + memory bound)

import { maybeRelativize } from '@main/utils/diffStats';

export type DiffLineKind = 'add' | 'del' | 'ctx';

export interface DiffLine {
  kind: DiffLineKind;
  // Line text with the terminating \n stripped. Truncated to
  // MAX_LINE_LENGTH with a "…" suffix when over-cap so the row still
  // renders without being a security/perf issue.
  text: string;
  // 1-based line numbers — present only for the side(s) the line exists
  // in. ctx rows have both; add rows have newLine; del rows have oldLine.
  oldLine?: number;
  newLine?: number;
}

export interface DiffHunk {
  // 1-based line in old/new file where this hunk starts. Used for the
  // `@@ -oldStart,oldLen +newStart,newLen @@` header in renderer.
  oldStart: number;
  oldLen: number;
  newStart: number;
  newLen: number;
  lines: DiffLine[];
  // Optional label shown above the hunk (e.g. "Edit 2 of 3" for
  // MultiEdit, or the cell ID for NotebookEdit). Empty for single-hunk
  // diffs.
  label?: string;
}

export interface DiffPreview {
  path: string;
  hunks: DiffHunk[];
  // True when at least one hunk had its line count clamped at
  // MAX_LINES_PER_SIDE — the renderer shows a "Diff truncated" hint so
  // users know what they're seeing isn't the whole picture.
  truncated: boolean;
}

const FILE_MUTATING_TOOLS = new Set([
  'Edit',
  'Write',
  'NotebookEdit',
  'MultiEdit',
]);

// LCS table is O(m·n) in time and memory; cap each side at 400 lines.
// Largest legitimate Edit in this repo is the toolbar refactor at ~250
// lines — 400 leaves comfortable headroom without letting a 50k-line
// malicious input freeze main.
const MAX_LINES_PER_SIDE = 400;
const MAX_HUNKS = 8;
const MAX_LINE_LENGTH = 500;

// Sibling cap from diffStats.ts — abort if either input exceeds 1 MB.
const MAX_STRING_BYTES = 1_000_000;

function splitLines(s: string): { lines: string[]; clipped: boolean } {
  if (s.length === 0) return { lines: [], clipped: false };
  if (s.length > MAX_STRING_BYTES) return { lines: [], clipped: true };
  const trimmed = s.endsWith('\n') ? s.slice(0, -1) : s;
  const raw = trimmed.length === 0 ? [] : trimmed.split('\n');
  if (raw.length <= MAX_LINES_PER_SIDE) {
    return { lines: raw.map(truncateLine), clipped: false };
  }
  return {
    lines: raw.slice(0, MAX_LINES_PER_SIDE).map(truncateLine),
    clipped: true,
  };
}

function truncateLine(line: string): string {
  if (line.length <= MAX_LINE_LENGTH) return line;
  return line.slice(0, MAX_LINE_LENGTH) + '…';
}

// Standard Myers-style LCS table + backtrack. Bounded by MAX_LINES_PER_SIDE
// on both sides so worst case is 400·400 = 160k cells — safe for main.
function diffLinesLCS(a: string[], b: string[]): DiffLine[] {
  const m = a.length;
  const n = b.length;
  if (m === 0 && n === 0) return [];
  if (m === 0) {
    return b.map((text, idx) => ({ kind: 'add' as const, text, newLine: idx + 1 }));
  }
  if (n === 0) {
    return a.map((text, idx) => ({ kind: 'del' as const, text, oldLine: idx + 1 }));
  }

  // dp[i][j] = LCS length of a[0..i] vs b[0..j]
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      if (a[i] === b[j]) dp[i + 1]![j + 1] = dp[i]![j]! + 1;
      else dp[i + 1]![j + 1] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  // Backtrack from (m, n) to (0, 0)
  const out: DiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      out.push({
        kind: 'ctx',
        text: a[i - 1]!,
        oldLine: i,
        newLine: j,
      });
      i--;
      j--;
    } else if (dp[i - 1]![j]! > dp[i]![j - 1]!) {
      // Strict greater — going up preserves more LCS length, must take del.
      out.push({ kind: 'del', text: a[i - 1]!, oldLine: i });
      i--;
    } else {
      // Equal or strict less — prefer the add path. Combined with the
      // final reverse, this orders dels BEFORE adds in the same change
      // block (matches unified diff convention + how Cursor renders).
      out.push({ kind: 'add', text: b[j - 1]!, newLine: j });
      j--;
    }
  }
  while (i > 0) {
    out.push({ kind: 'del', text: a[i - 1]!, oldLine: i });
    i--;
  }
  while (j > 0) {
    out.push({ kind: 'add', text: b[j - 1]!, newLine: j });
    j--;
  }
  return out.reverse();
}

interface EditLike {
  old_string?: unknown;
  new_string?: unknown;
}

function hunkFromEdit(edit: EditLike, label?: string): {
  hunk: DiffHunk | null;
  clipped: boolean;
} {
  const oldStr = typeof edit.old_string === 'string' ? edit.old_string : '';
  const newStr = typeof edit.new_string === 'string' ? edit.new_string : '';
  const oldSplit = splitLines(oldStr);
  const newSplit = splitLines(newStr);
  const clipped = oldSplit.clipped || newSplit.clipped;
  const lines = diffLinesLCS(oldSplit.lines, newSplit.lines);
  if (lines.length === 0) return { hunk: null, clipped };
  return {
    hunk: {
      oldStart: 1,
      oldLen: oldSplit.lines.length,
      newStart: 1,
      newLen: newSplit.lines.length,
      lines,
      label,
    },
    clipped,
  };
}

/**
 * Build a unified-diff preview for a single tool_use call. Returns null
 * when the tool isn't a file mutator or the input doesn't carry enough
 * data to produce a meaningful diff.
 */
export function computeToolDiffPreview(
  toolName: string,
  input: Record<string, unknown>,
  projectPath?: string,
): DiffPreview | null {
  try {
    if (!FILE_MUTATING_TOOLS.has(toolName)) return null;
    if (!input || typeof input !== 'object') return null;

    if (toolName === 'Edit') {
      const fp = typeof input.file_path === 'string' ? input.file_path : '';
      if (!fp) return null;
      const { hunk, clipped } = hunkFromEdit(input as EditLike);
      if (!hunk) return null;
      return {
        path: maybeRelativize(fp, projectPath),
        hunks: [hunk],
        truncated: clipped,
      };
    }

    if (toolName === 'MultiEdit') {
      const fp = typeof input.file_path === 'string' ? input.file_path : '';
      if (!fp) return null;
      const edits = Array.isArray(input.edits) ? (input.edits as unknown[]) : [];
      const hunks: DiffHunk[] = [];
      let anyClipped = false;
      let truncatedByCount = false;
      for (let idx = 0; idx < edits.length; idx++) {
        if (hunks.length >= MAX_HUNKS) {
          truncatedByCount = true;
          break;
        }
        const e = edits[idx];
        if (!e || typeof e !== 'object') continue;
        const label = edits.length > 1 ? `Edit ${idx + 1} of ${edits.length}` : undefined;
        const { hunk, clipped } = hunkFromEdit(e as EditLike, label);
        if (clipped) anyClipped = true;
        if (hunk) hunks.push(hunk);
      }
      if (hunks.length === 0) return null;
      return {
        path: maybeRelativize(fp, projectPath),
        hunks,
        truncated: anyClipped || truncatedByCount,
      };
    }

    if (toolName === 'Write') {
      const fp = typeof input.file_path === 'string' ? input.file_path : '';
      if (!fp) return null;
      const content = typeof input.content === 'string' ? input.content : '';
      const { lines, clipped } = splitLines(content);
      if (lines.length === 0) return null;
      // All lines are additions — no prior content available at this layer.
      const diffLines: DiffLine[] = lines.map((text, idx) => ({
        kind: 'add' as const,
        text,
        newLine: idx + 1,
      }));
      return {
        path: maybeRelativize(fp, projectPath),
        hunks: [
          {
            oldStart: 0,
            oldLen: 0,
            newStart: 1,
            newLen: lines.length,
            lines: diffLines,
          },
        ],
        truncated: clipped,
      };
    }

    if (toolName === 'NotebookEdit') {
      const fp = typeof input.notebook_path === 'string' ? input.notebook_path : '';
      if (!fp) return null;
      const editMode = typeof input.edit_mode === 'string' ? input.edit_mode : '';
      const newSource = typeof input.new_source === 'string' ? input.new_source : '';
      const oldSource = typeof input.old_source === 'string' ? input.old_source : '';
      const cellId =
        typeof input.cell_id === 'string' && input.cell_id ? `cell ${input.cell_id}` : undefined;

      if (editMode === 'delete') {
        const { lines, clipped } = splitLines(oldSource);
        if (lines.length === 0) return null;
        const diffLines: DiffLine[] = lines.map((text, idx) => ({
          kind: 'del' as const,
          text,
          oldLine: idx + 1,
        }));
        return {
          path: maybeRelativize(fp, projectPath),
          hunks: [
            {
              oldStart: 1,
              oldLen: lines.length,
              newStart: 0,
              newLen: 0,
              lines: diffLines,
              label: cellId,
            },
          ],
          truncated: clipped,
        };
      }

      // insert / replace / unknown — treat as Edit-like
      const { hunk, clipped } = hunkFromEdit(
        { old_string: oldSource, new_string: newSource },
        cellId,
      );
      if (!hunk) return null;
      return {
        path: maybeRelativize(fp, projectPath),
        hunks: [hunk],
        truncated: clipped,
      };
    }

    return null;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[diffPreview] failed to compute', err);
    return null;
  }
}
