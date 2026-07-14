// The gate retry loop, end to end through the real engine + the real scheduler,
// with every side effect (claude -p, PTYs, disk) mocked. This is the test that
// pins the phase-2 semantics: a FAIL re-queues the loop body AND the gate, and
// the run keeps going; a spent retry budget fails the run; an unparseable
// verdict fails the run rather than guessing a branch.

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import type { FlowGraph, FlowNode, FlowRun } from '@shared/flowTypes';

interface ExecRec {
  cwd: string;
  prompt: string;
  envPairs: string[];
  model?: string;
  killed: boolean;
  done: Promise<{ ok: boolean; text: string; error?: string }>;
  resolve: (r: { ok: boolean; text: string; error?: string }) => void;
}

const hoisted = vi.hoisted(() => ({
  execs: [] as ExecRec[],
  // What getSessionStats() reports — an interactive node is 'done' when its PTY
  // has been quiet for IDLE_DONE_MS *after* first speaking.
  stats: [] as Array<{ id: string; lastActivityAt: number }>,
}));

vi.mock('@main/services/flowExec', () => ({
  startClaudePrintIn: vi.fn(
    async (cwd: string, prompt: string, envPairs: string[] = [], model?: string) => {
      const rec = { cwd, prompt, envPairs, model, killed: false } as ExecRec;
      rec.done = new Promise((res) => {
        rec.resolve = res;
      });
      hoisted.execs.push(rec);
      return {
        done: rec.done,
        kill: () => {
          rec.killed = true;
        },
      };
    },
  ),
}));

vi.mock('@main/services/flowSessions', () => ({
  OUTPUT_CAP: 20_000,
  launchFlowSession: vi.fn(
    async (n: { id: string }, o: { runId: string }) => `p1:claude-cli:flow-${o.runId}-${n.id}`,
  ),
  killFlowSession: vi.fn(async () => undefined),
  // The agent speaks as soon as it boots — that is what arms the idle heuristic.
  captureFlowOutput: vi.fn(
    (_key: string, sink: { append: (t: string) => void; onFirstData: () => void }) => {
      sink.onFirstData();
      sink.append('interactive work done');
      return () => undefined;
    },
  ),
  sendToFlowSession: vi.fn(),
}));

vi.mock('@main/services/flowStore', () => ({
  loadFlows: vi.fn(async () => [graphRef.current]),
  saveFlow: vi.fn(async () => undefined),
  deleteFlow: vi.fn(async () => undefined),
  saveRun: vi.fn(async () => undefined),
  loadRecentRuns: vi.fn(async () => []),
}));

vi.mock('@main/services/PtyPool', () => ({ getSessionStats: vi.fn(() => hoisted.stats) }));
vi.mock('@main/services/ProjectScanner', () => ({ projectIdForPath: () => 'p1' }));
vi.mock('@main/services/ClaudeAuthService', () => ({
  resolveAuthEnvPairs: vi.fn(async () => ['ANTHROPIC_API_KEY=k']),
}));

import { killFlowSession, launchFlowSession, sendToFlowSession } from '../flowSessions';
import { createFlowService, type FlowService } from '../FlowService';

// The flow under test, swapped per-test (the flowStore mock reads it lazily).
const graphRef: { current: FlowGraph } = { current: null as unknown as FlowGraph };

const TICK_MS = 2_000;

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

// The mockup's pipeline: code → test → gate, gate loops back to code on FAIL and
// releases review on PASS.
const loopGraph = (gateOver: Partial<FlowNode> = {}): FlowGraph => ({
  id: 'f1',
  name: 'pipeline',
  description: 'feature work with a test gate',
  nodes: [
    node('code'),
    node('test'),
    node('g', { kind: 'gate', condition: 'the test output shows 0 failures', ...gateOver }),
    node('review'),
  ],
  edges: [
    { from: 'code', to: 'test' },
    { from: 'test', to: 'g' },
    { from: 'g', to: 'review', branch: 'pass' },
    { from: 'g', to: 'code', branch: 'fail' },
  ],
  createdAt: 0,
  updatedAt: 0,
});

let svc: FlowService;
let last: FlowRun;
// The engine's wall clock (deps.now). Interactive completion is a *duration*, so
// the tests move it by hand; the fake timers only drive the tick interval.
let clock: number;

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

/** One engine tick + a microtask drain, so launches settle before we assert. */
const tick = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(TICK_MS);
  await flush();
};

