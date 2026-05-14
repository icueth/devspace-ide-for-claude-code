// gitDiffGutter — CodeMirror 6 extension that visualizes the git diff of
// the current file against HEAD. Inspired by Cursor / VS Code:
//
//   1. Gutter bar (3px) on the left edge of every changed line
//      — green = added, amber = modified, red wedge = deletion boundary
//   2. Full-line background tint so changes are visible at a glance even
//      when scrolling fast (green/amber wash, very subtle)
//   3. Phantom "ghost" widgets above deletion boundaries that show the
//      actual REMOVED lines with red bg + strikethrough — same UX as the
//      chat's inline diff card so users see what was taken out, not just
//      that something was
//
// Lifecycle:
//   - host fetches HEAD content via api.git.diff() and dispatches a
//     setGitBaseline effect on mount + when the git store rolls forward
//   - state field stores baseline + last computed markers + deletions
//   - GutterMarker + line decorations + WidgetType all read from that field

import { Range, RangeSet, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  gutter,
  GutterMarker,
  WidgetType,
} from '@codemirror/view';

import {
  computeLineDiff,
  type DeletedBlock,
  type LineMarker,
} from '@renderer/utils/gitLineDiff';

export const setGitBaseline = StateEffect.define<string | null>();

interface BaselineState {
  baseline: string | null;
  // 1-based line → marker. null marker slot intentionally absent.
  markers: Map<number, LineMarker>;
  // 1-based anchor line → block of removed lines for phantom widgets.
  deletions: Map<number, DeletedBlock>;
  truncated: boolean;
}

const initialBaseline: BaselineState = {
  baseline: null,
  markers: new Map(),
  deletions: new Map(),
  truncated: false,
};

const baselineField = StateField.define<BaselineState>({
  create() {
    return initialBaseline;
  },
  update(value, tr) {
    let next = value;
    // Cheapest path first — baseline reset.
    for (const effect of tr.effects) {
      if (effect.is(setGitBaseline)) {
        const baseline = effect.value;
        if (baseline === null) {
          next = initialBaseline;
        } else {
          const { markers, deletions, truncated } = computeLineDiff(
            baseline,
            tr.state.doc.toString(),
          );
          next = { baseline, markers, deletions, truncated };
        }
      }
    }
    // If doc changed and we already have a baseline, recompute. Cheap
    // enough at 400-line cap; the LCS is also O(m·n) bounded.
    if (tr.docChanged && next.baseline !== null) {
      const { markers, deletions, truncated } = computeLineDiff(
        next.baseline,
        tr.state.doc.toString(),
      );
      next = { baseline: next.baseline, markers, deletions, truncated };
    }
    return next;
  },
});

class GitDiffMarker extends GutterMarker {
  constructor(private readonly kind: LineMarker['kind']) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return other instanceof GitDiffMarker && other.kind === this.kind;
  }
  override toDOM(): HTMLElement {
    const el = document.createElement('div');
    el.className = `cm-git-diff-marker cm-git-diff-${this.kind}`;
    return el;
  }
}

const ADD_MARKER = new GitDiffMarker('add');
const MOD_MARKER = new GitDiffMarker('mod');
const DEL_MARKER = new GitDiffMarker('del');

function markerFor(kind: LineMarker['kind']): GutterMarker {
  if (kind === 'add') return ADD_MARKER;
  if (kind === 'mod') return MOD_MARKER;
  return DEL_MARKER;
}

