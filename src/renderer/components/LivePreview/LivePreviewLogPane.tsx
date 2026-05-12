import { ChevronDown, ChevronUp, Terminal } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { cn } from '@renderer/lib/utils';


export interface LivePreviewLogPaneProps {
  /**
   * Tail of the dev-server's stdout/stderr. Already chronologically
   * ordered (oldest first). The pane caps to the last N internally so
   * extremely chatty servers (HMR storms) don't tank the renderer.
   */
  lines: string[];
  collapsed: boolean;
  onToggle: () => void;
  /** Optional override for the pill label (default: "Server log"). */
  label?: string;
}

// Hard cap on rendered lines. We trust the backend to only ship a
// recent window (~500), but render even fewer so DOM stays cheap.
const MAX_RENDERED_LINES = 200;

/**
 * Collapsible bottom pane showing the dev-server's stdout tail. Strips
 * ANSI color codes (Vite/Next love them) so the lines are readable in
 * the host theme. Auto-scrolls to the bottom on every update unless the
 * user has scrolled up — same UX pattern as a terminal pane.
 */
export function LivePreviewLogPane({
  lines,
  collapsed,
  onToggle,
  label,
}: LivePreviewLogPaneProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Tracks whether the user has scrolled away from the bottom. When
  // true, we DON'T auto-scroll on update — that would yank them out of
  // whatever line they're reading. Reset to "stick to bottom" once they
  // scroll back into the last 32px.
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    if (collapsed) return;
    if (!stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [lines, collapsed]);

  const onScroll = (ev: React.UIEvent<HTMLDivElement>) => {
    const el = ev.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 32;
  };

  const display = lines.slice(-MAX_RENDERED_LINES);

  return (
    <section
      className={cn(
        'flex shrink-0 flex-col border-t border-border bg-surface-2',
        collapsed ? 'h-7' : 'h-44',
      )}
      aria-label="Dev server log"
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex h-7 shrink-0 items-center gap-2 border-b border-border-subtle px-3 text-left transition hover:bg-surface-3"
        title={collapsed ? 'Expand log' : 'Collapse log'}
      >
        <Terminal size={11} className="text-text-muted" />
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-text-muted">
          {label ?? 'Server log'}
        </span>
        <span className="text-[10px] text-text-dim">
          ({display.length}
          {lines.length > display.length ? `+ of ${lines.length}` : ''})
        </span>
        <div className="flex-1" />
        {collapsed ? (
          <ChevronUp size={11} className="text-text-muted" />
        ) : (
          <ChevronDown size={11} className="text-text-muted" />
        )}
      </button>
      {!collapsed && (
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-y-auto bg-surface px-3 py-2 font-mono text-[10.5px] leading-snug text-text-secondary"
        >
          {display.length === 0 ? (
            <div className="text-text-dim">
              Waiting for output… the dev server hasn't written anything yet.
            </div>
          ) : (
            display.map((raw, i) => (
              // Index keys are fine here — `lines` is append-only from
              // the renderer's POV, so a row's index is stable until
              // the backend trims the head of its buffer.
              // Main strips ANSI before it ever reaches the renderer
              // (DevServerService.appendLog), so this is rendered as-is.
              <pre
                key={`${i}-${raw.length}`}
                className="whitespace-pre-wrap break-words"
              >
                {raw}
              </pre>
            ))
          )}
        </div>
      )}
    </section>
  );
}
