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
  Sparkles,
  Star,
  Trash2,
} from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import { useForgePrefillStore } from '@renderer/state/forgePrefill';
import { useWorkspaceStore } from '@renderer/state/workspace';
import { baseEditorTheme } from '@renderer/utils/codemirrorTheme';
import { computeForgeRating } from '@renderer/utils/forgeRating';
import type {
  DesignSeedingStatus,
  ForgeCatalogItem,
  ForgeStats,
  SkillDef,
  SkillScope,
} from '@shared/types';

const ForgeGenerateDialog = lazy(() =>
  import('@renderer/components/Settings/ForgeGenerateDialog').then((m) => ({
    default: m.ForgeGenerateDialog,
  })),
);

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
 * Status + controls for the bundled design-skill seeding. The seeder runs
 * on boot (best-effort, default on) and copies the bundled design packs into
 * ~/.claude/skills so the Claude Code CLI can discover them. This compact
 * row surfaces that state, lets the user toggle on-launch seeding, and
 * re-seed on demand (e.g. after a fresh install or to pick up a pack update).
 */
function DesignSeedingRow({ onReseeded }: { onReseeded: () => void }) {
  const [status, setStatus] = useState<DesignSeedingStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    void api.designSeeding
      .status()
      .then(setStatus)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  if (!status) return null;

  const toggle = async (enabled: boolean) => {
    setStatus({ ...status, enabled }); // optimistic
    try {
      await api.designSeeding.setEnabled(enabled);
    } finally {
      refresh();
    }
  };

  const reseed = async () => {
    setBusy(true);
    try {
      await api.designSeeding.reseed();
      onReseeded();
    } finally {
      setBusy(false);
      refresh();
    }
  };

  return (
    <div className="mt-2 rounded-[6px] border border-border-subtle bg-surface-3/40 p-2">
      <div className="flex items-center gap-1.5 text-[10.5px] font-medium text-text-secondary">
        <Sparkles size={10} className="text-accent" />
        <span>Bundled design skills</span>
      </div>
      <p className="mt-1 text-[10px] leading-snug text-text-dim">
        {status.skillCount > 0
          ? `${status.skillCount} skills · ${status.systemCount} systems in ~/.claude/skills` +
            (status.packVersion ? ` (pack ${status.packVersion})` : '')
          : 'Not seeded yet — seed to let Claude use the bundled design skills.'}
      </p>
      <label className="mt-1.5 flex cursor-pointer items-center gap-1.5 text-[10.5px] text-text-secondary">
        <input
          type="checkbox"
          checked={status.enabled}
          onChange={(e) => void toggle(e.target.checked)}
          className="h-3 w-3 accent-accent"
        />
        <span>Seed on launch</span>
      </label>
      <button
        onClick={() => void reseed()}
        disabled={busy}
        className="mt-1.5 inline-flex w-full items-center justify-center gap-1 rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-1 text-[10.5px] text-text-secondary transition hover:bg-surface-4 disabled:opacity-50"
        title="Copy the bundled design skills into ~/.claude/skills now (never overwrites your own skills)"
      >
        {busy ? 'Re-seeding…' : 'Re-seed now'}
      </button>
    </div>
  );
}

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
    // Built-in pack collapsed by default so the bundled list doesn't
    // bury the user's own skills on first open.
    builtin: true,
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
  // v0.25: forge integration — Claude-generate dialog + stats chips + catalog banner
  const [generateOpen, setGenerateOpen] = useState(false);
  const [generateBrief, setGenerateBrief] = useState<string>('');
  const [stats, setStats] = useState<ForgeStats[]>([]);
  const [catalog, setCatalog] = useState<ForgeCatalogItem[]>([]);
  const [catalogDismissed, setCatalogDismissed] = useState(false);
  const forgePrefill = useForgePrefillStore((s) => s.pending);
  const consumeForgePrefill = useForgePrefillStore((s) => s.consume);

  const reload = useCallback(async () => {
    const list = await api.skills.list(activeProject?.path ?? null, includePlugins);
    setSkills(list);
    return list;
  }, [activeProject?.path, includePlugins]);

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.path, includePlugins]);

  // v0.25: load forge stats + curated catalog matches for this project.
  // Guard with a cancellation flag — switching projects mid-flight could
  // otherwise let project A's response overwrite project B's after B
  // resolved first (out-of-order IPC resolution).
  useEffect(() => {
    if (!activeProject?.path) {
      setStats([]);
      setCatalog([]);
      return undefined;
    }
    let cancelled = false;
    void api.forge
      .listStats(activeProject.path)
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      .catch(() => undefined);
    void api.forge
      .discoverMatches(activeProject.path)
      .then((c) => {
        if (!cancelled) setCatalog(c);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeProject?.path]);

  // v0.25: consume chat /skill prefill — open generate dialog with brief
  useEffect(() => {
    if (forgePrefill && forgePrefill.kind === 'skill') {
      setGenerateBrief(forgePrefill.brief);
      setGenerateOpen(true);
      consumeForgePrefill();
    }
  }, [forgePrefill, consumeForgePrefill]);

  const statsByKey = useMemo(() => {
    const m = new Map<string, ForgeStats>();
    for (const s of stats) m.set(s.key, s);
    return m;
  }, [stats]);

  const catalogSkills = useMemo(
    () => catalog.filter((c) => c.kind === 'skill').slice(0, 5),
    [catalog],
  );

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
      builtin: [],
    };
    for (const s of skills) if (matches(s)) g[s.scope].push(s);
    return g;
  }, [skills, filter]);

  // Both 'plugin' (marketplace-managed) and 'builtin' (bundled inside the
  // .app) are read-only — the user has to duplicate them into a writable
  // scope before they can edit.
  const readOnly = draft?.scope === 'plugin' || draft?.scope === 'builtin';

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
    // Plugin / builtin → use the dedicated duplicate IPC which performs a
    // recursive folder copy preserving SKILL.md plus helper assets. Falls
    // back to the create+save flow for editable scopes so the user can
    // rename via a prompt.
    if (draft.scope === 'plugin' || draft.scope === 'builtin') {
      const targetScope: 'global' | 'project' =
        activeProject ? 'project' : 'global';
      try {
        const created = await api.skills.duplicate(
          draft.path,
          targetScope,
          targetScope === 'project' ? (activeProject?.path ?? null) : null,
        );
        await reload();
        setSelectedPath(created.path);
      } catch (err) {
        setError((err as Error).message);
      }
      return;
    }
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
  }, [draft, activeProject, reload]);

  // Builtin/plugin sidebar shortcut: lets the user duplicate directly to
  // the chosen scope without opening the read-only editor first.
  const onDuplicateReadOnly = useCallback(
    async (skill: SkillDef, targetScope: 'global' | 'project') => {
      try {
        const created = await api.skills.duplicate(
          skill.path,
          targetScope,
          targetScope === 'project' ? (activeProject?.path ?? null) : null,
        );
        await reload();
        setSelectedPath(created.path);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [activeProject?.path, reload],
  );

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
          {/* v0.25: Generate with Claude — entry to ForgeGenerateDialog */}
          <button
            onClick={() => {
              setGenerateBrief('');
              setGenerateOpen(true);
            }}
            className="mb-2 inline-flex w-full items-center justify-center gap-1.5 rounded-[7px] bg-gradient-to-r from-accent to-fuchsia-500 px-3 py-1.5 text-[11px] font-medium text-white transition hover:brightness-110"
            title="Have Claude draft a SKILL.md from a brief"
          >
            <Sparkles size={11} />
            Generate with Claude
          </button>
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
          <DesignSeedingRow onReseeded={reload} />
        </div>

        <div className="flex-1 overflow-y-auto">
          {(['global', 'project', 'plugin', 'builtin'] as SkillScope[]).map((scope) => {
            const list = grouped[scope];
            if (scope === 'plugin' && !includePlugins) return null;
            // Hide builtin section entirely when there's nothing bundled
            // (dev builds without the resources/builtin-packs/ dir).
            if (scope === 'builtin' && list.length === 0) return null;
            const isCollapsed = collapsed[scope];
            const canCreate = scope === 'global' || (scope === 'project' && !!activeProject);
            const isReadOnlyScope = scope === 'plugin' || scope === 'builtin';
            const scopeLabel =
              scope === 'global'
                ? 'Global'
                : scope === 'project'
                  ? 'Project'
                  : scope === 'plugin'
                    ? 'Plugins'
                    : 'Built-in';
            const ScopeIcon =
              scope === 'global'
                ? Globe
                : scope === 'project'
                  ? Folder
                  : Package;
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
                    <ScopeIcon size={11} />
                    <span className="flex-1">
                      {scopeLabel}
                      {isReadOnlyScope && (
                        <span className="ml-1 text-[9.5px] font-normal normal-case text-text-dim">
                          (read-only)
                        </span>
                      )}
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
                    {list.map((s) => (
                      <SkillRow
                        key={s.path}
                        skill={s}
                        stats={statsByKey.get(`${s.scope}:skill:${s.slug}`) ?? null}
                        isActive={selectedPath === s.path}
                        canDuplicateToProject={!!activeProject}
                        onSelect={() => setSelectedPath(s.path)}
                        onDuplicateReadOnly={onDuplicateReadOnly}
                      />
                    ))}
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
          <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-[12px] text-text-muted">
            {/* v0.25: catalog banner — curated skills matched against project stack */}
            {!catalogDismissed && catalogSkills.length > 0 && (
              <div className="w-full max-w-md rounded-[8px] border border-amber-500/40 bg-amber-500/5 p-3">
                <div className="mb-1.5 flex items-start justify-between gap-2">
                  <div className="flex items-center gap-1.5 text-[11px] font-medium text-amber-300">
                    <Sparkles size={11} />
                    {catalogSkills.length} skill{catalogSkills.length > 1 ? 's' : ''} match this project's stack
                  </div>
                  <button
                    onClick={() => setCatalogDismissed(true)}
                    className="rounded p-0.5 text-text-muted hover:bg-surface-3 hover:text-text"
                    title="Dismiss"
                  >
                    ×
                  </button>
                </div>
                <ul className="space-y-1">
                  {catalogSkills.map((c) => (
                    <li key={c.slug} className="text-[10.5px] text-text-secondary">
                      <span className="font-mono">{c.slug}</span> — {c.description}
                    </li>
                  ))}
                </ul>
                <div className="mt-2 text-[10px] text-text-dim">
                  Browse Built-in (read-only) on the left, then Duplicate to your project.
                </div>
              </div>
            )}
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
      {generateOpen && (
        <Suspense fallback={null}>
          <ForgeGenerateDialog
            open={generateOpen}
            kind="skill"
            projectPath={activeProject?.path ?? null}
            initialBrief={generateBrief}
            onClose={() => setGenerateOpen(false)}
            onSaved={(saved) => {
              void reload().then(() => {
                setSelectedPath(saved.path);
              });
            }}
          />
        </Suspense>
      )}
    </div>
  );
}

// One sidebar row. Plugin and builtin entries can't be edited directly
// — they get an inline duplicate dropdown so the user can clone to a
// writable scope without first opening the read-only editor. Overridden
// rows dim + tag so the precedence (project > global > plugin > builtin)
// is obvious at a glance.
function SkillRow({
  skill,
  stats,
  isActive,
  canDuplicateToProject,
  onSelect,
  onDuplicateReadOnly,
}: {
  skill: SkillDef;
  stats: ForgeStats | null;
  isActive: boolean;
  canDuplicateToProject: boolean;
  onSelect: () => void;
  onDuplicateReadOnly: (skill: SkillDef, target: 'global' | 'project') => void;
}) {
  const isReadOnly = skill.scope === 'plugin' || skill.scope === 'builtin';
  const isOverridden = skill.overridden === true;
  // v0.25: derive star rating from implicit forge signals. 5★ = pure thanks,
  // 1★ = mostly corrections. Falls back to "—" when fewer than 2 signals.
  const rating = computeForgeRating(stats);
  return (
    <div
      className={cn(
        'flex items-center gap-2 px-3 py-1.5 text-left text-[11.5px] transition',
        isActive
          ? 'bg-[rgba(76,141,255,0.18)] text-text'
          : 'text-text-secondary hover:bg-surface-3 hover:text-text',
        isOverridden && 'opacity-60',
      )}
    >
      <button
        onClick={onSelect}
        title={skill.description || skill.slug}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        {isReadOnly ? (
          <Lock size={10} className="shrink-0 text-text-dim" />
        ) : (
          <Lightbulb size={11} className="shrink-0 text-accent" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono">{skill.name}</span>
        {isOverridden && (
          <span
            className="shrink-0 rounded-full bg-surface-3 px-1.5 text-[9px] uppercase text-text-dim"
            title="A higher-priority scope shadows this entry"
          >
            Overridden
          </span>
        )}
        {skill.allowedTools && skill.allowedTools.length > 0 && (
          <span
            className="shrink-0 rounded-full bg-surface-3 px-1.5 text-[9px] uppercase text-text-muted"
            title={`Restricted to: ${skill.allowedTools.join(', ')}`}
          >
            {skill.allowedTools.length}t
          </span>
        )}
        {stats && stats.uses > 0 && (
          <span
            className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-surface-3 px-1.5 text-[9px] text-amber-300"
            title={`${stats.uses} use${stats.uses > 1 ? 's' : ''}${
              rating !== null ? ` · ${rating.toFixed(1)}★` : ''
            }`}
          >
            <Star size={8} fill="currentColor" />
            {stats.uses}
          </span>
        )}
        {skill.effort && (
          /* v0.37: surfaced from the skill's `effort:` frontmatter — read-only
             badge so the user can see at a glance which skills bump the
             thinking budget. Editor doesn't expose it yet (TODO v0.37.1). */
          <span
            className="shrink-0 rounded-full bg-accent/15 px-1.5 text-[9px] uppercase text-accent"
            title={`Skill effort: ${skill.effort}`}
          >
            {skill.effort}
          </span>
        )}
      </button>
      {isReadOnly && (
        <select
          aria-label="Duplicate to scope"
          title="Duplicate this read-only skill to a writable scope"
          value=""
          onChange={(e) => {
            const v = e.target.value as '' | 'global' | 'project';
            if (v === 'global' || v === 'project') {
              onDuplicateReadOnly(skill, v);
            }
            e.target.value = '';
          }}
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 rounded-[5px] border border-border-subtle bg-surface-3 px-1 py-[1px] text-[9.5px] uppercase text-text-muted hover:text-text focus:border-accent focus:outline-none"
        >
          <option value="" disabled>
            Duplicate to…
          </option>
          <option value="global">Global</option>
          {canDuplicateToProject && <option value="project">Project</option>}
        </select>
      )}
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

