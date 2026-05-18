import {
  Archive,
  Bot,
  Loader2,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import type { ForgeStats, ForgeUseEvent } from '@shared/types';

interface ForgeStatsCardProps {
  projectPath: string;
  stat: ForgeStats;
  onArchive?: (key: string) => void;
  onRefine?: (stat: ForgeStats) => void;
  onView?: (stat: ForgeStats) => void;
}

/**
 * One card per installed skill/agent. Shows aggregate stats, derived
 * star rating, and the 5 most-recent uses with thumb up / thumb down
 * actions. Thumb-down expands an inline note input so the user can
 * explain why the suggestion was off — note is forwarded to
 * `recordSignal`.
 */
export function ForgeStatsCard({
  projectPath,
  stat,
  onArchive,
  onRefine,
  onView,
}: ForgeStatsCardProps) {
  const [uses, setUses] = useState<ForgeUseEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [downNoteFor, setDownNoteFor] = useState<string | null>(null);
  const [noteText, setNoteText] = useState('');
  const [busySignal, setBusySignal] = useState(false);

  // Defer fetching uses until the card is expanded — keeps the Forge
  // grid mount cost ~O(1) per card.
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    setLoading(true);
    void api.forge
      .listUses({ projectPath, key: stat.key, limit: 5 })
      .then((list) => {
        if (!cancelled) setUses(list);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, projectPath, stat.key]);

  const stars = useMemo5Stars(stat.useful, stat.uses);

  const recordSignal = useCallback(
    async (messageId: string, signal: 'explicit-up' | 'explicit-down', note?: string) => {
      setBusySignal(true);
      try {
        await api.forge.recordSignal({
          projectPath,
          key: stat.key,
          messageId,
          signal,
          ...(note ? { note } : {}),
        });
      } catch (err) {
        console.error('[forge] recordSignal failed', err);
      } finally {
        setBusySignal(false);
      }
    },
    [projectPath, stat.key],
  );

  const submitDownNote = useCallback(
    async (messageId: string) => {
      await recordSignal(messageId, 'explicit-down', noteText.trim() || undefined);
      setDownNoteFor(null);
      setNoteText('');
    },
    [recordSignal, noteText],
  );

  const Icon = stat.kind === 'agent' ? Bot : Sparkles;
  const iconTone = stat.kind === 'agent' ? 'text-accent-2' : 'text-accent';

  return (
    <div className="rounded-[8px] border border-border-subtle bg-surface-2 p-3 transition hover:border-border-hi">
      <div className="flex items-start gap-2">
        <Icon size={14} className={cn('mt-0.5 shrink-0', iconTone)} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <div className="truncate text-[12.5px] font-medium text-text">
              {stat.slug}
            </div>
            <span className="rounded-full bg-surface-3 px-1.5 py-[1px] text-[9.5px] text-text-muted">
              {stat.scope}
            </span>
            {stat.removed && (
              <span className="rounded-full bg-semantic-warning/15 px-1.5 py-[1px] text-[9.5px] text-semantic-warning">
                archived
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate font-mono text-[10px] text-text-muted">
            {stat.path ?? '(removed)'}
          </div>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-3 text-[10.5px] text-text-muted">
        <span title="Uses">
          <span className="font-mono text-text">{stat.uses}</span> uses
        </span>
        <span title="Star rating derived from useful / uses, capped at 5">
          {stars}
        </span>
        <span className="ml-auto text-[10px]">
          ↑{stat.explicit.up} ↓{stat.explicit.down}
        </span>
      </div>

      <div className="mt-2 flex items-center justify-between gap-1.5">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-[10.5px] text-accent transition hover:underline"
        >
          {expanded ? 'Hide uses' : 'Recent uses'}
        </button>
        <div className="flex items-center gap-1">
          {onView && (
            <CardButton onClick={() => onView(stat)} label="View" />
          )}
          {onRefine && (
            <CardButton onClick={() => onRefine(stat)} label="Refine" />
          )}
          {onArchive && !stat.removed && (
            <CardButton
              onClick={() => onArchive(stat.key)}
              label="Archive"
              icon={<Archive size={10} />}
            />
          )}
        </div>
      </div>

      {expanded && (
        <div className="mt-2 space-y-1 border-t border-border-subtle pt-2">
          {loading && (
            <div className="flex items-center gap-2 text-[10.5px] text-text-muted">
              <Loader2 size={10} className="animate-spin" /> Loading uses…
            </div>
          )}
          {!loading && uses.length === 0 && (
            <div className="text-[10.5px] text-text-muted">No uses recorded yet.</div>
          )}
          {uses.map((u) => (
            <div key={u.id} className="rounded-[6px] bg-surface-3 px-2 py-1.5 text-[11px]">
              <div className="flex items-center gap-2">
                <span className="text-text-muted">{formatAgo(u.ts)}</span>
                <span className="truncate text-text">thread {u.threadId.slice(0, 6)}…</span>
                <div className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    disabled={busySignal}
                    onClick={() => void recordSignal(u.messageId, 'explicit-up')}
                    className="rounded p-0.5 text-text-muted transition hover:bg-surface-2 hover:text-semantic-success disabled:opacity-40"
                    title="Useful"
                  >
                    <ThumbsUp size={10} />
                  </button>
                  <button
                    type="button"
                    disabled={busySignal}
                    onClick={() => {
                      setDownNoteFor(u.id === downNoteFor ? null : u.id);
                      setNoteText('');
                    }}
                    className="rounded p-0.5 text-text-muted transition hover:bg-surface-2 hover:text-semantic-error disabled:opacity-40"
                    title="Not helpful"
                  >
                    <ThumbsDown size={10} />
                  </button>
                </div>
              </div>
              {u.signals.length > 0 && (
                <div className="mt-0.5 flex flex-wrap gap-1 text-[9.5px] text-text-muted">
                  {u.signals.map((s) => (
                    <span key={s} className="rounded-full bg-surface-2 px-1 py-[1px]">
                      {s}
                    </span>
                  ))}
                </div>
              )}
              {downNoteFor === u.id && (
                <div className="mt-1.5 flex items-center gap-1">
                  <input
                    type="text"
                    value={noteText}
                    onChange={(e) => setNoteText(e.target.value)}
                    placeholder="What went wrong? (optional)"
                    className="flex-1 rounded border border-border-subtle bg-surface px-1.5 py-0.5 text-[10.5px] text-text focus:border-accent focus:outline-none"
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => void submitDownNote(u.messageId)}
                    className="rounded bg-semantic-error/80 px-1.5 py-0.5 text-[10px] font-medium text-white transition hover:bg-semantic-error"
                  >
                    Send
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CardButton({
  onClick,
  label,
  icon,
}: {
  onClick: () => void;
  label: string;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-[5px] border border-border-subtle bg-surface-3 px-1.5 py-0.5 text-[10px] text-text-secondary transition hover:border-border-hi hover:bg-surface-4 hover:text-text"
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * Derive a 5-star string from useful / max(uses, 1). Hidden behind a
 * tiny helper so the math is identical wherever we render ratings.
 */
function useMemo5Stars(useful: number, uses: number): string {
  const ratio = uses === 0 ? 0 : Math.max(0, Math.min(1, useful / uses));
  const full = Math.round(ratio * 5);
  return '★★★★★'.slice(0, full) + '☆☆☆☆☆'.slice(0, 5 - full);
}

function formatAgo(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
