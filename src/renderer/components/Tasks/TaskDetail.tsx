import { Check, GitMerge, RefreshCw, Trash2, Upload } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import { useTasksStore } from '@renderer/state/tasks';
import type { Task } from '@shared/types';

const ClaudeCliPane = lazy(() =>
  import('@renderer/components/Dock/ClaudeCliPane').then((m) => ({
    default: m.ClaudeCliPane,
  })),
);

type Confirm = null | 'merge' | 'discard';

export function TaskDetail() {
  const tasks = useTasksStore((s) => s.tasks);
  const activeTaskId = useTasksStore((s) => s.activeTaskId);
  const merge = useTasksStore((s) => s.merge);
  const discard = useTasksStore((s) => s.discard);
  const createPr = useTasksStore((s) => s.createPr);
  const dismiss = useTasksStore((s) => s.dismiss);
  const task = tasks.find((t) => t.id === activeTaskId);

  const [tab, setTab] = useState<'terminal' | 'diff'>('terminal');
  const [diff, setDiff] = useState('');
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [prResult, setPrResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const taskId = task?.id ?? null;
  useEffect(() => {
    setConfirm(null);
    setPrResult(null);
    setTab('terminal');
  }, [taskId]);

  useEffect(() => {
    if (tab !== 'diff' || !taskId) return;
    let cancelled = false;
    void api.tasks.diff(taskId).then((d) => {
      if (!cancelled) setDiff(d || '# no changes vs base');
    });
    return () => {
      cancelled = true;
    };
  }, [tab, taskId]);

  if (!task) {
    return (
      <div className="flex flex-1 items-center justify-center text-[12px] text-text-muted">
        Select a task, or create one to run an agent in an isolated worktree.
      </div>
    );
  }

  // A merged task has no worktree/session anymore, so the terminal + diff would
  // both error — show a closing summary with a dismiss instead.
  if (task.status === 'done') {
    return <DoneView task={task} onDismiss={() => void dismiss(task.id)} />;
  }

  const runPr = async (): Promise<void> => {
    setBusy(true);
    setPrResult(null);
    try {
      const r = await createPr(task.id);
      setPrResult(r.ok ? `PR: ${r.url ?? 'created'}` : `PR failed: ${r.error ?? '?'}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="truncate text-[12px] font-semibold text-text">{task.title}</span>
        <span className="truncate text-[10px] text-text-muted">
          {task.branch} ← {task.baseBranch}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {(['terminal', 'diff'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                'rounded-[5px] px-2 py-1 text-[11px] capitalize transition',
                tab === t
                  ? 'bg-surface-3 text-text'
                  : 'text-text-muted hover:bg-surface-2 hover:text-text',
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Body */}
      <div className="relative min-h-0 flex-1">
        <div
          className="absolute inset-0"
          style={{ visibility: tab === 'terminal' ? 'visible' : 'hidden' }}
        >
          <Suspense fallback={null}>
            <ClaudeCliPane
              projectId={task.id}
              projectPath={task.worktreePath}
              tabId="agent"
              isActive={tab === 'terminal'}
            />
          </Suspense>
        </div>
        {tab === 'diff' && (
          <div className="absolute inset-0 flex flex-col">
            <button
              type="button"
              onClick={() => taskId && void api.tasks.diff(taskId).then(setDiff)}
              className="flex w-fit items-center gap-1 px-3 py-1 text-[10px] text-text-muted hover:text-text"
            >
              <RefreshCw size={10} /> refresh
            </button>
            <DiffText text={diff} />
          </div>
        )}
      </div>

      {/* Action bar */}
      <div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2 text-[11px]">
        {prResult && (
          <span className="truncate text-[10px] text-text-muted">{prResult}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {confirm === 'merge' ? (
            <ConfirmRow
              label={`Merge into ${task.baseBranch}?`}
              onConfirm={async () => {
                setBusy(true);
                try {
                  await merge(task.id);
                } finally {
                  setBusy(false);
                  setConfirm(null);
                }
              }}
              onCancel={() => setConfirm(null)}
            />
          ) : confirm === 'discard' ? (
            <ConfirmRow
              label="Discard task + worktree?"
              danger
              onConfirm={async () => {
                setBusy(true);
                try {
                  await discard(task.id);
                } finally {
                  setBusy(false);
                  setConfirm(null);
                }
              }}
              onCancel={() => setConfirm(null)}
            />
          ) : (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => void runPr()}
                className="flex items-center gap-1 rounded-[6px] border border-border px-2 py-1 text-text-secondary transition hover:bg-surface-3 hover:text-text disabled:opacity-40"
              >
                <Upload size={12} /> Create PR
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirm('discard')}
                className="flex items-center gap-1 rounded-[6px] border border-border px-2 py-1 text-text-secondary transition hover:text-semantic-error disabled:opacity-40"
              >
                <Trash2 size={12} /> Discard
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirm('merge')}
                className="flex items-center gap-1 rounded-[6px] bg-accent px-2.5 py-1 font-medium text-white transition hover:opacity-90 disabled:opacity-40"
              >
                <GitMerge size={12} /> Merge
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function DoneView({ task, onDismiss }: { task: Task; onDismiss: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-semantic-success/15">
        <Check size={22} className="text-semantic-success" />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[13px] font-semibold text-text">{task.title}</span>
        <span className="text-[11px] text-text-secondary">
          Merged into <span className="font-mono text-text">{task.baseBranch}</span>
        </span>
        <span className="font-mono text-[10px] text-text-dim">{task.branch}</span>
        <span className="mt-1 max-w-[280px] text-[10.5px] leading-relaxed text-text-muted">
          Worktree &amp; branch were cleaned up — the changes now live in{' '}
          {task.baseBranch}.
        </span>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="mt-1 flex items-center gap-1.5 rounded-[6px] border border-border px-3 py-1.5 text-[11px] text-text-secondary transition hover:bg-surface-3 hover:text-text"
      >
        <Trash2 size={12} /> Dismiss
      </button>
    </div>
  );
}

const DIFF_LINE: Record<string, string> = {
  meta: 'text-text-dim',
  hunk: 'text-accent-2 bg-[rgba(76,141,255,0.07)]',
  add: 'text-semantic-success bg-[rgba(62,207,142,0.08)]',
  del: 'text-semantic-error bg-[rgba(240,113,120,0.08)]',
  ctx: 'text-text-secondary',
};

function classifyDiffLine(ln: string): keyof typeof DIFF_LINE {
  if (
    ln.startsWith('diff --git') ||
    ln.startsWith('index ') ||
    ln.startsWith('--- ') ||
    ln.startsWith('+++ ') ||
    ln.startsWith('new file') ||
    ln.startsWith('deleted file') ||
    ln.startsWith('rename ')
  )
    return 'meta';
  if (ln.startsWith('@@')) return 'hunk';
  if (ln.startsWith('+')) return 'add';
  if (ln.startsWith('-')) return 'del';
  return 'ctx';
}

// Colorized unified diff (read-only). A task's diff spans many files, so a
// scrollable unified view reads better here than the per-file side-by-side
// DiffView; editing happens by opening the worktree file in the editor.
function DiffText({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <div className="min-h-0 flex-1 overflow-auto px-2 pb-3 font-mono text-[11px] leading-[1.5]">
      {lines.map((ln, i) => (
        <div
          key={i}
          className={cn('whitespace-pre px-1', DIFF_LINE[classifyDiffLine(ln)])}
        >
          {ln || ' '}
        </div>
      ))}
    </div>
  );
}

function ConfirmRow({
  label,
  danger,
  onConfirm,
  onCancel,
}: {
  label: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <span className="flex items-center gap-2">
      <span className="text-[11px] text-text-secondary">{label}</span>
      <button
        type="button"
        onClick={onCancel}
        className="rounded px-2 py-1 text-text-muted hover:text-text"
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={onConfirm}
        className={cn(
          'rounded px-2.5 py-1 font-medium text-white transition hover:opacity-90',
          danger ? 'bg-red-600' : 'bg-accent',
        )}
      >
        Confirm
      </button>
    </span>
  );
}
