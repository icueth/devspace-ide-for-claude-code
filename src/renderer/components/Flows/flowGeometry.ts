import type { FlowEdge, FlowNode, FlowNodeKind } from '@shared/flowTypes';

/**
 * Fixed card geometry + edge maths for the flow canvas.
 *
 * Every anchor is derived from the node's kind and world position — NEVER from
 * a DOM measurement. The SVG edges and the node transforms are committed in the
 * same React pass, so a measure-then-draw round trip would lag the wires one
 * frame behind the cards during a drag.
 */

// agent (the phase-1 card) — kept at its original size so existing graphs keep
// the exact layout they were designed with.
export const NODE_W = 208;
export const NODE_H = 78;
// gate — narrower, taller than an agent: it carries a condition line and two
// stacked out-ports instead of a body.
export const GATE_W = 172;
export const GATE_H = 88;
// note — a sticky. No ports, never executed.
export const NOTE_W = 180;
export const NOTE_H = 76;

/** undefined kind = 'agent' (phase-1 files predate `kind`). */
export function nodeKind(node: Pick<FlowNode, 'kind'>): FlowNodeKind {
  return node.kind ?? 'agent';
}

export function nodeSize(node: Pick<FlowNode, 'kind'>): { w: number; h: number } {
  switch (nodeKind(node)) {
    case 'gate':
      return { w: GATE_W, h: GATE_H };
    case 'note':
      return { w: NOTE_W, h: NOTE_H };
    default:
      return { w: NODE_W, h: NODE_H };
  }
}

// Gate out-ports sit at 32% / 68% of the card height — the mockup's split, far
// enough apart that a pass and a fail wire never overlap at the source.
export const PASS_PORT_Y = 0.32;
export const FAIL_PORT_Y = 0.68;

type Positioned = Pick<FlowNode, 'kind' | 'x' | 'y'>;

/** Where an edge LEAVES a node. Gates have two out-ports; branch picks one. */
export function outPort(node: Positioned, branch?: FlowEdge['branch']): [number, number] {
  const { w, h } = nodeSize(node);
  if (nodeKind(node) === 'gate') {
    const t = branch === 'fail' ? FAIL_PORT_Y : PASS_PORT_Y;
    return [node.x + w, node.y + h * t];
  }
  return [node.x + w, node.y + h / 2];
}

/** Where an edge ENTERS a node. Always the left-middle. */
export function inPort(node: Positioned): [number, number] {
  const { h } = nodeSize(node);
  return [node.x, node.y + h / 2];
}

// A fail edge that points back up the row (gate → an earlier agent) IS the
// retry loop. Routed straight, it would run underneath the very nodes it
// re-queues — so it dips below the row instead, exactly like the mockup.
const BACKWARD_X_SLACK = 40;
const SAME_ROW_SLACK = 110;
const DIP = 130;

export function isBackward(x1: number, y1: number, x2: number, y2: number): boolean {
  return x2 < x1 - BACKWARD_X_SLACK && Math.abs(y2 - y1) < SAME_ROW_SLACK;
}

/** The SVG `d` for an edge: a forward bezier, or a dipping arc when backward. */
export function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  if (isBackward(x1, y1, x2, y2)) {
    const dip = Math.max(y1, y2) + DIP;
    const mx = (x1 + x2) / 2;
    return `M${x1} ${y1} C${x1 + 90} ${y1 + 10}, ${x1 + 70} ${dip}, ${mx} ${dip} S${x2 - 90} ${y2 + 10}, ${x2} ${y2}`;
  }
  const dx = Math.max(70, Math.abs(x2 - x1) * 0.45);
  return `M${x1} ${y1} C${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

/** Where to hang the edge label. Analytic — no getPointAtLength (no DOM). */
export function edgeMid(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): [number, number] {
  if (isBackward(x1, y1, x2, y2)) {
    // The arc is two cubic segments joined at (mid-x, dip) — that joint IS the
    // path's midpoint.
    return [(x1 + x2) / 2, Math.max(y1, y2) + DIP];
  }
  // Cubic-bezier midpoint: B(0.5) = (P0 + 3·P1 + 3·P2 + P3) / 8.
  const dx = Math.max(70, Math.abs(x2 - x1) * 0.45);
  const mx = (x1 + 3 * (x1 + dx) + 3 * (x2 - dx) + x2) / 8;
  const my = (y1 + 3 * y1 + 3 * y2 + y2) / 8;
  return [mx, my];
}

/** Default label for a new edge — the branch reads on the wire, not the port. */
export function edgeLabelFor(branch?: FlowEdge['branch']): string {
  if (branch === 'pass') return 'pass ✓';
  if (branch === 'fail') return 'fail ✗ retry';
  return 'handoff';
}

/** Bounding box of the graph in world coords — feeds "fit view". */
export function graphBounds(
  nodes: Positioned[],
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (nodes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    const { w, h } = nodeSize(n);
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + w);
    maxY = Math.max(maxY, n.y + h);
  }
  return { minX, minY, maxX, maxY };
}
