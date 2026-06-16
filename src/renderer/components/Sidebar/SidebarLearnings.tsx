import * as Popover from '@radix-ui/react-popover';
import { Brain, ChevronDown, ChevronRight, Loader2, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import { useWorkspaceStore } from '@renderer/state/workspace';
import type { MemoryEntry, MemoryType } from '@shared/types';

// The memory types DevSpace distills as durable "learnings". 'feedback' doubles
// as the "preference" learning type (see MemoryType docs in shared/types), so
// it's counted here alongside 'lesson' and 'workflow'.
const LEARNING_TYPES: ReadonlySet<MemoryType> = new Set<MemoryType>([
  'lesson',
  'workflow',
  'feedback',
]);

// Short hover copy for the chip. Auto-distill is owned elsewhere now — this is
// purely a viewer, so the tooltip frames it that way (no manual trigger).
const TOOLTIP =
  'Distilled lessons DevSpace has learned from your work on this project. ' +
  'Auto-updates as you work; click to browse.';

// Human label per learning type for the row badge.
const TYPE_LABEL: Record<string, string> = {
  lesson: 'lesson',
  workflow: 'workflow',
  feedback: 'preference',
};

function isLearning(e: MemoryEntry): boolean {
  return LEARNING_TYPES.has(e.type);
}

/**
 * Sidebar learnings viewer — sits above the project root.
 *
 * Shows how many durable learnings (lesson / workflow / feedback) DevSpace has
 * distilled for the ACTIVE project, and opens a popover to browse + delete
 * them. Distillation itself is automatic now (owned by DistillationService);
 * this component never triggers it — it's read + delete only.
 *
 * Renders nothing when there's no active project with a path.
 */
export function SidebarLearnings() {
  const project = useWorkspaceStore((s) => {
    const id = s.activeProjectId;
    return s.projects.find((p) => p.id === id) ?? null;
  });
  const projectPath = project?.path ?? null;

  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const refetch = useCallback(async () => {
    if (!projectPath) {
      setEntries([]);
      return;
    }
    setLoading(true);
    try {
      const all = await api.memory.listEntries({ scope: 'project', projectPath });
      setEntries(all.filter(isLearning));
    } catch {
      // Best-effort: a failed fetch just shows the empty/zero state.
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  // Fetch on mount + whenever the active project changes. (refetch is keyed on
  // projectPath, so this re-runs when the user switches projects.)
  useEffect(() => {
    void refetch();
  }, [refetch]);

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await api.memory.deleteEntry(id);
      } finally {
        await refetch();
      }
    },
    [refetch],
  );

  // No active project (or it has no path) → nothing to show; render null.
  if (!projectPath) return null;

  const count = entries.length;
  const hasLearnings = count > 0;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          title={TOOLTIP}
          className={cn(
            'mx-2 mb-1 flex items-center gap-1.5 rounded-[6px] border border-border bg-surface-2/60 px-2 py-1 text-[11px] transition',
            'hover:border-border-hi hover:bg-surface-3',
            hasLearnings ? 'text-text-secondary hover:text-text' : 'text-text-muted',
          )}
        >
          <Brain
            size={12}
            className={cn(
              'shrink-0',
              hasLearnings ? 'text-[var(--color-accent-2)]' : 'text-text-dim',
            )}
          />
          <span className="truncate">
            {loading && !hasLearnings
              ? 'Loading learnings…'
              : hasLearnings
                ? `${count} learning${count === 1 ? '' : 's'}`
                : 'No learnings yet'}
          </span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="z-50 w-[300px] overflow-hidden rounded-md border border-border-emphasis bg-surface-raised shadow-lg animate-in fade-in-0 zoom-in-95"
        >
          <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-text">
              <Brain size={12} className="text-[var(--color-accent-2)]" />
              Learnings
              {count > 0 && (
                <span className="font-mono text-[10px] text-text-muted">{count}</span>
              )}
            </span>
            <Popover.Close asChild>
              <button
                type="button"
                title="Close"
                className="flex h-4 w-4 items-center justify-center rounded-sm text-text-muted transition hover:bg-surface-4 hover:text-text"
              >
                <X size={11} />
              </button>
            </Popover.Close>
          </div>

          <div className="max-h-[320px] overflow-y-auto">
            {loading && count === 0 && (
              <div className="flex items-center gap-2 px-3 py-3 text-[11px] text-text-muted">
                <Loader2 size={11} className="animate-spin" /> Loading…
              </div>
            )}

            {!loading && count === 0 && (
              <div className="px-3 py-4 text-[11px] leading-relaxed text-text-muted">
                Nothing learned yet — learnings appear automatically as you work.
              </div>
            )}

            {entries.map((entry) => (
              <LearningRow
                key={entry.id}
                entry={entry}
                onDelete={() => void handleDelete(entry.id)}
              />
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

interface LearningRowProps {
  entry: MemoryEntry;
  onDelete: () => void;
}

function LearningRow({ entry, onDelete }: LearningRowProps) {
  const [expanded, setExpanded] = useState(false);
  const title = entry.description || entry.slug;
  // body includes frontmatter; preview is a clean truncation. Prefer the
  // richer body when expanded, fall back to preview for the collapsed snippet.
  const detail = useMemo(() => {
    const body = entry.body?.trim();
    return body && body.length > 0 ? body : entry.preview?.trim() || '';
  }, [entry.body, entry.preview]);
  const hasDetail = detail.length > 0;

  return (
    <div className="group border-b border-border-subtle/60 px-3 py-2 last:border-b-0">
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={() => hasDetail && setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-start gap-1.5 text-left"
          disabled={!hasDetail}
        >
          {hasDetail ? (
            expanded ? (
              <ChevronDown size={11} className="mt-[2px] shrink-0 text-text-muted" />
            ) : (
              <ChevronRight size={11} className="mt-[2px] shrink-0 text-text-muted" />
            )
          ) : (
            <span className="mt-[2px] w-[11px] shrink-0" />
          )}
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="shrink-0 rounded-[4px] bg-surface-3 px-1 py-[1px] text-[9px] uppercase tracking-wide text-[var(--color-accent-2)]">
                {TYPE_LABEL[entry.type] ?? entry.type}
              </span>
            </span>
            <span className="mt-[3px] block text-[11px] leading-snug text-text-secondary">
              {title}
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={onDelete}
          title="Delete learning"
          className="mt-[1px] flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-text-muted opacity-0 transition group-hover:opacity-70 hover:bg-surface-4 hover:text-semantic-error hover:opacity-100"
        >
          <Trash2 size={11} />
        </button>
      </div>
      {expanded && hasDetail && (
        <div className="mt-1.5 whitespace-pre-wrap pl-[18px] text-[10.5px] leading-relaxed text-text-muted">
          {detail}
        </div>
      )}
    </div>
  );
}
