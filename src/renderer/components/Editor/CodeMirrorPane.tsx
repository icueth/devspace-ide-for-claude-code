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

import { inlineCompletion } from '@renderer/components/Editor/inlineCompletion';
import {
  SelectionEditDialog,
  type SelectionEditRequest,
} from '@renderer/components/Editor/SelectionEditDialog';
import { api } from '@renderer/lib/api';
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
  // Latest persisted LLM config — read by the inline-completion extension
  // on every keystroke. Refreshed on mount + on a window event the
  // Settings tab dispatches after a successful save so a flipped toggle
  // takes effect without remounting the editor.
  const llmConfigRef = useRef<{
    autocompleteEnabled: boolean;
    autocompleteDebounceMs: number;
  } | null>(null);

  const fontSize = useLayoutStore((s) => s.editorFontSize);
  const wordWrap = useLayoutStore((s) => s.wordWrap);

  // ⌘K → "edit this selection with AI" dialog. The keymap dispatcher
  // lives inside the CodeMirror extension list; we keep the request
  // payload (selection + line range + file context) in React state so
  // the dialog can render outside the editor without prop drilling.
  const [editRequest, setEditRequest] = useState<SelectionEditRequest | null>(
    null,
  );

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

  // Keep the LLM-config ref hot. Hydrate on mount and refresh whenever
  // the Settings tab announces a save via the `devspace:llm-config-saved`
  // event so a toggle flip takes effect immediately, no remount needed.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const cfg = await api.llm.getConfig();
        if (!cancelled) {
          llmConfigRef.current = {
            autocompleteEnabled: cfg.autocompleteEnabled,
            autocompleteDebounceMs: cfg.autocompleteDebounceMs,
          };
        }
      } catch {
        /* leave ref null — autocomplete just stays off */
      }
    };
    void refresh();
    const handler = () => void refresh();
    window.addEventListener('devspace:llm-config-saved', handler);
    return () => {
      cancelled = true;
      window.removeEventListener('devspace:llm-config-saved', handler);
    };
  }, []);

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

    // ⌘K — pop the AI selection-edit dialog. Bound via CodeMirror's own
    // keymap so it wins over OS-level shortcuts when the editor has
    // focus. No-ops without a selection; otherwise grabs ~6KB of file
    // context around the selection for the model.
    const editSelectionKey = keymap.of([
      {
        key: 'Mod-k',
        preventDefault: true,
        run(view) {
          const sel = view.state.selection.main;
          if (sel.empty) return false;
          const selection = view.state.sliceDoc(sel.from, sel.to);
          // Symmetric ~3KB context around the selection — keeps the
          // payload bounded on huge files but still gives the model
          // enough surrounding code to match style and pick up imports.
          const docText = view.state.doc.toString();
          const ctxStart = Math.max(0, sel.from - 3000);
          const ctxEnd = Math.min(docText.length, sel.to + 3000);
          const startLine = view.state.doc.lineAt(sel.from).number;
          const endLine = view.state.doc.lineAt(sel.to).number;
          setEditRequest({
            selection,
            context: docText.slice(ctxStart, ctxEnd),
            filename: path,
            startLine,
            endLine,
          });
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
          // LLM-driven inline ghost-text autocomplete. The extension
          // polls the latest persisted config on every keystroke (cheap
          // — it's a synchronous lookup of the cached config the main
          // process pushed at boot via preloadLlmConfig). Toggling the
          // setting takes effect mid-session without reloading the
          // editor.
          inlineCompletion({
            getFilename: () => path,
            getEnabled: () => llmConfigRef.current?.autocompleteEnabled ?? false,
            getDebounceMs: () =>
              llmConfigRef.current?.autocompleteDebounceMs ?? 500,
          }),
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
          editSelectionKey,
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

  const acceptEdit = (newText: string) => {
    const view = viewRef.current;
    if (!view) return;
    const sel = view.state.selection.main;
    // The selection range may have shifted slightly during the round
    // trip if the user typed elsewhere; the safer move would be to
    // remember the original from/to and reuse those, but in practice
    // ⌘K is modal-blocking so the selection is still where it was.
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: newText },
      selection: { anchor: sel.from + newText.length },
    });
    setEditRequest(null);
    view.focus();
  };

  // `absolute inset-0` forces the CodeMirror container to track the parent's
  // real dimensions, which is what .cm-scroller needs to enable wheel scroll.
  // A plain `h-full` loses its height when a grandparent has shrinking flex.
  return (
    <>
    <SelectionEditDialog
      open={editRequest !== null}
      request={editRequest}
      onCancel={() => setEditRequest(null)}
      onAccept={acceptEdit}
    />
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
    </>
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
