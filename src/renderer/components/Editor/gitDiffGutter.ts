// gitDiffGutter — CodeMirror 6 extension that paints a thin colored bar
// in a dedicated gutter for every line that differs from the file's
// committed (HEAD) version. Green = add, yellow = mod, red triangle = del
// boundary. Refreshes on doc edit + when the host updates the baseline
// via dispatching the `setBaseline` effect.
//
// Lifecycle:
//   - host fetches HEAD content via api.git.diff() and dispatches a
//     setBaseline effect once on mount + whenever the git store fires a
//     refresh
//   - state field stores baseline + last computed markers
//   - GutterMarker renders a 3px-wide colored bar (or triangle for del)

import { StateEffect, StateField } from '@codemirror/state';
import { EditorView, gutter, GutterMarker } from '@codemirror/view';

import { computeLineDiff, type LineMarker } from '@renderer/utils/gitLineDiff';

export const setGitBaseline = StateEffect.define<string | null>();

interface BaselineState {
  baseline: string | null;
  // 1-based line → marker. null marker slot intentionally absent.
  markers: Map<number, LineMarker>;
  truncated: boolean;
}

const initialBaseline: BaselineState = {
  baseline: null,
  markers: new Map(),
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
          const { markers, truncated } = computeLineDiff(
            baseline,
            tr.state.doc.toString(),
          );
          next = { baseline, markers, truncated };
        }
      }
    }
    // If doc changed and we already have a baseline, recompute. Cheap
    // enough at 400-line cap; the LCS is also O(m·n) bounded.
    if (tr.docChanged && next.baseline !== null) {
      const { markers, truncated } = computeLineDiff(
        next.baseline,
        tr.state.doc.toString(),
      );
      next = { baseline: next.baseline, markers, truncated };
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
});

export function gitDiffGutter() {
  return [
    baselineField,
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
