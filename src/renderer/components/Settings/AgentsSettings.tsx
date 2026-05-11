import { markdown } from '@codemirror/lang-markdown';
import {
  bracketMatching,
  syntaxHighlighting,
  defaultHighlightStyle,
} from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Copy,
  Folder,
  FolderOpen,
  Globe,
  Plus,
  Save,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import { useWorkspaceStore } from '@renderer/state/workspace';
import { baseEditorTheme } from '@renderer/utils/codemirrorTheme';
import type { AgentDef, AgentScope } from '@shared/types';

const MODEL_OPTIONS = ['', 'sonnet', 'opus', 'haiku'];
const TOOL_OPTIONS = [
  'Read',
  'Edit',
  'Write',
  'Bash',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
  'TodoWrite',
  'NotebookEdit',
];

/**
 * Settings tab for managing Claude Code agent files. Lists global
 * (~/.claude/agents/) and project (<project>/.claude/agents/) markdown
 * files; each click loads the parsed frontmatter into a form + the body
 * into a CodeMirror editor. Save round-trips through AgentsService
 * which re-serializes preserving unknown frontmatter keys (so custom
 * fields like `skills:` or `memory:` aren't dropped on edit).
 */
export function AgentsSettings() {
  const activeProject = useWorkspaceStore((s) => {
    const id = s.activeProjectId;
    return s.projects.find((p) => p.id === id) ?? null;
  });

  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [collapsed, setCollapsed] = useState<Record<AgentScope, boolean>>({
    global: false,
    project: false,
  });
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [draft, setDraft] = useState<AgentDef | null>(null);
  const [original, setOriginal] = useState<AgentDef | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creatingScope, setCreatingScope] = useState<AgentScope | null>(null);
  const [newSlug, setNewSlug] = useState('');

  const reload = useCallback(async () => {
    const list = await api.agents.list(activeProject?.path ?? null);
    setAgents(list);
    return list;
  }, [activeProject?.path]);

  useEffect(() => {
    void reload().then((list) => {
      if (!selectedPath && list.length > 0) setSelectedPath(list[0]!.path);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.path]);

  useEffect(() => {
    if (!selectedPath) {
      setDraft(null);
      setOriginal(null);
      return;
    }
    setError(null);
    void api.agents
      .read(selectedPath)
      .then((agent) => {
        setDraft(agent);
        setOriginal(agent);
      })
      .catch((err: unknown) => setError((err as Error).message));
  }, [selectedPath]);

  const dirty = useMemo(() => {
    if (!draft || !original) return false;
    return JSON.stringify(draft) !== JSON.stringify(original);
  }, [draft, original]);

  const grouped = useMemo(() => {
    const g: Record<AgentScope, AgentDef[]> = { global: [], project: [] };
    for (const a of agents) g[a.scope].push(a);
    return g;
  }, [agents]);

  const onSave = useCallback(async () => {
    if (!draft || saving) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await api.agents.save(draft);
      setDraft(saved);
      setOriginal(saved);
      // Refresh the list so name changes propagate to the sidebar label.
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [draft, saving, reload]);

  const onDelete = useCallback(async () => {
    if (!draft) return;
    const ok = window.confirm(
      `Delete agent "${draft.name}"? This removes ${draft.path}.`,
    );
    if (!ok) return;
    try {
      await api.agents.delete(draft.path);
      setSelectedPath(null);
      setDraft(null);
      setOriginal(null);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [draft, reload]);

  const onDuplicate = useCallback(async () => {
    if (!draft) return;
    const newName = window.prompt(
      'New agent slug (lowercase, hyphenated):',
      `${draft.slug}-copy`,
    );
    if (!newName) return;
    try {
      const fresh = await api.agents.create(
        draft.scope,
        draft.scope === 'project' ? (activeProject?.path ?? null) : null,
        newName,
      );
      // Copy fields from draft, then save.
      const next: AgentDef = {
        ...fresh,
        name: fresh.slug,
        description: draft.description,
        model: draft.model,
        tools: draft.tools,
        color: draft.color,
        body: draft.body,
        extra: draft.extra,
      };
      const saved = await api.agents.save(next);
      await reload();
      setSelectedPath(saved.path);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [draft, activeProject?.path, reload]);

  const onCreate = useCallback(
    async (scope: AgentScope) => {
      if (!newSlug.trim()) return;
      try {
        const fresh = await api.agents.create(
          scope,
          scope === 'project' ? (activeProject?.path ?? null) : null,
          newSlug.trim(),
        );
        await reload();
        setSelectedPath(fresh.path);
        setCreatingScope(null);
        setNewSlug('');
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [newSlug, activeProject?.path, reload],
  );

  return (
    <div className="flex h-full">
      <aside
        className="flex w-[280px] shrink-0 flex-col overflow-y-auto border-r border-border"
        style={{ background: 'var(--color-surface-2)' }}
      >
        {(['global', 'project'] as AgentScope[]).map((scope) => {
          const list = grouped[scope];
          const isCollapsed = collapsed[scope];
          const canCreate =
            scope === 'global' || (scope === 'project' && !!activeProject);
          return (
            <div key={scope} className="flex flex-col">
              <div className="flex items-center gap-1 border-b border-border-subtle bg-surface-3/40 px-2 py-2">
                <button
                  onClick={() =>
                    setCollapsed((p) => ({ ...p, [scope]: !isCollapsed }))
                  }
                  className="flex flex-1 items-center gap-1 text-left text-[10.5px] font-semibold uppercase tracking-wide text-text-muted transition hover:text-text"
                >
                  {isCollapsed ? (
                    <ChevronRight size={10} />
                  ) : (
                    <ChevronDown size={10} />
                  )}
                  {scope === 'global' ? <Globe size={11} /> : <Folder size={11} />}
                  <span className="flex-1">
                    {scope === 'global' ? 'Global' : 'Project'}
                  </span>
                  <span className="text-text-dim">({list.length})</span>
                </button>
                {canCreate && (
                  <button
                    onClick={() => {
                      setCreatingScope(scope);
                      setNewSlug('');
                    }}
                    title={`New ${scope} agent`}
                    className="rounded p-1 text-text-muted transition hover:bg-surface-3 hover:text-text"
                  >
                    <Plus size={11} />
                  </button>
                )}
              </div>
              {!isCollapsed && (
                <div className="flex flex-col py-1">
                  {creatingScope === scope && (
                    <div className="flex items-center gap-1 px-2 py-1.5">
                      <input
                        type="text"
                        value={newSlug}
                        onChange={(e) => setNewSlug(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void onCreate(scope);
                          if (e.key === 'Escape') setCreatingScope(null);
                        }}
                        autoFocus
                        placeholder="agent-slug"
                        className="min-w-0 flex-1 rounded-[5px] border border-border-subtle bg-surface-3 px-2 py-1 font-mono text-[11px] text-text placeholder:text-text-dim focus:border-accent focus:outline-none"
                      />
                      <button
                        onClick={() => void onCreate(scope)}
                        className="rounded-[5px] bg-accent px-2 py-1 text-[10px] text-white hover:brightness-110"
                      >
                        Add
                      </button>
                    </div>
                  )}
                  {list.length === 0 && creatingScope !== scope && (
                    <div className="px-3 py-2 text-[10.5px] text-text-dim">
                      No agents here yet.
                    </div>
                  )}
                  {list.map((a) => {
                    const isActive = selectedPath === a.path;
                    return (
                      <button
                        key={a.path}
                        onClick={() => setSelectedPath(a.path)}
                        title={a.description || a.slug}
                        className={cn(
                          'flex items-center gap-2 px-3 py-1.5 text-left text-[11.5px] transition',
                          isActive
                            ? 'bg-[rgba(76,141,255,0.18)] text-text'
                            : 'text-text-secondary hover:bg-surface-3 hover:text-text',
                        )}
                      >
                        <Bot
                          size={11}
                          className="shrink-0"
                          style={a.color ? { color: cssColor(a.color) } : undefined}
                        />
                        <span className="min-w-0 flex-1 truncate font-mono">
                          {a.name}
                        </span>
                        {a.model && (
                          <span className="shrink-0 rounded-full bg-surface-3 px-1.5 text-[9px] uppercase text-text-muted">
                            {a.model}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {!activeProject && (
          <div className="mt-auto px-3 py-3 text-[10px] text-text-dim">
            Open a project to enable project-scoped agents.
          </div>
        )}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {draft ? (
          <AgentEditor
            agent={draft}
            dirty={dirty}
            saving={saving}
            error={error}
            onChange={setDraft}
            onSave={onSave}
            onDelete={onDelete}
            onDuplicate={onDuplicate}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-[12px] text-text-muted">
            <div className="text-center">
              <FolderOpen size={24} className="mx-auto mb-2 text-text-dim" />
              <div>Select an agent from the left to edit it.</div>
              <div className="mt-1 text-[10.5px] text-text-dim">
                Or click <Plus size={9} className="-mt-0.5 inline" /> to create a new one.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface AgentEditorProps {
  agent: AgentDef;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  onChange: (next: AgentDef) => void;
  onSave: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
}

function AgentEditor({
  agent,
  dirty,
  saving,
  error,
  onChange,
  onSave,
  onDelete,
  onDuplicate,
}: AgentEditorProps) {
  const update = useCallback(
    (patch: Partial<AgentDef>) => onChange({ ...agent, ...patch }),
    [agent, onChange],
  );

  const toggleTool = useCallback(
    (toolId: string) => {
      const current = agent.tools ?? [];
      const next = current.includes(toolId)
        ? current.filter((t) => t !== toolId)
        : [...current, toolId];
      update({ tools: next.length === 0 ? undefined : next });
    },
    [agent.tools, update],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (dirty) onSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dirty, onSave]);

  return (
    <>
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-border bg-surface-2/60 px-3">
        <span className="truncate font-mono text-[10.5px] text-text-muted">
          {agent.path.replace(/^\/Users\/[^/]+/, '~')}
        </span>
        {dirty && (
          <span className="rounded-full bg-[rgba(245,158,11,0.18)] px-2 py-[1px] text-[9px] font-semibold uppercase tracking-wide text-[#fcd34d]">
            modified
          </span>
        )}
        <div className="flex-1" />
        {error && (
          <span className="truncate text-[10.5px] text-semantic-error">{error}</span>
        )}
        <button
          onClick={onDuplicate}
          title="Duplicate this agent"
          className="rounded p-1 text-text-muted transition hover:bg-surface-3 hover:text-text"
        >
          <Copy size={12} />
        </button>
        <button
          onClick={onDelete}
          title="Delete this agent"
          className="rounded p-1 text-text-muted transition hover:bg-surface-3 hover:text-semantic-error"
        >
          <Trash2 size={12} />
        </button>
        <button
          onClick={onSave}
          disabled={!dirty || saving}
          className={cn(
            'inline-flex items-center gap-1 rounded-[6px] px-3 py-[5px] text-[11px] font-medium transition',
            !dirty || saving
              ? 'pointer-events-none border border-border bg-surface-3 text-text-muted opacity-50'
              : 'text-white hover:brightness-110',
          )}
          style={
            !dirty || saving
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

      <div className="grid min-h-0 flex-1 grid-cols-[320px_1fr]">
        <div className="overflow-y-auto border-r border-border bg-surface-2/40 p-3">
          <FormField label="Name" hint="Lowercase, hyphenated identifier">
            <input
              type="text"
              value={agent.name}
              onChange={(e) => update({ name: e.target.value })}
              className="w-full rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-1.5 font-mono text-[11.5px] text-text focus:border-accent focus:outline-none"
            />
          </FormField>

          <FormField
            label="Description"
            hint="When should Claude dispatch to this agent?"
          >
            <textarea
              value={agent.description}
              onChange={(e) => update({ description: e.target.value })}
              rows={3}
              className="w-full resize-none rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-1.5 text-[11.5px] text-text focus:border-accent focus:outline-none"
            />
          </FormField>

          <FormField label="Model" hint="Override the default Claude model">
            <div className="flex flex-wrap gap-1">
              {MODEL_OPTIONS.map((m) => (
                <button
                  key={m || 'default'}
                  onClick={() => update({ model: m || undefined })}
                  className={cn(
                    'rounded-[5px] border px-2 py-1 text-[10.5px] transition',
                    (agent.model ?? '') === m
                      ? 'border-accent bg-accent/10 text-text'
                      : 'border-border-subtle bg-surface-3 text-text-secondary hover:border-border-hi hover:text-text',
                  )}
                >
                  {m || 'default'}
                </button>
              ))}
            </div>
          </FormField>

          <FormField
            label="Color"
            hint="Sidebar dot color (CSS color or claude alias)"
          >
            <input
              type="text"
              value={agent.color ?? ''}
              onChange={(e) => update({ color: e.target.value || undefined })}
              placeholder="blue, green, #a855f7…"
              className="w-full rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-1.5 font-mono text-[11px] text-text placeholder:text-text-dim focus:border-accent focus:outline-none"
            />
          </FormField>

          <FormField
            label="Tools"
            hint={
              agent.tools === undefined
                ? 'All tools allowed (default)'
                : `Restricted to ${agent.tools.length} tool(s)`
            }
            action={
              agent.tools !== undefined ? (
                <button
                  onClick={() => update({ tools: undefined })}
                  className="text-[10px] text-accent hover:underline"
                >
                  allow all
                </button>
              ) : null
            }
          >
            <div className="grid grid-cols-2 gap-1">
              {TOOL_OPTIONS.map((t) => {
                const checked = !agent.tools || agent.tools.includes(t);
                return (
                  <label
                    key={t}
                    className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-surface-3"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleTool(t)}
                      className="h-3 w-3 accent-accent"
                    />
                    <span className="font-mono text-[10.5px] text-text-secondary">
                      {t}
                    </span>
                  </label>
                );
              })}
            </div>
          </FormField>

          {Object.keys(agent.extra).length > 0 && (
            <div className="mt-3 rounded-[6px] border border-border-subtle bg-surface/40 p-2">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                Extra frontmatter
              </div>
              <div className="text-[10px] text-text-dim">
                {Object.keys(agent.extra)
                  .filter((k) => !k.startsWith('__line_'))
                  .join(', ') || '(preserved verbatim)'}
              </div>
            </div>
          )}
        </div>

        <BodyEditor
          key={agent.path}
          value={agent.body}
          onChange={(body) => update({ body })}
          onSave={onSave}
        />
      </div>
    </>
  );
}

function FormField({
  label,
  hint,
  action,
  children,
}: {
  label: string;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-baseline justify-between">
        <div className="text-[11px] font-medium text-text">
          {label}
          {hint && (
            <span className="ml-1.5 text-[10px] font-normal text-text-dim">
              {hint}
            </span>
          )}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

interface BodyEditorProps {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
}

function BodyEditor({ value, onChange, onSave }: BodyEditorProps) {
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
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          highlightActiveLine(),
          drawSelection(),
          history(),
          bracketMatching(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          oneDark,
          baseEditorTheme,
          markdown(),
          keymap.of([
            ...defaultKeymap,
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
          EditorView.theme({
            '&': { fontSize: '12.5px', height: '100%' },
            '.cm-content': { padding: '12px' },
          }),
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
  }, []);

  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    if (v.state.doc.toString() === value) return;
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: value },
    });
  }, [value]);

  return (
    <div className="relative min-h-0">
      <div ref={hostRef} className="absolute inset-0" />
    </div>
  );
}

// Claude's `color:` field accepts named CSS colors (red, blue, green, …)
// and also a handful of palette aliases. We just trust it as a CSS color
// — invalid values render no dot, which is fine.
function cssColor(name: string): string {
  return name.startsWith('#') || name.includes('(') ? name : name;
}
