import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import {
  bracketMatching,
  syntaxHighlighting,
  defaultHighlightStyle,
} from '@codemirror/language';
import { lintGutter, linter, type Diagnostic } from '@codemirror/lint';
import { EditorState } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap, search } from '@codemirror/search';
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  FileText,
  KeyRound,
  Save,
  Server,
  Settings as SettingsIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { AccountSettings } from '@renderer/components/Settings/AccountSettings';
import { TmuxSection } from '@renderer/components/Settings/TmuxSection';
import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import { baseEditorTheme } from '@renderer/utils/codemirrorTheme';
import { useWorkspaceStore } from '@renderer/state/workspace';
import type { SettingsCategory, SettingsFile } from '@shared/types';

type Tab = 'account' | 'files' | 'tmux';

interface SettingsPageProps {
  onClose: () => void;
  initialTab?: Tab;
}

/**
 * Full-page Claude settings — replaces the editor/dock area when open.
 * Three tabs:
 *   • Account — flips between Subscription and Custom API mode by writing
 *     env vars into ~/.claude/settings.json.
 *   • Files   — raw browser of every config file under ~/.claude (and the
 *     active project's .claude/, plus .mcp.json) with syntax-aware editing
 *     and explicit Save.
 *   • tmux    — live list of tmux sessions DevSpace (and others) have
 *     spawned, with rename / kill controls.
 */
export function SettingsPage({ onClose, initialTab = 'account' }: SettingsPageProps) {
  const [tab, setTab] = useState<Tab>(initialTab);

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-surface">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-surface-2/70 px-4">
        <button
          type="button"
          onClick={onClose}
          title="Back to editor (Esc)"
          className="flex items-center gap-1 rounded-[6px] border border-border bg-surface-3 px-2 py-1 text-[11px] text-text-secondary transition hover:border-border-hi hover:bg-surface-4 hover:text-text"
        >
          <ArrowLeft size={11} />
          Back
        </button>
        <span
          className="flex h-6 w-6 items-center justify-center rounded-[7px] text-white"
          style={{
            background: 'linear-gradient(135deg, var(--color-accent), #a855f7)',
            boxShadow: '0 0 12px rgba(76,141,255,0.3)',
          }}
        >
          <SettingsIcon size={12} strokeWidth={2.5} />
        </span>
        <h2 className="text-[13px] font-semibold text-text">Claude · Settings</h2>
        <span className="text-[10.5px] text-text-muted">
          Configs in <code className="font-mono">~/.claude</code>
        </span>
        <div className="flex-1" />
        <TabSwitch tab={tab} onChange={setTab} />
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === 'account' && <AccountSettings />}
        {tab === 'files' && <FilesSettings />}
        {tab === 'tmux' && <TmuxSection />}
      </div>
    </section>
  );
}

function TabSwitch({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  const tabs: Array<{ id: Tab; label: string; icon: React.ReactNode }> = [
    { id: 'account', label: 'Account', icon: <KeyRound size={11} /> },
    { id: 'files', label: 'Files', icon: <FileText size={11} /> },
    { id: 'tmux', label: 'tmux', icon: <Server size={11} /> },
  ];
  return (
    <div className="flex items-center gap-0.5 rounded-[7px] border border-border bg-surface-2 p-[2px]">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={cn(
            'flex h-[24px] items-center gap-1 rounded-[5px] px-2.5 text-[11px] transition',
            tab === t.id
              ? 'bg-surface-3 text-text shadow-[0_0_0_1px_rgba(76,141,255,0.25)]'
              : 'text-text-muted hover:text-text',
          )}
        >
          {t.icon}
          {t.label}
        </button>
      ))}
    </div>
  );
}

