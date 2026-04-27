import { Code, Columns2, Eye } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';

import { CodeMirrorPane } from '@renderer/components/Editor/CodeMirrorPane';
import { EditorTabs } from '@renderer/components/Editor/EditorTabs';
import { ImagePreview } from '@renderer/components/Editor/ImagePreview';
import { Resizer } from '@renderer/components/Layout/Resizer';

// Heavy view types — loaded on demand so the initial boot bundle stays lean.
// `@codemirror/merge` (DiffView), `react-markdown`+`highlight.js` (MarkdownPreview),
// and the Chromium PDF iframe each only matter once a matching tab opens.
const DiffView = lazy(() =>
  import('@renderer/components/Editor/DiffView').then((m) => ({ default: m.DiffView })),
);
const MarkdownPreview = lazy(() =>
  import('@renderer/components/Editor/MarkdownPreview').then((m) => ({
    default: m.MarkdownPreview,
  })),
);
const PdfPreview = lazy(() =>
  import('@renderer/components/Editor/PdfPreview').then((m) => ({ default: m.PdfPreview })),
);
import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import { useEditorStore, type PaneId } from '@renderer/state/editor';
import { useEditorViewStore } from '@renderer/state/editorView';
import { useLayoutStore } from '@renderer/state/layout';
import { getLanguageFromFileName } from '@renderer/utils/codemirrorLanguages';

export function EditorArea() {
  const splitTabs = useEditorStore((s) => s.splitTabs);
  const isSplit = splitTabs.length > 0;

  // Cmd+W via main-process menu closes the tab in the currently focused pane.
  useEffect(() => {
    return api.appEvents.onCloseTab(() => {
      const s = useEditorStore.getState();
      const pane = s.focusedPane;
      const path = pane === 'right' ? s.splitActivePath : s.activeTabPath;
      if (path) s.close(path, pane);
    });
  }, []);

  return (
    <div className="flex flex-1 overflow-hidden">
      <EditorPane pane="left" className="flex min-w-0 flex-1 flex-col" />
      {isSplit && (
        <>
          <div className="w-px shrink-0 bg-border" />
          <EditorPane pane="right" className="flex min-w-0 flex-1 flex-col" />
        </>
      )}
    </div>
  );
}

interface EditorPaneProps {
  pane: PaneId;
  className?: string;
}

function EditorPane({ pane, className }: EditorPaneProps) {
  const mainTabs = useEditorStore((s) => s.tabs);
  const mainActive = useEditorStore((s) => s.activeTabPath);
  const splitTabs = useEditorStore((s) => s.splitTabs);
  const splitActive = useEditorStore((s) => s.splitActivePath);
  const tabs = pane === 'right' ? splitTabs : mainTabs;
  const activeTabPath = pane === 'right' ? splitActive : mainActive;
  const updateContent = useEditorStore((s) => s.updateContent);
  const save = useEditorStore((s) => s.save);
  const clearPendingNav = useEditorStore((s) => s.clearPendingNav);
  const setFocusedPane = useEditorStore((s) => s.setFocusedPane);
  const moveToSplit = useEditorStore((s) => s.moveToSplit);
  const moveToMain = useEditorStore((s) => s.moveToMain);
  const focusedPane = useEditorStore((s) => s.focusedPane);
  const cursor = useEditorViewStore((s) => s.cursor);
  const wordWrap = useLayoutStore((s) => s.wordWrap);
  const editorFontSize = useLayoutStore((s) => s.editorFontSize);
  const [mdMode, setMdMode] = useState<'code' | 'preview' | 'split'>('split');
  const [dragOver, setDragOver] = useState(false);

  const activeTab = tabs.find((t) => t.path === activeTabPath) ?? null;
  const isFocused = focusedPane === pane;

  // Per-pane Cmd+S: only the focused pane should react.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isFocused) return;
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        if (activeTabPath) {
          e.preventDefault();
          void save(activeTabPath);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isFocused, activeTabPath, save]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const path = e.dataTransfer.getData('application/x-devspace-tab');
    if (!path) return;
    if (pane === 'right') {
      moveToSplit(path);
    } else {
      moveToMain(path);
    }
  };

  const onDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('application/x-devspace-tab')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  };

  return (
    <section
      className={className}
      onMouseDown={() => setFocusedPane(pane)}
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes('application/x-devspace-tab')) {
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="relative flex min-h-0 flex-1 flex-col">
        <EditorTabs pane={pane} />
        {!activeTab ? (
          <EmptyState pane={pane} />
        ) : activeTab.loading ? (
          <div className="flex flex-1 items-center justify-center text-text-muted">
            Loading {activeTab.name}…
          </div>
        ) : activeTab.error ? (
          <div className="flex flex-1 items-center justify-center text-semantic-error">
            <pre className="whitespace-pre-wrap px-6 text-[11px]">{activeTab.error}</pre>
          </div>
        ) : (
          <EditorBody
            tab={activeTab}
            onChange={(content) => updateContent(activeTab.path, content)}
            onSave={() => save(activeTab.path)}
            onNavDone={() => clearPendingNav(activeTab.path)}
            mdMode={mdMode}
          />
        )}
        {dragOver && (
          <div className="pointer-events-none absolute inset-2 rounded-md border-2 border-dashed border-accent/70 bg-accent/10" />
        )}
      </div>
      {activeTab && activeTab.kind === 'text' && (
        <StatusBar
          tab={activeTab}
          cursor={cursor && isFocused ? cursor : null}
          wordWrap={wordWrap}
          editorFontSize={editorFontSize}
          mdMode={mdMode}
          onMdMode={setMdMode}
        />
      )}
    </section>
  );
}

