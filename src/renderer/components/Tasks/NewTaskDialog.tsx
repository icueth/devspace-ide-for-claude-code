import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';

import { cn } from '@renderer/lib/utils';
import { useTasksStore } from '@renderer/state/tasks';
import { useWorkspaceStore } from '@renderer/state/workspace';

interface NewTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Create a worktree-isolated task: pick a title + a source repo (one of the
// current workspace's projects) and an agent. Submit forks a worktree+branch
// and launches the agent in the background (TaskService.create).
export function NewTaskDialog({ open, onOpenChange }: NewTaskDialogProps) {
  const projects = useWorkspaceStore((s) => s.projects);
  const create = useTasksStore((s) => s.create);
  const [title, setTitle] = useState('');
  const [repo, setRepo] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    const sourceRepoPath = repo || projects[0]?.path;
    if (!title.trim() || !sourceRepoPath || busy) return;
    setBusy(true);
    try {
      await create({ title: title.trim(), sourceRepoPath, agent: 'claude' });
      setTitle('');
      setRepo('');
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-24 z-50 w-[min(460px,85vw)] -translate-x-1/2 overflow-hidden rounded-lg border border-border-emphasis bg-surface-raised shadow-2xl">
          <Dialog.Title className="border-b border-border-subtle bg-surface-sidebar px-4 py-2 text-[12px] font-medium text-text">
            New task
          </Dialog.Title>
          <div className="flex flex-col gap-3 px-4 py-3">
            <label className="flex flex-col gap-1 text-[11px] text-text-secondary">
              Title
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submit();
                }}
                placeholder="Fix the login redirect bug"
                className="rounded-[6px] border border-border bg-surface-2 px-2 py-1.5 text-[12px] text-text outline-none focus:border-accent"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-text-secondary">
              Source repo
              <select
                value={repo || projects[0]?.path || ''}
                onChange={(e) => setRepo(e.target.value)}
                className="rounded-[6px] border border-border bg-surface-2 px-2 py-1.5 text-[12px] text-text outline-none focus:border-accent"
              >
                {projects.length === 0 && <option value="">No projects</option>}
                {projects.map((p) => (
                  <option key={p.id} value={p.path}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex justify-end gap-2 border-t border-border-subtle bg-surface-sidebar px-3 py-2 text-[11px]">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded px-2 py-1 text-text-secondary hover:bg-surface-overlay hover:text-text"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || !title.trim() || projects.length === 0}
              className={cn(
                'rounded bg-accent px-3 py-1 font-medium text-white transition hover:opacity-90',
                'disabled:pointer-events-none disabled:opacity-40',
              )}
            >
              {busy ? 'Creating…' : 'Create task'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
