import { SquareArrowOutUpRight } from 'lucide-react';

import {
  FAIL_PORT_Y,
  NODE_H,
  NODE_W,
  PASS_PORT_Y,
  nodeKind,
  nodeSize,
} from '@renderer/components/Flows/flowGeometry';
import { cn } from '@renderer/lib/utils';
import type { FlowEdge, FlowNode, FlowNodeRun, FlowNodeStatus } from '@shared/flowTypes';

// Re-exported so phase-1 importers (and the canvas) keep one source of truth.
export { NODE_H, NODE_W };

const STATUS_DOT: Record<FlowNodeStatus, string> = {
  queued: 'bg-semantic-warning',
  running: 'bg-semantic-success shadow-[0_0_8px_var(--color-accent)]',
  done: 'bg-semantic-success/70',
  failed: 'bg-semantic-error',
  skipped: 'bg-text-dim',
};

const STATUS_RING: Record<FlowNodeStatus, string> = {
  queued: 'border-semantic-warning/50',
  running:
    'border-semantic-success shadow-[0_0_0_1px_var(--color-accent),0_0_22px_var(--color-accent-glow)]',
  done: 'border-semantic-success/40',
  failed: 'border-semantic-error/70',
  skipped: 'border-border opacity-60',
};

interface Props {
  node: FlowNode;
  status?: FlowNodeStatus;
  nodeRun?: FlowNodeRun | null;
  selected: boolean;
  hasSession: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  /** branch is set only when the drag started on a gate's pass/fail port. */
  onPortPointerDown: (e: React.PointerEvent, branch?: FlowEdge['branch']) => void;
  onOpenSession: () => void;
}

export function FlowNodeCard(props: Props) {
  switch (nodeKind(props.node)) {
    case 'gate':
      return <GateCard {...props} />;
    case 'note':
      return <NoteCard {...props} />;
    default:
      return <AgentCard {...props} />;
  }
}

/** The retry counter — only meaningful once a gate has re-queued this node. */
function AttemptsBadge({ attempts }: { attempts?: number }) {
  if (!attempts || attempts < 2) return null;
  return (
    <span className="rounded border border-semantic-warning/50 bg-semantic-warning/10 px-1.5 py-px font-mono text-[9px] text-semantic-warning">
      retry ×{attempts}
    </span>
  );
}

function AgentCard({
  node,
  status,
  nodeRun,
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
          {node.model || node.cliId}
        </span>
      </div>

      <div className="flex items-center gap-1.5 border-t border-border-subtle px-3 pt-1.5 font-mono text-[9.5px] text-text-dim">
        <span className="rounded border border-border px-1.5 py-px">
          {node.mode === 'interactive' ? 'pane' : 'headless'}
        </span>
        <AttemptsBadge attempts={nodeRun?.attempts} />
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

/**
 * A gate: an LLM judge answers PASS/FAIL against `condition`. Two out-ports —
 * pass continues the flow, fail re-queues its target (bounded by maxRetries).
 * Port positions must agree with flowGeometry.outPort, which is what the edge
 * anchors use.
 */
function GateCard({ node, status, nodeRun, selected, onPointerDown, onPortPointerDown }: Props) {
  const { w, h } = nodeSize(node);
  const verdict = nodeRun?.verdict;
  return (
    <div
      data-node-id={node.id}
      onPointerDown={onPointerDown}
      style={{ left: node.x, top: node.y, width: w, height: h }}
      className={cn(
        'absolute cursor-grab rounded-lg border bg-semantic-warning/[0.06] shadow-lg shadow-black/40 transition-colors active:cursor-grabbing',
        status ? STATUS_RING[status] : 'border-semantic-warning/45',
        selected && 'border-accent shadow-[0_0_0_1px_var(--color-accent)]',
      )}
    >
      <div className="flex items-center gap-2 px-3 pb-1 pt-2.5">
        <span
          className={cn(
            'h-2 w-2 shrink-0 rounded-full',
            status ? STATUS_DOT[status] : 'bg-semantic-warning/60',
          )}
        />
        <span className="shrink-0 text-[12px] text-semantic-warning">◇</span>
        <span className="flex-1 truncate text-[12.5px] font-semibold text-text">
          {node.role || 'condition?'}
        </span>
      </div>

      <div className="truncate px-3 pb-1.5 font-mono text-[10px] text-semantic-warning/80">
        {node.condition || 'no condition set'}
      </div>

      <div className="flex items-center gap-1 px-3 font-mono text-[9px]">
        <span className="text-semantic-success">✓ pass</span>
        <span className="text-text-dim">·</span>
        <span className="text-semantic-error">✗ fail ×{node.maxRetries ?? 3}</span>
        <AttemptsBadge attempts={nodeRun?.attempts} />
        {verdict && (
          <span
            className={cn(
              'ml-auto rounded px-1 py-px font-semibold',
              verdict === 'pass' ? 'text-semantic-success' : 'text-semantic-error',
            )}
          >
            {verdict.toUpperCase()}
          </span>
        )}
      </div>

      <span className="absolute -left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 rounded-full border-2 border-border-hi bg-surface" />
      <span
        data-port="pass"
        onPointerDown={(e) => onPortPointerDown(e, 'pass')}
        title="Pass branch — drag to the node that runs when the condition holds"
        style={{ top: h * PASS_PORT_Y }}
        className="absolute -right-1.5 h-3 w-3 -translate-y-1/2 cursor-crosshair rounded-full border-2 border-semantic-success bg-surface transition hover:scale-125 hover:bg-semantic-success/25"
      />
      <span
        data-port="fail"
        onPointerDown={(e) => onPortPointerDown(e, 'fail')}
        title="Fail branch — drag to the agent that should retry"
        style={{ top: h * FAIL_PORT_Y }}
        className="absolute -right-1.5 h-3 w-3 -translate-y-1/2 cursor-crosshair rounded-full border-2 border-semantic-error bg-surface transition hover:scale-125 hover:bg-semantic-error/25"
      />
    </div>
  );
}

/** A sticky. Never executed, may not carry edges — so it has no ports at all. */
function NoteCard({ node, selected, onPointerDown }: Props) {
  const { w, h } = nodeSize(node);
  return (
    <div
      data-node-id={node.id}
      onPointerDown={onPointerDown}
      style={{ left: node.x, top: node.y, width: w, minHeight: h }}
      className={cn(
        'absolute cursor-grab overflow-hidden rounded-md border border-semantic-warning/25 bg-semantic-warning/10 px-3 py-2.5 shadow-lg shadow-black/30 transition-colors active:cursor-grabbing',
        selected && 'border-accent shadow-[0_0_0_1px_var(--color-accent)]',
      )}
    >
      <p className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-semantic-warning">
        {node.noteText || 'Note'}
      </p>
    </div>
  );
}
