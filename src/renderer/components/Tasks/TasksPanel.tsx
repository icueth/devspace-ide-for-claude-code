import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useTasksStore } from '@renderer/state/tasks';

import { NewTaskDialog } from './NewTaskDialog';
import { TaskRow } from './TaskRow';

// Flat, top-level list of worktree-isolated tasks (superset-style). Lives as an
// alternate left-sidebar mode (see useSidebarStore.mode). Live-updated via the
// tasks store's TASK_CHANGED subscription.
export function TasksPanel() {
  const tasks = useTasksStore((s) => s.tasks);
  const activeTaskId = useTasksStore((s) => s.activeTaskId);
  const setActiveTask = useTasksStore((s) => s.setActiveTask);
  const refresh = useTasksStore((s) => s.refresh);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      <div className="flex min-h-0 flex-1 flex-col gap-[2px] overflow-y-auto pb-2">
        {tasks.length === 0 ? (
          <p className="px-3 py-6 text-center text-[11px] text-text-muted">
            No tasks yet. Create one to run an agent in an isolated git worktree.
          </p>
        ) : (
          tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              active={task.id === activeTaskId}
              onClick={() => setActiveTask(task.id)}
            />
          ))
        )}
      </div>
      <NewTaskDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}
