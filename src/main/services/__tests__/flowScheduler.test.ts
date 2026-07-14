import { describe, expect, it } from 'vitest';

import {
  composeGatePrompt,
  composeNodePrompt,
  finishStatuses,
  parseGateVerdict,
  readyNodes,
  resetForRetry,
  retryTargets,
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

// ── phase 2: gates, notes, retry loops ──────────────────────────────────────

const gate = (id: string, over: Partial<FlowNode> = {}): FlowNode =>
  node(id, { kind: 'gate', condition: 'tests pass', ...over });

const note = (id: string, over: Partial<FlowNode> = {}): FlowNode =>
  node(id, { kind: 'note', noteText: 'remember', ...over });

// The mockup's pipeline: coder → tester → gate; the gate loops back to the coder
// on FAIL and releases the reviewer on PASS.
const loop = (over: Partial<FlowNode> = {}): FlowGraph =>
  graph(
    [node('code'), node('test'), gate('g', over), node('review')],
    [
      { from: 'code', to: 'test' },
      { from: 'test', to: 'g' },
      { from: 'g', to: 'review', branch: 'pass' },
      { from: 'g', to: 'code', branch: 'fail' },
    ],
  );

describe('validateGraph — gates and notes', () => {
  it('accepts a backward fail edge — that IS the retry loop, not a cycle', () => {
    expect(validateGraph(loop())).toEqual([]);
  });

  it('still rejects a cycle made of non-fail edges', () => {
    const g = graph(
      [node('a'), gate('b'), node('c')],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c', branch: 'pass' },
        { from: 'c', to: 'a' }, // an ordinary backward edge — still illegal
      ],
    );
    expect(validateGraph(g)).toContain('flow has a cycle — edges must form a DAG');
  });

  it('rejects a gate with no condition', () => {
    const g = loop({ condition: '  ' });
    expect(validateGraph(g).some((e) => /has no condition/.test(e))).toBe(true);
  });

  it('exempts gates and notes from the headless⇒claude rule (they have no agent)', () => {
    const g = graph([
      gate('g', { cliId: 'codex', mode: 'headless' }),
      note('n', { cliId: 'codex', mode: 'headless' }),
    ]);
    expect(validateGraph(g)).toEqual([]);
  });

  it('rejects a branch on an edge that does not leave a gate', () => {
    const g = graph([node('a'), node('b')], [{ from: 'a', to: 'b', branch: 'pass' }]);
    expect(validateGraph(g).some((e) => /is not a gate/.test(e))).toBe(true);
  });

  it('rejects a fail edge that targets a non-agent node', () => {
    const g = graph(
      [node('a'), gate('g'), gate('g2')],
      [
        { from: 'a', to: 'g' },
        { from: 'g', to: 'g2', branch: 'fail' },
      ],
    );
    expect(validateGraph(g).some((e) => /must target an agent node/.test(e))).toBe(true);
  });

  it('rejects any edge touching a note, in either direction', () => {
    const g = graph([node('a'), note('n')], [{ from: 'a', to: 'n' }]);
    expect(validateGraph(g).some((e) => /may not carry edges/.test(e))).toBe(true);
    const g2 = graph([node('a'), note('n')], [{ from: 'n', to: 'a' }]);
    expect(validateGraph(g2).some((e) => /may not carry edges/.test(e))).toBe(true);
  });

  it('accepts a note that just sits on the canvas', () => {
    expect(validateGraph(graph([node('a'), note('n')]))).toEqual([]);
  });
});

describe('readyNodes — gate verdicts', () => {
  const g = loop();

  it('does not let a fail edge gate its target (the loop body starts normally)', () => {
    // `code` is the fail-edge target of a gate that has not run. If the fail
    // edge counted as a dependency, nothing could ever start.
    expect(readyNodes(g, statuses(g))).toEqual(['code']);
  });

  it('holds the pass branch while the gate is merely done-with-no-verdict', () => {
    const s = statuses(g, { code: 'done', test: 'done', g: 'done' });
    expect(readyNodes(g, s, {})).toEqual([]);
  });

  it('holds the pass branch on a FAIL verdict', () => {
    const s = statuses(g, { code: 'done', test: 'done', g: 'done' });
    expect(readyNodes(g, s, { g: 'fail' })).toEqual([]);
  });

  it('releases the pass branch only on a PASS verdict', () => {
    const s = statuses(g, { code: 'done', test: 'done', g: 'done' });
    expect(readyNodes(g, s, { g: 'pass' })).toEqual(['review']);
  });

  it('re-launches the re-queued body after a retry reset (gate re-queued too)', () => {
    const s = statuses(g, { code: 'queued', test: 'queued', g: 'queued' });
    expect(readyNodes(g, s, { g: 'fail' })).toEqual(['code']);
  });

  it('never schedules a note', () => {
    const g2 = graph([node('a'), note('n')]);
    expect(readyNodes(g2, statuses(g2))).toEqual(['a']);
  });
});

