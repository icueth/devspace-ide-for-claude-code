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
const { latestRunFor, newNodeDefaults, starterFlow, statusByNode, useFlowsStore } =
  await import('../flows');
const { FLOW_TEMPLATES } = await import('../flowTemplates');
// The templates are checked against main's real validator (pure graph logic).
const { validateGraph } = await import('@main/services/flowScheduler');

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

describe('flows store — edge editing', () => {
  it('disconnect matches the branch exactly — a gate keeps its other branch', () => {
    const g = graph('f1');
    g.nodes.push({
      id: 'gate1', kind: 'gate', role: 'ok?', rolePrompt: '', condition: 'x',
      cliId: 'claude', mode: 'headless', x: 600, y: 0,
    });
    g.edges = [
      { from: 'gate1', to: 'b', branch: 'pass', label: 'pass ✓' },
      { from: 'gate1', to: 'b', branch: 'fail', label: 'fail ✗ retry' },
    ];
    useFlowsStore.setState({ flows: [g], selectedFlowId: 'f1', draft: structuredClone(g) });

    useFlowsStore.getState().disconnect('gate1', 'b', 'fail');
    expect(useFlowsStore.getState().draft!.edges).toEqual([
      { from: 'gate1', to: 'b', branch: 'pass', label: 'pass ✓' },
    ]);
  });

  it('setEdgeBranch flips a gate edge and refuses when the slot is taken', () => {
    const g = graph('f1');
    g.nodes.push({
      id: 'gate1', kind: 'gate', role: 'ok?', rolePrompt: '', condition: 'x',
      cliId: 'claude', mode: 'headless', x: 600, y: 0,
    });
    g.edges = [{ from: 'gate1', to: 'b', branch: 'pass', label: 'pass ✓' }];
    useFlowsStore.setState({ flows: [g], selectedFlowId: 'f1', draft: structuredClone(g) });

    useFlowsStore.getState().setEdgeBranch(g.edges[0]!, 'fail');
    expect(useFlowsStore.getState().draft!.edges[0]).toMatchObject({
      branch: 'fail',
      label: 'fail ✗ retry',
    });

    // Occupied slot: flipping back would collapse two edges into one.
    useFlowsStore.getState().connect('gate1', 'b', 'pass');
    const before = structuredClone(useFlowsStore.getState().draft!.edges);
    useFlowsStore
      .getState()
      .setEdgeBranch({ from: 'gate1', to: 'b', branch: 'fail' }, 'pass');
    expect(useFlowsStore.getState().draft!.edges).toEqual(before);
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

describe('flows store — node kinds', () => {
  beforeEach(() => {
    useFlowsStore.setState({
      flows: [graph('f1')],
      selectedFlowId: 'f1',
      draft: graph('f1'),
    });
  });

  it('adds an agent by default (phase-1 behaviour is unchanged)', () => {
    useFlowsStore.getState().addNode(10, 20);
    const added = useFlowsStore.getState().draft!.nodes.at(-1)!;
    expect(added).toMatchObject({ kind: 'agent', cliId: 'claude', mode: 'headless' });
    expect(useFlowsStore.getState().selectedNodeId).toBe(added.id);
  });

  it('adds a gate with an empty condition and a default retry budget', () => {
    useFlowsStore.getState().addNode(10, 20, 'gate');
    const gate = useFlowsStore.getState().draft!.nodes.at(-1)!;
    // Empty on purpose: validateGraph rejects a condition-less gate, so the
    // blank field IS the prompt to write one.
    expect(gate).toMatchObject({ kind: 'gate', condition: '', maxRetries: 3 });
  });

  it('adds a note', () => {
    useFlowsStore.getState().addNode(10, 20, 'note');
    expect(useFlowsStore.getState().draft!.nodes.at(-1)).toMatchObject({
      kind: 'note',
      noteText: 'Note',
    });
  });

  it('newNodeDefaults always fills the fields FlowNode requires', () => {
    for (const kind of ['agent', 'gate', 'note'] as const) {
      const d = newNodeDefaults(kind);
      expect(d.cliId).toBe('claude');
      expect(d.mode).toBeTruthy();
      expect(d.rolePrompt).toBeDefined();
      expect(d.role).toBeTruthy();
    }
  });
});

describe('flows store — branch edges', () => {
  const withGate = (): void => {
    const g = graph('f1');
    g.nodes.push({
      id: 'g',
      kind: 'gate',
      role: 'tests pass?',
      rolePrompt: '',
      cliId: 'claude',
      mode: 'headless',
      condition: 'green',
      x: 600,
      y: 0,
    });
    g.nodes.push({
      id: 'note1',
      kind: 'note',
      role: 'note',
      rolePrompt: '',
      cliId: 'claude',
      mode: 'headless',
      noteText: 'hi',
      x: 0,
      y: 300,
    });
    useFlowsStore.setState({ flows: [g], selectedFlowId: 'f1', draft: g });
  };

  beforeEach(withGate);

  it('tags a gate edge with its branch and a readable label', () => {
    useFlowsStore.getState().connect('g', 'a', 'fail');
    expect(useFlowsStore.getState().draft!.edges).toContainEqual({
      from: 'g',
      to: 'a',
      label: 'fail ✗ retry',
      branch: 'fail',
    });
  });

  it('defaults an unbranded gate edge to the pass branch', () => {
    useFlowsStore.getState().connect('g', 'b');
    expect(useFlowsStore.getState().draft!.edges).toContainEqual({
      from: 'g',
      to: 'b',
      label: 'pass ✓',
      branch: 'pass',
    });
  });

  it('never brands an edge that does not leave a gate', () => {
    useFlowsStore.getState().connect('b', 'a', 'fail');
    const edge = useFlowsStore.getState().draft!.edges.find((e) => e.from === 'b')!;
    expect(edge.branch).toBeUndefined();
    expect(edge.label).toBe('handoff');
  });

  it('lets a gate point at the same node on BOTH branches, but not twice on one', () => {
    const s = useFlowsStore.getState();
    s.connect('g', 'a', 'pass');
    s.connect('g', 'a', 'fail');
    s.connect('g', 'a', 'fail'); // duplicate branch — a no-op
    expect(useFlowsStore.getState().draft!.edges.filter((e) => e.from === 'g')).toHaveLength(2);
  });

  it('refuses any edge touching a note — validateGraph would reject the graph', () => {
    const s = useFlowsStore.getState();
    s.connect('a', 'note1');
    s.connect('note1', 'b');
    expect(useFlowsStore.getState().draft!.edges).toHaveLength(1); // just a→b
  });

  it('refuses a fail edge into a gate — you cannot retry a judgement', () => {
    // (the only fail-edge target main will accept is an agent)
    const s = useFlowsStore.getState();
    s.addNode(900, 0, 'gate');
    const g2 = useFlowsStore.getState().draft!.nodes.at(-1)!.id;
    s.connect('g', g2, 'fail');
    expect(
      useFlowsStore.getState().draft!.edges.some((e) => e.to === g2),
    ).toBe(false);
  });
});

describe('flows store — templates', () => {
  beforeEach(() => {
    useFlowsStore.setState({ projectPath: '/p', flows: [], draft: null });
  });

  it('createFlow() with no id starts from the blank starter', () => {
    useFlowsStore.getState().createFlow();
    expect(useFlowsStore.getState().draft!.name).toBe(starterFlow().name);
  });

  it('createFlow(templateId) builds that template and selects it', () => {
    useFlowsStore.getState().createFlow('pipeline');

    const s = useFlowsStore.getState();
    const draft = s.draft!;
    expect(s.selectedFlowId).toBe(draft.id);
    expect(s.flows.map((f) => f.id)).toContain(draft.id);
    // Persisted immediately: an unsaved flow can't be run from chat.
    expect(api.flows.save).toHaveBeenCalledWith('/p', expect.objectContaining({ id: draft.id }));

    // The mockup's shape: a gate with a fail edge looping back to an agent.
    const gate = draft.nodes.find((n) => n.kind === 'gate')!;
    expect(gate.condition).toBeTruthy();
    expect(gate.maxRetries).toBe(3);
    const fail = draft.edges.find((e) => e.branch === 'fail')!;
    expect(draft.nodes.find((n) => n.id === fail.to)!.kind).toBe('agent');
  });

  it('an unknown template id falls back to the starter rather than crashing', () => {
    useFlowsStore.getState().createFlow('nope');
    expect(useFlowsStore.getState().draft).not.toBeNull();
  });

  // Against the REAL validator, not a copy of its rules: a template that main
  // would refuse to run is a broken button, and it must fail HERE rather than in
  // the user's chat. (validateGraph is pure graph logic — no electron, no fs.)
  it('every template passes main\'s validateGraph', () => {
    for (const t of FLOW_TEMPLATES) {
      const g = t.build();
      expect(g.name).toBeTruthy();
      expect(g.description).toBeTruthy();
      expect({ name: g.name, errors: validateGraph(g) }).toEqual({
        name: g.name,
        errors: [],
      });
    }
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
