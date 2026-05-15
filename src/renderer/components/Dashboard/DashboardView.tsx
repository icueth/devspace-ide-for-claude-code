import {
  AlertTriangle,
  Brain,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Hash,
  Loader2,
  Network,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import type {
  MemPalaceDrawer,
  MemPalaceOverview,
  MemPalaceRoom,
  MemPalaceTriple,
  MemPalaceWing,
} from '@shared/mempalaceData';

declare const __APP_VERSION__: string;

/**
 * MemPalace Dashboard — replaces the legacy `~/.devspace/memory_v2` UI as
 * of v0.22.0. Browses the MemPalace vault directly (read-only SQLite) so
 * what the user sees here is exactly what Claude is reading from MCP.
 *
 * Layout:
 *   - Header: stats badges (drawers, wings, rooms, KG facts) + actions
 *   - Left rail: collapsible wing tree
 *   - Center: drawer list with substring search
 *   - Right: detail panel (selected drawer's content + related KG triples)
 */
export function DashboardView() {
  const [overview, setOverview] = useState<MemPalaceOverview | null>(null);
  const [wings, setWings] = useState<MemPalaceWing[]>([]);
  const [rooms, setRooms] = useState<Map<string, MemPalaceRoom[]>>(new Map());
  const [drawers, setDrawers] = useState<MemPalaceDrawer[]>([]);
  const [triples, setTriples] = useState<MemPalaceTriple[]>([]);
  const [selectedWing, setSelectedWing] = useState<string | null>(null);
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);
  const [expandedWings, setExpandedWings] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [selectedDrawerId, setSelectedDrawerId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [drawersLoading, setDrawersLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ov, wingList] = await Promise.all([
        api.mempalaceData.getOverview(),
        api.mempalaceData.listWings(),
      ]);
      setOverview(ov);
      setWings(wingList);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Reload the drawer pane whenever the filter set changes — wing/room
  // selection or a debounced query update.
  const loadDrawers = useCallback(async () => {
    setDrawersLoading(true);
    try {
      const list = await api.mempalaceData.listDrawers({
        wing: selectedWing ?? undefined,
        room: selectedRoom ?? undefined,
        query: query.trim() === '' ? undefined : query,
        limit: 80,
      });
      setDrawers(list);
      if (list.length > 0 && (selectedDrawerId === null || !list.some((d) => d.id === selectedDrawerId))) {
        setSelectedDrawerId(list[0]!.id);
      } else if (list.length === 0) {
        setSelectedDrawerId(null);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDrawersLoading(false);
    }
  }, [selectedWing, selectedRoom, query, selectedDrawerId]);

  useEffect(() => {
    if (searchTimer.current !== null) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      void loadDrawers();
    }, query.length === 0 ? 0 : 220);
    return () => {
      if (searchTimer.current !== null) clearTimeout(searchTimer.current);
    };
    // selectedDrawerId is intentionally excluded — re-running this effect
    // every time the selection changes would clobber the user's selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWing, selectedRoom, query]);

  // Lazy-load the rooms list for a wing when it's expanded for the first time.
  const toggleWing = useCallback(
    async (wing: string) => {
      const next = new Set(expandedWings);
      if (next.has(wing)) {
        next.delete(wing);
      } else {
        next.add(wing);
        if (!rooms.has(wing)) {
          try {
            const list = await api.mempalaceData.listRooms(wing);
            setRooms((prev) => {
              const m = new Map(prev);
              m.set(wing, list);
              return m;
            });
          } catch (err) {
            console.error('[mempalace] listRooms failed', err);
          }
        }
      }
      setExpandedWings(next);
    },
    [expandedWings, rooms],
  );

  const selectAll = useCallback(() => {
    setSelectedWing(null);
    setSelectedRoom(null);
  }, []);

  const selectWing = useCallback((wing: string) => {
    setSelectedWing(wing);
    setSelectedRoom(null);
  }, []);

  const selectRoom = useCallback((wing: string, room: string) => {
    setSelectedWing(wing);
    setSelectedRoom(room);
  }, []);

  // Pull related KG triples for the currently selected drawer's wing so the
  // detail pane can show "facts about this wing". Cheap query, no debounce.
  useEffect(() => {
    if (selectedDrawerId === null) {
      setTriples([]);
      return;
    }
    const drawer = drawers.find((d) => d.id === selectedDrawerId);
    if (drawer === undefined) {
      setTriples([]);
      return;
    }
    let cancelled = false;
    void api.mempalaceData
      .listTriples({ limit: 20 })
      .then((list) => {
        if (cancelled) return;
        if (drawer.wing === null) {
          setTriples(list);
          return;
        }
        const wingSlug = drawer.wing.toLowerCase();
        const related = list.filter(
          (t) =>
            t.subjectLabel.toLowerCase().includes(wingSlug) ||
            t.objectLabel.toLowerCase().includes(wingSlug) ||
            t.predicate.toLowerCase().includes(wingSlug),
        );
        setTriples(related.length > 0 ? related : list.slice(0, 8));
      })
      .catch(() => {
        if (!cancelled) setTriples([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedDrawerId, drawers]);

  const selectedDrawer = useMemo(
    () => drawers.find((d) => d.id === selectedDrawerId) ?? null,
    [drawers, selectedDrawerId],
  );

  // Render — branch the empty state at the top so all the
  // happy-path layout can assume an open vault below.
  if (loading && overview === null) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <div className="flex items-center gap-2 text-[12px] text-text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading MemPalace…
        </div>
      </div>
    );
  }

  if (overview !== null && !overview.vault.available) {
    return <EmptyVaultState reason={overview.vault.reason ?? 'MemPalace is not available.'} />;
  }

  return (
    <div className="flex h-full flex-col bg-background text-text">
      <DashboardHeader overview={overview} onRefresh={refresh} loading={loading} />

      {error !== null ? (
        <div className="mx-3 mt-2 flex items-start gap-2 rounded-[8px] border border-semantic-error/40 bg-semantic-error/10 px-3 py-2 text-[11.5px] text-semantic-error">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" />
          <div className="flex-1">{error}</div>
          <button
            type="button"
            onClick={() => setError(null)}
            className="rounded p-0.5 hover:bg-semantic-error/10"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <WingRail
          wings={wings}
          rooms={rooms}
          expandedWings={expandedWings}
          selectedWing={selectedWing}
          selectedRoom={selectedRoom}
          totalDrawers={overview?.drawerCount ?? 0}
          onSelectAll={selectAll}
          onSelectWing={selectWing}
          onSelectRoom={selectRoom}
          onToggleWing={toggleWing}
        />

        <DrawerList
          drawers={drawers}
          loading={drawersLoading}
          query={query}
          onQueryChange={setQuery}
          selectedDrawerId={selectedDrawerId}
          onSelect={setSelectedDrawerId}
          wingFilter={selectedWing}
          roomFilter={selectedRoom}
        />

        <DrawerDetail drawer={selectedDrawer} triples={triples} />
      </div>
    </div>
  );
}

// --- Empty state -----------------------------------------------------------

function EmptyVaultState({ reason }: { reason: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-background px-8 text-center">
      <div className="rounded-full bg-accent/10 p-3">
        <Brain className="h-7 w-7 text-accent" />
      </div>
      <h2 className="text-[15px] font-semibold text-text">MemPalace is empty</h2>
      <p className="max-w-md text-[12px] leading-relaxed text-text-muted">{reason}</p>
      <div className="mt-2 flex items-center gap-2 text-[11.5px] text-text-muted">
        <SettingsIcon className="h-3.5 w-3.5" />
        Open Settings → Memory to install or repair MemPalace.
      </div>
    </div>
  );
}

// --- Header ----------------------------------------------------------------

function DashboardHeader({
  overview,
  onRefresh,
  loading,
}: {
  overview: MemPalaceOverview | null;
  onRefresh: () => void;
  loading: boolean;
}) {
  const handleOpenVault = useCallback(() => {
    void api.mempalace.openVault().catch(() => undefined);
  }, []);

  return (
    <div className="flex items-center gap-3 border-b border-border-subtle bg-surface px-4 py-3">
      <div className="flex items-center gap-2">
        <div className="rounded-md bg-accent/10 p-1.5">
          <Brain className="h-4 w-4 text-accent" />
        </div>
        <div>
          <div className="text-[13px] font-semibold leading-tight text-text">MemPalace</div>
          <div className="text-[10.5px] leading-tight text-text-muted">
            v{__APP_VERSION__} · {overview?.vault.palaceDir ?? '—'}
          </div>
        </div>
      </div>

      <div className="ml-2 flex flex-wrap items-center gap-1.5">
        <StatBadge label="drawers" value={overview?.drawerCount ?? 0} />
        <StatBadge label="wings" value={overview?.wingCount ?? 0} />
        <StatBadge label="rooms" value={overview?.roomCount ?? 0} />
        <StatBadge label="kg facts" value={overview?.tripleCount ?? 0} />
        <StatBadge label="entities" value={overview?.entityCount ?? 0} />
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          onClick={handleOpenVault}
          className="inline-flex items-center gap-1.5 rounded-[6px] border border-border-subtle bg-background px-2.5 py-1 text-[11px] text-text hover:bg-surface-hover"
          title="Open vault folder in Finder"
        >
          <FolderOpen className="h-3.5 w-3.5" />
          Open vault
        </button>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-[6px] border border-border-subtle bg-background px-2.5 py-1 text-[11px] text-text hover:bg-surface-hover disabled:opacity-50"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading ? 'animate-spin' : null)} />
          Refresh
        </button>
      </div>
    </div>
  );
}

function StatBadge({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex items-baseline gap-1 rounded-full border border-border-subtle bg-background px-2 py-0.5 text-[10.5px] text-text-muted">
      <span className="font-mono font-semibold text-text">{value.toLocaleString()}</span>
      <span>{label}</span>
    </span>
  );
}

// --- Left rail -------------------------------------------------------------

function WingRail({
  wings,
  rooms,
  expandedWings,
  selectedWing,
  selectedRoom,
  totalDrawers,
  onSelectAll,
  onSelectWing,
  onSelectRoom,
  onToggleWing,
}: {
  wings: MemPalaceWing[];
  rooms: Map<string, MemPalaceRoom[]>;
  expandedWings: Set<string>;
  selectedWing: string | null;
  selectedRoom: string | null;
  totalDrawers: number;
  onSelectAll: () => void;
  onSelectWing: (wing: string) => void;
  onSelectRoom: (wing: string, room: string) => void;
  onToggleWing: (wing: string) => Promise<void>;
}) {
  const allActive = selectedWing === null && selectedRoom === null;
  return (
    <aside className="flex w-[220px] flex-none flex-col border-r border-border-subtle bg-surface">
      <div className="border-b border-border-subtle px-3 py-2">
        <div className="text-[10.5px] font-semibold uppercase tracking-wide text-text-muted">
          Wings
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <button
          type="button"
          onClick={onSelectAll}
          className={cn(
            'flex w-full items-center justify-between rounded-[6px] px-2 py-1.5 text-[11.5px]',
            allActive
              ? 'bg-accent/10 text-accent'
              : 'text-text hover:bg-surface-hover',
          )}
        >
          <span className="flex items-center gap-1.5">
            <Hash className="h-3.5 w-3.5" />
            All drawers
          </span>
          <span className="text-[10px] text-text-muted">{totalDrawers.toLocaleString()}</span>
        </button>

        <div className="mt-1 space-y-0.5">
          {wings.map((wing) => {
            const expanded = expandedWings.has(wing.name);
            const wingActive = selectedWing === wing.name && selectedRoom === null;
            const wingRooms = rooms.get(wing.name) ?? [];
            return (
              <div key={wing.name}>
                <div className="flex items-stretch">
                  <button
                    type="button"
                    onClick={() => void onToggleWing(wing.name)}
                    className="flex items-center rounded-l-[6px] px-1 text-text-muted hover:bg-surface-hover"
                    aria-label={expanded ? 'Collapse' : 'Expand'}
                  >
                    {expanded ? (
                      <ChevronDown className="h-3 w-3" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => onSelectWing(wing.name)}
                    className={cn(
                      'flex flex-1 items-center justify-between rounded-r-[6px] px-1.5 py-1 text-[11.5px]',
                      wingActive
                        ? 'bg-accent/10 text-accent'
                        : 'text-text hover:bg-surface-hover',
                    )}
                  >
                    <span className="truncate font-medium">{wing.name}</span>
                    <span className="ml-2 text-[10px] text-text-muted">
                      {wing.drawerCount.toLocaleString()}
                    </span>
                  </button>
                </div>
                {expanded && wingRooms.length > 0 ? (
                  <div className="ml-4 mt-0.5 space-y-0.5 border-l border-border-subtle pl-1">
                    {wingRooms.map((room) => {
                      const roomActive =
                        selectedWing === wing.name && selectedRoom === room.name;
                      return (
                        <button
                          type="button"
                          key={`${wing.name}/${room.name}`}
                          onClick={() => onSelectRoom(wing.name, room.name)}
                          className={cn(
                            'flex w-full items-center justify-between rounded-[6px] px-1.5 py-0.5 text-[11px]',
                            roomActive
                              ? 'bg-accent/10 text-accent'
                              : 'text-text-muted hover:bg-surface-hover hover:text-text',
                          )}
                        >
                          <span className="truncate">{room.name}</span>
                          <span className="ml-2 text-[10px]">{room.drawerCount}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
          {wings.length === 0 ? (
            <div className="px-2 py-3 text-[11px] text-text-muted">
              No wings yet — drawer count is zero.
            </div>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

// --- Drawer list -----------------------------------------------------------

function DrawerList({
  drawers,
  loading,
  query,
  onQueryChange,
  selectedDrawerId,
  onSelect,
  wingFilter,
  roomFilter,
}: {
  drawers: MemPalaceDrawer[];
  loading: boolean;
  query: string;
  onQueryChange: (v: string) => void;
  selectedDrawerId: number | null;
  onSelect: (id: number) => void;
  wingFilter: string | null;
  roomFilter: string | null;
}) {
  return (
    <section className="flex w-[380px] flex-none flex-col border-r border-border-subtle bg-background">
      <div className="border-b border-border-subtle px-3 py-2">
        <div className="flex items-center gap-2 rounded-[6px] border border-border-subtle bg-surface px-2.5 py-1.5">
          <Search className="h-3.5 w-3.5 text-text-muted" />
          <input
            type="text"
            placeholder={
              wingFilter !== null
                ? `Search in ${wingFilter}${roomFilter !== null ? '/' + roomFilter : ''}…`
                : 'Search MemPalace…'
            }
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            className="flex-1 bg-transparent text-[12px] text-text placeholder:text-text-muted focus:outline-none"
          />
          {query.length > 0 ? (
            <button
              type="button"
              onClick={() => onQueryChange('')}
              className="rounded p-0.5 text-text-muted hover:bg-surface-hover hover:text-text"
            >
              <X className="h-3 w-3" />
            </button>
          ) : null}
        </div>
        <div className="mt-1.5 flex items-center justify-between text-[10.5px] text-text-muted">
          <span>
            {drawers.length} {drawers.length === 1 ? 'drawer' : 'drawers'}
            {drawers.length === 80 ? ' (showing latest 80)' : ''}
          </span>
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {drawers.map((d) => {
          const active = d.id === selectedDrawerId;
          const snippet = d.document.slice(0, 220);
          return (
            <button
              type="button"
              key={d.id}
              onClick={() => onSelect(d.id)}
              className={cn(
                'flex w-full flex-col items-start gap-1 border-b border-border-subtle px-3 py-2 text-left text-[11.5px] transition-colors',
                active
                  ? 'bg-accent/8 text-text'
                  : 'text-text hover:bg-surface-hover',
              )}
            >
              <div className="flex w-full items-center gap-2 text-[10.5px] text-text-muted">
                {d.wing !== null ? (
                  <span className="rounded-full bg-accent/10 px-1.5 py-0.5 text-[9.5px] font-medium text-accent">
                    {d.wing}
                  </span>
                ) : null}
                {d.room !== null ? <span>/ {d.room}</span> : null}
                <span className="ml-auto font-mono text-[9.5px]">
                  {formatFiledAt(d.filedAt)}
                </span>
              </div>
              <div className="line-clamp-3 leading-snug">{snippet}</div>
            </button>
          );
        })}
        {!loading && drawers.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 py-8 text-center text-[11.5px] text-text-muted">
            No drawers match these filters.
          </div>
        ) : null}
      </div>
    </section>
  );
}

// --- Drawer detail ---------------------------------------------------------

function DrawerDetail({
  drawer,
  triples,
}: {
  drawer: MemPalaceDrawer | null;
  triples: MemPalaceTriple[];
}) {
  if (drawer === null) {
    return (
      <section className="flex flex-1 items-center justify-center bg-background">
        <div className="text-[12px] text-text-muted">Select a drawer to view its contents.</div>
      </section>
    );
  }
  return (
    <section className="flex min-w-0 flex-1 flex-col bg-background">
      <div className="border-b border-border-subtle px-4 py-3">
        <div className="flex flex-wrap items-center gap-1.5 text-[10.5px] text-text-muted">
          {drawer.wing !== null ? (
            <span className="rounded-full bg-accent/10 px-1.5 py-0.5 font-medium text-accent">
              {drawer.wing}
            </span>
          ) : null}
          {drawer.room !== null ? <span className="text-text-muted">{drawer.room}</span> : null}
          {drawer.hall !== null && drawer.hall !== drawer.room ? (
            <span className="text-text-muted">· {drawer.hall}</span>
          ) : null}
          {drawer.topic !== null ? (
            <span className="text-text-muted">· {drawer.topic}</span>
          ) : null}
          <span className="ml-auto font-mono">
            {drawer.filedAt !== null ? formatFiledAt(drawer.filedAt, true) : '—'}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-text-muted">
          {drawer.agent !== null ? <span>agent: {drawer.agent}</span> : null}
          {drawer.addedBy !== null ? <span>by: {drawer.addedBy}</span> : null}
          {drawer.sourceFile !== null && drawer.sourceFile.length > 0 ? (
            <span className="truncate font-mono">{drawer.sourceFile}</span>
          ) : null}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <pre className="whitespace-pre-wrap break-words font-sans text-[12.5px] leading-relaxed text-text">
          {drawer.document}
        </pre>
        {triples.length > 0 ? (
          <div className="mt-6 border-t border-border-subtle pt-3">
            <div className="mb-2 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-text-muted">
              <Network className="h-3 w-3" />
              Related facts ({triples.length})
            </div>
            <div className="space-y-1.5">
              {triples.map((t) => (
                <div
                  key={t.id}
                  className="rounded-[6px] border border-border-subtle bg-surface px-2 py-1.5 text-[11px]"
                >
                  <div className="flex flex-wrap items-baseline gap-1">
                    <span className="font-medium text-text">{t.subjectLabel}</span>
                    <span className="font-mono text-[10px] text-text-muted">{t.predicate}</span>
                    <span className="text-text">{t.objectLabel}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[9.5px] text-text-muted">
                    <span>conf {(t.confidence * 100).toFixed(0)}%</span>
                    {t.validFrom !== null ? (
                      <span className="font-mono">{t.validFrom.slice(0, 10)}</span>
                    ) : null}
                    {t.sourceCloset !== null ? (
                      <span className="truncate font-mono">{t.sourceCloset}</span>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

// --- Helpers ---------------------------------------------------------------

function formatFiledAt(value: string | null, full: boolean = false): string {
  if (value === null || value.length === 0) return '—';
  // mempalace filed_at is an ISO-like string (sometimes without TZ). Parse
  // permissively and fall back to the raw value when it isn't recognised.
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value.slice(0, 16);
  if (full) {
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  const diff = Date.now() - d.getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

