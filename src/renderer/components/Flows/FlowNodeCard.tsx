import { SquareArrowOutUpRight } from 'lucide-react';

import { cn } from '@renderer/lib/utils';
import type { FlowNode, FlowNodeStatus } from '@shared/flowTypes';

// Fixed card geometry. FlowCanvas computes edge endpoints from these instead
// of measuring the DOM — the SVG is drawn in world coords in the same pass as
// the node transforms, so a measure-then-draw round trip would lag the cards
// by a frame during a drag.
export const NODE_W = 208;
export const NODE_H = 78;

const STATUS_DOT: Record<FlowNodeStatus, string> = {
  queued: 'bg-semantic-warning',
  running: 'bg-semantic-success shadow-[0_0_8px_var(--color-accent)]',
  done: 'bg-semantic-success/70',
  failed: 'bg-semantic-error',
  skipped: 'bg-text-dim',
};

const STATUS_RING: Record<FlowNodeStatus, string> = {
  queued: 'border-semantic-warning/50',
  running: 'border-semantic-success shadow-[0_0_0_1px_var(--color-accent),0_0_22px_var(--color-accent-glow)]',
  done: 'border-semantic-success/40',
  failed: 'border-semantic-error/70',
  skipped: 'border-border opacity-60',
};

interface Props {
  node: FlowNode;
  status?: FlowNodeStatus;
  selected: boolean;
  hasSession: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onPortPointerDown: (e: React.PointerEvent) => void;
  onOpenSession: () => void;
}

export function FlowNodeCard({
  node,
  status,
  selected,
  hasSession,
  onPointerDown,
  onPortPointerDown,
  onOpenSession,
}: Props) {
  return (
    <div
      data-node-id={node.id}
      onPointerDown={onPointerDown}
      style={{ left: node.x, top: node.y, width: NODE_W, height: NODE_H }}
      className={cn(
        'absolute cursor-grab rounded-lg border bg-surface-3 shadow-lg shadow-black/40 transition-colors active:cursor-grabbing',
        status ? STATUS_RING[status] : 'border-border-emphasis',
        selected && 'border-accent shadow-[0_0_0_1px_var(--color-accent)]',
      )}
    >
      <div className="flex items-center gap-2 px-3 pb-1.5 pt-2.5">
        <span
          className={cn(
            'h-2 w-2 shrink-0 rounded-full',
            status ? STATUS_DOT[status] : 'bg-text-dim',
          )}
        />
        <span className="flex-1 truncate text-[13px] font-semibold text-text">
          {node.role || 'untitled'}
        </span>
        <span className="shrink-0 font-mono text-[9.5px] text-text-dim">
          {node.cliId}
        </span>
      </div>

      <div className="flex items-center gap-1.5 border-t border-border-subtle px-3 pt-1.5 font-mono text-[9.5px] text-text-dim">
        <span className="rounded border border-border px-1.5 py-px">
          {node.mode === 'interactive' ? 'pane' : 'headless'}
        </span>
        {status && <span className="text-text-muted">{status}</span>}
        {hasSession && (
          <button
            type="button"
            title="Open the live session in the dock"
            aria-label="Open live session"
            // The pane is a drag surface; stop the gesture from reaching it.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onOpenSession();
            }}
            className="ml-auto flex items-center gap-1 rounded border border-border px-1.5 py-px text-accent transition hover:border-accent hover:bg-accent/10"
          >
            <SquareArrowOutUpRight size={9} />
            open
          </button>
        )}
      </div>

      {/* Ports. `in` is a drop target only (hit-tested on pointerup); dragging
          starts from `out` — matching the mockup's one-way wiring gesture. */}
      <span className="absolute -left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 rounded-full border-2 border-border-hi bg-surface" />
      <span
        data-port="out"
        onPointerDown={onPortPointerDown}
        title="Drag to another node to hand off"
        className="absolute -right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 cursor-crosshair rounded-full border-2 border-border-hi bg-surface transition hover:scale-125 hover:border-accent hover:bg-accent/20"
      />
    </div>
  );
}
