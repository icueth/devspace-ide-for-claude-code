import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Folder,
  Globe,
  Lock,
  Package,
  Paintbrush,
  Search,
  Sparkles,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import { useEditorStore } from '@renderer/state/editor';
import { useWorkspaceStore } from '@renderer/state/workspace';
import type { DesignScope, DesignSkill, DesignSystem } from '@shared/design';

type SubTab = 'skills' | 'systems';

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
  const [tab, setTab] = useState<SubTab>('skills');

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface-2/40 px-4 py-2">
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
        <div className="flex-1" />
        <span className="text-[10.5px] text-text-muted">
          Sources: <code className="font-mono">~/.claude/skills</code> ·{' '}
          <code className="font-mono">.claude/skills</code> · built-in pack
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === 'skills' ? <SkillsBrowser /> : <SystemsBrowser />}
      </div>
    </div>
  );
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