// Phantom widget: renders the removed-line block above the anchor line.
// Each removed line gets a faux gutter (-) + the text with red bg +
// strikethrough so it visually mirrors the chat's unified diff card.
class DeletedLinesWidget extends WidgetType {
  constructor(private readonly lines: string[]) {
    super();
  }
  override eq(other: WidgetType): boolean {
    if (!(other instanceof DeletedLinesWidget)) return false;
    if (other.lines.length !== this.lines.length) return false;
    for (let i = 0; i < this.lines.length; i++) {
      if (other.lines[i] !== this.lines[i]) return false;
    }
    return true;
  }
  override toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-git-deleted-block';
    for (const line of this.lines) {
      const row = document.createElement('div');
      row.className = 'cm-git-deleted-row';
      const sign = document.createElement('span');
      sign.className = 'cm-git-deleted-sign';
      sign.textContent = '−';
      const text = document.createElement('span');
      text.className = 'cm-git-deleted-text';
      // Preserve the raw line content; whitespace via the CSS class.
      text.textContent = line || ' ';
      row.appendChild(sign);
      row.appendChild(text);
      wrap.appendChild(row);
    }
    return wrap;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

const ADD_LINE = Decoration.line({ class: 'cm-git-line-add' });
const MOD_LINE = Decoration.line({ class: 'cm-git-line-mod' });

// Decoration set is derived from the baseline state field — recomputed
// whenever the state field changes (cheap; markers/deletions are
// pre-computed Maps).
const decorationsField = StateField.define<DecorationSet>({
  create(state) {
    return buildDecorations(state.field(baselineField), state.doc);
  },
  update(value, tr) {
    const prev = tr.startState.field(baselineField, false);
    const next = tr.state.field(baselineField, false);
    if (prev === next && !tr.docChanged) return value;
    return buildDecorations(
      tr.state.field(baselineField),
      tr.state.doc,
    );
  },
  provide: (f) => EditorView.decorations.from(f),
});

type DecorationSet = RangeSet<Decoration>;

function buildDecorations(
  state: BaselineState,
  doc: { lines: number; line: (n: number) => { from: number } },
): DecorationSet {
  const out: Range<Decoration>[] = [];

  // 1. Line backgrounds for add/mod
  for (const [lineNumber, marker] of state.markers) {
    if (lineNumber < 1 || lineNumber > doc.lines) continue;
    const lineInfo = doc.line(lineNumber);
    if (marker.kind === 'add') {
      out.push(ADD_LINE.range(lineInfo.from));
    } else if (marker.kind === 'mod') {
      out.push(MOD_LINE.range(lineInfo.from));
    }
  }

  // 2. Phantom widgets for deletions. Anchor above the target line
  //    (block=true forces it onto its own line, doesn't push doc text).
  for (const [anchor, block] of state.deletions) {
    if (block.lines.length === 0) continue;
    if (anchor <= 0) {
      // Removed at the very top of the file — anchor before line 1.
      out.push(
        Decoration.widget({
          widget: new DeletedLinesWidget(block.lines),
          side: -1,
          block: true,
        }).range(0),
      );
      continue;
    }
    if (anchor > doc.lines) {
      // Removed at EOF — anchor below the last line.
      const last = doc.line(doc.lines);
      out.push(
        Decoration.widget({
          widget: new DeletedLinesWidget(block.lines),
          side: 1,
          block: true,
        }).range(last.from + (doc.lines === 0 ? 0 : 0)),
      );
      continue;
    }
    const lineInfo = doc.line(anchor);
    out.push(
      Decoration.widget({
        widget: new DeletedLinesWidget(block.lines),
        side: -1,
        block: true,
      }).range(lineInfo.from),
    );
  }

  // Sort by from-pos so RangeSet.of doesn't throw.
  out.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
  return RangeSet.of(out, true);
}

const gitDiffGutterTheme = EditorView.baseTheme({
  '.cm-git-diff-gutter': {
    width: '3px',
    paddingLeft: '0',
    paddingRight: '0',
  },
  '.cm-git-diff-marker': {
    width: '3px',
    height: '100%',
    minHeight: '14px',
  },
  '.cm-git-diff-add': {
    backgroundColor: '#34d399', // emerald-400
  },
  '.cm-git-diff-mod': {
    backgroundColor: '#fbbf24', // amber-400
  },
  '.cm-git-diff-del': {
    // A small red wedge at the top of the line — the deletion happened
    // ABOVE this line, so we anchor visually at the top edge.
    background:
      'linear-gradient(to bottom, #ef4444 0%, #ef4444 35%, transparent 35%)',
  },

  // Subtle full-line backgrounds so changes pop without overwhelming.
  '.cm-git-line-add': {
    backgroundColor: 'rgba(34, 197, 94, 0.10)',
  },
  '.cm-git-line-mod': {
    backgroundColor: 'rgba(251, 191, 36, 0.10)',
  },

  // Phantom deleted-line block — sits above the anchor line as a
  // floating panel that mirrors the chat's unified diff card.
  '.cm-git-deleted-block': {
    backgroundColor: 'rgba(239, 68, 68, 0.10)',
    borderLeft: '2px solid #ef4444',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    lineHeight: '1.55',
    padding: '2px 0',
    color: '#fca5a5',
    pointerEvents: 'auto',
    userSelect: 'text',
  },
  '.cm-git-deleted-row': {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '0',
    paddingLeft: '0',
    paddingRight: '8px',
    whiteSpace: 'pre',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  '.cm-git-deleted-sign': {
    flex: '0 0 auto',
    width: '32px',
    textAlign: 'center',
    color: '#ef4444',
    opacity: '0.7',
    userSelect: 'none',
  },
  '.cm-git-deleted-text': {
    flex: '1 1 auto',
    textDecoration: 'line-through',
    textDecorationColor: 'rgba(239, 68, 68, 0.5)',
    opacity: '0.85',
  },
});

export function gitDiffGutter() {
  return [
    baselineField,
    decorationsField,
    gutter({
      class: 'cm-git-diff-gutter',
      lineMarker(view, line) {
        const state = view.state.field(baselineField, false);
        if (!state) return null;
        // CM's `line.from` is a doc offset; convert to 1-based line number.
        const lineNumber = view.state.doc.lineAt(line.from).number;
        const marker = state.markers.get(lineNumber);
        return marker ? markerFor(marker.kind) : null;
      },
      // Re-render markers when our state field changes.
      lineMarkerChange(update) {
        const prev = update.startState.field(baselineField, false);
        const next = update.state.field(baselineField, false);
        return prev !== next;
      },
    }),
    gitDiffGutterTheme,
  ];
}