function EmptyState({ pane }: { pane: PaneId }) {
  return (
    <div className="flex flex-1 items-center justify-center text-text-muted">
      <div className="text-center">
        <div className="font-mono text-xs">
          {pane === 'right' ? 'Drop a tab here to split' : 'No file open'}
        </div>
        <div className="mt-2 text-[11px]">
          {pane === 'right'
            ? 'Or right-click a tab → Split Right'
            : 'Pick a file from the sidebar to start editing.'}
        </div>
      </div>
    </div>
  );
}

interface EditorBodyProps {
  tab: import('@renderer/state/editor').EditorTab;
  onChange: (content: string) => void;
  onSave: () => void;
  onNavDone: () => void;
  mdMode: 'code' | 'preview' | 'split';
}

function LazyFallback({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center text-[11px] text-text-muted">
      {label}
    </div>
  );
}

function EditorBody({ tab, onChange, onSave, onNavDone, mdMode }: EditorBodyProps) {
  const isMarkdown =
    tab.kind === 'text' && /\.(md|mdx|markdown)$/i.test(tab.name);

  return (
    <div className="min-h-0 flex-1">
      {tab.kind === 'image' ? (
        <ImagePreview tab={tab} />
      ) : tab.kind === 'pdf' ? (
        <Suspense fallback={<LazyFallback label="Loading PDF viewer…" />}>
          <PdfPreview tab={tab} />
        </Suspense>
      ) : tab.kind === 'diff' ? (
        <Suspense fallback={<LazyFallback label="Loading diff view…" />}>
          <DiffView
            key={tab.path}
            fileName={tab.diffRelPath ?? tab.name}
            oldContent={tab.diffOld ?? ''}
            newContent={tab.diffNew ?? ''}
          />
        </Suspense>
      ) : isMarkdown ? (
        <div className="flex h-full min-h-0">
          {mdMode !== 'preview' && (
            <div
              className={cn(
                'min-h-0 min-w-0',
                mdMode === 'split' ? 'flex-1 border-r border-border-subtle' : 'flex-1',
              )}
            >
              <CodeMirrorPane
                key={tab.path}
                path={tab.path}
                value={tab.content}
                onChange={onChange}
                onSave={onSave}
                pendingNav={tab.pendingNav}
                onNavDone={onNavDone}
              />
            </div>
          )}
          {mdMode !== 'code' && (
            <div className="min-h-0 min-w-0 flex-1">
              <Suspense fallback={<LazyFallback label="Loading preview…" />}>
                <MarkdownPreview markdown={tab.content} />
              </Suspense>
            </div>
          )}
        </div>
      ) : (
        <CodeMirrorPane
          key={tab.path}
          path={tab.path}
          value={tab.content}
          onChange={onChange}
          onSave={onSave}
          pendingNav={tab.pendingNav}
          onNavDone={onNavDone}
        />
      )}
    </div>
  );
}

interface StatusBarProps {
  tab: import('@renderer/state/editor').EditorTab;
  cursor: { line: number; column: number; selectionLength: number } | null;
  wordWrap: boolean;
  editorFontSize: number;
  mdMode: 'code' | 'preview' | 'split';
  onMdMode: (m: 'code' | 'preview' | 'split') => void;
}

function StatusBar({
  tab,
  cursor,
  wordWrap,
  editorFontSize,
  mdMode,
  onMdMode,
}: StatusBarProps) {
  const language = getLanguageFromFileName(tab.name);
  const isDirty = tab.content !== tab.savedContent;
  const isMarkdown = /\.(md|mdx|markdown)$/i.test(tab.name);
  return (
    <div
      className="flex h-6 shrink-0 items-center justify-between border-t border-border px-3 font-mono text-[10px] text-text-muted"
      style={{
        background: 'var(--color-surface-2)',
      }}
    >
      <span className="truncate">{tab.path}</span>
      <div className="flex items-center gap-3">
        {isMarkdown && (
          <div className="flex items-center gap-0.5 rounded-[5px] border border-border-subtle p-0.5">
            <ModeBtn active={mdMode === 'code'} onClick={() => onMdMode('code')} title="Code">
              <Code size={10} />
            </ModeBtn>
            <ModeBtn active={mdMode === 'split'} onClick={() => onMdMode('split')} title="Split">
              <Columns2 size={10} />
            </ModeBtn>
            <ModeBtn
              active={mdMode === 'preview'}
              onClick={() => onMdMode('preview')}
              title="Preview"
            >
              <Eye size={10} />
            </ModeBtn>
          </div>
        )}
        {cursor && (
          <span className="tabular-nums">
            Ln {cursor.line}, Col {cursor.column}
            {cursor.selectionLength > 0 && ` · ${cursor.selectionLength} sel`}
          </span>
        )}
        <span>UTF-8</span>
        <span>LF</span>
        <span>{editorFontSize}px</span>
        {wordWrap && <span>Wrap</span>}
        <span className="text-accent-2">{language}</span>
        <span className={isDirty ? 'text-semantic-warning' : 'text-semantic-success'}>
          {isDirty ? '● unsaved' : '✓ saved'}
        </span>
      </div>
    </div>
  );
}

interface ModeBtnProps {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}

function ModeBtn({ active, onClick, title, children }: ModeBtnProps) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        'flex h-4 w-4 items-center justify-center rounded-sm transition',
        active ? 'bg-surface-overlay text-text' : 'text-text-muted hover:text-text',
      )}
    >
      {children}
    </button>
  );
}

// Resizer re-export to avoid lint complaining about unused import.
export { Resizer as _EditorResizer };
