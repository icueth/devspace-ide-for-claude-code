import { describe, expect, it } from 'vitest';

import {
  composeNodePrompt,
  finishStatuses,
  readyNodes,
  upstreamOf,
  validateGraph,
  type StatusById,
} from '../flowScheduler';
import type { FlowEdge, FlowGraph, FlowNode } from '@shared/flowTypes';

const node = (id: string, over: Partial<FlowNode> = {}): FlowNode => ({
  id,
  role: id,
  rolePrompt: `do ${id}`,
  cliId: 'claude',
  mode: 'headless',
  x: 0,
  y: 0,
  ...over,
});

const graph = (nodes: FlowNode[], edges: FlowEdge[] = []): FlowGraph => ({
  id: 'f1',
  name: 'pipeline',
  description: 'test flow',
  nodes,
  edges,
  createdAt: 0,
  updatedAt: 0,
});

const statuses = (g: FlowGraph, over: StatusById = {}): StatusById => ({
  ...Object.fromEntries(g.nodes.map((n) => [n.id, 'queued' as const])),
  ...over,
});

describe('validateGraph', () => {
  it('accepts a linear DAG', () => {
    const g = graph([node('a'), node('b')], [{ from: 'a', to: 'b' }]);
    expect(validateGraph(g)).toEqual([]);
  });

  it('rejects an empty graph', () => {
    expect(validateGraph(graph([]))).toEqual(['flow has no nodes']);
  });

  it('rejects duplicate node ids', () => {
    const g = graph([node('a'), node('a')]);
    expect(validateGraph(g)).toContain('duplicate node id: a');
  });

  it('rejects a dangling edge (both directions)', () => {
    const g = graph([node('a')], [{ from: 'a', to: 'ghost' }, { from: 'ghost', to: 'a' }]);
    const errs = validateGraph(g);
    expect(errs).toContain('edge to unknown node: ghost');
    expect(errs).toContain('edge from unknown node: ghost');
  });

  it('reports a dangling edge as dangling, not as a phantom cycle', () => {
    const g = graph([node('a')], [{ from: 'ghost', to: 'a' }]);
    expect(validateGraph(g).some((e) => e.includes('cycle'))).toBe(false);
  });

  it('rejects a cycle', () => {
    const g = graph(
      [node('a'), node('b'), node('c')],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'a' },
      ],
    );
    expect(validateGraph(g)).toContain('flow has a cycle — edges must form a DAG');
  });

  it('rejects a self-edge as a cycle', () => {
    const g = graph([node('a')], [{ from: 'a', to: 'a' }]);
    expect(validateGraph(g)).toContain('flow has a cycle — edges must form a DAG');
  });

  it('rejects a headless node on a non-claude CLI', () => {
    const g = graph([node('a', { cliId: 'codex', mode: 'headless' })]);
    expect(validateGraph(g)[0]).toMatch(/headless.*must use claude/);
  });

  it('allows a non-claude node when it is interactive', () => {
    const g = graph([node('a', { cliId: 'codex', mode: 'interactive' })]);
    expect(validateGraph(g)).toEqual([]);
  });
});

describe('readyNodes', () => {
  const g = graph(
    [node('a'), node('b'), node('c'), node('d')],
    [
      { from: 'a', to: 'c' },
      { from: 'b', to: 'c' }, // fan-in: c waits for BOTH a and b
      { from: 'c', to: 'd' },
    ],
  );

  it('starts with every entry node (fan-out runs in parallel)', () => {
    expect(readyNodes(g, statuses(g)).sort()).toEqual(['a', 'b']);
  });

  it('holds a fan-in node until every upstream is done', () => {
    const s = statuses(g, { a: 'done', b: 'running' });
    expect(readyNodes(g, s)).toEqual([]);
  });

  it('releases the fan-in node once all upstream are done', () => {
    const s = statuses(g, { a: 'done', b: 'done' });
    expect(readyNodes(g, s)).toEqual(['c']);
  });

  it('never re-launches a node that is already running or done', () => {
    const s = statuses(g, { a: 'done', b: 'done', c: 'running' });
    expect(readyNodes(g, s)).toEqual([]);
  });

  it('does not release a node whose upstream failed', () => {
    const s = statuses(g, { a: 'failed', b: 'done' });
    expect(readyNodes(g, s)).toEqual([]);
  });

  it('progresses to the tail node', () => {
    const s = statuses(g, { a: 'done', b: 'done', c: 'done' });
    expect(readyNodes(g, s)).toEqual(['d']);
  });

  it('upstreamOf lists the direct parents', () => {
    expect(upstreamOf(g, 'c').sort()).toEqual(['a', 'b']);
    expect(upstreamOf(g, 'a')).toEqual([]);
  });
});

describe('finishStatuses', () => {
  const g = graph(
    [node('a'), node('b'), node('c')],
    [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ],
  );

  it('marks every unreached (still-queued) node skipped after a failure', () => {
    const s = statuses(g, { a: 'done', b: 'failed' });
    expect(finishStatuses(g, s)).toEqual({ a: 'done', b: 'failed', c: 'skipped' });
  });

  it('leaves terminal and running statuses untouched', () => {
    const s = statuses(g, { a: 'done', b: 'running', c: 'queued' });
    expect(finishStatuses(g, s)).toEqual({ a: 'done', b: 'running', c: 'skipped' });
  });

  it('is pure — the input map is not mutated', () => {
    const s = statuses(g, { a: 'failed' });
    finishStatuses(g, s);
    expect(s.c).toBe('queued');
  });
});

describe('composeNodePrompt', () => {
  const n = node('impl', { role: 'coder', rolePrompt: 'Write the code.' });

  it('grounds the agent in the task and its role', () => {
    const p = composeNodePrompt('Add dark mode', n, []);
    expect(p).toContain('"coder"');
    expect(p).toContain('Add dark mode');
    expect(p).toContain('Write the code.');
  });

  it('includes each upstream output as handoff context', () => {
    const p = composeNodePrompt('Add dark mode', n, [
      { role: 'researcher', output: 'The theme lives in tokens.css' },
    ]);
    expect(p).toContain('Handoff from upstream steps');
    expect(p).toContain('### researcher');
    expect(p).toContain('The theme lives in tokens.css');
  });

  it('omits the handoff section entirely when no upstream produced output', () => {
    const p = composeNodePrompt('Add dark mode', n, [{ role: 'researcher', output: '  ' }]);
    expect(p).not.toContain('Handoff from upstream steps');
  });

  it('tells the node its summary is what the next node receives', () => {
    expect(composeNodePrompt('t', n, [])).toContain('summary');
  });
});
