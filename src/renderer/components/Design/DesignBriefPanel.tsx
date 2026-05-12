import { ChevronRight, FileText, History, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { DesignVersionList } from '@renderer/components/Design/DesignVersionList';
import { cn } from '@renderer/lib/utils';
import type { DesignScreen, DesignScreenVersion } from '@shared/design';

export interface DesignBriefPanelProps {
  /**
   * Currently focused screen. `null` when nothing is selected; the panel
   * still renders a placeholder so the layout doesn't jump when a screen
   * becomes active.
   */
  screen: DesignScreen | null;
  /**
   * `htmlPath` of the version currently shown in the iframe. Used to
   * highlight the active row in the version list — typically equal to
   * `screen.htmlPath`, but the parent may temporarily point at an older
   * version for read-only preview.
   */
  activeHtmlPath: string | null;
  /**
   * Toggles the slide-out side panel. Persisting this lives in the
   * parent (DesignView) so closing the panel sticks across screen
   * switches.
   */
  open: boolean;
  onToggle: () => void;
  /**
   * Kick off `api.design.regenerate(...)`. The parent owns the actual
   * IPC call so the panel stays focused on local form state.
   */
  onRegenerate: (brief: string) => Promise<void> | void;
  /**
   * Switch the preview iframe to a historical version. The panel never
   * mutates the screen registry — it just notifies upstream.
   */
  onSelectVersion: (version: DesignScreenVersion) => void;
}

/**
 * Right-hand slide-out for a Design screen. Shows:
 *   • the brief that produced the current iframe (read-only)
 *   • a textarea for issuing a regeneration with a fresh brief
 *   • the version history (most recent first)
 *
 * Phase A keeps version selection lightweight — clicking a row just
 * swaps the preview iframe `src`. Diff overlay + branched edits are
 * deferred.
 */
export function DesignBriefPanel({
  screen,
  activeHtmlPath,
  open,
  onToggle,
  onRegenerate,
  onSelectVersion,
}: DesignBriefPanelProps) {
  const [draftBrief, setDraftBrief] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Whenever the user switches screens, the textarea should pre-fill with
  // the currently stored brief so they can tweak rather than rewrite.
  useEffect(() => {
    setDraftBrief(screen?.brief ?? '');
    setSubmitting(false);
  }, [screen?.id, screen?.brief]);

  const handleRegenerate = useCallback(async () => {
    if (!screen || submitting) return;
    const trimmed = draftBrief.trim();
    if (!trimmed) return;
    setSubmitting(true);
    try {
      await onRegenerate(trimmed);
    } finally {
      setSubmitting(false);
    }
  }, [draftBrief, onRegenerate, screen, submitting]);

  if (!open) {
    // Collapsed rail — a thin button on the right edge that re-opens the
    // panel. Mirrors the codeflow side-rail idiom so users find it on
    // muscle memory.
    return (
      <button
        type="button"
        onClick={onToggle}
        title="Show brief & history"
        className="flex h-full w-7 shrink-0 items-center justify-center border-l border-border bg-surface-2 text-text-muted transition hover:bg-surface-3 hover:text-text"
      >
        <ChevronRight size={12} />
      </button>
    );
  }

  return (
    <aside
      className="flex h-full w-[320px] shrink-0 flex-col border-l border-border bg-surface-2"
      aria-label="Design brief and version history"
    >
      <div
        className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3"
        style={{ background: 'var(--color-surface-2)' }}
      >
        <FileText size={11} className="text-text-muted" />
        <span className="text-[11px] font-semibold text-text">Brief</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onToggle}
          title="Hide panel"
          className="rounded p-1 text-text-muted transition hover:bg-surface-3 hover:text-text"
        >
          <X size={11} />
        </button>
      </div>

      {!screen ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-[11px] text-text-muted">
          Select a design to see its brief and version history.
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <section className="flex flex-col gap-2 border-b border-border-subtle px-3 py-3">
            <Label>Current brief</Label>
            {screen.brief.trim() ? (
              <p className="whitespace-pre-wrap rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-1.5 text-[11px] leading-snug text-text-secondary">
                {screen.brief}
              </p>
            ) : (
              <p className="text-[10.5px] italic text-text-dim">No brief recorded.</p>
            )}
          </section>

          <section className="flex flex-col gap-2 border-b border-border-subtle px-3 py-3">
            <Label>Regenerate with new brief</Label>
            <textarea
              value={draftBrief}
              onChange={(e) => setDraftBrief(e.target.value)}
              rows={5}
              placeholder="Describe what should change…"
              className="w-full resize-none rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-1.5 text-[11.5px] text-text placeholder:text-text-dim focus:border-accent focus:outline-none"
            />
            <button
              type="button"
              onClick={() => void handleRegenerate()}
              disabled={
                !draftBrief.trim() || submitting || screen.status === 'generating'
              }
              className={cn(
                'inline-flex items-center justify-center gap-1.5 rounded-[6px] px-3 py-[6px] text-[11px] font-medium transition',
                !draftBrief.trim() || submitting || screen.status === 'generating'
                  ? 'pointer-events-none border border-border bg-surface-3 text-text-muted opacity-60'
                  : 'text-white hover:brightness-110',
              )}
              style={
                !draftBrief.trim() || submitting || screen.status === 'generating'
                  ? undefined
                  : {
                      background:
                        'linear-gradient(135deg, var(--color-accent), var(--color-accent-3))',
                      boxShadow: '0 2px 8px rgba(76,141,255,0.25)',
                    }
              }
            >
              <RefreshCw
                size={11}
                className={cn(submitting && 'animate-spin')}
              />
              {submitting
                ? 'Sending…'
                : screen.status === 'generating'
                  ? 'Already generating…'
                  : 'Regenerate'}
            </button>
          </section>

          <section className="flex min-h-0 flex-col gap-1.5 px-2 py-3">
            <div className="flex items-center gap-1.5 px-1">
              <History size={11} className="text-text-muted" />
              <Label inline>Versions</Label>
              <span className="text-[10px] text-text-dim">
                ({screen.versions.length})
              </span>
            </div>
            <DesignVersionList
              versions={screen.versions}
              activeHtmlPath={activeHtmlPath}
              onSelect={onSelectVersion}
            />
          </section>
        </div>
      )}
    </aside>
  );
}

function Label({
  children,
  inline,
}: {
  children: React.ReactNode;
  inline?: boolean;
}) {
  return (
    <div
      className={cn(
        'text-[10px] font-semibold uppercase tracking-wide text-text-muted',
        inline ? '' : 'mb-0.5',
      )}
    >
      {children}
    </div>
  );
}
