import {
  BookOpen,
  Bot,
  Brain,
  Calendar,
  ChevronRight,
  Clock,
  ExternalLink,
  FileText,
  FolderOpen,
  FolderX,
  Hash,
  Home,
  Inbox,
  KeyRound,
  Lightbulb,
  Paintbrush,
  Pin,
  Plug,
  Plus,
  Search,
  Server,
  Settings as SettingsIcon,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { EntryEditor } from '@renderer/components/Dashboard/EntryEditor';
import { InboxList } from '@renderer/components/Dashboard/InboxList';
import { TimelineView } from '@renderer/components/Dashboard/TimelineView';
import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import {
  useDashboardStore,
  type DashboardView as DashboardViewName,
} from '@renderer/state/dashboard';
import { useWorkspaceStore } from '@renderer/state/workspace';
import type {
  MemoryEntry,
  MemoryInboxItem,
  MemoryProject,
  MemorySettings,
  MemoryStats,
  MemoryType,
} from '@shared/types';

// Friendly relative-time labels for the "Updated 3h ago" hints on list rows.
function formatRelative(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  const days = Math.floor(diff / 86400);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

// Color tokens for entry-type chips. Mirrors the inbox signal palette so
// users build a consistent mental model: same color = same family.
const TYPE_STYLES: Record<MemoryType, string> = {
  user: 'border-[rgba(168,85,247,0.3)] bg-[rgba(168,85,247,0.1)] text-accent-2',
  feedback: 'border-semantic-error/30 bg-semantic-error/10 text-semantic-error',
  project: 'border-accent/30 bg-accent/10 text-accent',
  reference: 'border-semantic-success/30 bg-semantic-success/10 text-semantic-success',
};

const SIDEBAR_NAV: Array<{
  view: DashboardViewName;
  label: string;
  icon: typeof Home;
}> = [
  { view: 'home', label: 'Home', icon: Home },
  { view: 'all', label: 'All entries', icon: BookOpen },
  { view: 'inbox', label: 'Inbox', icon: Inbox },
  { view: 'timeline', label: 'Timeline', icon: Calendar },
  { view: 'settings', label: 'Settings', icon: SettingsIcon },
];

/**
 * Cross-project memory dashboard — v0.19. Renders as a full-page editor
 * tab (kind='dashboard'), NOT a modal. Three regions:
 *   • Top bar: title + global search + settings shortcut.
 *   • Left rail: view picker + scope filters (project list, tag list).
 *   • Main area: switches by `currentView` between Home / All / Inbox /
 *     Timeline / Settings.
 *
 * Owns the EntryEditor side drawer for create/edit/delete flows. Each
 * sub-view (Inbox, Timeline) handles its own fetching + live event
 * subscription so the dashboard stays light.
 */
export function DashboardView() {
  const currentView = useDashboardStore((s) => s.currentView);
  const setView = useDashboardStore((s) => s.setView);
  const selectedProjectHash = useDashboardStore((s) => s.selectedProjectHash);
  const selectedTag = useDashboardStore((s) => s.selectedTag);
  const selectProject = useDashboardStore((s) => s.selectProject);
  const selectTag = useDashboardStore((s) => s.selectTag);
  const setProjectFilter = useDashboardStore((s) => s.setProjectFilter);
  const setTagFilter = useDashboardStore((s) => s.setTagFilter);
  const searchQuery = useDashboardStore((s) => s.searchQuery);
  const setSearchQuery = useDashboardStore((s) => s.setSearchQuery);
  const editingEntryId = useDashboardStore((s) => s.editingEntryId);
  const startEditing = useDashboardStore((s) => s.startEditing);

  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [projects, setProjects] = useState<MemoryProject[]>([]);
  const [inboxCount, setInboxCount] = useState<number>(0);
  const activeProject = useWorkspaceStore((s) => {
    const id = s.activeProjectId;
    return id ? s.projects.find((p) => p.id === id) ?? null : null;
  });

  // EntryEditor state: the editor renders both for create (when
  // editingEntryId === 'new') and for edit (when an id matches a known
  // entry). For inbox-accept flows we need a partial entry to pre-fill,
  // not a saved one, so we keep that suggestion in local state.
  const [editorTarget, setEditorTarget] = useState<{
    entry: MemoryEntry | null;
    prefill?: MemoryInboxItem;
  } | null>(null);

  // Initial load — stats + project list. Inbox count comes from a
  // dedicated listInbox(undefined) call since the stats endpoint doesn't
  // surface that number (it's volatile).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [s, p, inbox] = await Promise.all([
          api.memory.getStats(),
          api.memory.listProjects(),
          api.memory.listInbox(undefined),
        ]);
        if (cancelled) return;
        setStats(s);
        setProjects(p);
        setInboxCount(inbox.length);
      } catch (err) {
        console.error('[dashboard] initial load failed', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Refresh stats / inbox count on memory events. We re-fetch rather than
  // patch because the backend computes derived fields (top tags, diary
  // streak) that can't be locally synthesized.
  useEffect(() => {
    const unsub = api.memory.onEvent((ev) => {
      if (
        ev.kind === 'entry_created' ||
        ev.kind === 'entry_deleted' ||
        ev.kind === 'diary_updated' ||
        ev.kind === 'thread_summarized' ||
        ev.kind === 'index_rebuilt'
      ) {
        void api.memory.getStats().then(setStats).catch(console.error);
      }
      if (ev.kind === 'inbox_added' || ev.kind === 'inbox_resolved') {
        void api.memory
          .listInbox(undefined)
          .then((list) => setInboxCount(list.length))
          .catch(console.error);
      }
    });
    return unsub;
  }, []);

  // Sync the editor with the store's editingEntryId. The store holds the
  // id only; resolving it to a MemoryEntry requires either knowing the
  // entry already (from a list) or calling getEntry.
  useEffect(() => {
    if (editingEntryId === null) {
      setEditorTarget(null);
      return;
    }
    if (editingEntryId === 'new') {
      setEditorTarget({ entry: null });
      return;
    }
    void (async () => {
      const entry = await api.memory.getEntry(editingEntryId).catch(() => null);
      if (entry) setEditorTarget({ entry });
    })();
  }, [editingEntryId]);

  const handleNewEntry = useCallback(() => {
    startEditing('new');
  }, [startEditing]);

  const handleAcceptInbox = useCallback((item: MemoryInboxItem) => {
    // Pre-fill the editor with the suggestion. We render a transient
    // MemoryEntry-shaped object so the editor's create-mode validation
    // still kicks in (slug, etc.).
    setEditorTarget({
      entry: null,
      prefill: item,
    });
  }, []);

  const handleEditorClose = useCallback(() => {
    setEditorTarget(null);
    startEditing(null);
  }, [startEditing]);

  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => b.lastAccessedAt - a.lastAccessedAt),
    [projects],
  );

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-surface">
      <DashboardTopBar
        onNewEntry={handleNewEntry}
        onSettings={() => setView('settings')}
      />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <DashboardSidebar
          currentView={currentView}
          onView={setView}
          projects={sortedProjects}
          tags={stats?.topTags ?? []}
          selectedProjectHash={selectedProjectHash}
          selectedTag={selectedTag}
          onSelectProject={selectProject}
          onSelectTag={selectTag}
          inboxCount={inboxCount}
        />
        <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {/* Filter chips — show what's currently filtering the main view */}
          {(selectedProjectHash || selectedTag || searchQuery) && (
            <div className="flex shrink-0 items-center gap-1.5 border-b border-border-subtle bg-surface-2 px-4 py-2 text-[11px]">
              <span className="text-text-muted">Filtering:</span>
              {selectedProjectHash && (
                <FilterChip
                  label={
                    projects.find((p) => p.hash === selectedProjectHash)?.name ??
                    'project'
                  }
                  onClear={() => setProjectFilter(null)}
                />
              )}
              {selectedTag && (
                <FilterChip
                  label={`#${selectedTag}`}
                  onClear={() => setTagFilter(null)}
                />
              )}
              {searchQuery && (
                <FilterChip
                  label={`"${searchQuery}"`}
                  onClear={() => setSearchQuery('')}
                />
              )}
            </div>
          )}
          <div className="flex-1 px-6 py-5">
            {currentView === 'home' && (
              <HomeView
                stats={stats}
                inboxCount={inboxCount}
                onView={setView}
                onAcceptInbox={handleAcceptInbox}
                projectHash={selectedProjectHash}
              />
            )}
            {currentView === 'all' && (
              <AllEntriesView
                projectHash={selectedProjectHash}
                tag={selectedTag}
                searchQuery={searchQuery}
                onEdit={(id) => startEditing(id)}
              />
            )}
            {currentView === 'inbox' && (
              <div className="flex flex-col gap-3">
                <h2 className="text-[14px] font-semibold text-text">Inbox</h2>
                <p className="text-[11.5px] text-text-muted">
                  Auto-captured suggestions waiting for your review. Accept to
                  promote into a real memory entry, or dismiss to discard.
                </p>
                <InboxList
                  projectHash={selectedProjectHash}
                  mode="full"
                  onAccept={handleAcceptInbox}
                />
              </div>
            )}
            {currentView === 'timeline' && (
              <div className="flex flex-col gap-3">
                <h2 className="text-[14px] font-semibold text-text">Timeline</h2>
                <TimelineView
                  projectPath={
                    selectedProjectHash
                      ? projects.find((p) => p.hash === selectedProjectHash)?.path
                      : activeProject?.path
                  }
                />
              </div>
            )}
            {currentView === 'settings' && <SettingsView />}
          </div>
        </main>
      </div>
      {editorTarget && (
        <EntryEditor
          // Remount when switching between entries (or new ↔ existing)
          // so the local form state initializers re-run. Without a key
          // the editor keeps showing the previous entry's fields when
          // the user clicks a different row.
          key={editorTarget.entry?.id ?? 'new'}
          entry={editorTarget.entry}
          prefill={editorTarget.prefill}
          initialScope={
            editorTarget.prefill || selectedProjectHash || activeProject
              ? 'project'
              : 'global'
          }
          initialProjectPath={
            selectedProjectHash
              ? projects.find((p) => p.hash === selectedProjectHash)?.path
              : activeProject?.path
          }
          initialType={editorTarget.prefill?.suggestedType ?? 'project'}
          onClose={handleEditorClose}
          onSaved={() => {
            void api.memory.getStats().then(setStats).catch(console.error);
          }}
          onDeleted={() => {
            void api.memory.getStats().then(setStats).catch(console.error);
          }}
        />
      )}
    </div>
  );
}