function FilesSettings() {
  const activeProject = useWorkspaceStore((s) => {
    const id = s.activeProjectId;
    return s.projects.find((p) => p.id === id) ?? null;
  });

  const [categories, setCategories] = useState<SettingsCategory[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<SettingsFile | null>(null);
  const [content, setContent] = useState<string>('');
  const [originalContent, setOriginalContent] = useState<string>('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'ok'; ts: number }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  useEffect(() => {
    let cancelled = false;
    void api.settings
      .list(activeProject?.path ?? null)
      .then((cats) => {
        if (cancelled) return;
        setCategories(cats);
        if (!selected && cats.length > 0) {
          const preferred =
            cats[0]!.files.find((f) => f.label === 'settings.json') ??
            cats[0]!.files[0];
          if (preferred) setSelected(preferred);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.path]);

  useEffect(() => {
    if (!selected) {
      setContent('');
      setOriginalContent('');
      return;
    }
    let cancelled = false;
    setLoadError(null);
    setSaveStatus({ kind: 'idle' });
    void api.settings
      .read(selected.path)
      .then((text) => {
        if (cancelled) return;
        setContent(text);
        setOriginalContent(text);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const dirty = content !== originalContent;

  const handleSave = async (): Promise<void> => {
    if (!selected || saving) return;
    setSaving(true);
    setSaveStatus({ kind: 'idle' });
    try {
      await api.settings.write(selected.path, content);
      setOriginalContent(content);
      setSaveStatus({ kind: 'ok', ts: Date.now() });
    } catch (err) {
      setSaveStatus({ kind: 'error', message: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  // Cmd+S at the page level (in addition to CodeMirror's own keymap).
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, content, saving]);

  return (
    <div className="flex h-full">
      <aside
        className="flex w-[260px] shrink-0 flex-col overflow-y-auto border-r border-border"
        style={{ background: 'var(--color-surface-2)' }}
      >
        {categories.length === 0 && (
          <div className="px-4 py-6 text-[11px] text-text-muted">
            No configs found yet.
          </div>
        )}
        {categories.map((cat) => {
          const isCollapsed = collapsed[cat.id] ?? false;
          return (
            <div key={cat.id} className="flex flex-col">
              <button
                type="button"
                onClick={() =>
                  setCollapsed((prev) => ({ ...prev, [cat.id]: !isCollapsed }))
                }
                className="flex items-center gap-1 border-b border-border-subtle bg-surface-3/40 px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-wide text-text-muted transition hover:bg-surface-3 hover:text-text"
              >
                {isCollapsed ? (
                  <ChevronRight size={10} />
                ) : (
                  <ChevronDown size={10} />
                )}
                <span className="flex-1">{cat.label}</span>
                {cat.scope === 'project' && (
                  <span className="rounded-full bg-[rgba(168,85,247,0.15)] px-1.5 py-0.5 text-[8.5px] text-[#d8b4fe]">
                    proj
                  </span>
                )}
              </button>
              {!isCollapsed && (
                <div className="flex flex-col py-1">
                  {cat.files.map((f) => {
                    const isActive = selected?.path === f.path;
                    return (
                      <button
                        key={f.path}
                        type="button"
                        onClick={() => setSelected(f)}
                        title={f.path}
                        className={cn(
                          'flex items-center gap-2 px-3 py-1.5 text-left text-[11.5px] transition',
                          isActive
                            ? 'bg-[rgba(76,141,255,0.18)] text-text'
                            : 'text-text-secondary hover:bg-surface-3 hover:text-text',
                        )}
                      >
                        <FileText
                          size={11}
                          className={cn(
                            'shrink-0',
                            f.kind === 'json'
                              ? 'text-[#fbbf24]'
                              : f.kind === 'markdown'
                                ? 'text-[#86efac]'
                                : 'text-text-muted',
                          )}
                        />
                        <span className="truncate">{f.label}</span>
                        <span className="ml-auto font-mono text-[9px] uppercase text-text-muted">
                          {f.kind}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center gap-3 border-b border-border bg-surface-2/60 px-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {selected ? (
              <>
                <span className="truncate font-mono text-[10.5px] text-text-muted">
                  {selected.path.replace(/^\/Users\/[^/]+/, '~')}
                </span>
                {dirty && (
                  <span className="rounded-full bg-[rgba(245,158,11,0.18)] px-2 py-[1px] text-[9px] font-semibold uppercase tracking-wide text-[#fcd34d]">
                    modified
                  </span>
                )}
              </>
            ) : (
              <span className="text-[11px] text-text-muted">No file selected</span>
            )}
          </div>
          {saveStatus.kind === 'ok' && (
            <span className="text-[10.5px] text-semantic-success">Saved</span>
          )}
          {saveStatus.kind === 'error' && (
            <span className="truncate text-[10.5px] text-semantic-error">
              {saveStatus.message}
            </span>
          )}
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!selected || !dirty || saving}
            className={cn(
              'inline-flex items-center gap-1 rounded-[6px] px-3 py-[5px] text-[11px] font-medium transition',
              !selected || !dirty || saving
                ? 'pointer-events-none border border-border bg-surface-3 text-text-muted opacity-50'
                : 'text-white hover:brightness-110',
            )}
            style={
              !selected || !dirty || saving
                ? undefined
                : {
                    background:
                      'linear-gradient(135deg, var(--color-accent), var(--color-accent-3))',
                    boxShadow: '0 2px 8px rgba(76,141,255,0.25)',
                  }
            }
          >
            <Save size={11} />
            {saving ? 'Saving…' : 'Save (⌘S)'}
          </button>
        </div>
        {loadError && (
          <div className="border-b border-border-subtle bg-semantic-error/10 px-4 py-2 text-[11px] text-semantic-error">
            Load failed: {loadError}
          </div>
        )}
        <div className="min-h-0 flex-1">
          {selected ? (
            <FileEditor
              key={selected.path}
              file={selected}
              value={content}
              onChange={setContent}
              onSave={() => void handleSave()}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-[12px] text-text-muted">
              Select a config file from the left to start editing.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface FileEditorProps {
  file: SettingsFile;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
}

function FileEditor({ file, value, onChange, onSave }: FileEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    if (!hostRef.current) return;

    const langExt =
      file.kind === 'json'
        ? [json(), linter(jsonLinter)]
        : file.kind === 'markdown'
          ? [markdown()]
          : [];

    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          drawSelection(),
          history(),
          bracketMatching(),
          closeBrackets(),
          search({ top: true }),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          oneDark,
          baseEditorTheme,
          lintGutter(),
          ...langExt,
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            {
              key: 'Mod-s',
              preventDefault: true,
              run() {
                onSaveRef.current();
                return true;
              },
            },
          ]),
          EditorView.theme({ '&': { fontSize: '12.5px', height: '100%' } }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path, file.kind]);

  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    if (v.state.doc.toString() === value) return;
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: value },
    });
  }, [value]);

  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} className="absolute inset-0" />
    </div>
  );
}

function jsonLinter(view: EditorView): Diagnostic[] {
  const text = view.state.doc.toString();
  if (!text.trim()) return [];
  try {
    JSON.parse(text);
    return [];
  } catch (err) {
    const message = (err as Error).message;
    const match = /position (\d+)/.exec(message);
    const pos = match ? Math.min(text.length, parseInt(match[1]!, 10)) : 0;
    return [
      {
        from: pos,
        to: Math.min(text.length, pos + 1),
        severity: 'error',
        message,
      },
    ];
  }
}
