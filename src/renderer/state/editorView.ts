import type { EditorView } from '@codemirror/view';
import { create } from 'zustand';

export interface CursorInfo {
  line: number;
  column: number;
  selectionLength: number;
  totalLines: number;
  totalChars: number;
}

interface EditorViewState {
  view: EditorView | null;
  cursor: CursorInfo | null;
  setView: (view: EditorView | null) => void;
  setCursor: (c: CursorInfo | null) => void;
  getSelection: () => string;
}

export const useEditorViewStore = create<EditorViewState>((set, get) => ({
  view: null,
  cursor: null,
  setView: (view) => set({ view, cursor: view ? computeCursor(view) : null }),
  setCursor: (cursor) => set({ cursor }),
  getSelection: () => {
    const v = get().view;
    if (!v) return '';
    const { from, to } = v.state.selection.main;
    if (from === to) return '';
    return v.state.sliceDoc(from, to);
  },
}));

export function computeCursor(view: EditorView): CursorInfo {
  const sel = view.state.selection.main;
  const head = view.state.doc.lineAt(sel.head);
  return {
    line: head.number,
    column: sel.head - head.from + 1,
    selectionLength: sel.to - sel.from,
    totalLines: view.state.doc.lines,
    totalChars: view.state.doc.length,
  };
}
