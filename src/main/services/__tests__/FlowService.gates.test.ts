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

const hoisted = vi.hoisted(() => ({ execs: [] as ExecRec[] }));

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
  launchFlowSession: vi.fn(async () => 'p1:claude-cli:flow-r1-x'),
  killFlowSession: vi.fn(async () => undefined),
  captureFlowOutput: vi.fn(() => () => undefined),
  sendToFlowSession: vi.fn(),
}));

vi.mock('@main/services/flowStore', () => ({
  loadFlows: vi.fn(async () => [graphRef.current]),
  saveFlow: vi.fn(async () => undefined),
  deleteFlow: vi.fn(async () => undefined),
  saveRun: vi.fn(async () => undefined),
  loadRecentRuns: vi.fn(async () => []),
}));

vi.mock('@main/services/PtyPool', () => ({ getSessionStats: vi.fn(() => []) }));
vi.mock('@main/services/ProjectScanner', () => ({ projectIdForPath: () => 'p1' }));
vi.mock('@main/services/ClaudeAuthService', () => ({
  resolveAuthEnvPairs: vi.fn(async () => ['ANTHROPIC_API_KEY=k']),
}));

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
  const res = await svc.runFlow('/ws/p', 'pipeline', 'add dark mode');
  expect(res.ok).toBe(true);
  await flush(); // runFlow ticks immediately — let the entry node launch
};

const nodeOf = (id: string) => last.nodes.find((n) => n.nodeId === id);

beforeEach(() => {
  vi.useFakeTimers();
  hoisted.execs.length = 0;
  svc = createFlowService({
    onRunChanged: (run) => {
      last = run;
    },
    now: () => 1_000,
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