// ─── Top bar ──────────────────────────────────────────────────────────────

interface DashboardTopBarProps {
  onNewEntry: () => void;
  onSettings: () => void;
}

function DashboardTopBar({ onNewEntry, onSettings }: DashboardTopBarProps) {
  const searchQuery = useDashboardStore((s) => s.searchQuery);
  const setSearchQuery = useDashboardStore((s) => s.setSearchQuery);
  const setView = useDashboardStore((s) => s.setView);
  const [local, setLocal] = useState(searchQuery);

  // Debounced search — 250ms after the last keystroke we flush into the
  // store, which drives `AllEntriesView`'s search effect. This avoids
  // hammering the backend on every key.
  useEffect(() => {
    const t = setTimeout(() => {
      if (local !== searchQuery) setSearchQuery(local);
    }, 250);
    return () => clearTimeout(t);
  }, [local, searchQuery, setSearchQuery]);

  // When local search activates, hop to the All view so the user sees
  // results. We do this on the edge (empty → non-empty), not every render.
  const handleChange = (val: string) => {
    setLocal(val);
    if (val && !searchQuery) setView('all');
  };

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-surface-2 px-5">
      <div className="flex items-center gap-2">
        <Sparkles size={14} className="text-accent" />
        <h1 className="text-[13.5px] font-semibold text-text">Memory dashboard</h1>
      </div>
      <div className="ml-2 hidden text-[10.5px] uppercase tracking-wider text-text-dim md:block">
        v0.19
      </div>
      <div className="relative ml-auto w-[380px] max-w-[40vw]">
        <Search
          size={11}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted"
        />
        <input
          type="search"
          value={local}
          onChange={(e) => handleChange(e.target.value)}
          placeholder="Search memories…"
          className="w-full rounded-[7px] border border-border-subtle bg-surface px-7 py-1.5 text-[12px] text-text outline-none transition focus:border-accent"
        />
        {local && (
          <button
            type="button"
            onClick={() => handleChange('')}
            className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-text-muted hover:bg-surface-3 hover:text-text"
            title="Clear search"
            aria-label="Clear search"
          >
            <X size={10} />
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={onNewEntry}
        className="inline-flex h-[26px] items-center gap-1.5 rounded-[7px] border border-accent/40 bg-accent/10 px-2.5 text-[11px] font-medium text-accent transition hover:bg-accent/20"
        title="Create a new memory entry"
      >
        <Plus size={11} />
        New entry
      </button>
      <button
        type="button"
        onClick={onSettings}
        className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] border border-border-subtle bg-surface-3 text-text-muted transition hover:border-border-hi hover:text-text"
        title="Memory settings"
        aria-label="Settings"
      >
        <SettingsIcon size={12} />
      </button>
    </header>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────

interface DashboardSidebarProps {
  currentView: DashboardViewName;
  onView: (view: DashboardViewName) => void;
  projects: MemoryProject[];
  tags: MemoryStats['topTags'];
  selectedProjectHash: string | null;
  selectedTag: string | null;
  onSelectProject: (hash: string | null) => void;
  onSelectTag: (tag: string | null) => void;
  inboxCount: number;
}

function DashboardSidebar({
  currentView,
  onView,
  projects,
  tags,
  selectedProjectHash,
  selectedTag,
  onSelectProject,
  onSelectTag,
  inboxCount,
}: DashboardSidebarProps) {
  return (
    <aside className="flex w-[240px] shrink-0 flex-col gap-3 overflow-y-auto border-r border-border bg-surface-sidebar px-2 py-3">
      <nav className="flex flex-col gap-0.5">
        {SIDEBAR_NAV.map((item) => {
          const Icon = item.icon;
          const active = currentView === item.view;
          return (
            <button
              key={item.view}
              type="button"
              onClick={() => onView(item.view)}
              className={cn(
                'flex items-center justify-between rounded-[6px] px-2.5 py-1.5 text-[12px] transition',
                active
                  ? 'bg-accent/15 text-accent'
                  : 'text-text-secondary hover:bg-surface-3 hover:text-text',
              )}
            >
              <span className="flex items-center gap-2">
                <Icon size={12} />
                {item.label}
              </span>
              {item.view === 'inbox' && inboxCount > 0 && (
                <span
                  className={cn(
                    'inline-flex h-4 min-w-[18px] items-center justify-center rounded-full px-1 font-mono text-[9.5px]',
                    active ? 'bg-accent text-white' : 'bg-surface-4 text-text-muted',
                  )}
                >
                  {inboxCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="mt-1 border-t border-border-subtle pt-2">
        <SidebarSectionHeader
          label="All projects"
          count={projects.length}
          allActive={selectedProjectHash === null}
          onClearFilter={() => onSelectProject(null)}
        />
        <div className="flex flex-col gap-0.5">
          {projects.length === 0 ? (
            <div className="px-2.5 py-1.5 text-[11px] text-text-dim">
              No projects yet.
            </div>
          ) : (
            projects.slice(0, 50).map((p) => {
              const active = selectedProjectHash === p.hash;
              const ghost = !p.pathExists;
              // Trim the file basename off the absolute path so the
              // secondary line shows the parent dir — much more useful
              // than re-displaying the project name beside its own label.
              const parentDir = p.path.replace(/\/[^/]+$/, '') || '/';
              return (
                <button
                  key={p.hash}
                  type="button"
                  onClick={() => onSelectProject(active ? null : p.hash)}
                  className={cn(
                    'group flex items-start justify-between gap-2 rounded-[5px] px-2.5 py-1 text-left text-[11.5px] transition',
                    active
                      ? 'bg-accent/15 text-accent'
                      : 'text-text-secondary hover:bg-surface-3 hover:text-text',
                    ghost && !active && 'opacity-55',
                  )}
                  title={
                    ghost
                      ? `${p.path}\n(folder missing on disk)`
                      : p.path
                  }
                >
                  <span className="flex min-w-0 flex-col gap-px">
                    <span className="flex items-center gap-1.5">
                      <FolderOpen size={10} className="shrink-0" />
                      <span className="truncate">{p.name}</span>
                      {ghost && (
                        <span className="ml-1 shrink-0 rounded-sm bg-surface-3 px-1 py-px font-mono text-[9px] uppercase tracking-wider text-text-dim">
                          missing
                        </span>
                      )}
                    </span>
                    <span className="truncate pl-3.5 font-mono text-[9.5px] text-text-dim">
                      {parentDir}
                    </span>
                  </span>
                  <span className="mt-0.5 shrink-0 font-mono text-[9.5px] text-text-dim">
                    {p.memoryCount}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>

      <div className="mt-1 border-t border-border-subtle pt-2">
        <SidebarSectionHeader
          label="Tags"
          count={tags.length}
          allActive={selectedTag === null}
          onClearFilter={() => onSelectTag(null)}
        />
        <div className="flex flex-col gap-0.5">
          {tags.length === 0 ? (
            <div className="px-2.5 py-1.5 text-[11px] text-text-dim">
              No tags yet.
            </div>
          ) : (
            tags.map((t) => {
              const active = selectedTag === t.tag;
              return (
                <button
                  key={t.tag}
                  type="button"
                  onClick={() => onSelectTag(active ? null : t.tag)}
                  className={cn(
                    'flex items-center justify-between rounded-[5px] px-2.5 py-1 text-[11.5px] transition',
                    active
                      ? 'bg-accent/15 text-accent'
                      : 'text-text-secondary hover:bg-surface-3 hover:text-text',
                  )}
                >
                  <span className="flex items-center gap-1.5 truncate">
                    <Hash size={10} />
                    <span className="truncate">{t.tag}</span>
                  </span>
                  <span className="ml-2 shrink-0 font-mono text-[9.5px] text-text-dim">
                    {t.count}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </aside>
  );
}

function SidebarSectionHeader({
  label,
  count,
  allActive,
  onClearFilter,
}: {
  label: string;
  count: number;
  allActive: boolean;
  onClearFilter: () => void;
}) {
  return (
    <div className="mb-1 flex items-center justify-between px-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
      <span>
        {label} ({count})
      </span>
      {!allActive && (
        <button
          type="button"
          onClick={onClearFilter}
          className="rounded px-1 text-text-muted hover:bg-surface-3 hover:text-text"
          title="Clear filter"
        >
          <X size={9} />
        </button>
      )}
    </div>
  );
}

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10.5px] text-accent">
      {label}
      <button
        type="button"
        onClick={onClear}
        className="flex h-3 w-3 items-center justify-center rounded-full hover:bg-accent/20"
        title="Clear"
      >
        <X size={9} />
      </button>
    </span>
  );
}

// ─── Home view ───────────────────────────────────────────────────────────

interface HomeViewProps {
  stats: MemoryStats | null;
  inboxCount: number;
  onView: (view: DashboardViewName) => void;
  onAcceptInbox: (item: MemoryInboxItem) => void;
  projectHash: string | null;
}

function HomeView({
  stats,
  inboxCount,
  onView,
  onAcceptInbox,
  projectHash,
}: HomeViewProps) {
  const [recent, setRecent] = useState<MemoryEntry[]>([]);
  const [pinned, setPinned] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const [recentList, pinnedList] = await Promise.all([
          api.memory.listEntries({ scope: 'project' }).catch(() => []),
          api.memory.listEntries({ scope: 'project', pinnedOnly: true }).catch(() => []),
        ]);
        if (cancelled) return;
        const sortedRecent = [...recentList]
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 12);
        setRecent(sortedRecent);
        setPinned(pinnedList);
      } catch (err) {
        console.error('[dashboard] home load failed', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col gap-5">
      {/* Stats card */}
      <section
        className="grid grid-cols-2 gap-3 rounded-[10px] border border-border-subtle bg-surface-2 p-4 sm:grid-cols-4"
        aria-label="Memory stats"
      >
        <StatCard
          label="Projects"
          value={stats?.totalProjects ?? 0}
          icon={FolderOpen}
        />
        <StatCard
          label="Memories"
          value={stats?.totalMemories ?? 0}
          icon={BookOpen}
        />
        <StatCard
          label="Diary days"
          value={stats?.totalDiaryDays ?? 0}
          icon={Calendar}
        />
        <StatCard
          label="Streak"
          value={stats?.diaryStreak ?? 0}
          suffix="days"
          icon={Sparkles}
          accent
        />
      </section>

      {/* Recent entries */}
      <section>
        <SectionHeader
          title="Recent entries"
          onSeeAll={() => onView('all')}
          count={recent.length}
        />
        {loading ? (
          <div className="px-1 py-4 text-[11px] text-text-muted">Loading…</div>
        ) : recent.length === 0 ? (
          <EmptyHomeSection
            icon={BookOpen}
            message="No memories yet. Capture one from a chat thread or click 'New entry' above."
          />
        ) : (
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {recent.map((entry) => (
              <EntryRow key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
      </section>

      {/* Pinned */}
      <section>
        <SectionHeader
          title="Pinned"
          onSeeAll={() => onView('all')}
          count={pinned.length}
        />
        {pinned.length === 0 ? (
          <EmptyHomeSection
            icon={Pin}
            message="No pinned memories. Pin the most important entries so they stay at the top."
          />
        ) : (
          <div className="flex max-h-[280px] flex-col gap-2 overflow-y-auto">
            {pinned.slice(0, 50).map((entry) => (
              <EntryRow key={entry.id} entry={entry} compact />
            ))}
          </div>
        )}
      </section>

      {/* Inbox preview */}
      <section>
        <SectionHeader
          title="Inbox"
          onSeeAll={() => onView('inbox')}
          count={inboxCount}
        />
        <InboxList
          projectHash={projectHash}
          mode="preview"
          onAccept={onAcceptInbox}
          onJumpToFull={() => onView('inbox')}
        />
      </section>

      {/* Settings shortcuts — deep-link into Claude · Settings tabs */}
      <SettingsShortcuts
        variant="compact"
        onMemorySettings={() => onView('settings')}
      />
    </div>
  );
}

function StatCard({
  label,
  value,
  suffix,
  icon: Icon,
  accent,
}: {
  label: string;
  value: number;
  suffix?: string;
  icon: typeof Home;
  accent?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 rounded-[8px] border border-border-subtle bg-surface px-3 py-2.5">
      <Icon
        size={16}
        className={accent ? 'text-accent' : 'text-text-muted'}
      />
      <div className="flex min-w-0 flex-col">
        <span className="text-[10.5px] uppercase tracking-wider text-text-muted">
          {label}
        </span>
        <span className="flex items-baseline gap-1 text-[18px] font-bold tabular-nums text-text">
          {value}
          {suffix && (
            <span className="text-[10.5px] font-normal text-text-muted">
              {suffix}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

function SectionHeader({
  title,
  count,
  onSeeAll,
}: {
  title: string;
  count: number;
  onSeeAll?: () => void;
}) {
  return (
    <div className="mb-2 flex items-baseline justify-between">
      <h2 className="text-[12.5px] font-semibold uppercase tracking-wider text-text-secondary">
        {title}
        <span className="ml-1.5 font-mono text-[10px] text-text-dim">{count}</span>
      </h2>
      {onSeeAll && count > 0 && (
        <button
          type="button"
          onClick={onSeeAll}
          className="inline-flex items-center gap-1 text-[10.5px] text-text-muted hover:text-text"
        >
          See all
          <ChevronRight size={9} />
        </button>
      )}
    </div>
  );
}

function EmptyHomeSection({
  icon: Icon,
  message,
}: {
  icon: typeof Home;
  message: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-[8px] border border-dashed border-border-subtle bg-surface-2 px-4 py-5">
      <Icon size={16} className="shrink-0 text-text-dim" />
      <p className="text-[11.5px] leading-relaxed text-text-muted">{message}</p>
    </div>
  );
}

// ─── All entries view ────────────────────────────────────────────────────

interface AllEntriesViewProps {
  projectHash: string | null;
  tag: string | null;
  searchQuery: string;
  onEdit: (id: string) => void;
}

function AllEntriesView({
  projectHash,
  tag,
  searchQuery,
  onEdit,
}: AllEntriesViewProps) {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        if (searchQuery.trim().length > 0) {
          // Search path — backend ranks across slug/description/body/tags.
          const hits = await api.memory.search({
            query: searchQuery,
            scope: projectHash ? 'project' : undefined,
            tags: tag ? [tag] : undefined,
            limit: 200,
          });
          if (cancelled) return;
          setEntries(hits.map((h) => h.entry));
        } else {
          // List path — pulls both global and project entries when no
          // project filter is set. The backend honors `projectPath` when
          // present, otherwise returns the union across the user's stores.
          const [globalEntries, projectEntries] = await Promise.all([
            projectHash
              ? Promise.resolve([])
              : api.memory.listEntries({ scope: 'global' }).catch(() => []),
            api.memory
              .listEntries({
                scope: 'project',
              })
              .catch(() => []),
          ]);
          if (cancelled) return;
          let combined = [...globalEntries, ...projectEntries];
          if (projectHash) {
            combined = combined.filter((e) => e.projectHash === projectHash);
          }
          if (tag) {
            combined = combined.filter((e) => e.tags.includes(tag));
          }
          combined.sort((a, b) => b.updatedAt - a.updatedAt);
          setEntries(combined.slice(0, 200));
        }
      } catch (err) {
        console.error('[dashboard] all entries load failed', err);
        if (!cancelled) setEntries([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectHash, tag, searchQuery]);

  if (loading) {
    return <div className="px-1 py-4 text-[11px] text-text-muted">Loading…</div>;
  }

  if (entries.length === 0) {
    return (
      <EmptyHomeSection
        icon={BookOpen}
        message={
          searchQuery
            ? `No matches for "${searchQuery}".`
            : 'No entries match the current filters.'
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-[14px] font-semibold text-text">
        All entries
        <span className="ml-2 font-mono text-[11px] text-text-muted">
          {entries.length}
        </span>
      </h2>
      <ul className="flex flex-col gap-2">
        {entries.map((entry) => (
          <EntryRow
            key={entry.id}
            entry={entry}
            onClick={() => onEdit(entry.id)}
          />
        ))}
      </ul>
    </div>
  );
}

// ─── Entry row ───────────────────────────────────────────────────────────

interface EntryRowProps {
  entry: MemoryEntry;
  compact?: boolean;
  onClick?: () => void;
}

function EntryRow({ entry, compact, onClick }: EntryRowProps) {
  const selectTag = useDashboardStore((s) => s.selectTag);
  return (
    <li
      className={cn(
        'group flex flex-col gap-1.5 rounded-[8px] border border-border-subtle bg-surface-2 p-3 transition hover:border-border-hi',
        onClick && 'cursor-pointer',
      )}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
    >
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            'rounded-full border px-1.5 py-0.5 text-[10px] uppercase tracking-wider',
            TYPE_STYLES[entry.type],
          )}
        >
          {entry.type}
        </span>
        <span className="truncate font-mono text-[11.5px] text-text">
          {entry.slug}
        </span>
        {entry.pinned && (
          <Pin size={10} className="text-accent" aria-label="Pinned" />
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1 font-mono text-[10px] text-text-dim">
          <Clock size={9} />
          {formatRelative(entry.updatedAt)}
        </span>
      </div>
      {entry.description && (
        <p className="line-clamp-1 text-[12px] text-text-secondary">
          {entry.description}
        </p>
      )}
      {!compact && entry.preview && (
        <p className="line-clamp-2 text-[11px] leading-relaxed text-text-muted">
          {entry.preview}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1">
        {entry.scope === 'project' && entry.projectHash && (
          <span className="rounded border border-border-subtle bg-surface-3 px-1 py-px font-mono text-[9.5px] text-text-muted">
            project
          </span>
        )}
        {entry.scope === 'global' && (
          <span className="rounded border border-[rgba(168,85,247,0.3)] bg-[rgba(168,85,247,0.1)] px-1 py-px font-mono text-[9.5px] text-accent-2">
            global
          </span>
        )}
        {entry.tags.slice(0, 4).map((t) => (
          <button
            key={t}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              selectTag(t);
            }}
            className="rounded border border-border-subtle bg-surface-3 px-1 py-px font-mono text-[9.5px] text-text-secondary transition hover:border-accent/40 hover:text-accent"
          >
            #{t}
          </button>
        ))}
      </div>
    </li>
  );
}

// ─── Settings view ───────────────────────────────────────────────────────

function SettingsView() {
  const [settings, setSettings] = useState<MemorySettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await api.memory.getSettings();
        if (!cancelled) setSettings(s);
      } catch (err) {
        console.error('[dashboard] getSettings failed', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const patch = async (delta: Partial<MemorySettings>) => {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      const next = await api.memory.setSettings(delta);
      setSettings(next);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to save settings.');
    } finally {
      setSaving(false);
    }
  };

  if (!settings) {
    return <div className="px-1 py-4 text-[11px] text-text-muted">Loading settings…</div>;
  }

  return (
    <div className="flex max-w-[760px] flex-col gap-5">
      <div>
        <h2 className="text-[14px] font-semibold text-text">Settings</h2>
        <p className="mt-1 text-[11.5px] text-text-muted">
          Memory is stored locally under <code className="rounded bg-surface-3 px-1">~/.devspace/</code>.
          Toggles take effect immediately.
        </p>
      </div>

      <SettingsShortcuts variant="full" />

      <div className="flex items-center gap-2 border-t border-border-subtle pt-4">
        <Sparkles size={12} className="text-accent" />
        <h3 className="text-[12.5px] font-semibold uppercase tracking-wider text-text-secondary">
          Memory
        </h3>
      </div>

      <SettingRow
        label="Enabled"
        description="Master switch. When off, memory capture and recall both pause."
      >
        <Toggle
          checked={settings.enabled}
          onChange={(v) => patch({ enabled: v })}
          disabled={saving}
        />
      </SettingRow>

      <SettingRow
        label="Auto-capture"
        description="Smart mode flags corrections, decisions, and named entities. Manual only captures via slash-command. Off disables capture entirely."
      >
        <div className="flex gap-1">
          {(['smart', 'manual', 'off'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => patch({ autoCapture: mode })}
              disabled={saving}
              className={cn(
                'rounded-[5px] border px-2.5 py-1 text-[11px] transition',
                settings.autoCapture === mode
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border-subtle bg-surface-3 text-text-secondary hover:text-text',
              )}
            >
              {mode}
            </button>
          ))}
        </div>
      </SettingRow>

      <SettingRow
        label="Inject on new thread"
        description="Prepend the project's MEMORY.md to Claude's system prompt when a new chat thread starts. Bounded by max inject lines."
      >
        <Toggle
          checked={settings.injectOnNewThread}
          onChange={(v) => patch({ injectOnNewThread: v })}
          disabled={saving}
        />
      </SettingRow>

      <SettingRow
        label="Max inject lines"
        description={`How many lines of MEMORY.md to inject at most. Currently ${settings.maxInjectLines}.`}
      >
        <input
          type="range"
          min={20}
          max={500}
          step={10}
          value={settings.maxInjectLines}
          onChange={(e) =>
            void patch({ maxInjectLines: Number(e.target.value) })
          }
          disabled={saving}
          className="w-[180px] accent-accent"
        />
      </SettingRow>

      <SettingRow
        label="MemPalace sync"
        description="Opt-in one-way push to MemPalace MCP. Memories tagged [mempalace] get mirrored on save."
      >
        <Toggle
          checked={settings.mempalaceSyncEnabled}
          onChange={(v) => patch({ mempalaceSyncEnabled: v })}
          disabled={saving}
        />
      </SettingRow>

      <PruneGhostsRow onError={setError} />

      <div className="border-t border-border-subtle pt-4">
        <button
          type="button"
          onClick={() => {
            void api.memory
              .openDir('global')
              .catch((err) => setError((err as Error).message));
          }}
          className="inline-flex items-center gap-1.5 rounded-[6px] border border-border-subtle bg-surface-3 px-2.5 py-1.5 text-[11px] text-text-secondary transition hover:bg-surface-4 hover:text-text"
        >
          <ExternalLink size={11} />
          Open ~/.devspace/ in Finder
        </button>
      </div>

      {error && (
        <div className="rounded-[6px] border border-semantic-error/30 bg-semantic-error/10 px-2.5 py-1.5 text-[11px] text-semantic-error">
          {error}
        </div>
      )}
    </div>
  );
}

// ─── Settings shortcuts ──────────────────────────────────────────────────
//
// Ergonomic deep-link grid that opens the global Claude · Settings page on a
// specific tab. Reuses the `devspace:open-settings` custom event that
// App.tsx already subscribes to (App.tsx:106-127), so no plumbing is added.
// Settings replaces the editor area while open; closing it returns to the
// dashboard tab automatically.

type ClaudeSettingsTab =
  | 'account'
  | 'agents'
  | 'teams'
  | 'skills'
  | 'design'
  | 'mcp'
  | 'files'
  | 'tmux'
  | 'llm';

function openClaudeSettings(tab: ClaudeSettingsTab) {
  window.dispatchEvent(
    new CustomEvent('devspace:open-settings', { detail: { tab } }),
  );
}

const SHORTCUT_TILES: Array<{
  tab: ClaudeSettingsTab;
  label: string;
  hint: string;
  icon: typeof Home;
}> = [
  { tab: 'account', label: 'Account', hint: 'Subscription / API key', icon: KeyRound },
  { tab: 'agents', label: 'Agents', hint: 'Built-in & custom agents', icon: Bot },
  { tab: 'teams', label: 'Teams', hint: 'Multi-agent teams', icon: Users },
  { tab: 'skills', label: 'Skills', hint: 'Claude Code skills', icon: Lightbulb },
  { tab: 'design', label: 'Design', hint: 'Project tokens & libs', icon: Paintbrush },
  { tab: 'mcp', label: 'MCP', hint: 'MCP servers', icon: Plug },
  { tab: 'files', label: 'Files', hint: 'Raw ~/.claude/* edit', icon: FileText },
  { tab: 'tmux', label: 'tmux', hint: 'Sessions & runners', icon: Server },
  { tab: 'llm', label: 'LLM', hint: 'Provider routing', icon: Brain },
];

function SettingsShortcuts({
  variant = 'compact',
  onMemorySettings,
}: {
  variant?: 'compact' | 'full';
  onMemorySettings?: () => void;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[12.5px] font-semibold uppercase tracking-wider text-text-secondary">
          Settings shortcuts
          <span className="ml-1.5 font-mono text-[10px] text-text-dim">
            {SHORTCUT_TILES.length + (onMemorySettings ? 1 : 0)}
          </span>
        </h2>
        {variant === 'compact' && (
          <span className="text-[10.5px] text-text-muted">
            Open Claude · Settings on a specific tab
          </span>
        )}
      </div>
      <div
        className={cn(
          'grid gap-2',
          variant === 'compact'
            ? 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5'
            : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4',
        )}
      >
        {onMemorySettings && (
          <ShortcutTile
            label="Memory"
            hint="Auto-capture, inject, sync"
            icon={Sparkles}
            accent
            onClick={onMemorySettings}
          />
        )}
        {SHORTCUT_TILES.map((t) => (
          <ShortcutTile
            key={t.tab}
            label={t.label}
            hint={t.hint}
            icon={t.icon}
            onClick={() => openClaudeSettings(t.tab)}
          />
        ))}
      </div>
      {variant === 'full' && (
        <p className="mt-1 text-[11px] text-text-muted">
          Each tile opens the global Claude · Settings page on the selected
          tab. Closing it returns you here.
        </p>
      )}
    </section>
  );
}

function ShortcutTile({
  label,
  hint,
  icon: Icon,
  accent,
  onClick,
}: {
  label: string;
  hint: string;
  icon: typeof Home;
  accent?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${label} — ${hint}`}
      className={cn(
        'group flex items-start gap-2.5 rounded-[8px] border bg-surface-2 px-3 py-2.5 text-left transition',
        accent
          ? 'border-accent/40 hover:border-accent hover:bg-accent/5'
          : 'border-border-subtle hover:border-border-hi hover:bg-surface-3',
      )}
    >
      <Icon
        size={14}
        className={cn(
          'mt-[1px] shrink-0 transition',
          accent
            ? 'text-accent'
            : 'text-text-muted group-hover:text-text',
        )}
      />
      <div className="flex min-w-0 flex-col">
        <span className="text-[12px] font-medium text-text">{label}</span>
        <span className="truncate text-[10.5px] text-text-muted">{hint}</span>
      </div>
    </button>
  );
}

// Counts ghosts in real time + offers a one-click prune for empty
// ones. Ghosts with content are preserved (user may still want to read
// memories captured before moving the folder).
function PruneGhostsRow({ onError }: { onError: (msg: string | null) => void }) {
  const [projects, setProjects] = useState<MemoryProject[]>([]);
  const [busy, setBusy] = useState(false);
  const [lastPruned, setLastPruned] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await api.memory.listProjects();
      setProjects(list);
    } catch (err) {
      console.error('[dashboard] listProjects failed', err);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const ghosts = projects.filter((p) => !p.pathExists);
  const emptyGhosts = ghosts.filter(
    (p) => p.memoryCount === 0 && p.threadCount === 0 && p.diaryCount === 0,
  );
  const ghostsWithContent = ghosts.length - emptyGhosts.length;

  const handlePrune = async () => {
    setBusy(true);
    onError(null);
    try {
      const result = await api.memory.pruneGhostProjects();
      setLastPruned(result.prunedHashes.length);
      await refresh();
    } catch (err) {
      onError((err as Error).message ?? 'Failed to prune.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-start justify-between gap-4 rounded-[8px] border border-border-subtle bg-surface-2 px-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-medium text-text">Prune ghost projects</div>
        <p className="mt-0.5 text-[11px] leading-relaxed text-text-muted">
          Removes projects whose on-disk folder no longer exists AND have
          no captured memories. Ghosts with content are kept so you can
          still read them.
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[10.5px] text-text-dim">
          <span>
            <strong className="text-text-secondary">{emptyGhosts.length}</strong> empty ghost
            {emptyGhosts.length === 1 ? '' : 's'} ready to prune
          </span>
          {ghostsWithContent > 0 && (
            <span>
              <strong className="text-text-secondary">{ghostsWithContent}</strong> ghost
              {ghostsWithContent === 1 ? '' : 's'} kept (has content)
            </span>
          )}
          {lastPruned !== null && (
            <span className="text-semantic-success">
              Pruned {lastPruned} {lastPruned === 1 ? 'project' : 'projects'}.
            </span>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={() => void handlePrune()}
        disabled={busy || emptyGhosts.length === 0}
        className={cn(
          'inline-flex shrink-0 items-center gap-1.5 rounded-[6px] border px-2.5 py-1.5 text-[11px] transition',
          emptyGhosts.length === 0
            ? 'cursor-not-allowed border-border-subtle bg-surface-3 text-text-dim'
            : 'border-semantic-error/30 bg-semantic-error/10 text-semantic-error hover:bg-semantic-error/20',
        )}
      >
        <FolderX size={11} />
        {busy ? 'Pruning…' : `Prune ${emptyGhosts.length || ''}`.trim()}
      </button>
    </div>
  );
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-[8px] border border-border-subtle bg-surface-2 px-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-medium text-text">{label}</div>
        <p className="mt-0.5 text-[11px] leading-relaxed text-text-muted">
          {description}
        </p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      disabled={disabled}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition',
        checked
          ? 'border-accent bg-accent/30'
          : 'border-border-subtle bg-surface-3',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <span
        className={cn(
          'inline-block h-3.5 w-3.5 rounded-full transition-transform',
          checked ? 'translate-x-[18px] bg-accent' : 'translate-x-[2px] bg-text-muted',
        )}
      />
    </button>
  );
}

