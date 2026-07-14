import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deleteFlow,
  flowsDir,
  loadFlows,
  loadRecentRuns,
  loadRun,
  runsDir,
  saveFlow,
  saveRun,
} from '../flowStore';
import type { FlowGraph, FlowRun } from '@shared/flowTypes';

let project: string;

beforeEach(async () => {
  project = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'flowstore-'));
});
afterEach(async () => {
  await fs.promises.rm(project, { recursive: true, force: true });
});

const graph = (id: string, name = id): FlowGraph => ({
  id,
  name,
  description: 'a flow',
  nodes: [
    { id: 'a', role: 'researcher', rolePrompt: 'research', cliId: 'claude', mode: 'headless', x: 0, y: 0 },
  ],
  edges: [],
  createdAt: 1,
  updatedAt: 2,
});

const run = (id: string, startedAt: number): FlowRun => ({
  id,
  flowId: 'f1',
  flowName: 'pipeline',
  projectPath: project,
  projectId: 'p1',
  task: 'do the thing',
  status: 'running',
  nodes: [{ nodeId: 'a', status: 'queued' }],
  startedAt,
});

describe('flowStore graphs', () => {
  it('round-trips a flow through disk', async () => {
    await saveFlow(project, graph('f1', 'pipeline'));
    const [loaded] = await loadFlows(project);
    expect(loaded).toEqual(graph('f1', 'pipeline'));
  });

  it('writes to <project>/.devspace/flows/<id>.flow.json', async () => {
    await saveFlow(project, graph('f1'));
    const file = path.join(flowsDir(project), 'f1.flow.json');
    expect(fs.existsSync(file)).toBe(true);
  });

  it('returns [] when the project has no flows dir', async () => {
    expect(await loadFlows(project)).toEqual([]);
  });

  it('sorts flows by name', async () => {
    await saveFlow(project, graph('f2', 'zeta'));
    await saveFlow(project, graph('f1', 'alpha'));
    expect((await loadFlows(project)).map((f) => f.name)).toEqual(['alpha', 'zeta']);
  });

  it('skips a corrupt flow file instead of failing the whole list', async () => {
    await saveFlow(project, graph('good', 'good'));
    await fs.promises.writeFile(path.join(flowsDir(project), 'bad.flow.json'), '{not json');
    expect((await loadFlows(project)).map((f) => f.id)).toEqual(['good']);
  });

  it('skips a structurally-invalid flow file (hand-edited away its nodes)', async () => {
    await saveFlow(project, graph('good', 'good'));
    await fs.promises.writeFile(
      path.join(flowsDir(project), 'bad.flow.json'),
      JSON.stringify({ id: 'bad', name: 'bad' }),
    );
    expect((await loadFlows(project)).map((f) => f.id)).toEqual(['good']);
  });

  it('deletes a flow, and deleting a missing flow is a no-op', async () => {
    await saveFlow(project, graph('f1'));
    await deleteFlow(project, 'f1');
    expect(await loadFlows(project)).toEqual([]);
    await expect(deleteFlow(project, 'nope')).resolves.toBeUndefined();
  });
});

describe('flowStore runs', () => {
  it('round-trips a run and overwrites it on the next transition', async () => {
    await saveRun(project, run('r1', 100));
    expect((await loadRun(project, 'r1'))?.status).toBe('running');

    await saveRun(project, { ...run('r1', 100), status: 'done', endedAt: 200 });
    const after = await loadRun(project, 'r1');
    expect(after?.status).toBe('done');
    expect(after?.endedAt).toBe(200);

    const files = await fs.promises.readdir(runsDir(project));
    expect(files).toEqual(['r1.json']); // one journal per run, not one per write
  });

  it('lists recent runs newest-first and honors the limit', async () => {
    await saveRun(project, run('old', 100));
    await saveRun(project, run('new', 300));
    await saveRun(project, run('mid', 200));

    expect((await loadRecentRuns(project)).map((r) => r.id)).toEqual(['new', 'mid', 'old']);
    expect((await loadRecentRuns(project, 2)).map((r) => r.id)).toEqual(['new', 'mid']);
  });

  it('returns [] / null when nothing has run yet', async () => {
    expect(await loadRecentRuns(project)).toEqual([]);
    expect(await loadRun(project, 'nope')).toBeNull();
  });

  it('skips a corrupt run file', async () => {
    await saveRun(project, run('ok', 100));
    await fs.promises.writeFile(path.join(runsDir(project), 'bad.json'), 'nope');
    expect((await loadRecentRuns(project)).map((r) => r.id)).toEqual(['ok']);
  });
});
