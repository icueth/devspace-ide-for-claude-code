import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileCode,
  Folder,
  Globe,
  Loader2,
  Lock,
  Package,
  Paintbrush,
  Palette,
  RefreshCw,
  Search,
  Sparkles,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ProjectTokensPanel } from '@renderer/components/Design/ProjectTokensPanel';
import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import { useEditorStore } from '@renderer/state/editor';
import { useWorkspaceStore } from '@renderer/state/workspace';
import type {
  DesignScope,
  DesignSkill,
  DesignSystem,
  ProjectDesignProfile,
} from '@shared/design';

type SubTab = 'context' | 'skills' | 'systems' | 'tokens';

/**
 * Settings tab listing every design skill + design system DevSpace can
 * see for the active project. Two sub-sections mirror the picker UI in
 * the Design pane:
 *   • Skills  — page templates (dashboard, landing-page, slide-deck, …)
 *   • Systems — brand kits (apple, airbnb, …)
 *
 * Scope handling matches SkillsSettings.tsx:
 *   • built-in → read-only (bundled with the app)
 *   • global / project → editable. Phase A defers in-place editing and
 *     instead offers an "Open in editor" button that loads the SKILL.md
 *     into a new editor tab. That keeps this surface focused on
 *     discovery + provenance.
 */
export function DesignSettings() {
  // Project Context is the most valuable v0.10 surface — it shows the user
  // exactly what DevSpace will inject into the next generation prompt and is
  // the only tab they can act on without leaving Settings. So we open here
  // by default; Skills / Systems are still one click away.
  const [tab, setTab] = useState<SubTab>('context');

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface-2/40 px-4 py-2">
        <SubTabButton
          active={tab === 'context'}
          onClick={() => setTab('context')}
          icon={<FileCode size={11} />}
          label="Project context"
        />
        <SubTabButton
          active={tab === 'skills'}
          onClick={() => setTab('skills')}
          icon={<Paintbrush size={11} />}
          label="Skills"
        />
        <SubTabButton
          active={tab === 'systems'}
          onClick={() => setTab('systems')}
          icon={<Sparkles size={11} />}
          label="Design systems"
        />
        <SubTabButton
          active={tab === 'tokens'}
          onClick={() => setTab('tokens')}
          icon={<Palette size={11} />}
          label="Project tokens"
        />
        <div className="flex-1" />
        {tab === 'context' ? (
          <span className="text-[10.5px] text-text-muted">
            Source:{' '}
            <code className="font-mono">.devspace/design/profile.json</code>
          </span>
        ) : tab === 'tokens' ? (
          <span className="text-[10.5px] text-text-muted">
            Source:{' '}
            <code className="font-mono">.devspace/design/tokens.json</code>
          </span>
        ) : (
          <span className="text-[10.5px] text-text-muted">
            Sources: <code className="font-mono">~/.claude/skills</code> ·{' '}
            <code className="font-mono">.claude/skills</code> · built-in pack
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === 'context' ? (
          <ProjectContextBrowser />
        ) : tab === 'skills' ? (
          <SkillsBrowser />
        ) : tab === 'tokens' ? (
          <ProjectTokensSection />
        ) : (
          <SystemsBrowser />
        )}
      </div>
    </div>
  );
}

// ─── Project tokens sub-section ────────────────────────────────────────
//
// Mounts the standalone <ProjectTokensPanel> only when a project is open.
// Uses the same workspace selector pattern as ProjectContextBrowser so
// switching projects rebinds the panel to the new path automatically.
function ProjectTokensSection() {
  const activeProject = useWorkspaceStore((s) => {
    const id = s.activeProjectId;
    return s.projects.find((p) => p.id === id) ?? null;
  });
  if (!activeProject) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[820px] flex-col items-center gap-2 rounded-[8px] border border-dashed border-border bg-surface-2/40 px-6 py-10 text-center">
          <Palette size={22} className="text-text-dim" />
          <div className="text-[12px] font-medium text-text-secondary">
            No project open
          </div>
          <div className="max-w-[420px] text-[10.5px] leading-relaxed text-text-dim">
            Select a project to manage its design tokens.
          </div>
        </div>
      </div>
    );
  }
  return <ProjectTokensPanel projectPath={activeProject.path} />;
}

