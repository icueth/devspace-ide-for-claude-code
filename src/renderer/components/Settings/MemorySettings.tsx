import { Brain, CheckCircle2, Loader2, Sparkles } from 'lucide-react';
import { useState } from 'react';

import { MemPalaceSettings } from '@renderer/components/Settings/MemPalaceSettings';
import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import { useWorkspaceStore } from '@renderer/state/workspace';

// Result of a "Learn from recent work" distillation run. Mirrors the
// DistillSummary returned by the main-process DistillationService.
type DistillResult = Awaited<ReturnType<typeof api.memory.distill>>;

/**
 * Memory settings panel (Settings → Memory).
 *
 * Hosts the sub-project 3 "native learning" manual trigger — a single
 * "Learn from recent work" button that distills recent activity (diary,
 * devlog, captures, recent memory) into durable learnings via real Claude
 * (BackgroundClaudeRunner, the user's own subscription). The distilled
 * learnings are plain, editable memory entries — browse/prune them in the
 * memory store. The existing MemPalace installer renders below.
 */
export function MemorySettings() {
  const activeProject = useWorkspaceStore((s) => {
    const id = s.activeProjectId;
    return s.projects.find((p) => p.id === id) ?? null;
  });

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DistillResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleLearn = async () => {
    if (!activeProject?.path) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const summary = await api.memory.distill(activeProject.path);
      setResult(summary);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-5 px-6 py-6">
        <LearnCard
          hasProject={!!activeProject?.path}
          projectName={activeProject?.name ?? null}
          busy={busy}
          result={result}
          error={error}
          onLearn={handleLearn}
        />
      </div>

      {/* Existing MemPalace installer keeps its home on the Memory tab. */}
      <MemPalaceSettings />
    </div>
  );
}

function LearnCard({
  hasProject,
  projectName,
  busy,
  result,
  error,
  onLearn,
}: {
  hasProject: boolean;
  projectName: string | null;
  busy: boolean;
  result: DistillResult | null;
  error: string | null;
  onLearn: () => void | Promise<void>;
}) {
  const disabled = busy || !hasProject;
  return (
    <div className="flex items-start gap-3">
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] text-white"
        style={{
          background: 'linear-gradient(135deg, #6366f1, var(--color-accent))',
          boxShadow: '0 4px 16px rgba(99,102,241,0.25)',
        }}
      >
        <Brain size={16} strokeWidth={2.25} />
      </span>
      <div className="flex w-full flex-col gap-2">
        <h2 className="text-[15px] font-semibold text-text">Native learning</h2>
        <p className="text-[11.5px] text-text-muted">
          Distill your recent work on{' '}
          <span className="font-medium text-text-secondary">
            {projectName ?? 'this project'}
          </span>{' '}
          — diary, devlog, captured chat moments, and recent notes — into durable
          learnings, using real Claude on your own subscription. Learnings become
          plain memory entries you can edit or delete, and they auto-surface in
          future work.
        </p>

        <div className="mt-1 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void onLearn()}
            disabled={disabled}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-[7px] px-4 py-2 text-[12px] font-medium transition',
              disabled
                ? 'pointer-events-none border border-border bg-surface-3 text-text-muted opacity-60'
                : 'text-white hover:brightness-110',
            )}
            style={
              disabled
                ? undefined
                : {
                    background:
                      'linear-gradient(135deg, #6366f1, var(--color-accent))',
                    boxShadow: '0 4px 14px rgba(99,102,241,0.30)',
                  }
            }
          >
            {busy ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Sparkles size={12} />
            )}
            {busy ? 'Learning…' : 'Learn from recent work'}
          </button>
          {!hasProject && (
            <span className="text-[10.5px] text-text-muted">
              Open a project to enable learning.
            </span>
          )}
        </div>

        {result && <ResultChip result={result} />}
        {error && (
          <div className="rounded-[7px] border border-semantic-error/40 bg-semantic-error/10 px-3 py-2 text-[11px] text-semantic-error">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

function ResultChip({ result }: { result: DistillResult }) {
  const ok = result.status === 'ok';
  const summary =
    result.message ??
    (ok
      ? `Created ${result.created}, inboxed ${result.inboxed}, skipped ${result.skippedDup} duplicate(s).`
      : result.status);
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-[7px] border px-3 py-2 text-[11px]',
        ok
          ? 'border-semantic-success/40 bg-[rgba(34,197,94,0.10)] text-semantic-success'
          : 'border-border bg-surface-2/60 text-text-secondary',
      )}
    >
      {ok ? (
        <CheckCircle2 size={13} className="mt-[1px] shrink-0" />
      ) : (
        <Sparkles size={13} className="mt-[1px] shrink-0 text-text-muted" />
      )}
      <span>{summary}</span>
    </div>
  );
}
