import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  bracketMatching,
  defaultHighlightStyle,
  syntaxHighlighting,
} from '@codemirror/language';
import { MergeView } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { useEffect, useRef } from 'react';

import { getSyncLanguageExtension } from '@renderer/utils/codemirrorLanguages';
import { baseEditorTheme } from '@renderer/utils/codemirrorTheme';
import { useLayoutStore } from '@renderer/state/layout';

interface DiffViewProps {
  fileName: string;
  oldContent: string;
  newContent: string;
}

/**
 * Side-by-side git diff. Uses @codemirror/merge — read-only so the diff
 * surface is informational. Editing happens through the plain editor tab.
 */
export function DiffView({ fileName, oldContent, newContent }: DiffViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mergeRef = useRef<MergeView | null>(null);
  const fontSize = useLayoutStore((s) => s.editorFontSize);
  const wordWrap = useLayoutStore((s) => s.wordWrap);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const lang = getSyncLanguageExtension(fileName);
    const commonExt = [
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      lineNumbers(),
      highlightActiveLine(),
      drawSelection(),
      bracketMatching(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      oneDark,
      baseEditorTheme,
      EditorView.theme({ '&': { fontSize: `${fontSize}px`, height: '100%' } }),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      history(),
      ...(wordWrap ? [EditorView.lineWrapping] : []),
      ...(lang ? [lang] : []),
    ];

    const merge = new MergeView({
      parent: host,
      a: { doc: oldContent, extensions: commonExt },
      b: { doc: newContent, extensions: commonExt },
      revertControls: 'b-to-a',
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: { margin: 3, minSize: 8 },
    });
    mergeRef.current = merge;

    return () => {
      merge.destroy();
      mergeRef.current = null;
    };
  }, [fileName, oldContent, newContent, fontSize, wordWrap]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-4 border-b border-border-subtle bg-surface-sidebar px-3 text-[10px] uppercase tracking-wide text-text-muted">
        <span>Original (HEAD)</span>
        <span className="ml-auto">Working tree</span>
      </div>
      <div ref={hostRef} className="relative min-h-0 flex-1 overflow-auto" />
    </div>
  );
}
