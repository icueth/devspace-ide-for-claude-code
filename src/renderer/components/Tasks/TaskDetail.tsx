import { GitMerge, RefreshCw, Trash2, Upload } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import { useTasksStore } from '@renderer/state/tasks';

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
            <pre className="min-h-0 flex-1 overflow-auto px-3 pb-3 font-mono text-[11px] leading-[1.5] text-text-secondary">
              {diff}
            </pre>
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
