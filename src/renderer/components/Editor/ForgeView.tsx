import {
  Bot,
  CheckCircle2,
  Download,
  Hammer,
  Inbox,
  Loader2,
  Plus,
  Search,
  Sparkles,
  X,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ChatDraftDialog } from '@renderer/components/Editor/forge/ChatDraftDialog';
import { CreateDraftDialog } from '@renderer/components/Editor/forge/CreateDraftDialog';
import { ForgeStatsCard } from '@renderer/components/Editor/forge/ForgeStatsCard';
import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import { useEditorStore, type EditorTab } from '@renderer/state/editor';
import type {
  ForgeCatalogItem,
  ForgeDraft,
  ForgeKind,
  ForgeScope,
  ForgeStats,
  ForgeSuggestion,
} from '@shared/types';

type ForgeTab = 'skills' | 'agents' | 'drafts';
type ScopeFilter = 'all' | ForgeScope;

interface ForgeViewProps {
  tab: EditorTab;
}

/**
 * Forge — self-evolving skill / agent workshop. Lists installed skills
 * + agents with their use stats, lets users generate new ones from a
 * brief, and shows an inbox of auto-suggestions.
 */
export function ForgeView({ tab }: ForgeViewProps) {
  const projectPath = tab.forgeProjectPath ?? '';

  // ─── Data ───────────────────────────────────────────────────────────
  const [stats, setStats] = useState<ForgeStats[]>([]);
  const [drafts, setDrafts] = useState<ForgeDraft[]>([]);
  const [suggestions, setSuggestions] = useState<ForgeSuggestion[]>([]);
  const [catalog, setCatalog] = useState<ForgeCatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ─── UI state ───────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<ForgeTab>('skills');
  const [scope, setScope] = useState<ScopeFilter>('all');
  const [query, setQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [createPrefill, setCreatePrefill] = useState<{
    kind?: ForgeKind;
    scope?: ForgeScope;
    slug?: string;
    brief?: string;
  } | null>(null);
  const [chatDraftId, setChatDraftId] = useState<string | null>(null);

  // ─── v0.24 chat → Forge bridge: hydrate prefill once ────────────────
  // Tab carries `forgePrefillBrief` + `forgePrefillKind` from slash
  // command. Consume on first mount then clear so re-activating the
  // tab doesn't re-open the dialog unexpectedly.
  const tabPath = projectPath ? `forge:${projectPath}` : null;
  const tabPrefillBrief = useEditorStore((s) =>
    tabPath ? s.tabs.find((t) => t.path === tabPath)?.forgePrefillBrief : undefined,
  );
  const tabPrefillKind = useEditorStore((s) =>
    tabPath ? s.tabs.find((t) => t.path === tabPath)?.forgePrefillKind : undefined,
  );
  const tabPrefillConsumed = useEditorStore((s) =>
    tabPath ? s.tabs.find((t) => t.path === tabPath)?.forgePrefillConsumed : true,
  );
  useEffect(() => {
    if (!tabPath || tabPrefillConsumed !== false) return;
    if (tabPrefillBrief || tabPrefillKind) {
      setCreatePrefill({
        brief: tabPrefillBrief,
        kind: tabPrefillKind,
        scope: 'project',
      });
      setCreateOpen(true);
    }
    useEditorStore.getState().consumeForgePrefill(tabPath);
  }, [tabPath, tabPrefillBrief, tabPrefillKind, tabPrefillConsumed]);

  // ─── Initial + refresh loaders ──────────────────────────────────────
  const refresh = useCallback(async () => {
    if (!projectPath) return;
    try {
      const [s, d, sg, ca] = await Promise.all([
        api.forge.listStats(projectPath),
        api.forge.listDrafts(projectPath),
        api.forge.listSuggestions(projectPath),
        api.forge.discoverMatches(projectPath).catch(() => api.forge.listCatalog()),
      ]);
      setStats(s);
      setDrafts(d);
      setSuggestions(sg);
      setCatalog(ca);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  // ─── Live event subscription ────────────────────────────────────────
  useEffect(() => {
    if (!projectPath) return;
    const off = api.forge.onEvent((ev) => {
      // Most events relate to the active project — bail when scoped
      // elsewhere. `stats_updated` / `draft_*` can carry a draftId
      // without a projectPath, so we re-fetch for those too.
      if (ev.projectPath && ev.projectPath !== projectPath) return;
      if (
        ev.kind === 'draft_created' ||
        ev.kind === 'draft_updated' ||
        ev.kind === 'draft_ready' ||
        ev.kind === 'draft_error' ||
        ev.kind === 'draft_saved' ||
        ev.kind === 'draft_deleted' ||
        ev.kind === 'stats_updated' ||
        ev.kind === 'suggestion_added' ||
        ev.kind === 'suggestion_dismissed'
      ) {
        void refresh();
      }
      // Auto-open the chat dialog when a new draft is created so the
      // user can watch it stream. Skip if they already have one open.
      if (ev.kind === 'draft_created' && ev.draftId && !chatDraftId) {
        setChatDraftId(ev.draftId);
      }
    });
    return off;
  }, [projectPath, refresh, chatDraftId]);

  // ─── Derived ────────────────────────────────────────────────────────
  const filteredStats = useMemo(() => {
    const q = query.trim().toLowerCase();
    const targetKind: ForgeKind = activeTab === 'agents' ? 'agent' : 'skill';
    return stats.filter((s) => {
      if (activeTab === 'drafts') return false;
      if (s.kind !== targetKind) return false;
      if (scope !== 'all' && s.scope !== scope) return false;
      if (q && !s.slug.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [stats, activeTab, scope, query]);

  const filteredDrafts = useMemo(() => {
    const q = query.trim().toLowerCase();
    return drafts
      .filter((d) => (scope === 'all' ? true : d.scope === scope))
      .filter((d) => (q ? d.slug.toLowerCase().includes(q) || d.brief.toLowerCase().includes(q) : true))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [drafts, scope, query]);

  const counts = useMemo(() => {
    const skill = stats.filter((s) => s.kind === 'skill').length;
    const agent = stats.filter((s) => s.kind === 'agent').length;
    return { skills: skill, agents: agent, drafts: drafts.length };
  }, [stats, drafts]);

  // ─── Handlers ───────────────────────────────────────────────────────
  const handleNew = (kind: ForgeKind) => {
    setCreatePrefill({ kind, scope: 'project' });
    setCreateOpen(true);
  };

  const handleSuggestionGenerate = (sug: ForgeSuggestion) => {
    setCreatePrefill({
      kind: sug.suggestedKind,
      slug: sug.suggestedSlug,
      brief: sug.suggestedBrief,
      scope: 'project',
    });
    setCreateOpen(true);
  };

  const dismissSuggestion = async (id: string) => {
    try {
      await api.forge.dismissSuggestion({ projectPath, suggestionId: id });
    } catch (err) {
      console.error('[forge] dismissSuggestion failed', err);
    }
  };

  const installFromCatalog = async (item: ForgeCatalogItem) => {
    // We use the catalog body as the starter brief — the service
    // recognises the slug already, but generating a fresh draft lets
    // the user customize before commit.
    setCreatePrefill({
      kind: item.kind,
      slug: item.slug,
      brief: `Install ${item.kind} "${item.slug}" — ${item.description}\n\nMatches: ${item.matches.join(', ')}`,
      scope: 'project',
    });
    setCreateOpen(true);
  };

  // ─── Empty state ────────────────────────────────────────────────────
  if (!projectPath) {
    return (
      <div className="flex h-full items-center justify-center bg-surface text-[12px] text-text-muted">
        Forge needs a project — re-open this tab from the sidebar.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-surface text-text">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border bg-surface-2 px-4 py-2.5">
        <Hammer size={14} className="text-accent" />
        <div className="text-[13px] font-semibold">Forge</div>
        <span className="text-[10.5px] text-text-muted">
          Self-evolving skill / agent workshop
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => handleNew('skill')}
            className="inline-flex items-center gap-1 rounded-[6px] border border-border-subtle bg-surface-3 px-2.5 py-1 text-[11px] text-text-secondary transition hover:border-accent hover:bg-surface-4 hover:text-text"
          >
            <Plus size={11} />
            New skill
          </button>
          <button
            type="button"
            onClick={() => handleNew('agent')}
            className="inline-flex items-center gap-1 rounded-[6px] border border-border-subtle bg-surface-3 px-2.5 py-1 text-[11px] text-text-secondary transition hover:border-accent hover:bg-surface-4 hover:text-text"
          >
            <Plus size={11} />
            New agent
          </button>
        </div>
      </div>

      {/* Tabs + search */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle bg-surface-2 px-4 py-2">
        <TabPill
          active={activeTab === 'skills'}
          onClick={() => setActiveTab('skills')}
          label="Skills"
          icon={<Sparkles size={11} />}
          count={counts.skills}
        />
        <TabPill
          active={activeTab === 'agents'}
          onClick={() => setActiveTab('agents')}
          label="Agents"
          icon={<Bot size={11} />}
          count={counts.agents}
        />
        <TabPill
          active={activeTab === 'drafts'}
          onClick={() => setActiveTab('drafts')}
          label="Drafts"
          icon={<Hammer size={11} />}
          count={counts.drafts}
        />
        <div className="ml-3 flex items-center gap-1.5 rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-1">
          <Search size={11} className="text-text-muted" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by slug or brief…"
            className="w-[180px] bg-transparent text-[11.5px] text-text placeholder:text-text-muted focus:outline-none"
          />
        </div>
        <div className="ml-2 flex items-center gap-0.5 rounded-[6px] border border-border-subtle bg-surface-3 p-[2px]">
          <ScopePill active={scope === 'all'} onClick={() => setScope('all')} label="All" />
          <ScopePill active={scope === 'project'} onClick={() => setScope('project')} label="Project" />
          <ScopePill active={scope === 'global'} onClick={() => setScope('global')} label="Global" />
        </div>
      </div>

      {/* Main + right sidebar */}
      <div className="flex min-h-0 flex-1">
        {/* Main grid */}
        <section className="min-w-0 flex-1 overflow-y-auto px-4 py-3">
          {error && (
            <div className="mb-3 rounded border border-semantic-error/40 bg-semantic-error/10 px-3 py-2 text-[11px] text-semantic-error">
              {error}
            </div>
          )}

          {loading ? (
            <div className="flex items-center gap-2 text-[12px] text-text-muted">
              <Loader2 size={12} className="animate-spin" />
              Loading…
            </div>
          ) : activeTab === 'drafts' ? (
            <DraftGrid drafts={filteredDrafts} onOpen={setChatDraftId} />
          ) : (
            <StatsGrid
              projectPath={projectPath}
              stats={filteredStats}
              kindLabel={activeTab === 'agents' ? 'agents' : 'skills'}
              onRefine={(s) => {
                setCreatePrefill({
                  kind: s.kind,
                  scope: s.scope,
                  slug: `${s.slug}-v2`,
                  brief: `Refine the existing ${s.kind} "${s.slug}" — what should change?`,
                });
                setCreateOpen(true);
              }}
            />
          )}
        </section>

        {/* Right sidebar — suggestions + discover */}
        <aside className="flex w-[300px] flex-none flex-col border-l border-border bg-surface-2">
          <SuggestionsInbox
            suggestions={suggestions}
            onGenerate={handleSuggestionGenerate}
            onDismiss={(id) => void dismissSuggestion(id)}
          />
          <DiscoverPanel catalog={catalog} onInstall={(item) => void installFromCatalog(item)} />
        </aside>
      </div>

      {/* Modals */}
      <CreateDraftDialog
        open={createOpen}
        onOpenChange={(v) => {
          setCreateOpen(v);
          if (!v) setCreatePrefill(null);
        }}
        projectPath={projectPath}
        prefillKind={createPrefill?.kind}
        prefillScope={createPrefill?.scope}
        prefillSlug={createPrefill?.slug}
        prefillBrief={createPrefill?.brief}
        onCreated={(draft) => setChatDraftId(draft.id)}
      />
      <ChatDraftDialog
        open={!!chatDraftId}
        onOpenChange={(v) => {
          if (!v) setChatDraftId(null);
        }}
        draftId={chatDraftId}
        onSaved={() => {
          setChatDraftId(null);
          void refresh();
        }}
        onDeleted={() => {
          setChatDraftId(null);
          void refresh();
        }}
      />
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────

function TabPill({
  active,
  onClick,
  label,
  icon,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: React.ReactNode;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[6px] border px-2.5 py-1 text-[11.5px] transition',
        active
          ? 'border-accent bg-accent/15 text-text'
          : 'border-border-subtle bg-surface-3 text-text-secondary hover:bg-surface-4 hover:text-text',
      )}
    >
      {icon}
      <span>{label}</span>
      <span className="rounded-full bg-surface-4 px-1.5 py-[1px] text-[9.5px] text-text-muted">
        {count}
      </span>
    </button>
  );
}

function ScopePill({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-[5px] px-2 py-0.5 text-[10.5px] transition',
        active ? 'bg-accent/20 text-accent' : 'text-text-muted hover:text-text',
      )}
    >
      {label}
    </button>
  );
}

function StatsGrid({
  projectPath,
  stats,
  kindLabel,
  onRefine,
}: {
  projectPath: string;
  stats: ForgeStats[];
  kindLabel: string;
  onRefine: (s: ForgeStats) => void;
}) {
  if (stats.length === 0) {
    return (
      <div className="flex h-full min-h-[200px] items-center justify-center text-center text-[11.5px] text-text-muted">
        No {kindLabel} installed yet. Click <span className="mx-1 font-mono">+ New skill</span> or check the Discover panel.
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {stats.map((s) => (
        <ForgeStatsCard
          key={s.key}
          projectPath={projectPath}
          stat={s}
          onRefine={onRefine}
        />
      ))}
    </div>
  );
}

function DraftGrid({
  drafts,
  onOpen,
}: {
  drafts: ForgeDraft[];
  onOpen: (id: string) => void;
}) {
  if (drafts.length === 0) {
    return (
      <div className="flex h-full min-h-[200px] items-center justify-center text-center text-[11.5px] text-text-muted">
        No drafts in flight. Click <span className="mx-1 font-mono">+ New skill</span> to start one.
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {drafts.map((d) => (
        <DraftCard key={d.id} draft={d} onOpen={() => onOpen(d.id)} />
      ))}
    </div>
  );
}

function DraftCard({ draft, onOpen }: { draft: ForgeDraft; onOpen: () => void }) {
  const Icon = draft.kind === 'agent' ? Bot : Sparkles;
  const tone = draft.kind === 'agent' ? 'text-accent-2' : 'text-accent';
  const lastAssistant = [...draft.messages].reverse().find((m) => m.role === 'assistant');
  const statusMeta: Record<ForgeDraft['status'], { label: string; tone: string; icon: React.ReactNode }> = {
    pending: { label: 'pending', tone: 'bg-surface-3 text-text-muted', icon: null },
    generating: {
      label: 'generating',
      tone: 'bg-accent/15 text-accent',
      icon: <Loader2 size={9} className="animate-spin" />,
    },
    ready: {
      label: 'ready',
      tone: 'bg-semantic-success/15 text-semantic-success',
      icon: <CheckCircle2 size={9} />,
    },
    error: {
      label: 'error',
      tone: 'bg-semantic-error/15 text-semantic-error',
      icon: <XCircle size={9} />,
    },
  };
  const sm = statusMeta[draft.status];
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex flex-col items-start gap-2 rounded-[8px] border border-border-subtle bg-surface-2 p-3 text-left transition hover:border-border-hi hover:bg-surface-3"
    >
      <div className="flex w-full items-center gap-2">
        <Icon size={14} className={tone} />
        <div className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-text">
          {draft.slug || '(no slug)'}
        </div>
        <span className={cn('inline-flex items-center gap-1 rounded-full px-1.5 py-[1px] text-[9.5px] font-medium', sm.tone)}>
          {sm.icon}
          {sm.label}
        </span>
      </div>
      <div className="line-clamp-2 w-full text-[11px] text-text-muted">{draft.brief}</div>
      {lastAssistant && (
        <div className="line-clamp-2 w-full rounded-[6px] bg-surface px-2 py-1 font-mono text-[10.5px] text-text-secondary">
          {lastAssistant.content.slice(0, 220)}
        </div>
      )}
      <div className="flex w-full items-center justify-between text-[9.5px] text-text-muted">
        <span>{draft.scope === 'global' ? '🌐 global' : '📁 project'}</span>
        <span className="font-mono">{new Date(draft.updatedAt).toLocaleTimeString()}</span>
      </div>
    </button>
  );
}

function SuggestionsInbox({
  suggestions,
  onGenerate,
  onDismiss,
}: {
  suggestions: ForgeSuggestion[];
  onGenerate: (s: ForgeSuggestion) => void;
  onDismiss: (id: string) => void;
}) {
  return (
    <div className="flex flex-col border-b border-border bg-surface-2">
      <div className="flex items-center gap-1.5 px-3 py-2 text-[10.5px] font-semibold uppercase tracking-wider text-text-muted">
        <Inbox size={11} />
        Suggestions
        <span className="rounded-full bg-surface-3 px-1.5 py-[1px] text-[9.5px]">
          {suggestions.length}
        </span>
      </div>
      <div className="max-h-[280px] overflow-y-auto px-2 pb-2">
        {suggestions.length === 0 ? (
          <div className="px-2 py-3 text-[10.5px] text-text-muted">
            No suggestions yet — Forge watches your chat for repeated patterns.
          </div>
        ) : (
          suggestions.map((s) => (
            <div
              key={s.id}
              className="mb-1.5 rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-1.5"
            >
              <div className="mb-1 flex items-center gap-1.5">
                <span className="rounded-full bg-accent/15 px-1.5 py-[1px] text-[9.5px] text-accent">
                  {s.reason}
                </span>
                <span className="ml-auto text-[9.5px] text-text-muted">
                  {s.suggestedKind}
                </span>
              </div>
              <div className="mb-0.5 truncate font-mono text-[10.5px] text-text">
                {s.suggestedSlug}
              </div>
              <div className="line-clamp-2 text-[10.5px] text-text-muted">
                {s.suggestedBrief}
              </div>
              <div className="mt-1.5 flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onGenerate(s)}
                  className="inline-flex items-center gap-1 rounded-[5px] bg-accent px-1.5 py-0.5 text-[10px] font-medium text-white transition hover:brightness-110"
                >
                  <Sparkles size={9} />
                  Generate draft
                </button>
                <button
                  type="button"
                  onClick={() => onDismiss(s.id)}
                  className="rounded-[5px] border border-border-subtle bg-surface px-1.5 py-0.5 text-[10px] text-text-muted transition hover:text-text"
                >
                  <X size={9} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function DiscoverPanel({
  catalog,
  onInstall,
}: {
  catalog: ForgeCatalogItem[];
  onInstall: (item: ForgeCatalogItem) => void;
}) {
  const top = catalog.slice(0, 5);
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-1.5 px-3 py-2 text-[10.5px] font-semibold uppercase tracking-wider text-text-muted">
        <Download size={11} />
        Discover
        <span className="rounded-full bg-surface-3 px-1.5 py-[1px] text-[9.5px]">
          {catalog.length}
        </span>
      </div>
      <div className="text-[10px] text-text-muted px-3 pb-2">
        {top.length > 0
          ? `${top.length} starter ${top.length === 1 ? 'skill matches' : 'skills match'} this project`
          : 'No matching starter skills detected.'}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {top.map((item) => (
          <div
            key={item.slug}
            className="mb-1.5 rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-1.5"
          >
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[11px] font-medium text-text">{item.name}</span>
              <span className="ml-auto text-[9.5px] text-text-muted">{item.kind}</span>
            </div>
            <div className="line-clamp-2 text-[10.5px] text-text-muted">{item.description}</div>
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {item.matches.slice(0, 4).map((m) => (
                <span
                  key={m}
                  className="rounded-full bg-surface px-1.5 py-[1px] font-mono text-[9px] text-text-muted"
                >
                  {m}
                </span>
              ))}
            </div>
            <button
              type="button"
              onClick={() => onInstall(item)}
              className="mt-1.5 inline-flex items-center gap-1 rounded-[5px] bg-accent/80 px-1.5 py-0.5 text-[10px] font-medium text-white transition hover:bg-accent"
            >
              <Plus size={9} />
              Install
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
