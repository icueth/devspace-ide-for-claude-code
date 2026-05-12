import { ChevronDown, ChevronUp, Send, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { cn } from '@renderer/lib/utils';
import type { DesignMessage, DesignScreen } from '@shared/design';

// ─── Display caps ─────────────────────────────────────────────────────
//
// Generated HTML can be enormous (think 50 KB of markup in a single
// assistant turn). Rendering that into one giant text node tanks frame
// rate and trashes the message-list scroll perf. We clamp to a sensible
// preview chunk and lazily reveal more on demand, with a hard ceiling so
// even "show more" never tries to inject a megabyte into the DOM.
const PREVIEW_LIMIT = 4000;
const EXPANDED_LIMIT = 100_000;

// Submit-shortcut: Cmd+Enter on macOS, Ctrl+Enter elsewhere. Plain Enter
// stays as a newline so multi-line prompts feel natural (matches the
// Toolbar's brief textarea). Detected once at module load — the modifier
// is stable per-session.
const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPad|iPhone|iPod/.test(navigator.platform);
const SUBMIT_HINT = IS_MAC ? 'Cmd+Enter' : 'Ctrl+Enter';

export interface DesignChatTranscriptProps {
  /**
   * Currently focused screen. Drives the placeholder + empty-state copy.
   * We don't read `screen.brief` directly — the transcript ARE the brief
   * in v0.10. `null` collapses the transcript to a "select a design"
   * empty state.
   */
  screen: DesignScreen | null;
  /**
   * Append-only ordered list of turns for this screen. Streaming
   * assistant turns are flagged with `streaming: true` so we render a
   * pulse + caret. The parent (DesignView) owns the message buffer; we
   * just render whatever it hands us.
   */
  messages: DesignMessage[];
  /**
   * Send a follow-up turn. Resolved by the parent after IPC has been
   * queued — the actual streaming reply arrives through `messages` as
   * the backend pushes `message_*` events. We swallow errors silently
   * (DesignView raises them via the toolbar banner) so the composer
   * stays responsive.
   */
  onSubmit: (text: string) => Promise<void> | void;
  /**
   * Abort the in-flight generation. Only shown when `busy === true`.
   */
  onCancel: () => Promise<void> | void;
  /**
   * True while a generation is in flight for THIS screen. Disables the
   * submit button and unhides the Cancel button.
   */
  busy: boolean;
  /**
   * Surfaced inline above the composer when the last submit / generation
   * failed. The parent owns the value — clearing it (null) hides the
   * banner.
   */
  error: string | null;
}

interface MessageBubbleProps {
  msg: DesignMessage;
  // Forces the transcript to re-scroll-to-bottom whenever a streaming
  // assistant turn grows. Passed down so the bubble can ping the parent
  // scroller without owning the scroll container itself.
  onContentMeasured: () => void;
}

/**
 * v0.10 chat surface for the Design pane. Replaces the static
 * brief-textarea + Regenerate-button. The brief field is now a
 * transcript — each generation is a follow-up turn with prior
 * conversation as context.
 *
 * Layout (vertical):
 *   • Scrollable transcript area (oldest → newest)
 *   • Inline error banner (when present)
 *   • Composer: textarea + Cancel/Submit row
 *
 * Behavior:
 *   • Auto-scrolls to bottom on new messages and during streaming
 *     growth, but ONLY when the user is already pinned to the bottom.
 *     If they've scrolled up to inspect an older turn, we leave them
 *     alone (standard chat-UI etiquette).
 *   • Cmd/Ctrl+Enter submits. Plain Enter inserts a newline.
 *   • Long assistant turns (e.g. raw HTML) are clamped to 4 KB with a
 *     "show more" toggle, with a hard ceiling of 100 KB even when
 *     expanded so the DOM stays interactive.
 */
export function DesignChatTranscript({
  screen,
  messages,
  onSubmit,
  onCancel,
  busy,
  error,
}: DesignChatTranscriptProps) {
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Tracks whether the user is currently pinned to the bottom of the
  // transcript. We update this lazily on scroll events so streaming
  // growth doesn't fight a user who scrolled up to read history.
  const stickToBottomRef = useRef(true);

  // Reset draft when switching screens — half-typed prompts shouldn't
  // bleed across designs.
  useEffect(() => {
    setDraft('');
    stickToBottomRef.current = true;
  }, [screen?.id]);

  // Anchor scroll to bottom on initial mount / screen switch / new
  // messages. We run synchronously (useLayoutEffect) to avoid the
  // visible jump that would happen if the user saw the transcript
  // settle one frame above the bottom.
  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, screen?.id]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // 24 px slack — anything within a hair of the bottom counts as
    // "still pinned". Otherwise scroll-jitter from streaming content
    // would flip the flag back and forth.
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 24;
  }, []);

  // Called by each bubble whenever its rendered content size changes
  // (streaming token append, "show more" toggle). Re-anchors scroll
  // when the user is pinned to the bottom.
  const handleContentMeasured = useCallback(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  const canSubmit = !busy && draft.trim().length > 0 && !!screen;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    const text = draft.trim();
    setDraft('');
    // We optimistically clear the draft; if the parent rejects, the
    // error banner surfaces above the composer and the user can retype.
    // Restoring the draft on failure would surprise the user (their
    // text reappears) more than the cost of retyping in this rare path.
    await onSubmit(text);
    // Re-focus after submit so multi-turn iteration is fast.
    textareaRef.current?.focus();
  }, [canSubmit, draft, onSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Cmd/Ctrl+Enter submits. Plain Enter inserts a newline (default).
      // Shift+Enter also inserts a newline (default). We intentionally
      // do NOT bind plain Enter to submit because brief-like prompts
      // are routinely multi-line — users will paste lists, code, etc.
      const meta = IS_MAC ? e.metaKey : e.ctrlKey;
      if (meta && e.key === 'Enter') {
        e.preventDefault();
        void handleSubmit();
      }
    },
    [handleSubmit],
  );

  const handleCancel = useCallback(() => {
    void onCancel();
  }, [onCancel]);

  // Empty state hint — shown when the screen exists but has no turns yet
  // (which normally only happens during create flow before the first
  // assistant reply arrives, but we render defensively just in case).
  const showEmptyState = messages.length === 0 && !!screen;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-3"
      >
        {showEmptyState ? (
          <EmptyState />
        ) : (
          messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              msg={msg}
              onContentMeasured={handleContentMeasured}
            />
          ))
        )}
      </div>

      {error && (
        <div className="flex shrink-0 items-start gap-2 border-t border-semantic-error/30 bg-semantic-error/10 px-3 py-1.5 text-[11px] text-semantic-error">
          <span className="line-clamp-3 flex-1 whitespace-pre-wrap break-words">
            {error}
          </span>
        </div>
      )}

      <div className="shrink-0 border-t border-border-subtle bg-surface-2 px-3 py-2">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={3}
          disabled={!screen}
          placeholder={
            screen
              ? 'Refine this design… e.g. make the header darker, add a CTA section'
              : 'Select a design to start chatting…'
          }
          className="w-full resize-none rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-1.5 text-[11.5px] leading-snug text-text placeholder:text-text-dim focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        />

        <div className="mt-2 flex items-center gap-2">
          <span className="text-[10px] text-text-dim">{SUBMIT_HINT} to send</span>
          <div className="flex-1" />
          {busy && (
            <button
              type="button"
              onClick={handleCancel}
              title="Cancel generation"
              className="inline-flex items-center gap-1 rounded-[6px] border border-border-subtle bg-surface-3 px-2.5 py-[5px] text-[11px] font-medium text-text-muted transition hover:bg-surface-4 hover:text-text"
            >
              <X size={11} />
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            title={canSubmit ? `Send (${SUBMIT_HINT})` : 'Type a message to send'}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-[6px] px-3 py-[5px] text-[11px] font-medium transition',
              canSubmit
                ? 'text-white hover:brightness-110'
                : 'pointer-events-none border border-border bg-surface-3 text-text-muted opacity-60',
            )}
            style={
              canSubmit
                ? {
                    background:
                      'linear-gradient(135deg, var(--color-accent), var(--color-accent-3))',
                    boxShadow: '0 2px 8px rgba(76,141,255,0.25)',
                  }
                : undefined
            }
          >
            <Send size={11} />
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 text-center text-[11px] text-text-muted">
      <div className="mb-1 font-medium text-text-secondary">No conversation yet</div>
      <p className="max-w-[240px] text-[10.5px] leading-snug text-text-dim">
        Send a follow-up to refine this design. Try “tighten the hero
        spacing” or “swap the palette to warm neutrals.”
      </p>
    </div>
  );
}

