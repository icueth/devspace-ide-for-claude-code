import { describe, expect, it } from 'vitest';

import type { FlowNode } from '@shared/flowTypes';

import {
  FAIL_PORT_Y,
  GATE_H,
  GATE_W,
  NODE_H,
  NODE_W,
  NOTE_W,
  PASS_PORT_Y,
  edgeLabelFor,
  edgeMid,
  edgePath,
  graphBounds,
  inPort,
  isBackward,
  nodeKind,
  nodeSize,
  outPort,
} from '../flowGeometry';

const at = (x: number, y: number, kind?: FlowNode['kind']) => ({ x, y, kind });

describe('nodeKind / nodeSize', () => {
  it('treats a kind-less node as an agent — phase-1 files predate the field', () => {
    expect(nodeKind({ kind: undefined })).toBe('agent');
    expect(nodeSize({ kind: undefined })).toEqual({ w: NODE_W, h: NODE_H });
  });

  it('sizes each kind distinctly so edge anchors need no DOM measurement', () => {
    expect(nodeSize({ kind: 'gate' })).toEqual({ w: GATE_W, h: GATE_H });
    expect(nodeSize({ kind: 'note' }).w).toBe(NOTE_W);
    expect(GATE_W).not.toBe(NODE_W);
  });
});

describe('ports', () => {
  it('anchors an agent edge at the middle of its right/left edge', () => {
    expect(outPort(at(100, 200))).toEqual([100 + NODE_W, 200 + NODE_H / 2]);
    expect(inPort(at(100, 200))).toEqual([100, 200 + NODE_H / 2]);
  });

  it('splits a gate into stacked pass/fail out-ports', () => {
    const gate = at(0, 0, 'gate');
    const [px, py] = outPort(gate, 'pass');
    const [fx, fy] = outPort(gate, 'fail');

    expect(px).toBe(GATE_W);
    expect(fx).toBe(GATE_W);
    expect(py).toBe(GATE_H * PASS_PORT_Y);
    expect(fy).toBe(GATE_H * FAIL_PORT_Y);
    // The whole point: a pass and a fail wire must not leave from the same spot.
    expect(fy).toBeGreaterThan(py);
  });

  it('defaults a gate edge with no branch to the pass port', () => {
    const gate = at(0, 0, 'gate');
    expect(outPort(gate)).toEqual(outPort(gate, 'pass'));
  });

  it('ignores branch on a non-gate — only a gate has two out-ports', () => {
    expect(outPort(at(0, 0), 'fail')).toEqual(outPort(at(0, 0)));
  });
});

describe('edge routing', () => {
  it('routes a forward edge as a plain bezier', () => {
    const d = edgePath(0, 0, 400, 0);
    expect(d.startsWith('M0 0 C')).toBe(true);
    expect(d).not.toContain('S'); // no second segment = no dip
  });

  it('arcs a backward same-row edge BELOW the row (the gate retry loop)', () => {
    // A gate at x=1000 pointing back at a coder at x=200, same row.
    expect(isBackward(1000, 200, 200, 200)).toBe(true);

    const d = edgePath(1000, 200, 200, 200);
    expect(d).toContain('S'); // the dipping two-segment arc

    const [, my] = edgeMid(1000, 200, 200, 200);
    // The label (and the arc's waist) hangs below both endpoints, so the wire
    // cannot run underneath the very nodes it re-queues.
    expect(my).toBeGreaterThan(200);
  });

  it('does not arc an edge that merely points slightly left', () => {
    expect(isBackward(100, 0, 80, 0)).toBe(false); // within the x slack
  });

  it('does not arc a backward edge that is far off-row (it can route around)', () => {
    expect(isBackward(1000, 0, 200, 400)).toBe(false);
  });

  it('puts the forward midpoint between the endpoints', () => {
    const [mx, my] = edgeMid(0, 100, 400, 100);
    expect(mx).toBeGreaterThan(0);
    expect(mx).toBeLessThan(400);
    expect(my).toBe(100);
  });
});

describe('edgeLabelFor', () => {
  it('labels branches so the wire reads without selecting it', () => {
    expect(edgeLabelFor('pass')).toBe('pass ✓');
    expect(edgeLabelFor('fail')).toBe('fail ✗ retry');
    expect(edgeLabelFor()).toBe('handoff');
  });
});

describe('graphBounds', () => {
  it('spans every node, respecting per-kind sizes', () => {
    const b = graphBounds([at(0, 0), at(500, 300, 'gate')])!;
    expect(b).toEqual({ minX: 0, minY: 0, maxX: 500 + GATE_W, maxY: 300 + GATE_H });
  });

  it('returns null for an empty graph — nothing to fit', () => {
    expect(graphBounds([])).toBeNull();
  });
});
