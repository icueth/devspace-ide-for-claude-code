import { Check, Inbox as InboxIcon, Loader2, Pencil, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import type { MemoryEntry, MemoryInboxItem } from '@shared/types';

// Color tokens for the signal chip. We stay inside DevSpace's semantic
// palette so the chips read consistently with the rest of the app and
// users don't have to re-train their eye for a new color vocabulary.
const SIGNAL_STYLES: Record<
  MemoryInboxItem['signal'],
  { label: string; className: string }
> = {
  correction: {
    label: 'correction',
    className: 'border-semantic-error/30 bg-semantic-error/10 text-semantic-error',
  },
  confirmation: {
    label: 'confirmation',
    className: 'border-semantic-success/30 bg-semantic-success/10 text-semantic-success',
  },
  decision: {
    label: 'decision',
    className: 'border-accent/30 bg-accent/10 text-accent',
  },
  'named-entity': {
    label: 'named-entity',
    className: 'border-[rgba(168,85,247,0.3)] bg-[rgba(168,85,247,0.1)] text-accent-2',
  },
  manual: {
    label: 'manual',
    className: 'border-border-subtle bg-surface-3 text-text-secondary',
  },
};

export interface InboxListProps {
  // When set, only items belonging to this project's hash are shown. null
  // shows everything (the dashboard's cross-project default).
  projectHash: string | null;
  // Render mode — 'preview' caps at 3 items for the Home card; 'full'
  // renders the entire list for the Inbox view.
  mode: 'preview' | 'full';
  // Callback invoked when the user picks "Accept / Edit before accepting".
  // The dashboard owns the EntryEditor and patches the suggestion into it.
  onAccept: (item: MemoryInboxItem) => void;
  // Optional click-to-jump for previews — clicking a row in preview mode
  // jumps the dashboard to the full Inbox view.
  onJumpToFull?: () => void;
}

/**
 * Renders the memory auto-capture inbox. The backend's `proposeFromTurn`
 * pipeline drops suggestions in here; users either promote them to real
 * entries (Accept) or dismiss them.
 *
 * Subscribes to `api.memory.onEvent` and refreshes whenever an
 * `inbox_added` or `inbox_resolved` event arrives — keeps the list live
 * without polling.
 */
export function InboxList({
  projectHash,
  mode,
  onAccept,
  onJumpToFull,
}: InboxListProps) {
  const [items, setItems] = useState<MemoryInboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState<Set<string>>(new Set());

  const refresh = useMemo(
    () => async () => {
      try {
        const list = await api.memory.listInbox(undefined);
        // We always pull the full inbox so the dashboard can show the
        // global count, then filter client-side. Project-scope filter is
        // cheap (O(n)) and lets us avoid a second round-trip when the
        // user toggles the project filter.
        setItems(list);
      } catch (err) {
        console.error('[inbox] listInbox failed', err);
        setItems([]);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Initial load.
  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  // Live updates. Listen for any inbox-related event and trigger a refresh.
  // We re-list rather than mutate locally because the backend is the source
  // of truth (de-dup, ordering, etc.) and the list is bounded.
  useEffect(() => {
    const unsub = api.memory.onEvent((ev) => {
      if (ev.kind === 'inbox_added' || ev.kind === 'inbox_resolved') {
        void refresh();
      }
    });
    return unsub;
  }, [refresh]);

  const filtered = useMemo(() => {
    const base = projectHash
      ? items.filter((it) => it.projectHash === projectHash)
      : items;
    return mode === 'preview' ? base.slice(0, 3) : base.slice(0, 200);
  }, [items, projectHash, mode]);

  const handleDismiss = async (id: string) => {
    setResolving((prev) => new Set(prev).add(id));
    try {
      await api.memory.dismissInbox(id);
      setItems((prev) => prev.filter((it) => it.id !== id));
    } catch (err) {
      console.error('[inbox] dismiss failed', err);
    } finally {
      setResolving((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  // Direct accept — promotes the suggestion using the backend's defaults
  // (type/slug/description verbatim from the suggestion). The dashboard's
  // Accept handler uses `onAccept` instead when the user wants to review
  // the entry before promoting.
  const handleQuickAccept = async (item: MemoryInboxItem) => {
    setResolving((prev) => new Set(prev).add(item.id));
    try {
      const entry: MemoryEntry = await api.memory.resolveInbox({
        inboxId: item.id,
        type: item.suggestedType,
        slug: item.suggestedSlug,
        description: item.suggestedDescription,
        body: item.body,
      });
      // Optimistic remove — the inbox_resolved event will also fire and
      // call refresh, but removing immediately makes the UI feel snappy.
      setItems((prev) => prev.filter((it) => it.id !== item.id));
      void entry; // result not displayed in the inbox; resolved entries land in All view
    } catch (err) {
      console.error('[inbox] resolve failed', err);
    } finally {
      setResolving((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-4 py-6 text-[11px] text-text-muted">
        <Loader2 size={12} className="animate-spin" />
        Loading inbox…
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <EmptyState
        message={
          projectHash
            ? 'No pending suggestions for this project.'
            : 'No pending suggestions. Chat turns flagged as corrections, decisions, or named-entities will appear here.'
        }
      />
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {filtered.map((item) => {
        const isResolving = resolving.has(item.id);
        const signal = SIGNAL_STYLES[item.signal];
        return (
          <li
            key={item.id}
            className={cn(
              'group rounded-[8px] border border-border-subtle bg-surface-2 p-3 transition hover:border-border-hi',
              isResolving && 'opacity-50',
            )}
            onClick={mode === 'preview' ? onJumpToFull : undefined}
            role={mode === 'preview' ? 'button' : undefined}
          >
            <div className="mb-1.5 flex items-center gap-1.5">
              <span
                className={cn(
                  'rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider',
                  signal.className,
                )}
              >
                {signal.label}
              </span>
              <span className="rounded-[5px] border border-border-subtle bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-text-muted">
                {item.suggestedType}
              </span>
              <span className="truncate font-mono text-[11px] text-text-secondary">
                {item.suggestedSlug}
              </span>
            </div>
            <div className="mb-2 line-clamp-3 whitespace-pre-wrap text-[12px] leading-relaxed text-text">
              {item.body}
            </div>
            {item.suggestedDescription && (
              <div className="mb-2 text-[11px] italic text-text-muted">
                Suggested description: {item.suggestedDescription}
              </div>
            )}
            {mode === 'full' && (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleQuickAccept(item);
                  }}
                  disabled={isResolving}
                  className="inline-flex items-center gap-1 rounded-[5px] border border-semantic-success/30 bg-semantic-success/10 px-2 py-1 text-[11px] text-semantic-success transition hover:bg-semantic-success/20"
                  title="Accept with the suggested defaults"
                >
                  <Check size={11} />
                  Accept
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onAccept(item);
                  }}
                  disabled={isResolving}
                  className="inline-flex items-center gap-1 rounded-[5px] border border-border-subtle bg-surface-3 px-2 py-1 text-[11px] text-text-secondary transition hover:border-accent/40 hover:text-text"
                  title="Open the entry editor with this suggestion pre-filled"
                >
                  <Pencil size={11} />
                  Edit before accepting
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleDismiss(item.id);
                  }}
                  disabled={isResolving}
                  className="inline-flex items-center gap-1 rounded-[5px] border border-border-subtle bg-surface-3 px-2 py-1 text-[11px] text-text-muted transition hover:border-semantic-error/30 hover:text-semantic-error"
                  title="Dismiss this suggestion permanently"
                >
                  <X size={11} />
                  Dismiss
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-[8px] border border-dashed border-border-subtle bg-surface-2 px-6 py-10 text-center">
      <InboxIcon size={20} className="text-text-dim" />
      <p className="max-w-[360px] text-[11.5px] leading-relaxed text-text-muted">
        {message}
      </p>
    </div>
  );
}