// Heuristic: tag an assistant message as "html-heavy" so we render it
// in monospace (matches the code that's streaming in). Prose answers
// ("I'll restructure the hero...") should NOT get mono — that's the F2
// audit finding. We classify by looking at the first ~512 chars of the
// trimmed message:
//   • starts with `<` and contains either a doctype, `<html`, or two+
//     element tags → html
//   • >= 6% of the prefix is `<` characters → html
//   • otherwise → prose
//
// During streaming the classification can flip from prose→html as more
// tokens arrive (Claude often emits a one-line intro before the html
// dump). We re-classify on each content change; the memo keeps it cheap.
function classifyAssistantContent(raw: string): 'prose' | 'html' {
  if (!raw) return 'prose';
  const trimmed = raw.trimStart();
  if (trimmed.length === 0) return 'prose';
  const prefix = trimmed.slice(0, 512);
  const lower = prefix.toLowerCase();
  if (
    lower.startsWith('<!doctype') ||
    lower.startsWith('<html') ||
    lower.startsWith('```html')
  ) {
    return 'html';
  }
  if (prefix[0] === '<') {
    // count tag-opens in the first 512 chars
    let tagOpens = 0;
    for (let i = 0; i < prefix.length; i++) {
      if (prefix[i] === '<') tagOpens++;
      if (tagOpens >= 2) return 'html';
    }
  }
  // Density check — html dumps are very `<`-dense.
  const lt = (prefix.match(/</g) ?? []).length;
  if (lt / prefix.length >= 0.06) return 'html';
  return 'prose';
}

