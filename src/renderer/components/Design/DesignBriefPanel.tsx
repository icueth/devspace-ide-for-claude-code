import { ChevronRight, History, MessagesSquare, X } from 'lucide-react';

import { DesignChatTranscript } from '@renderer/components/Design/DesignChatTranscript';
import { DesignVersionList } from '@renderer/components/Design/DesignVersionList';
import { cn } from '@renderer/lib/utils';
import type {
  DesignMessage,
  DesignScreen,
  DesignScreenVersion,
} from '@shared/design';

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
   * v0.10: chat-style transcript for this screen. The parent owns the
   * message buffer (loaded from `api.design.listMessages` on screen
   * switch, then mutated by `message_*` events). Legacy screens with no
   * persisted messages get a synthetic seed from the backend so this
   * array is never empty for an existing screen.
   */
  messages: DesignMessage[];
  /**
   * Send a follow-up turn to the active screen. Replaces the v0.9
   * `onRegenerate` callback — instead of a wholesale brief swap, every
   * submit appends to the transcript and feeds the prior conversation
   * back into the prompt.
   */
  onFollowUp: (text: string) => Promise<void> | void;
  /**
   * Abort the in-flight generation. Surfaced as a "Cancel" button in
   * the composer while `busy` is true.
   */
  onCancel: () => Promise<void> | void;
  /**
   * True while a generation is in flight for the active screen.
   * Disables the composer's submit button and shows the Cancel button.
   */
  busy: boolean;
  /**
   * Most-recent error message from a failed follow-up. Rendered inline
   * above the composer. The parent clears it (null) when the user
   * acks or starts a new turn.
   */
  error: string | null;
  /**
   * Switch the preview iframe to a historical version. The panel never
   * mutates the screen registry — it just notifies upstream.
   */
  onSelectVersion: (version: DesignScreenVersion) => void;
}

/**
 * Right-hand slide-out for a Design screen. v0.10 layout:
 *   • Chat-style transcript (replaces the single-shot brief textarea)
 *   • Version history (most recent first)
 *
 * The chat surface IS the brief in v0.10. Each user turn is a follow-up
 * generation; each assistant turn is the streaming output from claude.
 * The version list stays alongside so users can still pop back to a
 * prior render at any time without losing the conversation context.
 */
export function DesignBriefPanel({
  screen,
  activeHtmlPath,
  open,
  onToggle,
  messages,
  onFollowUp,
  onCancel,
  busy,
  error,
  onSelectVersion,
}: DesignBriefPanelProps) {
  if (!open) {
    // Collapsed rail — a thin button on the right edge that re-opens the
    // panel. Mirrors the codeflow side-rail idiom so users find it on
    // muscle memory.
    return (
      <button
        type="button"
        onClick={onToggle}
        title="Show chat & history"
        className="flex h-full w-7 shrink-0 items-center justify-center border-l border-border bg-surface-2 text-text-muted transition hover:bg-surface-3 hover:text-text"
      >
        <ChevronRight size={12} />
      </button>
    );
  }

  return (
    <aside
      className="flex h-full w-[360px] shrink-0 flex-col border-l border-border bg-surface-2"
      aria-label="Design chat and version history"
    >
      <div
        className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3"
        style={{ background: 'var(--color-surface-2)' }}
      >
        <MessagesSquare size={11} className="text-text-muted" />
        <span className="text-[11px] font-semibold text-text">Chat</span>
        {messages.length > 0 && (
          <span className="text-[10px] text-text-dim">({messages.length})</span>
        )}
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
          Select a design to see its chat and version history.
        </div>
      ) : (
        // Split the panel: top half = transcript (flex-1), bottom = versions
        // (fixed-ish, scrollable when long). The transcript owns its own
        // scrolling container so streaming content doesn't grow the
        // versions section.
        <div className="flex min-h-0 flex-1 flex-col">
          <DesignChatTranscript
            screen={screen}
            messages={messages}
            onSubmit={onFollowUp}
            onCancel={onCancel}
            busy={busy}
            error={error}
          />

          <section
            className={cn(
              'flex max-h-[40%] min-h-[120px] shrink-0 flex-col gap-1.5 border-t border-border bg-surface-2 px-2 py-2',
            )}
          >
            <div className="flex items-center gap-1.5 px-1">
              <History size={11} className="text-text-muted" />
              <span className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                Versions
              </span>
              <span className="text-[10px] text-text-dim">
                ({screen.versions.length})
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <DesignVersionList
                versions={screen.versions}
                activeHtmlPath={activeHtmlPath}
                onSelect={onSelectVersion}
              />
            </div>
          </section>
        </div>
      )}
    </aside>
  );
}
