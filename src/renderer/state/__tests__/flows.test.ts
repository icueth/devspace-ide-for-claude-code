import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FlowGraph, FlowRun } from '@shared/flowTypes';

// The store's debounced writer calls api.flows.save — mock the bridge so the
// tests assert the write schedule instead of hitting the (rejecting) stub.
vi.mock('@renderer/lib/api', () => ({
  api: {
    flows: {
      list: vi.fn(async () => []),
      runs: vi.fn(async () => []),
      save: vi.fn(async (_p: string, g: FlowGraph) => g),
      remove: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
      onChanged: vi.fn(() => () => undefined),
    },
  },
}));

const { api } = await import('@renderer/lib/api');
const { latestRunFor, statusByNode, useFlowsStore } = await import('../flows');

const graph = (id: string, name = id): FlowGraph => ({
  id,
  name,
  description: '',
  nodes: [
    { id: 'a', role: 'a', rolePrompt: '', cliId: 'claude', mode: 'headless', x: 0, y: 0 },
    { id: 'b', role: 'b', rolePrompt: '', cliId: 'claude', mode: 'headless', x: 300, y: 0 },
  ],
  edges: [{ from: 'a', to: 'b' }],
  createdAt: 1,
  updatedAt: 1,
});

const run = (id: string, flowId: string, startedAt: number): FlowRun => ({
  id,
  flowId,
  flowName: flowId,
  projectPath: '/p',
  projectId: 'p1',
  task: 'do it',
  status: 'running',
  nodes: [
    { nodeId: 'a', status: 'done' },
    { nodeId: 'b', status: 'running', sessionKey: `p1:claude-cli:flow-${id}-b` },
  ],
  startedAt,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useFlowsStore.setState({
    projectPath: '/p',
    flows: [],
    runs: [],
    selectedFlowId: null,
    selectedNodeId: null,
    draft: null,
    loading: false,
  });
});

afterEach(async () => {
  // Drain any debounce the test left armed so it can't fire into the next one.
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  await useFlowsStore.getState().flush();
});

describe('flows store — applyChanged', () => {
  it('replaces the flow list when evt.flows is present', () => {
    useFlowsStore.getState().applyChanged({ projectPath: '/p', flows: [graph('f1')] });
    expect(useFlowsStore.getState().flows.map((f) => f.id)).toEqual(['f1']);
  });

  it('ignores pushes for a different project', () => {
    useFlowsStore.setState({ flows: [graph('f1')] });
    useFlowsStore.getState().applyChanged({ projectPath: '/other', flows: [] });
    expect(useFlowsStore.getState().flows).toHaveLength(1);
  });

  it('upserts a run by id rather than appending duplicates', () => {
    const r1 = run('r1', 'f1', 10);
    useFlowsStore.getState().applyChanged({ projectPath: '/p', run: r1 });
    useFlowsStore
      .getState()
      .applyChanged({ projectPath: '/p', run: { ...r1, status: 'done' } });

    const runs = useFlowsStore.getState().runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('done');
  });

  it('keeps flows and runs independent (a run push does not clear the list)', () => {
    useFlowsStore.setState({ flows: [graph('f1')] });
    useFlowsStore.getState().applyChanged({ projectPath: '/p', run: run('r1', 'f1', 1) });
    expect(useFlowsStore.getState().flows).toHaveLength(1);
    expect(useFlowsStore.getState().runs).toHaveLength(1);
  });

  it('adopts an external edit into the draft when nothing is queued locally', () => {
    useFlowsStore.setState({
      flows: [graph('f1')],
      selectedFlowId: 'f1',
      draft: graph('f1'),
    });
    useFlowsStore
      .getState()
      .applyChanged({ projectPath: '/p', flows: [graph('f1', 'renamed')] });
    expect(useFlowsStore.getState().draft!.name).toBe('renamed');
  });

  it('does NOT clobber the draft while a local save is pending', () => {
    useFlowsStore.setState({
      flows: [graph('f1')],
      selectedFlowId: 'f1',
      draft: graph('f1'),
    });
    // Local edit → debounce armed (nothing written yet).
    useFlowsStore.getState().updateFlowMeta({ name: 'my-local-edit' });
    // Main echoes the pre-edit copy back.
    useFlowsStore.getState().applyChanged({ projectPath: '/p', flows: [graph('f1')] });
    expect(useFlowsStore.getState().draft!.name).toBe('my-local-edit');
  });

  it('falls back to the first flow when the selected one is deleted elsewhere', () => {
    useFlowsStore.setState({
      flows: [graph('f1'), graph('f2')],
      selectedFlowId: 'f1',
      draft: graph('f1'),
      selectedNodeId: 'a',
    });
    useFlowsStore.getState().applyChanged({ projectPath: '/p', flows: [graph('f2')] });

    const s = useFlowsStore.getState();
    expect(s.selectedFlowId).toBe('f2');
    expect(s.draft!.id).toBe('f2');
    expect(s.selectedNodeId).toBeNull();
  });
});

