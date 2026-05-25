import * as nodeFs from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Drive controlled temp fixtures rather than the real resources/ tree, and
// mock electron so AgentsService loads without an Electron app context.
let builtinAgentsDir = '';
let builtinExists = true;

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
}));
vi.mock('@main/utils/builtinPackPaths', () => ({
  getBuiltinAgentsDir: () => builtinAgentsDir,
  getBuiltinSkillsDir: () => path.join(path.dirname(builtinAgentsDir), 'skills'),
  builtinPacksExist: async () => builtinExists,
}));

let originalHome: string | undefined;

async function writeAgent(dir: string, slug: string, tag = slug): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${slug}.md`);
  const content = `---\nname: ${slug}\ndescription: agent ${slug}\n---\n\nBODY-${tag}\n`;
  await writeFile(file, content, 'utf8');
  return file;
}

describe('AgentsService — listAgents parallel read + cache (FIX 4)', () => {
  let tmp = '';
  let fakeHome = '';
  let projectDir = '';
  let globalAgentsDir = '';
  let projectAgentsDir = '';

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'devspace-agents-'));
    fakeHome = path.join(tmp, 'home');
    projectDir = path.join(tmp, 'project');
    builtinAgentsDir = path.join(tmp, 'builtin', 'agents');
    globalAgentsDir = path.join(fakeHome, '.claude', 'agents');
    projectAgentsDir = path.join(projectDir, '.claude', 'agents');
    builtinExists = true;
    await mkdir(fakeHome, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    vi.resetModules();
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tmp, { recursive: true, force: true });
  });

  it('parallel read returns the same set as the per-scope inputs', async () => {
    await writeAgent(globalAgentsDir, 'reviewer');
    await writeAgent(globalAgentsDir, 'tester');
    await writeAgent(projectAgentsDir, 'planner');
    await writeAgent(builtinAgentsDir, 'starter');

    const { listAgents, __resetAgentsCacheForTests } = await import(
      '@main/services/AgentsService'
    );
    __resetAgentsCacheForTests();
    const agents = await listAgents(projectDir);
    const slugs = agents.map((a) => a.slug).sort();
    expect(slugs).toEqual(['planner', 'reviewer', 'starter', 'tester']);

    // Scope precedence + sort order preserved: project first, then global,
    // then builtin.
    expect(agents[0]!.slug).toBe('planner');
    expect(agents[0]!.scope).toBe('project');
    expect(agents.at(-1)!.scope).toBe('builtin');
  });

  it('cache hit avoids re-reading agent files on a second call', async () => {
    await writeAgent(globalAgentsDir, 'reviewer');
    await writeAgent(globalAgentsDir, 'tester');

    const { listAgents, __resetAgentsCacheForTests } = await import(
      '@main/services/AgentsService'
    );
    __resetAgentsCacheForTests();

    await listAgents(projectDir); // populate cache (reads each file once)

    // Now spy on the heavy per-file read. A genuine cache hit serves from the
    // stored result and must NOT re-read any agent file (only the cheap
    // snapshot stat+readdir runs).
    const readFileSpy = vi.spyOn(nodeFs.promises, 'readFile');
    const second = await listAgents(projectDir);
    expect(second.map((a) => a.slug).sort()).toEqual(['reviewer', 'tester']);
    expect(readFileSpy).not.toHaveBeenCalled();
    readFileSpy.mockRestore();
  });

  it('snapshot change (new agent) busts the cache', async () => {
    await writeAgent(globalAgentsDir, 'reviewer');

    const { listAgents, __resetAgentsCacheForTests } = await import(
      '@main/services/AgentsService'
    );
    __resetAgentsCacheForTests();

    const first = await listAgents(projectDir);
    expect(first.map((a) => a.slug)).toEqual(['reviewer']);

    // Add a new agent — changes the dir entry count, busting the snapshot.
    await writeAgent(globalAgentsDir, 'tester');
    const second = await listAgents(projectDir);
    expect(second.map((a) => a.slug).sort()).toEqual(['reviewer', 'tester']);
  });

  it('returns a fresh array on cache hit (caller mutation does not leak)', async () => {
    await writeAgent(globalAgentsDir, 'reviewer');
    const { listAgents, __resetAgentsCacheForTests } = await import(
      '@main/services/AgentsService'
    );
    __resetAgentsCacheForTests();

    const first = await listAgents(projectDir);
    first.pop(); // mutate the returned array
    const second = await listAgents(projectDir);
    expect(second.map((a) => a.slug)).toEqual(['reviewer']);
  });

  it('in-place edit via saveAgent is reflected immediately (cache invalidated)', async () => {
    await writeAgent(globalAgentsDir, 'reviewer');
    const { listAgents, saveAgent, __resetAgentsCacheForTests } = await import(
      '@main/services/AgentsService'
    );
    __resetAgentsCacheForTests();
    const first = await listAgents(projectDir);
    expect(first.find((a) => a.slug === 'reviewer')?.description).toBe(
      'agent reviewer',
    );

    // Overwrite the agent .md in place: the agents dir mtime + entry count are
    // unchanged, so the snapshot can't detect it. Only invalidateAgentsCache()
    // inside saveAgent makes the next list reflect the edit within the TTL.
    const reviewer = first.find((a) => a.slug === 'reviewer')!;
    await saveAgent({ ...reviewer, description: 'EDITED description' });

    const second = await listAgents(projectDir);
    expect(second.find((a) => a.slug === 'reviewer')?.description).toBe(
      'EDITED description',
    );
  });
});
