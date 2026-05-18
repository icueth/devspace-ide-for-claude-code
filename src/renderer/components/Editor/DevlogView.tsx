import {
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  FileText,
  FolderOpen,
  Loader2,
  Pencil,
  Plus,
  Save,
  Settings as SettingsIcon,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import type { EditorTab } from '@renderer/state/editor';
import type {
  DevlogEntry,
  DevlogEntryType,
  DevlogPlanStatus,
  DevlogSettings,
} from '@shared/types';

interface DevlogViewProps {
  tab: EditorTab;
}

type FilterKind = 'all' | DevlogEntryType;

interface DateBucket {
  key: 'today' | 'yesterday' | 'last7' | 'older';
  label: string;
  entries: DevlogEntry[];
}

/**
 * Group entries into time-bucketed sections (Today / Yesterday / Last 7d / Older)
 * based on `createdAt`. Buckets are sorted newest-first; entries inside each
 * bucket are sorted newest-first as well.
 *
 * Exported so DevlogView's renderer-side tests can pin the bucketing
 * behavior without standing up the full component.
 */
export function groupByDate(entries: DevlogEntry[], now: number = Date.now()): DateBucket[] {
  // Anchor the day boundary to the user's local midnight so "Today" matches
  // the date the user actually sees on the wall clock, not a UTC midnight.
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const todayStart = start.getTime();
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
  const sevenDaysAgoStart = todayStart - 7 * 24 * 60 * 60 * 1000;

  const today: DevlogEntry[] = [];
  const yesterday: DevlogEntry[] = [];
  const last7: DevlogEntry[] = [];
  const older: DevlogEntry[] = [];

  for (const e of entries) {
    const t = e.createdAt;
    if (t >= todayStart) today.push(e);
    else if (t >= yesterdayStart) yesterday.push(e);
    else if (t >= sevenDaysAgoStart) last7.push(e);
    else older.push(e);
  }

  const sortDesc = (a: DevlogEntry, b: DevlogEntry) => b.createdAt - a.createdAt;
  today.sort(sortDesc);
  yesterday.sort(sortDesc);
  last7.sort(sortDesc);
  older.sort(sortDesc);

  const buckets: DateBucket[] = [];
  if (today.length > 0) buckets.push({ key: 'today', label: 'Today', entries: today });
  if (yesterday.length > 0)
    buckets.push({ key: 'yesterday', label: 'Yesterday', entries: yesterday });
  if (last7.length > 0)
    buckets.push({ key: 'last7', label: 'Last 7 days', entries: last7 });
  if (older.length > 0) buckets.push({ key: 'older', label: 'Older', entries: older });
  return buckets;
}

const TYPE_META: Record<
  DevlogEntryType,
  { label: string; icon: typeof ClipboardList; tone: string }
> = {
  plan: { label: 'Plans', icon: ClipboardList, tone: 'text-accent' },
  agent: { label: 'Agents', icon: Bot, tone: 'text-accent-2' },
  result: { label: 'Results', icon: CheckCircle2, tone: 'text-semantic-success' },
  log: { label: 'Logs', icon: FileText, tone: 'text-text-muted' },
};

export function DevlogView({ tab }: DevlogViewProps) {
  const projectPath = tab.devlogProjectPath ?? '';
  const [entries, setEntries] = useState<DevlogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKind>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedBody, setSelectedBody] = useState<string>('');
  const [bodyLoading, setBodyLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [creating, setCreating] = useState<DevlogEntryType | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [newBody, setNewBody] = useState('');
  const [busySave, setBusySave] = useState(false);
  const [settings, setSettings] = useState<DevlogSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // ─── Load entries ───────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    if (!projectPath) return;
    try {
      const list = await api.devlog.list({ projectPath });
      setEntries(list);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    // CR-8: clear entries synchronously on projectPath change so the
    // user doesn't flash the prior project's timeline before refresh
    // resolves.
    setEntries([]);
    setLoading(true);
    void refresh();
  }, [refresh]);

  // ─── Live event subscription ────────────────────────────────────────
  // CR-8: debounce refresh — auto-capture writes several entry_created
  // events per chat turn; debouncing collapses the burst into one walk.
  useEffect(() => {
    if (!projectPath) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void refresh();
      }, 300);
    };
    const off = api.devlog.onEvent((ev) => {
      if (ev.projectPath !== projectPath) return;
      if (
        ev.kind === 'entry_created' ||
        ev.kind === 'entry_updated' ||
        ev.kind === 'entry_deleted' ||
        ev.kind === 'index_rebuilt'
      ) {
        schedule();
      }
    });
    return () => {
      if (timer) clearTimeout(timer);
      off();
    };
  }, [projectPath, refresh]);

  // ─── Load settings once ─────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void api.devlog
      .getSettings()
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // ─── Selection body load ────────────────────────────────────────────
  useEffect(() => {
    if (!selectedId || !projectPath) {
      setSelectedBody('');
      return;
    }
    let cancelled = false;
    setBodyLoading(true);
    void api.devlog
      .get({ projectPath, entryId: selectedId })
      .then((entry) => {
        if (cancelled) return;
        setSelectedBody(entry?.body ?? '');
      })
      .catch(() => {
        if (!cancelled) setSelectedBody('');
      })
      .finally(() => {
        if (!cancelled) setBodyLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, projectPath]);

  // ─── Derived: filtered entries + counts ─────────────────────────────
  const counts = useMemo(() => {
    const map: Record<FilterKind, number> = { all: entries.length, plan: 0, agent: 0, result: 0, log: 0 };
    for (const e of entries) map[e.type] = (map[e.type] ?? 0) + 1;
    return map;
  }, [entries]);

  const filtered = useMemo(() => {
    if (filter === 'all') return entries;
    return entries.filter((e) => e.type === filter);
  }, [entries, filter]);

  const buckets = useMemo(() => groupByDate(filtered), [filtered]);

  const selected = useMemo(
    () => entries.find((e) => e.id === selectedId) ?? null,
    [entries, selectedId],
  );

  // When selection switches into edit mode, snapshot current values so
  // Cancel can discard changes cleanly.
  const startEdit = useCallback(() => {
    if (!selected) return;
    setDraftTitle(selected.title);
    setDraftBody(selectedBody);
    setEditing(true);
  }, [selected, selectedBody]);

  const cancelEdit = () => {
    setEditing(false);
    setDraftTitle('');
    setDraftBody('');
  };

  const saveEdit = useCallback(async () => {
    if (!selected || !projectPath) return;
    setBusySave(true);
    try {
      await api.devlog.update({
        projectPath,
        entryId: selected.id,
        title: draftTitle.trim() || selected.title,
        body: draftBody,
      });
      setEditing(false);
      // Optimistically update the cached body — the event listener will
      // refetch the index, but the body load runs on selection change so
      // we mirror it here so the detail pane stays in sync immediately.
      setSelectedBody(draftBody);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusySave(false);
    }
  }, [selected, projectPath, draftTitle, draftBody]);

  const deleteEntry = useCallback(async () => {
    if (!selected || !projectPath) return;
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete "${selected.title}"?`)) return;
    try {
      await api.devlog.delete({ projectPath, entryId: selected.id });
      setSelectedId(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [selected, projectPath]);

  const changePlanStatus = useCallback(
    async (status: DevlogPlanStatus) => {
      if (!selected || !projectPath) return;
      try {
        await api.devlog.update({ projectPath, entryId: selected.id, status });
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [selected, projectPath],
  );

  const createEntry = useCallback(async () => {
    if (!creating || !projectPath || !newTitle.trim()) return;
    setBusySave(true);
    try {
      const created = await api.devlog.create({
        projectPath,
        type: creating,
        title: newTitle.trim(),
        body: newBody,
        ...(creating === 'plan' ? { status: 'in_progress' as DevlogPlanStatus } : {}),
      });
      setCreating(null);
      setNewTitle('');
      setNewBody('');
      setSelectedId(created.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusySave(false);
    }
  }, [creating, projectPath, newTitle, newBody]);

  const updateSettings = useCallback(async (patch: Partial<DevlogSettings>) => {
    try {
      const next = await api.devlog.setSettings(patch);
      setSettings(next);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const openDir = useCallback(() => {
    if (!projectPath) return;
    void api.devlog.openDir(projectPath).catch(() => undefined);
  }, [projectPath]);

  // ─── Render ─────────────────────────────────────────────────────────
  if (!projectPath) {
    return (
      <div className="flex h-full items-center justify-center bg-surface text-[12px] text-text-muted">
        Devlog needs a project — re-open this tab from the sidebar.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-surface text-text">
      {/* Settings sub-panel (collapsible) */}
      <SettingsBar
        settings={settings}
        open={settingsOpen}
        onToggle={() => setSettingsOpen((v) => !v)}
        onChange={updateSettings}
        onOpenDir={openDir}
      />

      <div className="flex min-h-0 flex-1">
        {/* Left sidebar — filters + new entry buttons */}
        <aside className="flex w-[240px] flex-none flex-col border-r border-border bg-surface-2">
          <div className="border-b border-border-subtle px-3 py-2">
            <div className="text-[10.5px] font-semibold uppercase tracking-wide text-text-muted">
              Filter
            </div>
          </div>
          <div className="flex-1 overflow-y-auto px-2 py-2">
            <FilterRow
              label="All"
              icon={null}
              count={counts.all}
              active={filter === 'all'}
              onClick={() => setFilter('all')}
            />
            {(['plan', 'agent', 'result', 'log'] as DevlogEntryType[]).map((t) => {
              const meta = TYPE_META[t];
              const Icon = meta.icon;
              return (
                <FilterRow
                  key={t}
                  label={meta.label}
                  icon={<Icon size={12} className={meta.tone} />}
                  count={counts[t] ?? 0}
                  active={filter === t}
                  onClick={() => setFilter(t)}
                />
              );
            })}
          </div>
          <div className="border-t border-border-subtle px-2 py-2">
            <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-text-muted">
              Create
            </div>
            <NewButton label="+ New plan" onClick={() => setCreating('plan')} />
            <NewButton label="+ New result" onClick={() => setCreating('result')} />
            <NewButton label="+ New log entry" onClick={() => setCreating('log')} />
          </div>
        </aside>

        {/* Middle — timeline */}
        <section className="flex w-[420px] flex-none flex-col border-r border-border bg-surface">
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-border-subtle px-3">
            <div className="text-[10.5px] font-semibold uppercase tracking-wide text-text-muted">
              Timeline
            </div>
            {loading && <Loader2 size={12} className="animate-spin text-text-muted" />}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {error && (
              <div className="m-3 rounded border border-semantic-error/40 bg-semantic-error/10 p-2 text-[11px] text-semantic-error">
                {error}
              </div>
            )}
            {!loading && buckets.length === 0 && (
              <div className="flex h-full items-center justify-center px-6 text-center text-[11.5px] text-text-muted">
                {filter === 'all'
                  ? 'No devlog entries yet. Click "+ New plan" to start.'
                  : `No ${TYPE_META[filter as DevlogEntryType]?.label.toLowerCase() ?? ''} yet.`}
              </div>
            )}
            {buckets.map((bucket) => (
              <div key={bucket.key} className="mb-2">
                <div className="sticky top-0 z-[1] flex items-center gap-2 bg-surface px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                  <span>{bucket.label}</span>
                  <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[9.5px]">
                    {bucket.entries.length}
                  </span>
                </div>
                {bucket.entries.map((e) => (
                  <TimelineRow
                    key={e.id}
                    entry={e}
                    active={e.id === selectedId}
                    onClick={() => setSelectedId(e.id)}
                  />
                ))}
              </div>
            ))}
          </div>
        </section>

        {/* Right — detail */}
        <section className="flex min-w-0 flex-1 flex-col bg-surface">
          <DetailPane
            entry={selected}
            body={selectedBody}
            bodyLoading={bodyLoading}
            editing={editing}
            draftTitle={draftTitle}
            draftBody={draftBody}
            onChangeDraftTitle={setDraftTitle}
            onChangeDraftBody={setDraftBody}
            onEdit={startEdit}
            onCancelEdit={cancelEdit}
            onSaveEdit={saveEdit}
            onDelete={deleteEntry}
            onPlanStatus={changePlanStatus}
            busySave={busySave}
          />
        </section>
      </div>

      {/* Inline "new entry" modal */}
      {creating && (
        <NewEntryDialog
          kind={creating}
          title={newTitle}
          body={newBody}
          busy={busySave}
          onTitle={setNewTitle}
          onBody={setNewBody}
          onCancel={() => {
            setCreating(null);
            setNewTitle('');
            setNewBody('');
          }}
          onCreate={createEntry}
        />
      )}
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────

function FilterRow({
  label,
  icon,
  count,
  active,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center justify-between rounded-[6px] px-2 py-1.5 text-[11.5px] transition',
        active ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-surface-3 hover:text-text',
      )}
    >
      <span className="flex items-center gap-1.5">
        {icon}
        {label}
      </span>
      <span className="text-[10px] text-text-muted">{count}</span>
    </button>
  );
}

function NewButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-0.5 flex w-full items-center gap-1.5 rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-1.5 text-[11px] text-text-secondary transition hover:border-border-hi hover:bg-surface-4 hover:text-text"
    >
      <Plus size={11} />
      {label.replace(/^\+\s*/, '')}
    </button>
  );
}

function TimelineRow({
  entry,
  active,
  onClick,
}: {
  entry: DevlogEntry;
  active: boolean;
  onClick: () => void;
}) {
  const meta = TYPE_META[entry.type];
  const Icon = meta.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full flex-col items-start gap-1 border-b border-border-subtle px-3 py-2 text-left transition-colors',
        active ? 'bg-accent/10 text-text' : 'text-text hover:bg-surface-2',
      )}
    >
      <div className="flex w-full items-center gap-2">
        <Icon size={12} className={meta.tone} />
        <span className="truncate text-[12px] font-medium">{entry.title}</span>
        <span className="ml-auto shrink-0">
          <Chip entry={entry} />
        </span>
      </div>
      <div className="line-clamp-1 w-full text-[11px] text-text-muted">{entry.preview}</div>
    </button>
  );
}

function Chip({ entry }: { entry: DevlogEntry }) {
  if (entry.type === 'plan' && entry.status) {
    const tone =
      entry.status === 'done'
        ? 'bg-semantic-success/15 text-semantic-success'
        : entry.status === 'abandoned'
          ? 'bg-semantic-error/15 text-semantic-error'
          : 'bg-accent/15 text-accent';
    return (
      <span className={cn('rounded-full px-1.5 py-[1px] text-[9.5px] font-medium', tone)}>
        {entry.status.replace('_', ' ')}
      </span>
    );
  }
  if ((entry.type === 'agent' || entry.type === 'result') && entry.verdict) {
    const tone =
      entry.verdict === 'success'
        ? 'bg-semantic-success/15 text-semantic-success'
        : entry.verdict === 'failed'
          ? 'bg-semantic-error/15 text-semantic-error'
          : 'bg-semantic-warning/15 text-semantic-warning';
    return (
      <span className={cn('rounded-full px-1.5 py-[1px] text-[9.5px] font-medium', tone)}>
        {entry.verdict}
      </span>
    );
  }
  if (entry.type === 'result' && entry.version) {
    return (
      <span className="rounded-full bg-surface-3 px-1.5 py-[1px] font-mono text-[9.5px] text-text-muted">
        v{entry.version}
      </span>
    );
  }
  return null;
}

function DetailPane(props: {
  entry: DevlogEntry | null;
  body: string;
  bodyLoading: boolean;
  editing: boolean;
  draftTitle: string;
  draftBody: string;
  onChangeDraftTitle: (v: string) => void;
  onChangeDraftBody: (v: string) => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: () => Promise<void>;
  onDelete: () => Promise<void>;
  onPlanStatus: (s: DevlogPlanStatus) => Promise<void>;
  busySave: boolean;
}) {
  const {
    entry,
    body,
    bodyLoading,
    editing,
    draftTitle,
    draftBody,
    onChangeDraftTitle,
    onChangeDraftBody,
    onEdit,
    onCancelEdit,
    onSaveEdit,
    onDelete,
    onPlanStatus,
    busySave,
  } = props;

  if (!entry) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-[12px] text-text-muted">
        Select an entry, or click <span className="font-mono">+ New plan</span> to start.
      </div>
    );
  }

  const meta = TYPE_META[entry.type];
  const Icon = meta.icon;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-4 py-3">
        <Icon size={14} className={meta.tone} />
        {editing ? (
          <input
            type="text"
            value={draftTitle}
            onChange={(e) => onChangeDraftTitle(e.target.value)}
            className="min-w-0 flex-1 rounded border border-border-subtle bg-surface-2 px-2 py-1 text-[13px] font-semibold text-text focus:border-accent focus:outline-none"
          />
        ) : (
          <div className="min-w-0 flex-1 truncate text-[13px] font-semibold">{entry.title}</div>
        )}
        {entry.type === 'plan' && !editing && (
          <select
            value={entry.status ?? 'in_progress'}
            onChange={(e) => void onPlanStatus(e.target.value as DevlogPlanStatus)}
            className="rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-[3px] text-[11px] text-text focus:border-accent focus:outline-none"
          >
            <option value="in_progress">in_progress</option>
            <option value="done">done</option>
            <option value="abandoned">abandoned</option>
          </select>
        )}
        {!editing ? (
          <>
            <button
              type="button"
              onClick={onEdit}
              className="rounded p-1.5 text-text-muted transition hover:bg-surface-3 hover:text-text"
              title="Edit"
            >
              <Pencil size={12} />
            </button>
            <button
              type="button"
              onClick={() => void onDelete()}
              className="rounded p-1.5 text-text-muted transition hover:bg-surface-3 hover:text-semantic-error"
              title="Delete"
            >
              <Trash2 size={12} />
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onCancelEdit}
              disabled={busySave}
              className="rounded p-1.5 text-text-muted transition hover:bg-surface-3 hover:text-text disabled:opacity-50"
              title="Cancel"
            >
              <X size={12} />
            </button>
            <button
              type="button"
              onClick={() => void onSaveEdit()}
              disabled={busySave}
              className="inline-flex items-center gap-1 rounded-[6px] bg-accent px-2 py-1 text-[11px] font-medium text-white transition hover:brightness-110 disabled:opacity-50"
              title="Save"
            >
              {busySave ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
              Save
            </button>
          </>
        )}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border-subtle px-4 py-1.5 text-[10.5px] text-text-muted">
        <span className="rounded-full bg-surface-3 px-1.5 py-[1px]">{entry.type}</span>
        <Chip entry={entry} />
        {entry.subagentType && <span>agent: {entry.subagentType}</span>}
        {entry.durationMs !== undefined && <span>{Math.round(entry.durationMs / 100) / 10}s</span>}
        <span className="ml-auto font-mono">{new Date(entry.createdAt).toLocaleString()}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {bodyLoading ? (
          <div className="flex items-center gap-2 text-[12px] text-text-muted">
            <Loader2 size={12} className="animate-spin" /> Loading entry…
          </div>
        ) : editing ? (
          <textarea
            value={draftBody}
            onChange={(e) => onChangeDraftBody(e.target.value)}
            className="h-full min-h-[200px] w-full resize-none rounded border border-border-subtle bg-surface-2 px-3 py-2 font-mono text-[12px] text-text focus:border-accent focus:outline-none"
          />
        ) : (
          <pre className="whitespace-pre-wrap break-words font-sans text-[12.5px] leading-relaxed text-text">
            {body || entry.preview}
          </pre>
        )}
      </div>

      {entry.filesTouched && entry.filesTouched.length > 0 && (
        <div className="shrink-0 border-t border-border-subtle px-4 py-2 text-[10.5px] text-text-muted">
          <div className="mb-1 font-semibold uppercase tracking-wide">Files touched</div>
          <div className="space-y-0.5">
            {entry.filesTouched.slice(0, 10).map((f) => (
              <div key={f} className="truncate font-mono">
                {f}
              </div>
            ))}
            {entry.filesTouched.length > 10 && (
              <div className="text-[10px]">+{entry.filesTouched.length - 10} more</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SettingsBar({
  settings,
  open,
  onToggle,
  onChange,
  onOpenDir,
}: {
  settings: DevlogSettings | null;
  open: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<DevlogSettings>) => void;
  onOpenDir: () => void;
}) {
  return (
    <div className="shrink-0 border-b border-border bg-surface-2">
      <div className="flex h-9 items-center gap-2 px-3">
        <button
          type="button"
          onClick={onToggle}
          className="inline-flex items-center gap-1.5 rounded-[6px] px-2 py-1 text-[11px] text-text-secondary transition hover:bg-surface-3 hover:text-text"
        >
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          <SettingsIcon size={11} />
          Settings
        </button>
        <span className="text-[10.5px] text-text-muted">
          Devlog · per-project work log
        </span>
        <button
          type="button"
          onClick={onOpenDir}
          className="ml-auto inline-flex items-center gap-1.5 rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-1 text-[11px] text-text-secondary transition hover:border-border-hi hover:bg-surface-4 hover:text-text"
          title="Open .devspace/devlog/ in Finder"
        >
          <FolderOpen size={11} />
          Open dir
        </button>
      </div>

      {open && settings && (
        <div className="grid grid-cols-2 gap-3 border-t border-border-subtle px-4 py-3 text-[11.5px]">
          <CheckboxRow
            label="Auto-capture agents"
            hint="Log every Task() dispatch as an agent entry"
            checked={settings.autoCaptureAgents}
            onChange={(v) => onChange({ autoCaptureAgents: v })}
          />
          <CheckboxRow
            label="Inject on new thread"
            hint="Prepend latest devlog entries into new chat threads"
            checked={settings.injectOnNewThread}
            onChange={(v) => onChange({ injectOnNewThread: v })}
          />
          <NumberRow
            label="Max inject entries"
            value={settings.maxInjectEntries}
            min={1}
            max={50}
            onChange={(v) => onChange({ maxInjectEntries: v })}
          />
          <CheckboxRow
            label="Commit to repo"
            hint="Write .gitignore so devlog is tracked"
            checked={settings.commitToRepo}
            onChange={(v) => onChange({ commitToRepo: v })}
          />
          <NumberRow
            label="Log retention (days, 0 = forever)"
            value={settings.logRetentionDays}
            min={0}
            max={365}
            onChange={(v) => onChange({ logRetentionDays: v })}
          />
          <NumberRow
            label="Agent retention (days)"
            value={settings.agentRetentionDays}
            min={0}
            max={365}
            onChange={(v) => onChange({ agentRetentionDays: v })}
          />
        </div>
      )}
    </div>
  );
}

function CheckboxRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-[6px] border border-border-subtle bg-surface-3 px-3 py-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-accent"
      />
      <div className="min-w-0">
        <div className="text-text">{label}</div>
        {hint && <div className="text-[10.5px] text-text-muted">{hint}</div>}
      </div>
    </label>
  );
}

function NumberRow({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-2 rounded-[6px] border border-border-subtle bg-surface-3 px-3 py-2">
      <div className="flex-1 truncate text-text">{label}</div>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const parsed = Number.parseInt(e.target.value, 10);
          if (Number.isFinite(parsed)) onChange(Math.max(min, Math.min(max, parsed)));
        }}
        className="w-16 rounded border border-border-subtle bg-surface px-2 py-1 text-right text-[11.5px] text-text focus:border-accent focus:outline-none"
      />
    </label>
  );
}

function NewEntryDialog(props: {
  kind: DevlogEntryType;
  title: string;
  body: string;
  busy: boolean;
  onTitle: (v: string) => void;
  onBody: (v: string) => void;
  onCancel: () => void;
  onCreate: () => Promise<void>;
}) {
  const { kind, title, body, busy, onTitle, onBody, onCancel, onCreate } = props;
  const meta = TYPE_META[kind];
  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-[3px]"
      onClick={onCancel}
    >
      <div
        className="w-[520px] max-w-[92vw] rounded-xl border border-border-emphasis bg-surface-raised p-5 shadow-[0_20px_60px_rgba(0,0,0,0.5)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center gap-2 text-[14px] font-semibold text-text">
          <meta.icon size={14} className={meta.tone} />
          New {meta.label.replace(/s$/, '').toLowerCase()} entry
        </div>
        <div className="mb-3 text-[11.5px] text-text-muted">
          Stored under <span className="font-mono">.devspace/devlog/{kind}/</span>
        </div>

        <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-text-muted">
          Title
        </label>
        <input
          type="text"
          value={title}
          onChange={(e) => onTitle(e.target.value)}
          placeholder="Short headline (becomes filename slug)"
          className="mb-3 w-full rounded border border-border-emphasis bg-surface px-2.5 py-1.5 text-[13px] text-text focus:border-accent focus:outline-none"
          autoFocus
        />

        <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-text-muted">
          Body
        </label>
        <textarea
          value={body}
          onChange={(e) => onBody(e.target.value)}
          rows={8}
          placeholder="Markdown body — frontmatter is added automatically."
          className="mb-3 w-full rounded border border-border-emphasis bg-surface px-2.5 py-1.5 font-mono text-[12px] text-text focus:border-accent focus:outline-none"
        />

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-[6px] border border-border-subtle bg-surface-3 px-3 py-1.5 text-[11.5px] text-text-secondary transition hover:bg-surface-4 hover:text-text disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void onCreate()}
            disabled={busy || !title.trim()}
            className="inline-flex items-center gap-1.5 rounded-[6px] bg-accent px-3 py-1.5 text-[11.5px] font-medium text-white transition hover:brightness-110 disabled:opacity-50"
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