interface SubTabButtonProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}

function SubTabButton({ active, onClick, icon, label }: SubTabButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-[24px] items-center gap-1 rounded-[5px] border px-2.5 text-[11px] transition',
        active
          ? 'border-accent/40 bg-[rgba(76,141,255,0.12)] text-text'
          : 'border-border bg-surface-3 text-text-muted hover:border-border-hi hover:text-text',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

// ─── Project context browser ────────────────────────────────────────
//
// Surfaces the auto-detected ProjectDesignProfile that main builds via
// ProjectProfileBuilder.ts. The profile is injected into every design
// generation prompt under "## Project Context" so output matches the
// host project's framework / styling stack / brand cues. Users land here
// to (a) confirm DevSpace detected what they expected, (b) hit Refresh
// after editing package.json so the next generation picks up the change.

function ProjectContextBrowser() {
  const activeProject = useWorkspaceStore((s) => {
    const id = s.activeProjectId;
    return s.projects.find((p) => p.id === id) ?? null;
  });

  const [profile, setProfile] = useState<ProjectDesignProfile | null>(null);
  // `loading` is the initial mount / project-switch fetch. We split it
  // from `refreshing` so the refresh button can spin without blowing
  // away the currently-rendered profile (which would feel jarring).
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumps every minute so "Last built: N minutes ago" updates without
  // refetching the profile. Cheap rerender — the component is mounted
  // only when this tab is visible.
  const [, setTick] = useState(0);

  const projectPath = activeProject?.path ?? null;

  useEffect(() => {
    if (!projectPath) {
      setProfile(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api.design
      .getProfile(projectPath)
      .then((p) => {
        if (!cancelled) setProfile(p);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  // Keep "Last built: …" relative timestamps fresh without re-fetching.
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const onRefresh = useCallback(async () => {
    if (!projectPath || refreshing) return;
    setRefreshing(true);
    setError(null);
    try {
      const next = await api.design.rebuildProfile(projectPath);
      setProfile(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, [projectPath, refreshing]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-[820px] px-6 py-5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-[14px] font-semibold text-text">
              Project context
            </h3>
            <p className="mt-1 text-[11.5px] leading-snug text-text-muted">
              DevSpace inspects your project and injects this profile into
              every design generation so the output matches your framework,
              styling stack, and conventions.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void onRefresh()}
            disabled={!projectPath || refreshing || loading}
            title="Re-scan package.json and refresh the cached profile"
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 rounded-[6px] border px-3 py-[6px] text-[11px] font-medium transition',
              !projectPath || refreshing || loading
                ? 'pointer-events-none border-border bg-surface-3 text-text-muted opacity-50'
                : 'border-border-subtle bg-surface-3 text-text hover:border-border-hi hover:bg-surface-4',
            )}
          >
            {refreshing ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <RefreshCw size={11} />
            )}
            {refreshing ? 'Refreshing…' : 'Refresh project context'}
          </button>
        </div>

        {error && (
          <div className="mb-3 rounded-[6px] border border-semantic-error/30 bg-semantic-error/10 px-3 py-2 text-[11px] text-semantic-error">
            {error}
          </div>
        )}

        {!projectPath ? (
          <ProjectContextEmpty
            title="No project open"
            hint="Open a project from the workspace tree to detect its design profile."
          />
        ) : loading && !profile ? (
          <ProjectContextLoading />
        ) : !profile ? (
          <ProjectContextEmpty
            title="No project context available"
            hint="Open a project with a package.json to enable project-aware design generation."
          />
        ) : (
          <ProjectContextCard profile={profile} projectPath={projectPath} />
        )}
      </div>
    </div>
  );
}

function ProjectContextLoading() {
  return (
    <div className="flex h-[200px] items-center justify-center rounded-[8px] border border-border-subtle bg-surface-2">
      <div className="flex items-center gap-2 text-[11.5px] text-text-muted">
        <Loader2 size={13} className="animate-spin text-accent" />
        Detecting project profile…
      </div>
    </div>
  );
}

function ProjectContextEmpty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-[8px] border border-dashed border-border bg-surface-2/40 px-6 py-10 text-center">
      <FileCode size={22} className="text-text-dim" />
      <div className="text-[12px] font-medium text-text-secondary">{title}</div>
      <div className="max-w-[420px] text-[10.5px] leading-relaxed text-text-dim">
        {hint}
      </div>
    </div>
  );
}

interface ProjectContextCardProps {
  profile: ProjectDesignProfile;
  projectPath: string;
}

function ProjectContextCard({ profile, projectPath }: ProjectContextCardProps) {
  // Chip values are user-facing labels — capitalize where the union value
  // is lowercased. Keep the raw union value for the title attr so power
  // users can grep their config.
  const chips: Array<{ label: string; value: string; title: string }> = [
    {
      label: 'Framework',
      value: prettyFramework(profile.framework),
      title: profile.framework,
    },
    {
      label: 'Styling',
      value: prettyStyling(profile.styling),
      title: profile.styling,
    },
    {
      label: 'Package manager',
      value: profile.packageManager,
      title: profile.packageManager,
    },
    {
      label: 'Language',
      value: profile.typescript ? 'TypeScript' : 'JavaScript',
      title: profile.typescript ? 'tsconfig.json present' : 'no tsconfig.json',
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {chips.map((c) => (
          <Chip
            key={c.label}
            label={c.label}
            value={c.value}
            title={c.title}
          />
        ))}
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">
          Summary
        </div>
        <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap rounded-[6px] border border-border-subtle bg-surface-3 px-3 py-2 font-mono text-[10.5px] leading-relaxed text-text-secondary">
          {profile.summary || '(empty)'}
        </pre>
      </div>

      {profile.evidence.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">
            Evidence
          </div>
          <div className="text-[10.5px] leading-relaxed text-text-dim">
            Detected from:{' '}
            {profile.evidence.map((file, i) => (
              <span key={file}>
                <code className="font-mono text-text-secondary">{file}</code>
                {i < profile.evidence.length - 1 ? ', ' : ''}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border-subtle pt-3 text-[10.5px] text-text-dim">
        <span>
          Last built:{' '}
          <span className="text-text-secondary">
            {formatRelativeTime(profile.builtAt)}
          </span>
        </span>
        <span className="text-text-dim/60">·</span>
        <span className="truncate font-mono">
          {projectPath.replace(/^\/Users\/[^/]+/, '~')}
        </span>
      </div>
    </div>
  );
}

function Chip({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title?: string;
}) {
  return (
    <div
      className="rounded-[6px] border border-border-subtle bg-surface-3 px-2.5 py-1.5"
      title={title}
    >
      <div className="text-[9.5px] font-semibold uppercase tracking-wide text-text-muted">
        {label}
      </div>
      <div className="mt-0.5 truncate text-[11.5px] font-medium text-text">
        {value}
      </div>
    </div>
  );
}

function prettyFramework(kind: ProjectDesignProfile['framework']): string {
  switch (kind) {
    case 'vite':
      return 'Vite';
    case 'next':
      return 'Next.js';
    case 'astro':
      return 'Astro';
    case 'remix':
      return 'Remix';
    case 'sveltekit':
      return 'SvelteKit';
    case 'nuxt':
      return 'Nuxt';
    case 'gatsby':
      return 'Gatsby';
    case 'angular':
      return 'Angular';
    case 'vue-cli':
      return 'Vue CLI';
    case 'cra':
      return 'CRA';
    case 'storybook':
      return 'Storybook';
    case 'vitepress':
      return 'VitePress';
    case 'docusaurus':
      return 'Docusaurus';
    case 'static':
      return 'Static';
    case 'unknown':
      return 'Unknown';
  }
}

function prettyStyling(kind: ProjectDesignProfile['styling']): string {
  switch (kind) {
    case 'tailwind':
      return 'Tailwind';
    case 'vanilla-css':
      return 'Vanilla CSS';
    case 'styled-components':
      return 'styled-components';
    case 'css-modules':
      return 'CSS Modules';
    case 'unknown':
      return 'Unknown';
  }
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return 'just now';
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 1) return `${sec} seconds ago`;
  if (min === 1) return '1 minute ago';
  if (min < 60) return `${min} minutes ago`;
  const hr = Math.floor(min / 60);
  if (hr === 1) return '1 hour ago';
  if (hr < 24) return `${hr} hours ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return 'yesterday';
  if (day < 30) return `${day} days ago`;
  const month = Math.floor(day / 30);
  if (month === 1) return '1 month ago';
  if (month < 12) return `${month} months ago`;
  const year = Math.floor(day / 365);
  if (year === 1) return '1 year ago';
  return `${year} years ago`;
}

// ─── Skills browser ──────────────────────────────────────────────────

function SkillsBrowser() {
  const activeProject = useWorkspaceStore((s) => {
    const id = s.activeProjectId;
    return s.projects.find((p) => p.id === id) ?? null;
  });
  const [skills, setSkills] = useState<DesignSkill[]>([]);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<DesignSkill | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<DesignScope, boolean>>({
    project: false,
    global: false,
    builtin: true,
  });

  useEffect(() => {
    let cancelled = false;
    void api.design
      .listSkills(activeProject?.path ?? null)
      .then((list) => {
        if (cancelled) return;
        setSkills(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) console.warn('[design-settings] listSkills failed:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProject?.path]);

  useEffect(() => {
    if (!selected) {
      setBody(null);
      setBodyError(null);
      return;
    }
    let cancelled = false;
    setBody(null);
    setBodyError(null);
    void api.fs
      .readFile(selected.path)
      .then((text) => {
        if (!cancelled) setBody(text);
      })
      .catch((err: unknown) => {
        if (!cancelled) setBodyError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const grouped = useMemo(
    () => groupAndFilter(skills, filter, (s) => `${s.slug} ${s.name} ${s.description} ${s.category}`),
    [skills, filter],
  );

  return (
    <CatalogLayout
      filter={filter}
      onFilterChange={setFilter}
      filterPlaceholder="Filter skills…"
      grouped={grouped}
      collapsed={collapsed}
      onToggleCollapse={(scope) => setCollapsed((p) => ({ ...p, [scope]: !p[scope] }))}
      selectedPath={selected?.path ?? null}
      onSelect={(item) => setSelected(item as DesignSkill)}
      renderRow={(item) => {
        const s = item as DesignSkill;
        return (
          <>
            {s.scope === 'builtin' ? (
              <Lock size={10} className="shrink-0 text-text-dim" />
            ) : (
              <Paintbrush size={11} className="shrink-0 text-accent" />
            )}
            <span className="min-w-0 flex-1 truncate font-mono">{s.name}</span>
            {s.category && (
              <span className="shrink-0 rounded-full bg-surface-3 px-1.5 text-[9px] uppercase text-text-muted">
                {s.category}
              </span>
            )}
          </>
        );
      }}
      detail={
        selected ? (
          <Detail
            scope={selected.scope}
            slug={selected.slug}
            name={selected.name}
            description={selected.description}
            path={selected.path}
            body={body}
            bodyError={bodyError}
            extra={
              selected.category ? (
                <Meta label="Category" value={selected.category} />
              ) : null
            }
          />
        ) : (
          <EmptyDetail
            icon={<Paintbrush size={22} className="text-text-dim" />}
            title="Pick a skill"
            hint="Built-in skills ship with DevSpace. Add your own under ~/.claude/skills/."
          />
        )
      }
    />
  );
}

// ─── Systems browser ─────────────────────────────────────────────────

function SystemsBrowser() {
  const activeProject = useWorkspaceStore((s) => {
    const id = s.activeProjectId;
    return s.projects.find((p) => p.id === id) ?? null;
  });
  const [systems, setSystems] = useState<DesignSystem[]>([]);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<DesignSystem | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<DesignScope, boolean>>({
    project: false,
    global: false,
    builtin: true,
  });

  useEffect(() => {
    let cancelled = false;
    void api.design
      .listSystems(activeProject?.path ?? null)
      .then((list) => {
        if (cancelled) return;
        setSystems(list);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          console.warn('[design-settings] listSystems failed:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProject?.path]);

  useEffect(() => {
    if (!selected) {
      setBody(null);
      setBodyError(null);
      return;
    }
    let cancelled = false;
    setBody(null);
    setBodyError(null);
    void api.fs
      .readFile(selected.path)
      .then((text) => {
        if (!cancelled) setBody(text);
      })
      .catch((err: unknown) => {
        if (!cancelled) setBodyError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const grouped = useMemo(
    () => groupAndFilter(systems, filter, (s) => `${s.slug} ${s.name} ${s.description} ${s.brand}`),
    [systems, filter],
  );

  return (
    <CatalogLayout
      filter={filter}
      onFilterChange={setFilter}
      filterPlaceholder="Filter design systems…"
      grouped={grouped}
      collapsed={collapsed}
      onToggleCollapse={(scope) => setCollapsed((p) => ({ ...p, [scope]: !p[scope] }))}
      selectedPath={selected?.path ?? null}
      onSelect={(item) => setSelected(item as DesignSystem)}
      renderRow={(item) => {
        const s = item as DesignSystem;
        return (
          <>
            {s.scope === 'builtin' ? (
              <Lock size={10} className="shrink-0 text-text-dim" />
            ) : (
              <Sparkles size={11} className="shrink-0 text-accent" />
            )}
            <span className="min-w-0 flex-1 truncate font-mono">{s.name}</span>
            {s.brand && (
              <span className="shrink-0 rounded-full bg-surface-3 px-1.5 text-[9px] uppercase text-text-muted">
                {s.brand}
              </span>
            )}
          </>
        );
      }}
      detail={
        selected ? (
          <Detail
            scope={selected.scope}
            slug={selected.slug}
            name={selected.name}
            description={selected.description}
            path={selected.path}
            body={body}
            bodyError={bodyError}
            extra={
              selected.brand ? (
                <Meta label="Brand" value={selected.brand} />
              ) : null
            }
          />
        ) : (
          <EmptyDetail
            icon={<Sparkles size={22} className="text-text-dim" />}
            title="Pick a design system"
            hint="Design systems describe brand colors, typography, and component looks."
          />
        )
      }
    />
  );
}

// ─── Shared catalog layout ───────────────────────────────────────────

interface CatalogItem {
  slug: string;
  name: string;
  scope: DesignScope;
  path: string;
}

interface CatalogLayoutProps<T extends CatalogItem> {
  filter: string;
  onFilterChange: (v: string) => void;
  filterPlaceholder: string;
  grouped: Record<DesignScope, T[]>;
  collapsed: Record<DesignScope, boolean>;
  onToggleCollapse: (scope: DesignScope) => void;
  selectedPath: string | null;
  onSelect: (item: T) => void;
  renderRow: (item: T) => React.ReactNode;
  detail: React.ReactNode;
}

function CatalogLayout<T extends CatalogItem>({
  filter,
  onFilterChange,
  filterPlaceholder,
  grouped,
  collapsed,
  onToggleCollapse,
  selectedPath,
  onSelect,
  renderRow,
  detail,
}: CatalogLayoutProps<T>) {
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
              onChange={(e) => onFilterChange(e.target.value)}
              placeholder={filterPlaceholder}
              className="w-full rounded-[6px] border border-border-subtle bg-surface-3 py-1 pl-7 pr-2 text-[11.5px] text-text placeholder:text-text-dim focus:border-accent focus:outline-none"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {(['project', 'global', 'builtin'] as DesignScope[]).map((scope) => {
            const list = grouped[scope];
            const isCollapsed = collapsed[scope];
            return (
              <div key={scope} className="flex flex-col">
                <button
                  type="button"
                  onClick={() => onToggleCollapse(scope)}
                  className="flex items-center gap-1 border-b border-border-subtle bg-surface-3/40 px-2 py-2 text-left text-[10.5px] font-semibold uppercase tracking-wide text-text-muted transition hover:text-text"
                >
                  {isCollapsed ? (
                    <ChevronRight size={10} />
                  ) : (
                    <ChevronDown size={10} />
                  )}
                  {scope === 'project' ? (
                    <Folder size={11} />
                  ) : scope === 'global' ? (
                    <Globe size={11} />
                  ) : (
                    <Package size={11} />
                  )}
                  <span className="flex-1">
                    {scope === 'project'
                      ? 'Project'
                      : scope === 'global'
                        ? 'Global'
                        : 'Built-in'}
                  </span>
                  <span className="text-text-dim">({list.length})</span>
                </button>
                {!isCollapsed && (
                  <div className="flex flex-col py-1">
                    {list.length === 0 ? (
                      <div className="px-3 py-2 text-[10.5px] text-text-dim">
                        {filter ? 'No matches.' : 'Empty.'}
                      </div>
                    ) : (
                      list.map((item) => (
                        <button
                          key={item.path}
                          type="button"
                          onClick={() => onSelect(item)}
                          title={item.slug}
                          className={cn(
                            'flex items-center gap-2 px-3 py-1.5 text-left text-[11.5px] transition',
                            selectedPath === item.path
                              ? 'bg-[rgba(76,141,255,0.18)] text-text'
                              : 'text-text-secondary hover:bg-surface-3 hover:text-text',
                          )}
                        >
                          {renderRow(item)}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        {detail}
      </div>
    </div>
  );
}

interface DetailProps {
  scope: DesignScope;
  slug: string;
  name: string;
  description: string;
  path: string;
  body: string | null;
  bodyError: string | null;
  extra?: React.ReactNode;
}

function Detail({
  scope,
  slug,
  name,
  description,
  path,
  body,
  bodyError,
  extra,
}: DetailProps) {
  const readOnly = scope === 'builtin';
  const openFile = useEditorStore((s) => s.open);

  const onOpen = useCallback(() => {
    // Built-in skills live inside the packaged app bundle and are
    // read-only to the user — but routing them through the same editor
    // tab pipeline is still useful for previewing. The user just won't
    // be able to save changes back to the asar.
    void openFile(path);
  }, [openFile, path]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-border bg-surface-2/60 px-3">
        <span className="truncate font-mono text-[10.5px] text-text-muted">
          {path.replace(/^\/Users\/[^/]+/, '~')}
        </span>
        {readOnly && (
          <span className="inline-flex items-center gap-1 rounded-full bg-surface-3 px-2 py-[1px] text-[9px] uppercase text-text-muted">
            <Lock size={9} /> read-only
          </span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={onOpen}
          className="inline-flex items-center gap-1 rounded-[6px] border border-border-subtle bg-surface-3 px-2.5 py-[5px] text-[11px] text-text-secondary transition hover:border-border-hi hover:bg-surface-4 hover:text-text"
          title="Open this file in a new editor tab"
        >
          <ExternalLink size={11} />
          Open in editor
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-baseline gap-2">
            <h3 className="text-[14px] font-semibold text-text">{name}</h3>
            <span className="font-mono text-[10.5px] text-text-dim">{slug}</span>
          </div>
          {description && (
            <p className="text-[11.5px] leading-snug text-text-secondary">
              {description}
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Meta label="Scope" value={scopeLabel(scope)} />
          {extra}
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
            Body preview
          </div>
          {bodyError ? (
            <div className="rounded-[6px] border border-semantic-error/30 bg-semantic-error/10 px-3 py-2 text-[11px] text-semantic-error">
              {bodyError}
            </div>
          ) : body === null ? (
            <div className="rounded-[6px] border border-border-subtle bg-surface-3 px-3 py-2 text-[11px] text-text-muted">
              Loading…
            </div>
          ) : (
            <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-[6px] border border-border-subtle bg-surface-3 px-3 py-2 font-mono text-[10.5px] leading-relaxed text-text-secondary">
              {body || '(empty)'}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyDetail({
  icon,
  title,
  hint,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <div className="flex h-full items-center justify-center text-[12px] text-text-muted">
      <div className="text-center">
        <div className="mx-auto mb-2">{icon}</div>
        <div>{title}</div>
        <div className="mt-1 text-[10.5px] text-text-dim">{hint}</div>
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-1.5">
      <div className="text-[9.5px] font-semibold uppercase tracking-wide text-text-muted">
        {label}
      </div>
      <div className="mt-0.5 text-[11px] text-text">{value}</div>
    </div>
  );
}

function scopeLabel(scope: DesignScope): string {
  if (scope === 'project') return 'Project';
  if (scope === 'global') return 'Global';
  return 'Built-in';
}

function groupAndFilter<T extends CatalogItem>(
  items: T[],
  filter: string,
  searchKey: (item: T) => string,
): Record<DesignScope, T[]> {
  const q = filter.toLowerCase().trim();
  const groups: Record<DesignScope, T[]> = {
    project: [],
    global: [],
    builtin: [],
  };
  for (const item of items) {
    if (q && !searchKey(item).toLowerCase().includes(q)) continue;
    groups[item.scope].push(item);
  }
  return groups;
}
