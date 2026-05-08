import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { Prec, StateEffect, StateField } from '@codemirror/state';

import { api } from '@renderer/lib/api';

/**
 * CodeMirror 6 extension for LLM-powered inline ghost-text autocomplete.
 *
 * Lifecycle of a single suggestion:
 *
 *   1. User types or moves the cursor.
 *   2. Plugin debounces, then collects prefix (last 1.5KB before cursor)
 *      + suffix (next 0.5KB after cursor) + filename hint.
 *   3. Calls api.llm.complete via IPC. Main process gates on the
 *      `autocompleteEnabled` master switch — the renderer doesn't have to
 *      know if the user has toggled the setting off.
 *   4. If the response is non-empty AND the cursor hasn't moved since the
 *      request started, we set a `setSuggestion` state effect that puts
 *      the text + anchor position into a state field.
 *   5. The decoration plugin renders the suggestion as a faded
 *      ghost-text widget after the cursor.
 *   6. Tab → splice the suggestion into the doc and clear the state.
 *      Esc / any other edit → clear without inserting.
 *
 * Failure modes are silent — autocomplete must never throw at the user.
 */

interface Suggestion {
  text: string;
  anchor: number; // doc offset where the ghost text should render
}

const setSuggestion = StateEffect.define<Suggestion | null>();

const suggestionField = StateField.define<Suggestion | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setSuggestion)) return e.value;
    }
    if (tr.docChanged) {
      // Any edit — including the user accepting our own suggestion via
      // Tab — should clear the ghost. The Tab handler dispatches a
      // setSuggestion(null) effect alongside the doc change, but a stray
      // keystroke from the user must invalidate the suggestion too.
      return null;
    }
    if (tr.selection && value && tr.selection.main.head !== value.anchor) {
      return null;
    }
    return value;
  },
});

class GhostTextWidget extends WidgetType {
  constructor(private readonly text: string) {
    super();
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-llm-ghost';
    // Use textContent so any newlines render as literal whitespace inside
    // the inline decoration. Multi-line suggestions still display, just
    // collapsed onto the cursor line.
    span.textContent = this.text;
    return span;
  }
  eq(other: GhostTextWidget) {
    return other.text === this.text;
  }
  ignoreEvent() {
    return true;
  }
}

const ghostTheme = EditorView.theme({
  '.cm-llm-ghost': {
    color: 'rgba(180, 180, 200, 0.55)',
    fontStyle: 'italic',
    pointerEvents: 'none',
    whiteSpace: 'pre',
  },
});

const decorationsPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;
    update(update: ViewUpdate) {
      const sug = update.state.field(suggestionField);
      if (!sug || !sug.text) {
        this.decorations = Decoration.none;
        return;
      }
      this.decorations = Decoration.set([
        Decoration.widget({
          widget: new GhostTextWidget(sug.text),
          side: 1,
        }).range(sug.anchor),
      ]);
    }
  },
  { decorations: (v) => v.decorations },
);

interface FetchPluginOpts {
  // Path of the file being edited — sent to the LLM for language
  // hinting. Doesn't affect the main process logic but improves output
  // quality, especially for ambiguous file types.
  getFilename: () => string;
  // Per-config debounce window. Read live so a settings change takes
  // effect without remounting the editor.
  getDebounceMs: () => number;
  // Called before every fetch — short-circuits the request when the
  // master switch is off so we don't even pay the IPC round trip.
  isEnabled: () => boolean;
}

const completionFetchPlugin = (opts: FetchPluginOpts) =>
  ViewPlugin.fromClass(
    class {
      view: EditorView;
      timer: ReturnType<typeof setTimeout> | null = null;
      // Increment on every fetch attempt; each callback checks whether
      // its id is still current to discard stale results from races
      // (user typed again before the previous request returned).
      seq = 0;
      lastFetchedAt = 0;
      constructor(view: EditorView) {
        this.view = view;
      }
      update(update: ViewUpdate) {
        // Only schedule a new fetch on user-driven changes, not on our
        // own setSuggestion dispatches.
        if (!update.docChanged && !update.selectionSet) return;
        if (!opts.isEnabled()) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.fetchCompletion(), opts.getDebounceMs());
      }
      async fetchCompletion() {
        if (!opts.isEnabled()) return;
        const view = this.view;
        const state = view.state;
        const cursor = state.selection.main.head;
        // Grab generous context around the cursor; the main process
        // truncates further before sending to the LLM.
        const prefix = state.doc.sliceString(Math.max(0, cursor - 4000), cursor);
        const suffix = state.doc.sliceString(
          cursor,
          Math.min(state.doc.length, cursor + 1000),
        );
        // Heuristic: only fire when there's some context to predict
        // from — avoids spending tokens on a brand-new empty file.
        if (prefix.length < 4) return;

        const myId = ++this.seq;
        try {
          const res = await api.llm.complete({
            prefix,
            suffix,
            filename: opts.getFilename(),
          });
          // Drop stale responses: another keystroke kicked off a newer
          // request, OR the cursor has since moved.
          if (myId !== this.seq) return;
          if (view.state.selection.main.head !== cursor) return;
          if (!res.text) {
            view.dispatch({ effects: setSuggestion.of(null) });
            return;
          }
          view.dispatch({
            effects: setSuggestion.of({ text: res.text, anchor: cursor }),
          });
        } catch {
          // swallow — autocomplete is best-effort
        }
      }
      destroy() {
        if (this.timer) clearTimeout(this.timer);
      }
    },
  );

/**
 * Tab key handler — wins over the default Tab indent only when there's
 * an active suggestion. Esc clears.
 */
const acceptKeymap = Prec.highest(
  keymap.of([
    {
      key: 'Tab',
      run: (view) => {
        const sug = view.state.field(suggestionField, false);
        if (!sug || !sug.text) return false;
        view.dispatch({
          changes: { from: sug.anchor, insert: sug.text },
          selection: { anchor: sug.anchor + sug.text.length },
          effects: setSuggestion.of(null),
        });
        return true;
      },
    },
    {
      key: 'Escape',
      run: (view) => {
        const sug = view.state.field(suggestionField, false);
        if (!sug) return false;
        view.dispatch({ effects: setSuggestion.of(null) });
        return true;
      },
    },
  ]),
);

/**
 * Public extension factory. `getEnabled` and `getDebounce` are read
 * lazily so settings updates take effect mid-session.
 */
export function inlineCompletion(opts: {
  getFilename: () => string;
  getEnabled: () => boolean;
  getDebounceMs: () => number;
}) {
  return [
    suggestionField,
    decorationsPlugin,
    completionFetchPlugin({
      getFilename: opts.getFilename,
      getDebounceMs: opts.getDebounceMs,
      isEnabled: opts.getEnabled,
    }),
    acceptKeymap,
    ghostTheme,
  ];
}
