import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FlowGraph, FlowNodeRun, FlowRun } from '@shared/flowTypes';

// flowEvents subscribes to the flows store, which reaches for the bridge.
vi.mock('@renderer/lib/api', () => ({
  api: {
    flows: {
      list: vi.fn(async () => []),
      runs: vi.fn(async () => []),
      save: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      onChanged: vi.fn(() => () => undefined),
      chat: { onChanged: vi.fn(() => () => undefined) },
    },
  },
}));

const { approxTokens, diffRun, eventsForRun, labelsFor, useFlowEventsStore } =
  await import('../flowEvents');

const NOW = 5_000;

const flow: FlowGraph = {
  id: 'f1',
  name: 'feature-pipeline',
  description: '',
  nodes: [
    { id: 'coder', role: 'coder', rolePrompt: '', cliId: 'claude', mode: 'headless', x: 0, y: 0 },
    { id: 'tester', role: 'tester', rolePrompt: '', cliId: 'claude', mode: 'headless', x: 0, y: 0 },
    {
      id: 'gate',
      kind: 'gate',
      role: 'tests pass?',
      rolePrompt: '',
      cliId: 'claude',
      mode: 'headless',
      condition: 'suite is green',
      x: 0,
      y: 0,
    },
  ],
  edges: [],
  createdAt: 1,
  updatedAt: 1,
};

const labels = labelsFor([flow]);

const run = (nodes: FlowNodeRun[], over: Partial<FlowRun> = {}): FlowRun => ({
  id: 'r1',
  flowId: 'f1',
  flowName: 'feature-pipeline',
  projectPath: '/p',
  projectId: 'p1',
  task: 'add CSV export',
  status: 'running',
  nodes,
  startedAt: 100,
  ...over,
});

beforeEach(() => {
  useFlowEventsStore.getState().reset(null);
});

describe('diffRun — first snapshot', () => {
  it('opens the timeline with a run-started event stamped at startedAt', () => {
    const evts = diffRun(undefined, run([{ nodeId: 'coder', status: 'queued' }]), labels, NOW);

    expect(evts).toHaveLength(1);
    expect(evts[0]).toMatchObject({ kind: 'run-started', at: 100 });
    expect(evts[0]!.text).toContain('feature-pipeline');
  });
});

describe('diffRun — node transitions', () => {
  it('emits node-started → node-done with ≈tokens from the captured output', () => {
    const before = run([{ nodeId: 'coder', status: 'queued' }]);
    const started = run([{ nodeId: 'coder', status: 'running', startedAt: 200 }]);
    const done = run([
      { nodeId: 'coder', status: 'done', startedAt: 200, endedAt: 300, output: 'x'.repeat(400) },
    ]);

    const a = diffRun(before, started, labels, NOW);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: 'node-started', at: 200, nodeId: 'coder' });
    expect(a[0]!.text).toContain('coder');

    const b = diffRun(started, done, labels, NOW);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ kind: 'node-done', at: 300, nodeId: 'coder', tokens: 100 });
    expect(b[0]!.text).toBe('coder ✓ done');
  });

  it('uses the graph role for the label, falling back to the raw node id', () => {
    const evts = diffRun(
      run([{ nodeId: 'ghost', status: 'queued' }]),
      run([{ nodeId: 'ghost', status: 'done', endedAt: 1 }]),
      labels,
      NOW,
    );
    expect(evts[0]!.text).toBe('ghost ✓ done');
  });

  it('emits node-failed with the error text', () => {
    const evts = diffRun(
      run([{ nodeId: 'tester', status: 'running' }]),
      run([{ nodeId: 'tester', status: 'failed', endedAt: 400, error: 'exit 1' }]),
      labels,
      NOW,
    );
    expect(evts[0]).toMatchObject({ kind: 'node-failed', at: 400 });
    expect(evts[0]!.text).toContain('exit 1');
  });

  it('falls back to `now` when a transition carries no timestamp', () => {
    const evts = diffRun(
      run([{ nodeId: 'coder', status: 'queued' }]),
      run([{ nodeId: 'coder', status: 'running' }]),
      labels,
      NOW,
    );
    expect(evts[0]!.at).toBe(NOW);
  });

  it('emits nothing when the snapshot is unchanged (main re-pushes freely)', () => {
    const snap = run([{ nodeId: 'coder', status: 'done', endedAt: 1 }]);
    expect(diffRun(snap, snap, labels, NOW)).toEqual([]);
  });
});

