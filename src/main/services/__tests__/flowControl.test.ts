import { beforeEach, describe, expect, it, vi } from 'vitest';

// The router is the only chat-facing entry point into the flow engine, so it is
// tested against a mocked service — no sockets, no PTYs, no fs. pathScope is
// mocked too: assertInWorkspace normally reads the real workspaces file.
vi.mock('@main/utils/pathScope', () => ({
  assertInWorkspace: vi.fn(async (p: string) => {
    if (!p.startsWith('/ws')) throw new Error(`path outside any open workspace: ${p}`);
    return p;
  }),
}));

import { routeFlowControl } from '../flowControl';
import type { FlowGraph, FlowRun } from '@shared/flowTypes';

const FLOW: FlowGraph = {
  id: 'f1',
  name: 'feature-pipeline',
  description: 'multi-step feature work with tests',
  nodes: [
    { id: 'a', role: 'coder', rolePrompt: 'code', cliId: 'claude', mode: 'headless', x: 0, y: 0 },
    { id: 'b', role: 'tester', rolePrompt: 'test', cliId: 'claude', mode: 'interactive', x: 1, y: 1 },
  ],
  edges: [{ from: 'a', to: 'b' }],
  createdAt: 1,
  updatedAt: 2,
};

const RUN: FlowRun = {
  id: 'r1',
  flowId: 'f1',
  flowName: 'feature-pipeline',
  projectPath: '/ws/proj',
  projectId: 'p1',
  task: 'add dark mode',
  status: 'running',
  nodes: [
    { nodeId: 'a', status: 'done', output: 'x'.repeat(5_000) },
    { nodeId: 'b', status: 'running', sessionKey: 'p1:claude-cli:flow-r1-b' },
  ],
  startedAt: 100,
};

// Widened return types (not inferred from the happy-path literal) so a test can
// mock a rejection — the engine's failures are half of what the router relays.
type Ack = Promise<{ ok: boolean; error?: string }>;

const makeSvc = () => ({
  list: vi.fn(async () => [FLOW]),
  runs: vi.fn(async () => [RUN]),
  runFlow: vi.fn(
    async (): Promise<{ ok: true; runId: string } | { ok: false; error: string }> => ({
      ok: true,
      runId: 'r1',
    }),
  ),
  stopRun: vi.fn(async (): Ack => ({ ok: true })),
  sendToNode: vi.fn(async (): Ack => ({ ok: true })),
  getRun: vi.fn(() => RUN as FlowRun | undefined),
});

let svc: ReturnType<typeof makeSvc>;
beforeEach(() => {
  svc = makeSvc();
});

describe('routeFlowControl — list', () => {
  it('returns the flows of a repo with their routing descriptions', async () => {
    const res = await routeFlowControl(svc, { op: 'list', repo: '/ws/proj' });
    expect(res.ok).toBe(true);
    expect(res.flows).toEqual([
      {
        id: 'f1',
        name: 'feature-pipeline',
        description: 'multi-step feature work with tests',
        nodes: [
          { id: 'a', role: 'coder', cli: 'claude', mode: 'headless' },
          { id: 'b', role: 'tester', cli: 'claude', mode: 'interactive' },
        ],
        edges: [{ from: 'a', to: 'b' }],
      },
    ]);
  });

  it('requires a repo', async () => {
    expect(await routeFlowControl(svc, { op: 'list' })).toEqual({
      ok: false,
      error: 'repo required',
    });
  });

  it('rejects a repo outside any open workspace', async () => {
    await expect(
      routeFlowControl(svc, { op: 'list', repo: '/etc' }),
    ).rejects.toThrow(/outside any open workspace/);
    expect(svc.list).not.toHaveBeenCalled();
  });
});

