import {
  Calendar as CalendarIcon,
  ChevronDown,
  ChevronRight,
  Loader2,
  PenLine,
  Save,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import type { DiaryEntry } from '@shared/types';

// Month header label — "May 2026", "December 2025", etc. Uses the locale's
// long month name + numeric year. We keep formatting deterministic via the
// 'en-US' locale so the dashboard reads the same on every machine.
function formatMonthHeader(yyyymm: string): string {
  const [year, month] = yyyymm.split('-');
  const d = new Date(Number(year), Number(month) - 1, 1);
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// Returns today's date in the YYYY-MM-DD form the backend expects.
function todayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

interface DayInfo {
  dayNum: string;
  weekday: string;
}

function parseDayInfo(dateKey: string): DayInfo {
  const [year, month, day] = dateKey.split('-').map(Number);
  const d = new Date(year, month - 1, day);
  return {
    dayNum: String(day),
    weekday: d.toLocaleDateString('en-US', { weekday: 'short' }),
  };
}

export interface TimelineViewProps {
  // When set, restrict the timeline to one project's diary. null = global
  // diary (which is per-user, not per-project).
  projectPath?: string;
}

export function TimelineView({ projectPath }: TimelineViewProps) {
  const [entries, setEntries] = useState<DiaryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [composer, setComposer] = useState<{ body: string; busy: boolean } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const today = todayKey();

  // Initial load + reload when the project filter changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const list = await api.memory.listDiary({
          scope: projectPath ? 'project' : 'global',
          projectPath,
        });
        if (cancelled) return;
        // Sort newest first — the on-disk order isn't guaranteed and the
        // dashboard reads top-down.
        const sorted = [...list].sort((a, b) => b.date.localeCompare(a.date));
        setEntries(sorted);
      } catch (err) {
        console.error('[timeline] listDiary failed', err);
        if (!cancelled) setEntries([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  // Live updates — bump on `diary_updated`. Re-fetches the whole list
  // because writeDiary's batching may compress multiple turns into one
  // entry and we don't want stale word counts.
  useEffect(() => {
    const unsub = api.memory.onEvent((ev) => {
      if (ev.kind !== 'diary_updated') return;
      void (async () => {
        try {
          const list = await api.memory.listDiary({
            scope: projectPath ? 'project' : 'global',
            projectPath,
          });
          const sorted = [...list].sort((a, b) => b.date.localeCompare(a.date));
          setEntries(sorted);
        } catch (err) {
          console.error('[timeline] diary refresh failed', err);
        }
      })();
    });
    return unsub;
  }, [projectPath]);

  // Group by YYYY-MM. Each month becomes a section header with its day
  // cards underneath. Months are iterated in newest-first order to match
  // the sort above.
  const grouped = useMemo(() => {
    const buckets = new Map<string, DiaryEntry[]>();
    for (const e of entries) {
      const ym = e.date.slice(0, 7); // YYYY-MM
      const list = buckets.get(ym) ?? [];
      list.push(e);
      buckets.set(ym, list);
    }
    return Array.from(buckets.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [entries]);

  const hasToday = entries.some((e) => e.date === today);

  const toggleExpand = (date: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  };

  const openComposer = () => {
    if (hasToday) {
      // Jump to today by expanding its card. Smooth-scroll via id anchor.
      setExpanded((prev) => new Set(prev).add(today));
      const el = document.getElementById(`diary-day-${today}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    setComposer({ body: '', busy: false });
  };

  const saveComposer = async () => {
    if (!composer) return;
    setComposer((c) => (c ? { ...c, busy: true } : c));
    setError(null);
    try {
      const saved = await api.memory.writeDiary({
        date: today,
        scope: projectPath ? 'project' : 'global',
        projectPath,
        body: composer.body,
      });
      setEntries((prev) => [saved, ...prev]);
      setComposer(null);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to save diary.');
      setComposer((c) => (c ? { ...c, busy: false } : c));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-4 py-6 text-[11px] text-text-muted">
        <Loader2 size={12} className="animate-spin" />
        Loading diary…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Sticky composer trigger row */}
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-text-muted">
          {entries.length === 0
            ? 'No diary entries yet.'
            : `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`}
        </div>
        <button
          type="button"
          onClick={openComposer}
          className="inline-flex items-center gap-1.5 rounded-[6px] border border-accent/30 bg-accent/10 px-2.5 py-1.5 text-[11px] font-medium text-accent transition hover:bg-accent/20"
        >
          <PenLine size={11} />
          {hasToday ? "Jump to today's entry" : "Write today's entry"}
        </button>
      </div>

      {/* Inline composer */}
      {composer && (
        <div className="rounded-[8px] border border-accent/30 bg-surface-2 p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-[11px] font-medium text-text">
              Today · {today}
            </div>
            <button
              type="button"
              onClick={() => setComposer(null)}
              disabled={composer.busy}
              className="flex h-5 w-5 items-center justify-center rounded text-text-muted transition hover:bg-surface-3 hover:text-text"
            >
              <X size={11} />
            </button>
          </div>
          <textarea
            autoFocus
            value={composer.body}
            onChange={(e) =>
              setComposer({ body: e.target.value, busy: composer.busy })
            }
            rows={8}
            placeholder="What happened today?"
            className="w-full resize-y rounded-[6px] border border-border-subtle bg-surface px-2.5 py-2 font-mono text-[12px] leading-relaxed text-text outline-none transition focus:border-accent"
          />
          {error && (
            <p className="mt-1.5 text-[11px] text-semantic-error">{error}</p>
          )}
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setComposer(null)}
              disabled={composer.busy}
              className="rounded-[5px] border border-border-subtle bg-surface-3 px-2.5 py-1 text-[11px] text-text-secondary hover:text-text"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={saveComposer}
              disabled={composer.busy || composer.body.trim().length === 0}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-[5px] border px-2.5 py-1 text-[11px] font-medium transition',
                composer.busy || composer.body.trim().length === 0
                  ? 'cursor-not-allowed border-border-subtle bg-surface-3 text-text-muted opacity-60'
                  : 'border-accent bg-accent text-white hover:brightness-110',
              )}
            >
              <Save size={11} />
              {composer.busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {/* Empty state when nothing exists yet */}
      {grouped.length === 0 && !composer && (
        <div className="flex flex-col items-center gap-2 rounded-[8px] border border-dashed border-border-subtle bg-surface-2 px-6 py-10 text-center">
          <CalendarIcon size={20} className="text-text-dim" />
          <p className="max-w-[360px] text-[11.5px] leading-relaxed text-text-muted">
            Your timeline is empty. Write today's entry to start a streak.
          </p>
        </div>
      )}

      {/* Month groups */}
      {grouped.map(([ym, days]) => (
        <section key={ym} className="flex flex-col gap-2">
          <h3 className="sticky top-0 z-[1] -mx-1 bg-surface px-1 py-1 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            {formatMonthHeader(ym)}
            <span className="ml-2 font-mono text-[10px] text-text-dim">
              {days.length} day{days.length === 1 ? '' : 's'}
            </span>
          </h3>
          {days.map((d) => (
            <DayCard
              key={d.date}
              entry={d}
              expanded={expanded.has(d.date)}
              onToggle={() => toggleExpand(d.date)}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

interface DayCardProps {
  entry: DiaryEntry;
  expanded: boolean;
  onToggle: () => void;
}

function DayCard({ entry, expanded, onToggle }: DayCardProps) {
  const info = parseDayInfo(entry.date);
  const preview = entry.body.slice(0, 200);
  const truncated = entry.body.length > preview.length;

  return (
    <article
      id={`diary-day-${entry.date}`}
      className="rounded-[8px] border border-border-subtle bg-surface-2 transition hover:border-border-hi"
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start gap-3 px-3 py-2.5 text-left"
      >
        <div className="flex w-12 shrink-0 flex-col items-center gap-0.5 rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-1">
          <span className="font-mono text-[16px] font-bold text-text leading-none">
            {info.dayNum}
          </span>
          <span className="text-[9.5px] uppercase tracking-wider text-text-muted">
            {info.weekday}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            <span className="font-mono text-[10.5px] text-text-dim">
              {entry.date}
            </span>
            {entry.scope === 'project' && (
              <span className="rounded border border-border-subtle bg-surface-3 px-1 py-px font-mono text-[9.5px] text-text-muted">
                project
              </span>
            )}
            <span className="font-mono text-[10px] text-text-muted">
              {entry.wordCount} word{entry.wordCount === 1 ? '' : 's'}
            </span>
          </div>
          {!expanded && (
            <p className="line-clamp-2 whitespace-pre-wrap text-[12px] leading-relaxed text-text-secondary">
              {preview}
              {truncated && '…'}
            </p>
          )}
        </div>
        <span className="shrink-0 self-center text-text-muted">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border-subtle px-3 py-3">
          {/* Plain pre-formatted markdown — we explicitly don't pull in
              a markdown renderer just for the dashboard (decision from
              the v0.19 plan). Whitespace + line breaks read cleanly in
              this font. */}
          <pre className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-text">
            {entry.body}
          </pre>
        </div>
      )}
    </article>
  );
}
