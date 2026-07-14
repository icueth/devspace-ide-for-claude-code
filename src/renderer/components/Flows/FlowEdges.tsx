import {
  edgeMid,
  edgePath,
  inPort,
  outPort,
} from '@renderer/components/Flows/flowGeometry';
import { cn } from '@renderer/lib/utils';
import type { FlowEdge, FlowGraph, FlowNodeStatus } from '@shared/flowTypes';

interface Props {
  graph: FlowGraph;
  statuses: Record<string, FlowNodeStatus>;
  /** The wire being dragged, in world coords. */
  wire: { from: string; branch?: FlowEdge['branch']; x: number; y: number } | null;
}

export function FlowEdges({ graph, statuses, wire }: Props) {
  return (
    <svg width={1} height={1} style={{ overflow: 'visible' }} aria-hidden>
      <defs>
        <Arrow id="fl-arr" fill="var(--color-border-hi)" />
        <Arrow id="fl-arr-run" fill="var(--color-accent)" />
        {/* semantic.* are literals in tailwind.config (no CSS var to reference). */}
        <Arrow id="fl-arr-fail" fill="#ef4444" />
        <Arrow id="fl-arr-pass" fill="#22c55e" />
      </defs>

      {graph.edges.map((edge) => {
        const a = graph.nodes.find((n) => n.id === edge.from);
        const b = graph.nodes.find((n) => n.id === edge.to);
        if (!a || !b) return null;

        const [x1, y1] = outPort(a, edge.branch);
        const [x2, y2] = inPort(b);
        const [mx, my] = edgeMid(x1, y1, x2, y2);

        // A fail edge is the retry loop — it stays red whether or not anything
        // has failed yet, because it describes the ROUTE, not the state.
        const isFail = edge.branch === 'fail';
        const isPass = edge.branch === 'pass';
        const failed = statuses[edge.from] === 'failed';
        const active = statuses[edge.to] === 'running';

        const marker = isFail
          ? 'fl-arr-fail'
          : failed
            ? 'fl-arr-fail'
            : active
              ? 'fl-arr-run'
              : isPass
                ? 'fl-arr-pass'
                : 'fl-arr';

        return (
          <g key={`${edge.from}-${edge.branch ?? 'x'}->${edge.to}`}>
            <path
              d={edgePath(x1, y1, x2, y2)}
              fill="none"
              strokeWidth={1.6}
              className={cn(
                isFail
                  ? 'stroke-semantic-error'
                  : failed
                    ? 'stroke-semantic-error'
                    : active
                      ? 'stroke-accent'
                      : isPass
                        ? 'stroke-semantic-success/70'
                        : 'stroke-border-hi',
              )}
              // Fail wires are dashed for good: a dashed line reads as
              // "conditional", and the retry arc must never be mistaken for a
              // normal handoff running underneath the row.
              strokeDasharray={isFail ? '5 4' : active ? '6 5' : undefined}
              markerEnd={`url(#${marker})`}
            />
            {edge.label && (
              <text
                x={mx}
                y={my - 6}
                textAnchor="middle"
                className={cn(
                  'font-mono text-[9.5px]',
                  isFail
                    ? 'fill-semantic-error'
                    : active
                      ? 'fill-accent'
                      : isPass
                        ? 'fill-semantic-success'
                        : 'fill-[var(--color-text-dim)]',
                )}
              >
                {edge.label}
              </text>
            )}
          </g>
        );
      })}

      {wire &&
        (() => {
          const from = graph.nodes.find((n) => n.id === wire.from);
          if (!from) return null;
          const [x1, y1] = outPort(from, wire.branch);
          return (
            <path
              d={edgePath(x1, y1, wire.x, wire.y)}
              fill="none"
              strokeWidth={1.6}
              strokeDasharray="5 5"
              className={cn(
                wire.branch === 'fail'
                  ? 'stroke-semantic-error'
                  : wire.branch === 'pass'
                    ? 'stroke-semantic-success'
                    : 'stroke-accent',
              )}
            />
          );
        })()}
    </svg>
  );
}

function Arrow({ id, fill }: { id: string; fill: string }) {
  return (
    <marker
      id={id}
      viewBox="0 0 8 8"
      refX="7"
      refY="4"
      markerWidth="7"
      markerHeight="7"
      orient="auto"
    >
      <path d="M0 0 L8 4 L0 8 z" fill={fill} />
    </marker>
  );
}