describe('diffRun — gates and retries', () => {
  it('reports a gate verdict instead of a plain done', () => {
    const evts = diffRun(
      run([{ nodeId: 'gate', status: 'running' }]),
      run([{ nodeId: 'gate', status: 'done', endedAt: 500, verdict: 'fail' }]),
      labels,
      NOW,
    );
    expect(evts[0]).toMatchObject({ kind: 'gate-fail', nodeId: 'gate' });
    expect(evts[0]!.text).toContain('FAIL');
  });

  it('announces a retry when a gate re-queues a node, then its second done', () => {
    // The gate failed: coder is re-queued with attempts bumped to 2.
    const first = run([{ nodeId: 'coder', status: 'done', endedAt: 300, attempts: 1 }]);
    const requeued = run([{ nodeId: 'coder', status: 'queued', attempts: 2 }]);

    const retry = diffRun(first, requeued, labels, NOW);
    expect(retry.map((e) => e.kind)).toContain('node-retry');
    expect(retry.find((e) => e.kind === 'node-retry')!.text).toContain('retry ×2');

    // The SECOND done is a real event, not an echo of the first — the attempt
    // number is part of the event id, so dedup must not swallow it.
    const doneAgain = run([{ nodeId: 'coder', status: 'done', endedAt: 900, attempts: 2 }]);
    const second = diffRun(requeued, doneAgain, labels, NOW);
    expect(second).toHaveLength(1);
    expect(second[0]!.kind).toBe('node-done');
    expect(second[0]!.id).not.toBe(
      diffRun(
        run([{ nodeId: 'coder', status: 'running', attempts: 1 }]),
        first,
        labels,
        NOW,
      )[0]!.id,
    );
  });
});

describe('diffRun — run completion', () => {
  it.each([
    ['done', 'run-done'],
    ['failed', 'run-failed'],
    ['stopped', 'run-stopped'],
  ] as const)('emits %s → %s', (status, kind) => {
    const evts = diffRun(
      run([], { status: 'running' }),
      run([], { status, endedAt: 999 }),
      labels,
      NOW,
    );
    expect(evts).toHaveLength(1);
    expect(evts[0]).toMatchObject({ kind, at: 999 });
  });
});

describe('flowEvents store — ingest', () => {
  it('accumulates events and never doubles them on a re-push', () => {
    const store = useFlowEventsStore.getState();
    const snap = run([{ nodeId: 'coder', status: 'done', endedAt: 300, output: 'ab' }]);

    store.ingest('/p', [snap], [flow], NOW);
    store.ingest('/p', [snap], [flow], NOW); // idempotent echo

    const events = useFlowEventsStore.getState().events;
    expect(events.map((e) => e.kind)).toEqual(['run-started', 'node-done']);
  });

  it('keeps the timeline in chronological order across pushes', () => {
    const store = useFlowEventsStore.getState();
    store.ingest('/p', [run([{ nodeId: 'coder', status: 'running', startedAt: 200 }])], [flow], NOW);
    store.ingest(
      '/p',
      [run([{ nodeId: 'coder', status: 'done', startedAt: 200, endedAt: 300 }])],
      [flow],
      NOW,
    );

    const ats = useFlowEventsStore.getState().events.map((e) => e.at);
    expect(ats).toEqual([...ats].sort((a, b) => a - b));
  });

  it('drops the timeline when the project changes — runs are project-scoped', () => {
    const store = useFlowEventsStore.getState();
    store.ingest('/p', [run([{ nodeId: 'coder', status: 'done', endedAt: 1 }])], [flow], NOW);
    expect(useFlowEventsStore.getState().events.length).toBeGreaterThan(0);

    useFlowEventsStore.getState().ingest('/other', [], [flow], NOW);
    expect(useFlowEventsStore.getState().events).toEqual([]);
  });
});

describe('helpers', () => {
  it('approxTokens is chars/4, and undefined for no output', () => {
    expect(approxTokens('x'.repeat(4000))).toBe(1000);
    expect(approxTokens(undefined)).toBeUndefined();
    expect(approxTokens('')).toBeUndefined();
  });

  it('eventsForRun scopes the log strip to one run', () => {
    const evts = diffRun(undefined, run([]), labels, NOW);
    expect(eventsForRun(evts, 'r1')).toHaveLength(1);
    expect(eventsForRun(evts, 'other')).toHaveLength(0);
    expect(eventsForRun(evts, null)).toHaveLength(0);
  });
});