describe('flows store — draft editing', () => {
  beforeEach(() => {
    useFlowsStore.setState({
      flows: [graph('f1')],
      selectedFlowId: 'f1',
      draft: graph('f1'),
    });
  });

  it('debounces saves: many edits collapse into one write', async () => {
    const s = useFlowsStore.getState();
    s.moveNode('a', 10, 10);
    s.moveNode('a', 20, 20);
    s.moveNode('a', 30, 30);
    expect(api.flows.save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(800);
    expect(api.flows.save).toHaveBeenCalledTimes(1);
    expect(api.flows.save).toHaveBeenCalledWith(
      '/p',
      expect.objectContaining({ id: 'f1' }),
    );
  });

  it('flush() forces the pending write immediately', async () => {
    useFlowsStore.getState().updateNode('a', { role: 'researcher' });
    await useFlowsStore.getState().flush();
    expect(api.flows.save).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(api.flows.save).mock.calls[0]![1];
    expect(saved.nodes.find((n) => n.id === 'a')!.role).toBe('researcher');
  });

  it('deleting a node also drops its dangling edges', () => {
    useFlowsStore.getState().deleteNode('b');
    const d = useFlowsStore.getState().draft!;
    expect(d.nodes.map((n) => n.id)).toEqual(['a']);
    expect(d.edges).toHaveLength(0);
  });

  it('refuses self-edges and duplicate edges', () => {
    const s = useFlowsStore.getState();
    s.connect('a', 'a');
    s.connect('a', 'b'); // already exists
    expect(useFlowsStore.getState().draft!.edges).toHaveLength(1);
  });

  it('connects two nodes with a handoff edge', () => {
    useFlowsStore.getState().connect('b', 'a');
    expect(useFlowsStore.getState().draft!.edges).toContainEqual({
      from: 'b',
      to: 'a',
      label: 'handoff',
    });
  });
});

describe('flows store — project switch', () => {
  it('flushes a pending edit to the OLD project before repointing the store', async () => {
    useFlowsStore.setState({
      flows: [graph('f1')],
      selectedFlowId: 'f1',
      draft: graph('f1'),
    });
    // Edit in /p → debounce armed with pendingPath=/p.
    useFlowsStore.getState().updateFlowMeta({ name: 'edited-in-p' });

    // Switch to /q before the debounce fires. The queued write must land in
    // /p with the /p draft — pairing the old path with /q's draft would write
    // one project's flow into another's flows dir.
    await useFlowsStore.getState().loadForProject('/q');

    expect(api.flows.save).toHaveBeenCalledTimes(1);
    const [savedPath, savedGraph] = vi.mocked(api.flows.save).mock.calls[0]!;
    expect(savedPath).toBe('/p');
    expect((savedGraph as FlowGraph).name).toBe('edited-in-p');

    // The timer is disarmed — nothing fires later against /q.
    await vi.runOnlyPendingTimersAsync();
    expect(api.flows.save).toHaveBeenCalledTimes(1);
  });
});

describe('flows selectors', () => {
  it('latestRunFor picks the newest run of that flow', () => {
    const runs = [run('old', 'f1', 1), run('new', 'f1', 9), run('other', 'f2', 99)];
    expect(latestRunFor(runs, 'f1')!.id).toBe('new');
    expect(latestRunFor(runs, 'nope')).toBeNull();
  });

  it('statusByNode maps a run onto the canvas status ring', () => {
    expect(statusByNode(run('r1', 'f1', 1))).toEqual({ a: 'done', b: 'running' });
    expect(statusByNode(null)).toEqual({});
  });
});
