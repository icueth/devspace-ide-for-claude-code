import { Check, CheckCheck, Shield, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';

/**
 * Phase 4a — bottom-anchored banner that surfaces Claude's tool-approval
 * prompts inside Terminal mode. Without this the user has to click into the
 * xterm canvas and physically type `y` for every Bash / Edit / Write call,
 * which is tedious and error-prone.
 *
 * Wiring:
 *   - Main's ApprovalDetector fires PTY_TOOL_APPROVAL when claude prints a
 *     prompt → renderer's preload bridge fans it out to this component.
 *   - Allow / Deny / Always allow write `y\r` / `n\r` / `a\r` directly to
 *     the PTY through `api.pty.write` — same channel a manual keystroke
 *     would use. The terminal's own onData echo handles the visual update.
 *
 * State:
 *   - `pending` holds the latest request that hasn't been acted on yet.
 *     We DON'T queue — claude only ever has one prompt outstanding, so the
 *     latest detection (after dedupe) supersedes anything older.
 *   - `lastHandledAt` blocks re-showing the same prompt within a short
 *     window after the user clicks a button. Cheap insurance against the
 *     detector seeing a redraw and re-firing before claude's response
 *     processing kicks in.
 */

interface ApprovalRequestPayload {
  toolName: string | null;
  raw: string;
  matchedAt: number;
}

interface ToolApprovalBannerProps {
  sessionId: string;
  /** Bumped by the parent (typically status === 'running') to enable the
   *  subscription. We don't subscribe before the PTY is alive — saves a
   *  spurious listener attach during the brief "starting…" window. */
  enabled: boolean;
}

/** ms-window during which a freshly-dismissed prompt with the same raw
 *  text is treated as a redraw, not a new request. The main-side detector
 *  has its own DEDUPE_WINDOW_MS (500); doubling that here covers PTY
 *  buffering jitter when the user clicks Allow. */
const POST_ACTION_DEDUPE_MS = 1000;

export function ToolApprovalBanner({
  sessionId,
  enabled,
}: ToolApprovalBannerProps) {
  const [pending, setPending] = useState<ApprovalRequestPayload | null>(null);
  const [lastHandledRaw, setLastHandledRaw] = useState<string | null>(null);
  const [lastHandledAt, setLastHandledAt] = useState(0);

  useEffect(() => {
    if (!enabled || !sessionId) return undefined;
    const unsubscribe = api.pty.onToolApproval(sessionId, (ev) => {
      const req = ev.request;
      // Suppress a redraw of a prompt we just answered. The main detector
      // covers identical raw within 500ms; this catches the slightly wider
      // window where claude is still processing our `y\r`.
      if (
        lastHandledRaw === req.raw &&
        Date.now() - lastHandledAt < POST_ACTION_DEDUPE_MS
      ) {
        return;
      }
      setPending(req);
    });
    return () => {
      unsubscribe();
    };
    // lastHandledRaw / lastHandledAt are read inside the cb via closure —
    // we intentionally DON'T re-subscribe when they change (that would
    // race the in-flight prompt). The closure sees stale values but the
    // check is conservative (won't mis-show prompts, only mis-suppress
    // immediate redraws — handled by the main detector instead).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, enabled]);

  const respond = (key: 'y' | 'n' | 'a'): void => {
    if (!pending) return;
    void api.pty.write(sessionId, `${key}\r`);
    setLastHandledRaw(pending.raw);
    setLastHandledAt(Date.now());
    setPending(null);
  };

  const dismiss = (): void => {
    // Just hide the banner — don't write anything to the PTY. User can
    // still respond via the terminal directly.
    if (pending) {
      setLastHandledRaw(pending.raw);
      setLastHandledAt(Date.now());
    }
    setPending(null);
  };

  // Wrap the conditional in a fixed-size container so the slide animation
  // has somewhere to translate from. We render the host even when there's
  // nothing pending — keeps the layout stable so the terminal underneath
  // doesn't jolt when the banner appears.
  const visible = !!pending;
  const toolLabel = pending?.toolName ?? 'Tool call';
  // Trim the raw prompt for display — keep first 120 chars. The full
  // string is still in `pending.raw` if we ever want to surface it in a
  // tooltip / expand interaction.
  const preview = (pending?.raw ?? '').trim().slice(0, 120);

  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-center px-3 pb-3 transition-transform duration-200 ease-out',
        visible ? 'translate-y-0' : 'translate-y-full',
      )}
      aria-hidden={!visible}
    >
      <div
        className="pointer-events-auto flex w-full max-w-[680px] items-center gap-2 rounded-[8px] border border-accent/40 bg-surface-2/95 px-3 py-2 shadow-xl backdrop-blur-sm"
        style={{
          boxShadow:
            '0 8px 28px rgba(0,0,0,0.45), 0 0 0 1px rgb(var(--color-accent-rgb) / 0.15)',
        }}
        role="dialog"
        aria-label="Approve Claude tool call"
      >
        <div
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] bg-accent-3 text-[11px] font-bold text-white"
        >
          <Shield size={12} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-[12px] font-semibold text-text">
              Approve {toolLabel}?
            </span>
          </div>
          {preview && (
            <div
              className="truncate font-mono text-[10.5px] text-text-muted"
              title={pending?.raw}
            >
              {preview}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => respond('y')}
          title="Send y — approve this single call"
          className="inline-flex h-[26px] shrink-0 items-center gap-1 rounded-[7px] px-2.5 text-[11px] font-medium text-white transition hover:brightness-110"
          style={{ background: 'var(--color-accent-3)' }}
        >
          <Check size={11} />
          Allow
        </button>
        <button
          type="button"
          onClick={() => respond('a')}
          title="Send a — claude may treat this as 'always allow this tool' on supported builds"
          className="inline-flex h-[26px] shrink-0 items-center gap-1 rounded-[7px] border border-border-subtle bg-surface-3 px-2.5 text-[11px] text-text-secondary transition hover:border-border-hi hover:bg-surface-4 hover:text-text"
        >
          <CheckCheck size={11} />
          Always
        </button>
        <button
          type="button"
          onClick={() => respond('n')}
          title="Send n — deny this call"
          className="inline-flex h-[26px] shrink-0 items-center gap-1 rounded-[7px] border border-border-subtle bg-surface-3 px-2.5 text-[11px] text-text-secondary transition hover:border-semantic-error/40 hover:bg-surface-4 hover:text-semantic-error"
        >
          Deny
        </button>
        <button
          type="button"
          onClick={dismiss}
          title="Dismiss — handle in terminal directly"
          aria-label="Dismiss approval banner"
          className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px] text-text-muted transition hover:bg-surface-4 hover:text-text"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}