/** Answer the Nth claude -p (node or judge) and let the engine react. */
const answer = async (
  i: number,
  r: { ok: boolean; text: string; error?: string },
): Promise<void> => {
  hoisted.execs[i].resolve(r);
  await flush();
};

const start = async (g: FlowGraph): Promise<void> => {
  graphRef.current = g;
  const res = await svc.runFlow('/ws/p', g.name, 'add dark mode');
  expect(res).toMatchObject({ ok: true }); // an invalid graph reports why

  await flush(); // runFlow ticks immediately — let the entry node launch
};

const nodeOf = (id: string) => last.nodes.find((n) => n.nodeId === id);

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  hoisted.execs.length = 0;
  hoisted.stats.length = 0;
  clock = 1_000;
  svc = createFlowService({
    onRunChanged: (run) => {
      last = run;
    },
    now: () => clock,
    idgen: () => 'r1',
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('gate retry loop', () => {
  it('re-queues the loop body on FAIL and passes on the second attempt', async () => {
    await start(loopGraph({ maxRetries: 2 }));

    // attempt 1 — the body runs, the judge rejects it.
    expect(hoisted.execs).toHaveLength(1);
    await answer(0, { ok: true, text: 'wrote the feature' });
    await tick();
    await answer(1, { ok: true, text: '3 failures in theme.test.ts' });
    await tick();

    // exec 2 is the JUDGE: it gets the condition and the evidence, not a role brief.
    expect(hoisted.execs[2].prompt).toContain('the test output shows 0 failures');
    expect(hoisted.execs[2].prompt).toContain('3 failures in theme.test.ts');
    expect(hoisted.execs[2].prompt).toContain('PASS or FAIL');

    await answer(2, { ok: true, text: 'FAIL\nthe suite is red — fix theme.test.ts' });

    // The whole body went back to queued; so did the gate (or it could never be
    // re-evaluated — readyNodes only launches queued nodes). The run lives on.
    expect(last.status).toBe('running');
    expect(nodeOf('code')?.status).toBe('queued');
    expect(nodeOf('test')?.status).toBe('queued');
    expect(nodeOf('g')?.status).toBe('queued');
    expect(nodeOf('g')?.verdict).toBe('fail');
    // review is downstream of the gate's pass branch — never released, never reset.
    expect(nodeOf('review')?.status).toBe('queued');

    // attempt 2 — the retried coder is told WHY it is retrying (the gate is its
    // upstream along the fail edge, so its verdict text is handoff context).
    await tick();
    expect(hoisted.execs).toHaveLength(4);
    expect(hoisted.execs[3].prompt).toContain('fix theme.test.ts');
    expect(nodeOf('code')?.attempts).toBe(2);

    await answer(3, { ok: true, text: 'fixed the theme test' });
    await tick();
    await answer(4, { ok: true, text: '0 failures' });
    await tick();
    await answer(5, { ok: true, text: 'PASS\nsuite is green' });

    expect(nodeOf('g')?.verdict).toBe('pass');
    expect(nodeOf('g')?.status).toBe('done');
    expect(nodeOf('g')?.attempts).toBe(2); // two evaluations

    // Only now does the pass branch fire. review's ONLY upstream is the gate, so
    // its handoff context is the judge's verdict text — edges are the only
    // channel between nodes, and there is no transitive context.
    await tick();
    expect(hoisted.execs).toHaveLength(7);
    expect(hoisted.execs[6].prompt).toContain('suite is green');
    await answer(6, { ok: true, text: 'lgtm' });
    await tick();

    expect(last.status).toBe('done');
    expect(nodeOf('review')?.status).toBe('done');
  });

  it('fails the run when the retry budget is spent', async () => {
    await start(loopGraph({ maxRetries: 1 }));

    await answer(0, { ok: true, text: 'code v1' });
    await tick();
    await answer(1, { ok: true, text: 'still 3 failures' });
    await tick();
    await answer(2, { ok: true, text: 'FAIL\nstill red' }); // retry 1 of 1
    expect(last.status).toBe('running');

    await tick();
    await answer(3, { ok: true, text: 'code v2' });
    await tick();
    await answer(4, { ok: true, text: 'still 3 failures' });
    await tick();
    await answer(5, { ok: true, text: 'FAIL\nstill red' }); // budget spent

    expect(last.status).toBe('failed');
    expect(nodeOf('g')?.status).toBe('failed');
    expect(last.error).toMatch(/condition failed after 1 retry/);
    expect(last.error).toMatch(/still red/);
    // Everything that never got its turn is honestly skipped, not queued forever.
    expect(nodeOf('review')?.status).toBe('skipped');
  });

  it('defaults to 3 retries when the gate does not say', async () => {
    await start(loopGraph());

    // 4 evaluations = 1 + 3 retries. Drive the body → gate cycle four times.
    for (let i = 0; i < 4; i++) {
      const base = i * 3;
      await answer(base, { ok: true, text: 'code' });
      await tick();
      await answer(base + 1, { ok: true, text: 'red' });
      await tick();
      await answer(base + 2, { ok: true, text: 'FAIL\nnope' });
      if (i < 3) {
        expect(last.status).toBe('running');
        await tick();
      }
    }
    expect(last.status).toBe('failed');
    expect(last.error).toMatch(/after 3 retries/);
  });

  it('fails the gate (and the run) on an unparseable verdict — never guesses a branch', async () => {
    await start(loopGraph());

    await answer(0, { ok: true, text: 'code' });
    await tick();
    await answer(1, { ok: true, text: 'maybe green?' });
    await tick();
    await answer(2, { ok: true, text: 'It broadly looks fine to me.' });

    expect(last.status).toBe('failed');
    expect(last.error).toMatch(/did not answer PASS or FAIL/);
  });

  it('fails the run when the judge process itself fails', async () => {
    await start(loopGraph());

    await answer(0, { ok: true, text: 'code' });
    await tick();
    await answer(1, { ok: true, text: 'red' });
    await tick();
    await answer(2, { ok: false, text: '', error: 'claude not found on PATH' });

    expect(last.status).toBe('failed');
    expect(last.error).toMatch(/claude not found on PATH/);
  });

  it('fails a FAILing gate that has no fail branch to retry through', async () => {
    const g = loopGraph();
    g.edges = g.edges.filter((e) => e.branch !== 'fail');
    await start(g);

    await answer(0, { ok: true, text: 'code' });
    await tick();
    await answer(1, { ok: true, text: 'red' });
    await tick();
    await answer(2, { ok: true, text: 'FAIL\nthe suite is red' });

    expect(last.status).toBe('failed');
    expect(last.error).toMatch(/condition failed/);
    expect(last.error).toMatch(/the suite is red/);
  });
});

// An inner gate inside an OUTER gate's loop body: code → test → gi → review → go,
// where gi loops back to code on FAIL and so does go. Both fail targets reach
// their gate again (validateGraph requires it), so both are real retry loops.
const nestedGraph = (): FlowGraph => ({
  id: 'f2',
  name: 'nested',
  description: 'a gate inside another gate’s loop',
  nodes: [
    node('code'),
    node('test'),
    node('gi', { kind: 'gate', condition: 'the suite is green', maxRetries: 1 }),
    node('review'),
    node('go', { kind: 'gate', condition: 'the review is clean', maxRetries: 3 }),
    node('ship'),
  ],
  edges: [
    { from: 'code', to: 'test' },
    { from: 'test', to: 'gi' },
    { from: 'gi', to: 'review', branch: 'pass' },
    { from: 'gi', to: 'code', branch: 'fail' },
    { from: 'review', to: 'go' },
    { from: 'go', to: 'ship', branch: 'pass' },
    { from: 'go', to: 'code', branch: 'fail' },
  ],
  createdAt: 0,
  updatedAt: 0,
});

describe('retry budget — a gate spends its OWN rejections', () => {
  it('gives an inner gate its full budget however often an outer loop re-ran it', async () => {
    await start(nestedGraph());

    // Two outer iterations. The inner gate PASSES both times — it has rejected
    // nothing, so it has spent nothing. Its *launch* count climbs all the same.
    for (let i = 0; i < 2; i++) {
      const b = i * 5;
      await answer(b, { ok: true, text: 'code' });
      await tick();
      await answer(b + 1, { ok: true, text: 'suite green' });
      await tick();
      await answer(b + 2, { ok: true, text: 'PASS' }); // inner gate
      await tick();
      await answer(b + 3, { ok: true, text: 'reviewed' });
      await tick();
      await answer(b + 4, { ok: true, text: 'FAIL\nthe review found a leak' }); // outer
      await tick();
    }

    // Third pass through the body — and NOW the inner gate rejects, for the
    // first time in the run.
    await answer(10, { ok: true, text: 'code' });
    await tick();
    await answer(11, { ok: true, text: 'still 3 failures' });
    await tick();
    expect(nodeOf('gi')?.attempts).toBe(3); // three launches …
    await answer(12, { ok: true, text: 'FAIL\nthe suite is red' }); // … one rejection

    // Reading the budget off `attempts` (the phase-2 bug) makes this its THIRD
    // strike against a budget of 1, and the run dies here having never once let
    // the inner gate retry.
    expect(last.status).toBe('running');
    expect(nodeOf('gi')?.status).toBe('queued');
    expect(nodeOf('code')?.status).toBe('queued');

    // Its budget is 1, so the SECOND rejection is the one that ends the run.
    await tick();
    await answer(13, { ok: true, text: 'code' });
    await tick();
    await answer(14, { ok: true, text: 'still 3 failures' });
    await tick();
    await answer(15, { ok: true, text: 'FAIL\nstill red' });

    expect(last.status).toBe('failed');
    expect(last.error).toMatch(/condition failed after 1 retry/);
  });
});

describe('interactive nodes — retry', () => {
  it('relaunches into a FRESH session and never types the brief into a live TUI', async () => {
    const g = loopGraph({ maxRetries: 2 });
    g.nodes[0] = node('code', { mode: 'interactive' });
    await start(g);

    const key = 'p1:claude-cli:flow-r1-code';
    hoisted.stats.push({ id: key, lastActivityAt: clock }); // the PTY is alive
    expect(vi.mocked(launchFlowSession)).toHaveBeenCalledTimes(1);
    expect(nodeOf('code')?.sessionKey).toBe(key);

    // The agent goes quiet → the idle heuristic calls it done, the tester runs,
    // and the gate rejects the work.
    clock += 30_000;
    await tick();
    expect(nodeOf('code')?.status).toBe('done');

    await answer(0, { ok: true, text: 'red: 3 failures' }); // tester
    await tick();
    await answer(1, { ok: true, text: 'FAIL\nfix theme.test.ts' }); // gate
    expect(nodeOf('code')?.status).toBe('queued');

    await tick(); // …the retry launch

    // The old session is killed FIRST, so the relaunch is a plain first launch:
    // claude takes the brief as its argument. Typing a multi-line brief into the
    // live TUI (the phase-2 path) submits it one fragment per newline.
    expect(vi.mocked(killFlowSession)).toHaveBeenCalledWith('p1', 'claude', 'r1', 'code');
    expect(vi.mocked(sendToFlowSession)).not.toHaveBeenCalled();
    expect(vi.mocked(launchFlowSession)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(killFlowSession).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(launchFlowSession).mock.invocationCallOrder[1],
    );

    // …and the fresh session is briefed with WHY it is retrying.
    const opts = vi.mocked(launchFlowSession).mock.calls[1][1];
    expect(opts.prompt).toContain('fix theme.test.ts');
    expect(nodeOf('code')?.attempts).toBe(2);
  });

  it('takes no kill path on a FIRST launch', async () => {
    const g = loopGraph();
    g.nodes[0] = node('code', { mode: 'interactive' });
    await start(g);

    expect(vi.mocked(launchFlowSession)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(killFlowSession)).not.toHaveBeenCalled();
  });
});

describe('per-node model + notes', () => {
  it('passes each node its own --model, judge included', async () => {
    const g = loopGraph({ model: 'opus-4.8' });
    g.nodes[0].model = 'haiku-4.5'; // code
    await start(g);

    expect(hoisted.execs[0].model).toBe('haiku-4.5');
    await answer(0, { ok: true, text: 'code' });
    await tick();
    expect(hoisted.execs[1].model).toBeUndefined(); // test — the CLI default
    await answer(1, { ok: true, text: 'green' });
    await tick();
    expect(hoisted.execs[2].model).toBe('opus-4.8'); // the gate's judge
  });

  it('gives a note no journal entry and never runs it', async () => {
    const g = loopGraph();
    g.nodes.push(node('n', { kind: 'note', noteText: 'remember the RTL case' }));
    await start(g);

    expect(last.nodes.map((n) => n.nodeId)).toEqual(['code', 'test', 'g', 'review']);

    // …and the run can still reach 'done' — a note left as a queued journal
    // entry would hold the run open forever.
    await answer(0, { ok: true, text: 'code' });
    await tick();
    await answer(1, { ok: true, text: 'green' });
    await tick();
    await answer(2, { ok: true, text: 'PASS' });
    await tick();
    await answer(3, { ok: true, text: 'lgtm' });
    await tick();
    expect(last.status).toBe('done');
  });
});