describe('routeFlowControl — run', () => {
  it('starts a run and returns its id', async () => {
    const res = await routeFlowControl(svc, {
      op: 'run',
      repo: '/ws/proj',
      flow: 'feature-pipeline',
      task: 'add dark mode',
    });
    expect(res).toEqual({ ok: true, runId: 'r1' });
    expect(svc.runFlow).toHaveBeenCalledWith('/ws/proj', 'feature-pipeline', 'add dark mode');
  });

  it.each([
    [{ op: 'run', flow: 'f', task: 't' }, 'repo required'],
    [{ op: 'run', repo: '/ws/p', task: 't' }, 'flow required'],
    [{ op: 'run', repo: '/ws/p', flow: 'f' }, 'task required'],
    [{ op: 'run', repo: '/ws/p', flow: 'f', task: '   ' }, 'task required'],
  ])('rejects a malformed request (%#)', async (req, error) => {
    expect(await routeFlowControl(svc, req)).toEqual({ ok: false, error });
    expect(svc.runFlow).not.toHaveBeenCalled();
  });

  it('relays the engine\'s rejection (unknown flow / invalid graph) verbatim', async () => {
    svc.runFlow.mockResolvedValueOnce({
      ok: false,
      error: 'flow "x" is invalid — flow has a cycle',
    });
    const res = await routeFlowControl(svc, {
      op: 'run',
      repo: '/ws/proj',
      flow: 'x',
      task: 't',
    });
    expect(res).toEqual({ ok: false, error: 'flow "x" is invalid — flow has a cycle' });
  });

  it('never starts a run for a repo outside the workspace', async () => {
    await expect(
      routeFlowControl(svc, { op: 'run', repo: '/tmp/evil', flow: 'f', task: 't' }),
    ).rejects.toThrow(/outside any open workspace/);
    expect(svc.runFlow).not.toHaveBeenCalled();
  });
});

describe('routeFlowControl — status', () => {
  it('reports per-node status with a capped output tail', async () => {
    const res = await routeFlowControl(svc, { op: 'status', runId: 'r1' });
    expect(res.ok).toBe(true);
    const run = res.run as { status: string; nodes: Array<{ node: string; status: string; output?: string }> };
    expect(run.status).toBe('running');
    expect(run.nodes.map((n) => [n.node, n.status])).toEqual([
      ['a', 'done'],
      ['b', 'running'],
    ]);
    // 5k of captured output, tailed to 2k for the tool reply.
    expect(run.nodes[0].output).toHaveLength(2_000);
  });

  it('reports a run that is no longer live', async () => {
    svc.getRun.mockReturnValueOnce(undefined);
    const res = await routeFlowControl(svc, { op: 'status', runId: 'gone' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found or already finished/);
  });

  it('requires a runId', async () => {
    expect(await routeFlowControl(svc, { op: 'status' })).toEqual({
      ok: false,
      error: 'runId required',
    });
  });
});

describe('routeFlowControl — send / stop / runs', () => {
  it('relays a steering message to a node', async () => {
    const res = await routeFlowControl(svc, {
      op: 'send',
      runId: 'r1',
      node: 'b',
      text: 'also cover the edge case',
    });
    expect(res).toEqual({ ok: true });
    expect(svc.sendToNode).toHaveBeenCalledWith('r1', 'b', 'also cover the edge case');
  });

  it('rejects an empty steering message', async () => {
    expect(
      await routeFlowControl(svc, { op: 'send', runId: 'r1', node: 'b', text: '  ' }),
    ).toEqual({ ok: false, error: 'text required' });
    expect(svc.sendToNode).not.toHaveBeenCalled();
  });

  it('stops a run', async () => {
    expect(await routeFlowControl(svc, { op: 'stop', runId: 'r1' })).toEqual({ ok: true });
    expect(svc.stopRun).toHaveBeenCalledWith('r1');
  });

  it('relays a stop failure (already finished)', async () => {
    svc.stopRun.mockResolvedValueOnce({ ok: false, error: 'run not found' });
    expect(await routeFlowControl(svc, { op: 'stop', runId: 'r1' })).toEqual({
      ok: false,
      error: 'run not found',
    });
  });

  it('lists recent runs as slim summaries (no output payloads)', async () => {
    const res = await routeFlowControl(svc, { op: 'runs', repo: '/ws/proj' });
    expect(res.ok).toBe(true);
    expect(res.runs).toEqual([
      {
        runId: 'r1',
        flow: 'feature-pipeline',
        status: 'running',
        startedAt: 100,
        endedAt: undefined,
        error: undefined,
        nodes: [
          { node: 'a', status: 'done' },
          { node: 'b', status: 'running' },
        ],
      },
    ]);
    expect(JSON.stringify(res.runs)).not.toContain('xxxx');
  });
});

describe('routeFlowControl — unknown op', () => {
  it('is rejected, not silently ignored', async () => {
    expect(await routeFlowControl(svc, { op: 'nuke' })).toEqual({
      ok: false,
      error: 'unknown op: nuke',
    });
    expect(await routeFlowControl(svc, {})).toEqual({
      ok: false,
      error: 'unknown op: undefined',
    });
  });
});
