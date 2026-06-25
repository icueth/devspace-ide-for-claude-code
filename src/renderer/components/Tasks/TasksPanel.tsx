import { ChevronDown, Database, Plus, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { cn } from '@renderer/lib/utils';
import { useTasksStore } from '@renderer/state/tasks';
import type { TaskStatus } from '@shared/types';

import { NewTaskDialog } from './NewTaskDialog';
import { TaskRow } from './TaskRow';

// Superset-style status buckets. merge/discard tears a task down (removes it
// from the list), so in practice only the live buckets render; the map is
// exhaustive over TaskStatus so a new status can't silently fall through.
const GROUPS: { key: string; label: string; statuses: TaskStatus[]; live?: boolean }[] = [
  {
    key: 'progress',
    label: 'In Progress',
    statuses: ['setting-up', 'running', 'integrating'],
    live: true,
  },
  { key: 'review', label: 'Ready for Review', statuses: ['awaiting-review'] },
  { key: 'attention', label: 'Needs Attention', statuses: ['error'] },
  { key: 'done', label: 'Done', statuses: ['done', 'discarded'] },
];

// Flat, top-level list of worktree-isolated tasks (superset-style), bucketed by
// status with a client-side filter. Live-updated via the tasks store's
// TASK_CHANGED subscription. Lives as an alternate left-sidebar mode.
export function TasksPanel() {
  const tasks = useTasksStore((s) => s.tasks);
  const activeTaskId = useTasksStore((s) => s.activeTaskId);
  const setActiveTask = useTasksStore((s) => s.setActiveTask);
  const refresh = useTasksStore((s) => s.refresh);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tasks;
    return tasks.filter((t) =>
      `${t.title} ${t.branch} ${t.sourceRepoPath}`.toLowerCase().includes(q),
    );
  }, [tasks, query]);

  const grouped = useMemo(
    () =>
      GROUPS.map((g) => ({
        ...g,
        items: filtered.filter((t) => g.statuses.includes(t.status)),
      })).filter((g) => g.items.length > 0),
    [filtered],
  );

  return (
    <div className="relative z-[1] flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between px-3 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
          Tasks {tasks.length > 0 && `(${tasks.length})`}
        </span>
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          title="New worktree-isolated task"
          className="flex h-6 items-center gap-1 rounded-[6px] border border-border px-2 text-[11px] text-text-muted transition hover:border-border-hi hover:bg-surface-3 hover:text-text"
        >
          <Plus size={12} /> New
        </button>
      </div>

      {tasks.length > 0 && (
        <div className="mx-2 mb-1.5 flex items-center gap-2 rounded-[7px] border border-border bg-surface-2 px-2 py-1">
          <Search size={12} className="shrink-0 text-text-dim" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter tasks…"
            aria-label="Filter tasks"
            className="min-w-0 flex-1 bg-transparent text-[11.5px] text-text outline-none placeholder:text-text-dim"
          />
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pb-2">
        {tasks.length === 0 ? (
          <p className="px-3 py-6 text-center text-[11px] text-text-muted">
            No tasks yet. Create one to run an agent in an isolated git worktree.
          </p>
        ) : grouped.length === 0 ? (
          <p className="px-3 py-6 text-center text-[11px] text-text-muted">
            No tasks match “{query}”.
          </p>
        ) : (
          grouped.map((g) => (
            <TaskGroup key={g.key} label={g.label} count={g.items.length} live={g.live}>
              {g.items.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  active={t.id === activeTaskId}
                  onClick={() => setActiveTask(t.id)}
                />
              ))}
            </TaskGroup>
          ))
        )}
      </div>

      {tasks.length > 0 && (
        <div className="flex shrink-0 items-center gap-1.5 border-t border-border-subtle px-3 py-1.5 text-[10px] text-text-dim">
          <Database size={11} />
          {tasks.length} worktree{tasks.length > 1 ? 's' : ''}
          <span className="opacity-40">·</span>
          <span className="truncate">~/.devspace/worktrees</span>
        </div>
      )}

      <NewTaskDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}

function TaskGroup({
  label,
  count,
  live,
  children,
}: {
  label: string;
  count: number;
  live?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="flex flex-col gap-[2px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 pb-0.5 pt-1.5 text-[10px] font-bold uppercase tracking-wider text-text-muted transition hover:text-text-secondary"
      >
        <ChevronDown
          size={11}
          strokeWidth={2.5}
          className={cn('transition-transform', !open && '-rotate-90')}
        />
        {label}
        <span className="rounded-[9px] bg-surface-3 px-1.5 font-mono text-[9.5px] font-medium leading-[15px] text-text-dim">
          {count}
        </span>
        {live && (
          <span
            aria-hidden
            className="ml-auto h-[6px] w-[6px] rounded-full bg-accent"
            style={{ boxShadow: '0 0 0 3px var(--color-accent-glow)' }}
          />
        )}
      </button>
      {open && <div className="flex flex-col gap-[2px]">{children}</div>}
    </div>
  );
}
