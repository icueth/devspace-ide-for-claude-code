import { CircleDot, Loader2, TriangleAlert, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import type { Task, TaskStatus } from '@shared/types';

// Agent → avatar glyph + gradient. Only 'claude' actually runs today; the rest
// are pre-mapped so multi-agent support lights the right badge with no change
// here. Unknown agents fall back to the claude badge.
const AGENT_BADGE: Record<
  string,
  { glyph: string; bg: string; fg: string }
> = {
  claude: { glyph: '✻', bg: 'linear-gradient(135deg,#e9a06b,#d97757)', fg: '#2a1206' },
  codex: { glyph: '❖', bg: 'linear-gradient(135deg,#3ecf8e,#169c6b)', fg: '#04190f' },
  cursor: { glyph: '▸', bg: 'linear-gradient(135deg,#d6dae3,#9aa3b5)', fg: '#11151d' },
  gemini: { glyph: '✦', bg: 'linear-gradient(135deg,#6aa2ff,#a974ff)', fg: '#0a0d13' },
};

// How each status reads in the row. `busy` shows the spinner; `ready` the green
// dot; `done` a check tone; `error` the warning glyph.
const STATUS_VIEW: Record<
  TaskStatus,
  { label: string; tone: 'busy' | 'ready' | 'done' | 'idle' | 'error' }
> = {
  'setting-up': { label: 'Setting up', tone: 'busy' },
  running: { label: 'Generating', tone: 'busy' },
  'awaiting-review': { label: 'Ready', tone: 'ready' },
  integrating: { label: 'Merging', tone: 'busy' },
  done: { label: 'Merged', tone: 'done' },
  discarded: { label: 'Discarded', tone: 'idle' },
  error: { label: 'Error', tone: 'error' },
};

function timeAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 45) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p;
}

interface TaskRowProps {
  task: Task;
  active: boolean;
  onClick: () => void;
  /** When provided, a hover-reveal dismiss (×) clears this finished task. */
  onDismiss?: () => void;
}

export function TaskRow({ task, active, onClick, onDismiss }: TaskRowProps) {
  const badge = AGENT_BADGE[task.agent] ?? AGENT_BADGE.claude;
  const view = STATUS_VIEW[task.status];
  const [stat, setStat] = useState<{ additions: number; deletions: number } | null>(
    null,
  );

  // Lazily pull the +/- summary per row (cheap `git --shortstat`, best-effort).
  // Refetch whenever the status flips — a generating agent's diff keeps growing.
  // A finished task's worktree is gone, so skip the fetch (it would just error).
  const terminal = task.status === 'done' || task.status === 'discarded';
  useEffect(() => {
    if (terminal) return;
    let cancelled = false;
    void api.tasks.diffStat(task.id).then((s) => {
      if (!cancelled) setStat({ additions: s.additions, deletions: s.deletions });
    });
    return () => {
      cancelled = true;
    };
  }, [task.id, task.status, terminal]);

  const hasDiff = !!stat && (stat.additions > 0 || stat.deletions > 0);

  return (
    <div
      className={cn(
        'group relative mx-1.5 flex gap-2.5 rounded-[9px] border px-2 py-2 transition',
        active
          ? 'border-border-emphasis bg-surface-3'
          : 'border-transparent hover:bg-surface-2',
      )}
    >
      {active && (
        <span
          aria-hidden
          className="pointer-events-none absolute left-0 top-2 bottom-2 w-[2.5px] rounded-[3px] bg-accent"
          style={{ boxShadow: '0 0 8px var(--color-accent-glow)' }}
        />
      )}

      <button
        type="button"
        onClick={onClick}
        title={`${task.title}\n${task.sourceRepoPath} · ${task.branch}`}
        className="flex min-w-0 flex-1 gap-2.5 text-left"
      >
        <span
          aria-hidden
          className="mt-[1px] flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px] text-[13px] font-bold"
          style={{
            background: badge.bg,
            color: badge.fg,
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.15)',
          }}
        >
          {badge.glyph}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span
              className={cn(
                'flex-1 truncate text-[12.5px] font-semibold',
                active ? 'text-text' : 'text-text-secondary group-hover:text-text',
              )}
            >
              {task.title}
            </span>
            <span className="shrink-0 text-[10px] text-text-dim">
              {timeAgo(task.createdAt, Date.now())}
            </span>
          </span>

          <span className="mt-[3px] flex items-center gap-2">
            <StatusChip label={view.label} tone={view.tone} />
            {hasDiff && (
              <span className="ml-auto flex shrink-0 gap-1.5 font-mono text-[10px]">
                {stat!.additions > 0 && (
                  <span className="text-semantic-success">+{stat!.additions}</span>
                )}
                {stat!.deletions > 0 && (
                  <span className="text-semantic-error">−{stat!.deletions}</span>
                )}
              </span>
            )}
          </span>

          <span className="mt-1 block truncate font-mono text-[9.5px] text-text-dim">
            {basename(task.sourceRepoPath)} · {task.branch}
          </span>
        </span>
      </button>

      {onDismiss && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
          title="Dismiss task"
          className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-[5px] text-text-muted opacity-0 transition group-hover:opacity-70 hover:bg-surface-4 hover:!opacity-100 hover:text-text"
        >
          <X size={11} />
        </button>
      )}
    </div>
  );
}

function StatusChip({
  label,
  tone,
}: {
  label: string;
  tone: 'busy' | 'ready' | 'done' | 'idle' | 'error';
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-[10.5px] font-medium',
        tone === 'busy' && 'text-accent-2',
        tone === 'ready' && 'text-semantic-success',
        tone === 'done' && 'text-text-muted',
        tone === 'error' && 'text-semantic-error',
        tone === 'idle' && 'text-text-muted',
      )}
    >
      {tone === 'busy' && <Loader2 size={10} className="animate-spin" />}
      {tone === 'ready' && (
        <span
          className="h-[6px] w-[6px] rounded-full bg-current"
          style={{ boxShadow: '0 0 6px currentColor' }}
        />
      )}
      {tone === 'done' && <CircleDot size={10} className="text-semantic-success" />}
      {tone === 'error' && <TriangleAlert size={10} />}
      {tone === 'idle' && <CircleDot size={10} />}
      {label}
    </span>
  );
}
