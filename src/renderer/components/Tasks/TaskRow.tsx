import { cn } from '@renderer/lib/utils';
import type { Task, TaskStatus } from '@shared/types';

const STATUS_STYLE: Record<TaskStatus, string> = {
  'setting-up': 'bg-amber-500/15 text-amber-300',
  running: 'bg-[rgba(76,141,255,0.18)] text-[#bcd1ff]',
  'awaiting-review': 'bg-purple-500/20 text-purple-300',
  integrating: 'bg-amber-500/15 text-amber-300',
  done: 'bg-green-500/15 text-green-300',
  discarded: 'bg-zinc-500/15 text-zinc-400',
  error: 'bg-red-500/15 text-red-300',
};

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p;
}

interface TaskRowProps {
  task: Task;
  active: boolean;
  onClick: () => void;
}

export function TaskRow({ task, active, onClick }: TaskRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${task.title}\n${task.sourceRepoPath} · ${task.branch}`}
      className={cn(
        'mx-1 flex flex-col items-start gap-0.5 rounded-[6px] px-2 py-1.5 text-left transition',
        active
          ? 'bg-surface-3 text-text'
          : 'text-text-secondary hover:bg-surface-2 hover:text-text',
      )}
    >
      <span className="flex w-full items-center gap-1.5">
        <span className="truncate text-[12px] font-medium">{task.title}</span>
        <span
          className={cn(
            'ml-auto shrink-0 rounded-full px-1.5 py-[1px] text-[8.5px] font-semibold uppercase tracking-wide',
            STATUS_STYLE[task.status],
          )}
        >
          {task.status}
        </span>
      </span>
      <span className="w-full truncate text-[10px] text-text-muted">
        {basename(task.sourceRepoPath)} · {task.branch}
      </span>
    </button>
  );
}
