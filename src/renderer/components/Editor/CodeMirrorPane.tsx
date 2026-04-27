import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
  defaultHighlightStyle,
} from '@codemirror/language';
import { lintKeymap } from '@codemirror/lint';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState } from '@codemirror/state';
import { useSyncExternalStore } from 'react';
import { oneDark } from '@codemirror/theme-one-dark';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { Clipboard, Copy, Scissors, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { cn } from '@renderer/lib/utils';
import {
  getAsyncLanguageDesc,
  getSyncLanguageExtension,
} from '@renderer/utils/codemirrorLanguages';
import { baseEditorTheme } from '@renderer/utils/codemirrorTheme';
import { computeCursor, useEditorViewStore } from '@renderer/state/editorView';
import { useLayoutStore } from '@renderer/state/layout';

interface CodeMirrorPaneProps {
  path: string;
  value: string;
  onChange: (value: string) => void;
  onSave?: () => void;
  pendingNav?: { line: number; column?: number };
  onNavDone?: () => void;
}

export function CodeMirrorPane({
  path,
  value,
  onChange,
  onSave,
  pendingNav,
  onNavDone,
}: CodeMirrorPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const languageCompartmentRef = useRef<Compartment | null>(null);
  const fontCompartmentRef = useRef<Compartment | null>(null);
  const wrapCompartmentRef = useRef<Compartment | null>(null);

  const fontSize = useLayoutStore((s) => s.editorFontSize);
  const wordWrap = useLayoutStore((s) => s.wordWrap);

  // React to font size / word-wrap changes without rebuilding the editor.
  useEffect(() => {
    const v = viewRef.current;
    const c = fontCompartmentRef.current;
    if (!v || !c) return;
    v.dispatch({
      effects: c.reconfigure(
        EditorView.theme({ '&': { fontSize: `${fontSize}px` } }),
      ),
    });
  }, [fontSize]);

  useEffect(() => {
    const v = viewRef.current;
    const c = wrapCompartmentRef.current;
    if (!v || !c) return;
    v.dispatch({
      effects: c.reconfigure(wordWrap ? EditorView.lineWrapping : []),
    });
  }, [wordWrap]);

  // Silence unused imports when not compiling with strict unused checks.
  void useSyncExternalStore;

  // Keep latest callbacks without recreating the editor view.
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  // Create editor once per tab (path change = new tab).
  useEffect(() => {
    if (!hostRef.current) return;

    const saveKey = keymap.of([
      {
        key: 'Mod-s',
        preventDefault: true,
        run() {
          onSaveRef.current?.();
          return true;
        },
      },
    ]);

    const syncLang = getSyncLanguageExtension(path);
    const languageCompartment = new Compartment();
    const fontCompartment = new Compartment();
    const wrapCompartment = new Compartment();
    languageCompartmentRef.current = languageCompartment;
    fontCompartmentRef.current = fontCompartment;
    wrapCompartmentRef.current = wrapCompartment;

    const initialFont = useLayoutStore.getState().editorFontSize;
    const initialWrap = useLayoutStore.getState().wordWrap;
    const fontThemeFor = (size: number) =>
      EditorView.theme({ '&': { fontSize: `${size}px` } });

    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          foldGutter(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          highlightSelectionMatches(),
          search({ top: true }),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          oneDark,
          baseEditorTheme,
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...foldKeymap,
            ...completionKeymap,
            ...lintKeymap,
            indentWithTab,
          ]),
          saveKey,
          languageCompartment.of(syncLang ?? []),
          fontCompartment.of(fontThemeFor(initialFont)),
          wrapCompartment.of(initialWrap ? EditorView.lineWrapping : []),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString());
            }
            if (update.docChanged || update.selectionSet) {
              useEditorViewStore.getState().setCursor(computeCursor(update.view));
            }
          }),
        ],
      }),
    });

    viewRef.current = view;
    useEditorViewStore.getState().setView(view);

    // Async fallback for rarer languages (TOML, Clojure, etc.) via language-data.
    if (!syncLang) {
      const desc = getAsyncLanguageDesc(path);
      if (desc) {
        desc
          .load()
          .then((support) => {
            view.dispatch({ effects: languageCompartment.reconfigure(support) });
          })
          .catch(() => undefined);
      }
    }

    return () => {
      view.destroy();
      if (viewRef.current === view) viewRef.current = null;
      if (useEditorViewStore.getState().view === view) {
        useEditorViewStore.getState().setView(null);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Sync external value changes (e.g. reload) without rebuilding the editor.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (view.state.doc.toString() === value) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
  }, [value]);

  // Consume pending navigation requests (Quick Open, search click, Cmd+G).
  useEffect(() => {
    if (!pendingNav) return;
    const view = viewRef.current;
    if (!view) return;
    // Wait for the content swap to commit before computing the target line.
    const id = requestAnimationFrame(() => {
      const v = viewRef.current;
      if (!v) return;
      const total = v.state.doc.lines;
      const line = Math.max(1, Math.min(total, pendingNav.line));
      const lineInfo = v.state.doc.line(line);
      const col = Math.max(0, Math.min(lineInfo.length, pendingNav.column ?? 0));
      const pos = lineInfo.from + col;
      v.dispatch({
        selection: { anchor: pos, head: pos },
        scrollIntoView: true,
        effects: EditorView.scrollIntoView(pos, { y: 'center' }),
      });
      v.focus();
      onNavDone?.();
    });
    return () => cancelAnimationFrame(id);
  }, [pendingNav, onNavDone]);

  // Re-evaluated each time the menu opens so disabled state (Copy/Cut/Delete
  // require a non-empty selection) reflects what's actually selected.
  const [hasSelection, setHasSelection] = useState(false);

  const refreshSelection = (): void => {
    const v = viewRef.current;
    const sel = v?.state.selection.main;
    setHasSelection(!!sel && sel.from !== sel.to);
  };

  const getSelectedText = (): string => {
    const v = viewRef.current;
    if (!v) return '';
    const { from, to } = v.state.selection.main;
    return from === to ? '' : v.state.sliceDoc(from, to);
  };

  const handleCopy = async (): Promise<void> => {
    const text = getSelectedText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard denied — silent fail is OK for menu actions */
    }
  };

  const handleCut = async (): Promise<void> => {
    const v = viewRef.current;
    if (!v) return;
    const { from, to } = v.state.selection.main;
    if (from === to) return;
    const text = v.state.sliceDoc(from, to);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* swallow — proceed with delete so the action still feels responsive */
    }
    v.dispatch({ changes: { from, to, insert: '' } });
    v.focus();
  };

  const handlePaste = async (): Promise<void> => {
    const v = viewRef.current;
    if (!v) return;
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return;
    }
    if (!text) return;
    const { from, to } = v.state.selection.main;
    v.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
    });
    v.focus();
  };

  const handleDelete = (): void => {
    const v = viewRef.current;
    if (!v) return;
    const { from, to } = v.state.selection.main;
    if (from === to) return;
    v.dispatch({ changes: { from, to, insert: '' } });
    v.focus();
  };

  const handleSelectAll = (): void => {
    const v = viewRef.current;
    if (!v) return;
    v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } });
    v.focus();
  };

  // `absolute inset-0` forces the CodeMirror container to track the parent's
  // real dimensions, which is what .cm-scroller needs to enable wheel scroll.
  // A plain `h-full` loses its height when a grandparent has shrinking flex.
  return (
    <ContextMenu.Root
      onOpenChange={(open) => {
        if (open) refreshSelection();
      }}
    >
      <ContextMenu.Trigger asChild>
        <div className="relative h-full w-full">
          <div ref={hostRef} className="absolute inset-0" />
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="z-50 min-w-[200px] rounded-md border border-border-emphasis bg-surface-raised p-1 text-xs shadow-lg animate-in fade-in-0 zoom-in-95"
          style={{ backgroundColor: 'var(--color-surface-raised)' }}
        >
          <EditorMenuItem
            icon={<Copy size={11} />}
            shortcut="⌘C"
            disabled={!hasSelection}
            onSelect={handleCopy}
          >
            Copy
          </EditorMenuItem>
          <EditorMenuItem
            icon={<Scissors size={11} />}
            shortcut="⌘X"
            disabled={!hasSelection}
            onSelect={handleCut}
          >
            Cut
          </EditorMenuItem>
          <EditorMenuItem
            icon={<Clipboard size={11} />}
            shortcut="⌘V"
            onSelect={handlePaste}
          >
            Paste
          </EditorMenuItem>
          <EditorMenuItem
            icon={<Trash2 size={11} />}
            disabled={!hasSelection}
            onSelect={handleDelete}
          >
            Delete
          </EditorMenuItem>
          <ContextMenu.Separator className="my-1 h-px bg-border-subtle" />
          <EditorMenuItem shortcut="⌘A" onSelect={handleSelectAll}>
            Select All
          </EditorMenuItem>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

interface EditorMenuItemProps {
  icon?: React.ReactNode;
  shortcut?: string;
  disabled?: boolean;
  children: React.ReactNode;
  onSelect: () => void | Promise<void>;
}

function EditorMenuItem({
  icon,
  shortcut,
  disabled,
  children,
  onSelect,
}: EditorMenuItemProps) {
  return (
    <ContextMenu.Item
      disabled={disabled}
      onSelect={() => {
        void onSelect();
      }}
      className={cn(
        'flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-[11.5px] outline-none',
        'data-[highlighted]:bg-surface-3',
        disabled && 'pointer-events-none opacity-40',
      )}
    >
      <span className="flex h-3 w-3 shrink-0 items-center justify-center text-text-muted">
        {icon}
      </span>
      <span className="flex-1">{children}</span>
      {shortcut && (
        <span className="ml-3 font-mono text-[10px] text-text-muted">{shortcut}</span>
      )}
    </ContextMenu.Item>
  );
}