function MessageBubble({ msg, onContentMeasured }: MessageBubbleProps) {
  const [expanded, setExpanded] = useState(false);
  // v0.13 LOW #4: once a streaming turn flips to 'html', never downgrade
  // back to 'prose'. The reverse transition would swap the bubble font
  // mid-stream which looks broken. Cached as a ref so the upgrade is
  // sticky for the lifetime of this bubble instance.
  const classificationRef = useRef<'prose' | 'html'>('prose');

  const isUser = msg.role === 'user';
  const isSystem = msg.role === 'system';

  // Compute the display slice. We keep this in a memo so a streaming
  // assistant turn (whose `content` grows token-by-token) only does the
  // slice work when content actually changes.
  const { displayText, isClipped, totalLen } = useMemo(() => {
    const raw = msg.content ?? '';
    const limit = expanded ? EXPANDED_LIMIT : PREVIEW_LIMIT;
    if (raw.length <= limit) {
      return { displayText: raw, isClipped: false, totalLen: raw.length };
    }
    return {
      displayText: raw.slice(0, limit),
      isClipped: true,
      totalLen: raw.length,
    };
  }, [msg.content, expanded]);

  // F2: classify so prose answers don't get monospace. v0.13 LOW #4:
  // upgrade is sticky — once a turn flips to 'html', don't flicker back.
  const contentKind = useMemo(() => {
    if (isUser || isSystem) return 'prose' as const;
    if (classificationRef.current === 'html') return 'html' as const;
    const next = classifyAssistantContent(msg.content ?? '');
    if (next === 'html') classificationRef.current = 'html';
    return next;
  }, [msg.content, isUser, isSystem]);

  // Notify the parent transcript that our height likely changed so it
  // can re-anchor the scroll if the user is pinned to the bottom.
  // Streaming assistant turns are the common case here.
  useLayoutEffect(() => {
    onContentMeasured();
  }, [displayText, expanded, onContentMeasured]);

  const label = isUser ? 'You' : isSystem ? 'System' : 'Claude';

  return (
    <div
      className={cn(
        'flex flex-col gap-1',
        isUser ? 'items-end' : 'items-start',
      )}
    >
      <div className="flex items-center gap-1.5 px-1">
        <span
          className={cn(
            'text-[10px] font-semibold uppercase tracking-wide',
            isUser
              ? 'text-accent'
              : isSystem
                ? 'text-text-dim'
                : 'text-text-muted',
          )}
        >
          {label}
        </span>
        {msg.streaming && (
          <span
            className="inline-flex items-center gap-1 text-[10px] text-text-dim"
            aria-live="polite"
          >
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            streaming
          </span>
        )}
      </div>

      <div
        className={cn(
          'max-w-[92%] rounded-[8px] border px-2.5 py-1.5 text-[11.5px] leading-snug',
          isUser
            ? 'border-accent/30 bg-[rgba(76,141,255,0.12)] text-text'
            : isSystem
              ? 'border-border-subtle bg-surface-3 italic text-text-dim'
              : 'border-border-subtle bg-surface-3 text-text-secondary',
          // F2: only assistant turns classified as html-heavy get mono.
          // Prose answers stay in the default font so they're readable.
          contentKind === 'html' ? 'font-mono' : '',
        )}
      >
        {/*
          Render as plain text. The assistant content WILL include raw
          HTML (e.g. `<div class="hero">…</div>`) because claude streams
          the generated markup as a token stream. We intentionally show
          it verbatim — that's the whole UX moment, the user gets to
          watch the page being built. `whitespace-pre-wrap` preserves
          newlines + indentation; `break-words` keeps oversized URLs /
          attribute lists from blowing out the bubble width.
        */}
        <pre className="m-0 whitespace-pre-wrap break-words font-[inherit] text-[inherit] leading-[inherit]">
          {displayText}
          {msg.streaming && <span className="opacity-60">▍</span>}
        </pre>

        {isClipped && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-1.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-text-muted transition hover:bg-surface-4 hover:text-text"
          >
            {expanded ? (
              <>
                <ChevronUp size={10} />
                Show less
              </>
            ) : (
              <>
                <ChevronDown size={10} />
                Show more ({formatBytes(totalLen)} total)
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} chars`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
