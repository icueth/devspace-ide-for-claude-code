import { Brain, Loader2 } from 'lucide-react';
import { useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import { useWorkspaceStore } from '@renderer/state/workspace';

// Result of a "Learn from recent work" distillation run. Mirrors the
// DistillSummary returned by the main-process DistillationService.
type DistillResult = Awaited<ReturnType<typeof api.memory.distill>>;

// Tooltip describing exactly what the trigger does — the same copy that used to
// live in Settings → Memory, condensed into a single hover string.
const TOOLTIP =
  'Learn from recent work — distill your recent diary, devlog, and chat ' +
  'activity on this project into durable lessons using Claude. New learnings ' +
  'show up in Memory (searchable); low-confidence ones go to the inbox for review.';

// Map a DistillSummary into a one-line, human toast message naming the project.
// Mirrors the DistillationService status union exactly: 'ok' | 'no-activity' |
// 'no-claude' | 'run-failed' | 'unparseable' | 'error'.
function toastMessageFor(result: DistillResult, projectName: string): string {
  switch (result.status) {
    case 'ok': {
      if (result.created > 0) {
        const base = `Learned ${result.created} lesson${result.created === 1 ? '' : 's'} from ${projectName}`;
        return result.inboxed > 0
          ? `${base} · ${result.inboxed} to review in Memory inbox`
          : base;
      }
      if (result.inboxed > 0) {
        return `${result.inboxed} learning${result.inboxed === 1 ? '' : 's'} from ${projectName} to review in Memory inbox`;
      }
      return `No new learnings from ${projectName}.`;
    }
    case 'no-activity':
      return `No recent activity to learn from in ${projectName}.`;
    case 'no-claude':
      return 'Learn needs the Claude CLI (claude not found).';
    case 'run-failed':
      return result.message
        ? `Learn failed: ${result.message}`
        : `Learn failed while running Claude for ${projectName}.`;
    case 'unparseable':
      return "Claude didn't return usable learnings — try again.";
    case 'error':
    default:
      return result.message
        ? `Learn failed: ${result.message}`
        : `Learn failed for ${projectName}.`;
  }
}

// Best-effort toast via the shared ResourceToastHost (mounted in App.tsx).
function fireToast(message: string): void {
  try {
    window.dispatchEvent(
      new CustomEvent('devspace:resource-toast', { detail: { message } }),
    );
  } catch {
    /* no DOM window (tests) — skip */
  }
}

/**
 * Sidebar "Learn from recent work" trigger — sits above the project root.
 *
 * Distills the ACTIVE project's recent diary / devlog / captured chat activity
 * into durable learnings via real Claude (`claude -p`, the user's own
 * subscription — not the Agent SDK pool). Results are reported through the
 * shared resource-toast; no inline state beyond the busy spinner.
 *
 * Renders nothing when there's no active project with a path.
 */
export function SidebarLearnButton() {
  const project = useWorkspaceStore((s) => {
    const id = s.activeProjectId;
    return s.projects.find((p) => p.id === id) ?? null;
  });
  const [busy, setBusy] = useState(false);

  // No active project (or it has no path) → nothing to learn from; render null.
  if (!project?.path) return null;

  const handleLearn = async () => {
    if (busy) return; // guard against double-click
    setBusy(true);
    try {
      const summary = await api.memory.distill(project.path);
      fireToast(toastMessageFor(summary, project.name));
    } catch (err) {
      fireToast(`Learn failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void handleLearn()}
      disabled={busy}
      title={TOOLTIP}
      className={cn(
        'mx-2 mb-1 flex items-center gap-1.5 rounded-[6px] border border-border bg-surface-2/60 px-2 py-1 text-[11px] text-text-secondary transition',
        busy
          ? 'cursor-default opacity-70'
          : 'hover:border-border-hi hover:bg-surface-3 hover:text-text',
      )}
    >
      {busy ? (
        <Loader2 size={12} className="shrink-0 animate-spin text-[var(--color-accent-2)]" />
      ) : (
        <Brain size={12} className="shrink-0 text-[var(--color-accent-2)]" />
      )}
      <span className="truncate">{busy ? 'Learning…' : 'Learn from recent work'}</span>
    </button>
  );
}