describe('retryTargets / resetForRetry', () => {
  const g = loop();

  it('lists the fail-edge targets', () => {
    expect(retryTargets(g, 'g')).toEqual(['code']);
    expect(retryTargets(g, 'code')).toEqual([]);
  });

  it('re-queues the whole loop body (BFS from the fail target)', () => {
    const s = statuses(g, { code: 'done', test: 'done', g: 'running' });
    expect(resetForRetry(g, 'g', s)).toEqual({
      code: 'queued',
      test: 'queued',
      g: 'running', // the gate is the caller's business, never the BFS's
      review: 'queued',
    });
  });

  it('re-queues a failed node too — a retry is exactly what it needs', () => {
    const s = statuses(g, { code: 'done', test: 'failed', g: 'running' });
    expect(resetForRetry(g, 'g', s).test).toBe('queued');
  });

  it('leaves a still-running sibling alone', () => {
    const fan = graph(
      [node('a'), node('b'), gate('g')],
      [
        { from: 'a', to: 'g' },
        { from: 'b', to: 'g' },
        { from: 'g', to: 'a', branch: 'fail' },
        { from: 'g', to: 'b', branch: 'fail' },
      ],
    );
    const s = statuses(fan, { a: 'done', b: 'running', g: 'running' });
    const out = resetForRetry(fan, 'g', s);
    expect(out.a).toBe('queued');
    expect(out.b).toBe('running');
  });

  it('never crosses the gate — the pass branch downstream is untouched', () => {
    const g2 = graph(
      [node('code'), gate('g'), node('ship')],
      [
        { from: 'code', to: 'g' },
        { from: 'g', to: 'ship', branch: 'pass' },
        { from: 'g', to: 'code', branch: 'fail' },
      ],
    );
    const s = statuses(g2, { code: 'done', g: 'running', ship: 'done' });
    // `ship` is only reachable from `code` THROUGH the gate, so it must not be
    // dragged back into the loop.
    expect(resetForRetry(g2, 'g', s).ship).toBe('done');
  });

  it('is pure — the input map is not mutated', () => {
    const s = statuses(g, { code: 'done', test: 'done' });
    resetForRetry(g, 'g', s);
    expect(s.code).toBe('done');
  });
});

describe('parseGateVerdict', () => {
  it('reads a bare verdict', () => {
    expect(parseGateVerdict('PASS')).toBe('pass');
    expect(parseGateVerdict('FAIL')).toBe('fail');
  });

  it('reads the verdict from the FIRST non-empty line, ignoring the reasoning', () => {
    expect(parseGateVerdict('\n\nFAIL\nthe suite still has 3 failures — PASS later')).toBe('fail');
  });

  it('takes the first token when the line says both', () => {
    expect(parseGateVerdict('PASS — it did not FAIL any test')).toBe('pass');
  });

  it('is case-insensitive and tolerates punctuation', () => {
    expect(parseGateVerdict('Pass: everything green')).toBe('pass');
    expect(parseGateVerdict('**fail**')).toBe('fail');
  });

  it('does not match a verdict word embedded in another word', () => {
    expect(parseGateVerdict('PASSPORT checks out')).toBeNull();
  });

  it('returns null for anything unparseable — the caller fails the gate', () => {
    expect(parseGateVerdict('')).toBeNull();
    expect(parseGateVerdict('I think it looks fine\nPASS')).toBeNull();
  });
});

describe('composeGatePrompt', () => {
  it('demands a machine-readable first-line verdict', () => {
    const p = composeGatePrompt('tests pass', [{ role: 'tester', output: '3 failures' }]);
    expect(p).toContain('PASS or FAIL');
    expect(p).toContain('FIRST line');
  });

  it('hands the judge the condition and the evidence', () => {
    const p = composeGatePrompt('tests pass', [{ role: 'tester', output: '3 failures' }]);
    expect(p).toContain('tests pass');
    expect(p).toContain('### tester');
    expect(p).toContain('3 failures');
  });

  it('defaults to FAIL when the evidence is unclear (says so explicitly)', () => {
    expect(composeGatePrompt('x', [])).toMatch(/unclear.*answer FAIL/is);
  });

  it('says the FAIL reasoning is handed to the retrying agents', () => {
    expect(composeGatePrompt('x', [])).toMatch(/retry/i);
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
