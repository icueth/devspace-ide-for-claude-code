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
  ChevronDown,
  ChevronRight,
  Copy,
  Folder,
  Globe,
  Lightbulb,
  Lock,
  Package,
  Plus,
  Save,
  Search,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import { useWorkspaceStore } from '@renderer/state/workspace';
import { baseEditorTheme } from '@renderer/utils/codemirrorTheme';
import type { SkillDef, SkillScope } from '@shared/types';

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
];

/**
 * Settings tab for Claude Code skills (~/.claude/skills/<name>/SKILL.md).
 * Lists user-created and project skills as editable; plugin-managed
 * skills (under ~/.claude/plugins/marketplaces/) are read-only — the
 * marketplace tooling owns their lifecycle.
 *
 * Skills are typically numerous (100+ from anthropic-agent-skills alone)
 * so the sidebar is virtualization-friendly (sorted list + a small
 * filter input). Plugin skills are off by default to keep the initial
 * load fast; a toggle pulls them in.
 */
export function SkillsSettings() {
  const activeProject = useWorkspaceStore((s) => {
    const id = s.activeProjectId;
    return s.projects.find((p) => p.id === id) ?? null;
  });

  const [skills, setSkills] = useState<SkillDef[]>([]);
  const [includePlugins, setIncludePlugins] = useState(false);
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Record<SkillScope, boolean>>({
    global: false,
    project: false,
    plugin: true,
  });
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [draft, setDraft] = useState<SkillDef | null>(null);
  const [original, setOriginal] = useState<SkillDef | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creatingScope, setCreatingScope] = useState<'global' | 'project' | null>(
    null,
  );
  const [newSlug, setNewSlug] = useState('');

  const reload = useCallback(async () => {
    const list = await api.skills.list(activeProject?.path ?? null, includePlugins);
    setSkills(list);
    return list;
  }, [activeProject?.path, includePlugins]);

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.path, includePlugins]);

  useEffect(() => {
    if (!selectedPath) {
      setDraft(null);
      setOriginal(null);
      return;
    }
    setError(null);
    void api.skills
      .read(selectedPath)
      .then((s) => {
        setDraft(s);
        setOriginal(s);
      })
      .catch((err: unknown) => setError((err as Error).message));
  }, [selectedPath]);

  const dirty = useMemo(() => {
    if (!draft || !original) return false;
    return JSON.stringify(draft) !== JSON.stringify(original);
  }, [draft, original]);

  const grouped = useMemo(() => {
    const q = filter.toLowerCase();
    const matches = (s: SkillDef) =>
      !q ||
      s.slug.toLowerCase().includes(q) ||
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q);
    const g: Record<SkillScope, SkillDef[]> = {
      global: [],
      project: [],
      plugin: [],
    };
    for (const s of skills) if (matches(s)) g[s.scope].push(s);
    return g;
  }, [skills, filter]);

  const readOnly = draft?.scope === 'plugin';

  const onSave = useCallback(async () => {
    if (!draft || readOnly || saving) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await api.skills.save(draft);
      setDraft(saved);
      setOriginal(saved);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [draft, readOnly, saving, reload]);

  const onDelete = useCallback(async () => {
    if (!draft || readOnly) return;
    const ok = window.confirm(
      `Delete skill "${draft.name}"?\nThis removes the entire folder at ${draft.path.replace(/\/SKILL\.md$/, '')}.`,
    );
    if (!ok) return;
    try {
      await api.skills.delete(draft.path);
      setSelectedPath(null);
      setDraft(null);
      setOriginal(null);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [draft, readOnly, reload]);

  const onDuplicate = useCallback(async () => {
    if (!draft) return;
    // Plugin → user clone gives users a way to customize without touching
    // the marketplace.
    const newName = window.prompt(
      'New skill slug (lowercase, hyphenated):',
      `${draft.slug}-copy`,
    );
    if (!newName) return;
    try {
      const fresh = await api.skills.create('global', null, newName);
      const next: SkillDef = {
        ...fresh,
        name: fresh.slug,
        description: draft.description,
        model: draft.model,
        allowedTools: draft.allowedTools,
        body: draft.body,
        extra: { ...draft.extra },
      };
      const saved = await api.skills.save(next);
      await reload();
      setSelectedPath(saved.path);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [draft, reload]);

  const onCreate = useCallback(
    async (scope: 'global' | 'project') => {
      if (!newSlug.trim()) return;
      try {
        const fresh = await api.skills.create(
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
        className="flex w-[300px] shrink-0 flex-col overflow-hidden border-r border-border"
        style={{ background: 'var(--color-surface-2)' }}
      >
        <div className="border-b border-border-subtle bg-surface-3/40 p-2">
          <div className="relative">
            <Search
              size={11}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-text-dim"
            />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter skills…"
              className="w-full rounded-[6px] border border-border-subtle bg-surface-3 py-1 pl-7 pr-2 text-[11.5px] text-text placeholder:text-text-dim focus:border-accent focus:outline-none"
            />
          </div>
          <label className="mt-2 flex cursor-pointer items-center gap-1.5 text-[10.5px] text-text-secondary">
            <input
              type="checkbox"
              checked={includePlugins}
              onChange={(e) => setIncludePlugins(e.target.checked)}
              className="h-3 w-3 accent-accent"
            />
            <Package size={10} className="text-text-muted" />
            <span>Include marketplace plugins (read-only)</span>
          </label>
        </div>

        <div className="flex-1 overflow-y-auto">
          {(['global', 'project', 'plugin'] as SkillScope[]).map((scope) => {
            const list = grouped[scope];
            if (scope === 'plugin' && !includePlugins) return null;
            const isCollapsed = collapsed[scope];
            const canCreate = scope === 'global' || (scope === 'project' && !!activeProject);
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
                    {scope === 'global' ? (
                      <Globe size={11} />
                    ) : scope === 'project' ? (
                      <Folder size={11} />
                    ) : (
                      <Package size={11} />
                    )}
                    <span className="flex-1">
                      {scope === 'global'
                        ? 'Global'
                        : scope === 'project'
                          ? 'Project'
                          : 'Plugins'}
                    </span>
                    <span className="text-text-dim">({list.length})</span>
                  </button>
                  {canCreate && (
                    <button
                      onClick={() => {
                        setCreatingScope(scope as 'global' | 'project');
                        setNewSlug('');
                      }}
                      title={`New ${scope} skill`}
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
                            if (e.key === 'Enter')
                              void onCreate(scope as 'global' | 'project');
                            if (e.key === 'Escape') setCreatingScope(null);
                          }}
                          autoFocus
                          placeholder="skill-slug"
                          className="min-w-0 flex-1 rounded-[5px] border border-border-subtle bg-surface-3 px-2 py-1 font-mono text-[11px] text-text placeholder:text-text-dim focus:border-accent focus:outline-none"
                        />
                        <button
                          onClick={() =>
                            void onCreate(scope as 'global' | 'project')
                          }
                          className="rounded-[5px] bg-accent px-2 py-1 text-[10px] text-white hover:brightness-110"
                        >
                          Add
                        </button>
                      </div>
                    )}
                    {list.length === 0 && creatingScope !== scope && (
                      <div className="px-3 py-2 text-[10.5px] text-text-dim">
                        {filter ? 'No matches.' : 'Empty.'}
                      </div>
                    )}
                    {list.map((s) => {
                      const isActive = selectedPath === s.path;
                      return (
                        <button
                          key={s.path}
                          onClick={() => setSelectedPath(s.path)}
                          title={s.description || s.slug}
                          className={cn(
                            'flex items-center gap-2 px-3 py-1.5 text-left text-[11.5px] transition',
                            isActive
                              ? 'bg-[rgba(76,141,255,0.18)] text-text'
                              : 'text-text-secondary hover:bg-surface-3 hover:text-text',
                          )}
                        >
                          {s.scope === 'plugin' ? (
                            <Lock size={10} className="shrink-0 text-text-dim" />
                          ) : (
                            <Lightbulb size={11} className="shrink-0 text-accent" />
                          )}
                          <span className="min-w-0 flex-1 truncate font-mono">
                            {s.name}
                          </span>
                          {s.allowedTools && s.allowedTools.length > 0 && (
                            <span
                              className="shrink-0 rounded-full bg-surface-3 px-1.5 text-[9px] uppercase text-text-muted"
                              title={`Restricted to: ${s.allowedTools.join(', ')}`}
                            >
                              {s.allowedTools.length}t
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
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {draft ? (
          <SkillEditor
            skill={draft}
            readOnly={readOnly}
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
              <Lightbulb size={24} className="mx-auto mb-2 text-text-dim" />
              <div>Select a skill from the left.</div>
              <div className="mt-1 text-[10.5px] text-text-dim">
                Skills live in <span className="font-mono">~/.claude/skills/&lt;name&gt;/SKILL.md</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface SkillEditorProps {
  skill: SkillDef;
  readOnly: boolean;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  onChange: (next: SkillDef) => void;
  onSave: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
}

function SkillEditor({
  skill,
  readOnly,
  dirty,
  saving,
  error,
  onChange,
  onSave,
  onDelete,
  onDuplicate,
}: SkillEditorProps) {
  const update = useCallback(
    (patch: Partial<SkillDef>) => onChange({ ...skill, ...patch }),
    [skill, onChange],
  );

  const toggleTool = useCallback(
    (toolId: string) => {
      const current = skill.allowedTools ?? [];
      const next = current.includes(toolId)
        ? current.filter((t) => t !== toolId)
        : [...current, toolId];
      update({ allowedTools: next.length === 0 ? undefined : next });
    },
    [skill.allowedTools, update],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (dirty && !readOnly) onSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dirty, readOnly, onSave]);

  return (
    <>
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-border bg-surface-2/60 px-3">
        <span className="truncate font-mono text-[10.5px] text-text-muted">
          {skill.path.replace(/^\/Users\/[^/]+/, '~')}
        </span>
        {readOnly && (
          <span className="inline-flex items-center gap-1 rounded-full bg-surface-3 px-2 py-[1px] text-[9px] uppercase text-text-muted">
            <Lock size={9} /> read-only
          </span>
        )}
        {dirty && !readOnly && (
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
          title="Duplicate to a user skill"
          className="rounded p-1 text-text-muted transition hover:bg-surface-3 hover:text-text"
        >
          <Copy size={12} />
        </button>
        {!readOnly && (
          <button
            onClick={onDelete}
            title="Delete this skill folder"
            className="rounded p-1 text-text-muted transition hover:bg-surface-3 hover:text-semantic-error"
          >
            <Trash2 size={12} />
          </button>
        )}
        <button
          onClick={onSave}
          disabled={!dirty || saving || readOnly}
          className={cn(
            'inline-flex items-center gap-1 rounded-[6px] px-3 py-[5px] text-[11px] font-medium transition',
            !dirty || saving || readOnly
              ? 'pointer-events-none border border-border bg-surface-3 text-text-muted opacity-50'
              : 'text-white hover:brightness-110',
          )}
          style={
            !dirty || saving || readOnly
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
          <FormField label="Name" hint="Folder slug — drives the trigger key">
            <input
              type="text"
              value={skill.name}
              disabled={readOnly}
              onChange={(e) => update({ name: e.target.value })}
              className="w-full rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-1.5 font-mono text-[11.5px] text-text focus:border-accent focus:outline-none disabled:opacity-60"
            />
          </FormField>

          <FormField label="Description" hint="When should Claude pull this skill in?">
            <textarea
              value={skill.description}
              disabled={readOnly}
              onChange={(e) => update({ description: e.target.value })}
              rows={4}
              className="w-full resize-none rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-1.5 text-[11.5px] text-text focus:border-accent focus:outline-none disabled:opacity-60"
            />
          </FormField>

          <FormField label="Model" hint="Override default model when this skill activates">
            <div className="flex flex-wrap gap-1">
              {MODEL_OPTIONS.map((m) => (
                <button
                  key={m || 'default'}
                  onClick={() => update({ model: m || undefined })}
                  disabled={readOnly}
                  className={cn(
                    'rounded-[5px] border px-2 py-1 text-[10.5px] transition disabled:opacity-60',
                    (skill.model ?? '') === m
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
            label="Allowed tools"
            hint={
              skill.allowedTools === undefined
                ? 'All tools (default)'
                : `Restricted to ${skill.allowedTools.length}`
            }
            action={
              skill.allowedTools !== undefined && !readOnly ? (
                <button
                  onClick={() => update({ allowedTools: undefined })}
                  className="text-[10px] text-accent hover:underline"
                >
                  allow all
                </button>
              ) : null
            }
          >
            <div className="grid grid-cols-2 gap-1">
              {TOOL_OPTIONS.map((t) => {
                const checked = !skill.allowedTools || skill.allowedTools.includes(t);
                return (
                  <label
                    key={t}
                    className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-surface-3"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={readOnly}
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

          {skill.pluginSource && (
            <div className="mt-3 rounded-[6px] border border-border-subtle bg-surface/40 p-2">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                Source
              </div>
              <div className="text-[10.5px] text-text-dim font-mono">
                {skill.pluginSource}
              </div>
            </div>
          )}
        </div>

        <BodyEditor
          key={skill.path}
          value={skill.body}
          readOnly={readOnly}
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

function BodyEditor({
  value,
  readOnly,
  onChange,
  onSave,
}: {
  value: string;
  readOnly: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
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
          EditorState.readOnly.of(readOnly),
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
  }, [readOnly]);

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
