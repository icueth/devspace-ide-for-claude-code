import { mkdtemp, mkdir, writeFile, rm, readFile, access } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Builtin scope tests. We can't let the real builtin pack (under
// resources/builtin-packs/) bleed into these tests — every assertion is
// against a controlled fixture. Mock the path resolver to point at a temp
// dir per test and mock electron so AgentsService/SkillsService can load
// without an Electron app context.
let builtinAgentsDir = '';
let builtinSkillsDir = '';
let builtinExists = true;

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
}));
vi.mock('@main/utils/builtinPackPaths', () => ({
  getBuiltinAgentsDir: () => builtinAgentsDir,
  getBuiltinSkillsDir: () => builtinSkillsDir,
  builtinPacksExist: async () => builtinExists,
}));

// Force HOME at the top of the temp tree so the readAgent/readSkill scope
// inference doesn't accidentally classify a temp-rooted path as 'global'.
// We also have to remap homedir() at the OS level since the services
// call it directly.
let originalHome: string | undefined;

async function writeAgent(
  dir: string,
  slug: string,
  bodyTag = slug,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${slug}.md`);
  const content = `---\nname: ${slug}\ndescription: agent ${slug}\n---\n\nBODY-${bodyTag}\n`;
  await writeFile(file, content, 'utf8');
  return file;
}

async function writeSkill(
  dir: string,
  slug: string,
  bodyTag = slug,
): Promise<string> {
  const folder = path.join(dir, slug);
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, 'SKILL.md');
  const content = `---\nname: ${slug}\ndescription: skill ${slug}\n---\n\nBODY-${bodyTag}\n`;
  await writeFile(file, content, 'utf8');
  return file;
}

describe('AgentsService — builtin scope', () => {
  let tmp = '';
  let fakeHome = '';
  let projectDir = '';

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'devspace-builtin-agents-'));
    fakeHome = path.join(tmp, 'home');
    projectDir = path.join(tmp, 'project');
    builtinAgentsDir = path.join(tmp, 'builtin', 'agents');
    builtinSkillsDir = path.join(tmp, 'builtin', 'skills');
    builtinExists = true;
    await mkdir(fakeHome, { recursive: true });
    await mkdir(projectDir, { recursive: true });

    // Redirect $HOME so globalAgentsDir() points inside our temp tree.
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    // Re-import modules to pick up the patched homedir on each test —
    // vitest caches by default. We use vi.resetModules to ensure the
    // mocked electron + path resolver are re-evaluated.
    vi.resetModules();
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tmp, { recursive: true, force: true });
  });

  it('lists builtin agents when no global/project dirs exist', async () => {
    await writeAgent(builtinAgentsDir, 'alpha');
    await writeAgent(builtinAgentsDir, 'beta');

    const { listAgents } = await import('@main/services/AgentsService');
    const agents = await listAgents(null);

    expect(agents).toHaveLength(2);
    expect(agents.map((a) => a.slug).sort()).toEqual(['alpha', 'beta']);
    for (const a of agents) {
      expect(a.scope).toBe('builtin');
      // None are overridden — no shadows exist.
      expect(a.overridden).toBeUndefined();
    }
  });

  it('precedence: global shadows builtin (2-way)', async () => {
    await writeAgent(builtinAgentsDir, 'shared');
    await writeAgent(path.join(fakeHome, '.claude', 'agents'), 'shared');

    const { listAgents } = await import('@main/services/AgentsService');
    const agents = await listAgents(null);

    const builtinEntry = agents.find(
      (a) => a.slug === 'shared' && a.scope === 'builtin',
    );
    const globalEntry = agents.find(
      (a) => a.slug === 'shared' && a.scope === 'global',
    );

    expect(builtinEntry).toBeDefined();
    expect(globalEntry).toBeDefined();
    expect(builtinEntry?.overridden).toBe(true);
    expect(globalEntry?.overridden).toBeUndefined();
  });

  it('precedence: project > global > builtin (3-way)', async () => {
    await writeAgent(builtinAgentsDir, 'shared');
    await writeAgent(path.join(fakeHome, '.claude', 'agents'), 'shared');
    await writeAgent(path.join(projectDir, '.claude', 'agents'), 'shared');

    const { listAgents } = await import('@main/services/AgentsService');
    const agents = await listAgents(projectDir);

    const byScope = Object.fromEntries(
      agents
        .filter((a) => a.slug === 'shared')
        .map((a) => [a.scope, a]),
    );

    expect(byScope.project?.overridden).toBeUndefined();
    expect(byScope.global?.overridden).toBe(true);
    expect(byScope.builtin?.overridden).toBe(true);
  });

  it('saveAgent throws on builtin-scope agent', async () => {
    const file = await writeAgent(builtinAgentsDir, 'readonly');

    const { readAgent, saveAgent } = await import('@main/services/AgentsService');
    const agent = await readAgent(file);
    expect(agent.scope).toBe('builtin');

    await expect(saveAgent(agent)).rejects.toThrow(/read-only/);
  });

  it('deleteAgent throws on a builtin file path', async () => {
    const file = await writeAgent(builtinAgentsDir, 'permanent');

    const { deleteAgent } = await import('@main/services/AgentsService');
    await expect(deleteAgent(file)).rejects.toThrow(/refuse to delete/);
    // Confirm the file is still on disk after the failed delete.
    await expect(access(file)).resolves.toBeUndefined();
  });

  it('duplicateAgent writes a copy at the target scope and roundtrips', async () => {
    const srcFile = await writeAgent(builtinAgentsDir, 'starter', 'BUILTIN-BODY');

    const { duplicateAgent, readAgent } = await import('@main/services/AgentsService');
    const dup = await duplicateAgent(srcFile, 'global', null);

    expect(dup.scope).toBe('global');
    expect(dup.slug).toBe('starter');
    expect(dup.path).toBe(
      path.join(fakeHome, '.claude', 'agents', 'starter.md'),
    );
    expect(dup.body).toContain('BUILTIN-BODY');

    // On disk: the bytes match the source exactly.
    const original = await readFile(srcFile, 'utf8');
    const copied = await readFile(dup.path, 'utf8');
    expect(copied).toBe(original);

    // Read back through readAgent and verify scope inference.
    const reread = await readAgent(dup.path);
    expect(reread.scope).toBe('global');
    expect(reread.name).toBe('starter');

    // Refuses to overwrite.
    await expect(duplicateAgent(srcFile, 'global', null)).rejects.toThrow(
      /already exists/,
    );
  });
});

describe('SkillsService — builtin scope', () => {
  let tmp = '';
  let fakeHome = '';
  let projectDir = '';

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'devspace-builtin-skills-'));
    fakeHome = path.join(tmp, 'home');
    projectDir = path.join(tmp, 'project');
    builtinAgentsDir = path.join(tmp, 'builtin', 'agents');
    builtinSkillsDir = path.join(tmp, 'builtin', 'skills');
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

  it('precedence: project > global > builtin', async () => {
    await writeSkill(builtinSkillsDir, 'shared');
    await writeSkill(path.join(fakeHome, '.claude', 'skills'), 'shared');
    await writeSkill(path.join(projectDir, '.claude', 'skills'), 'shared');

    const { listSkills } = await import('@main/services/SkillsService');
    const skills = await listSkills(projectDir);

    const byScope = Object.fromEntries(
      skills.filter((s) => s.slug === 'shared').map((s) => [s.scope, s]),
    );
    expect(byScope.project?.overridden).toBeUndefined();
    expect(byScope.global?.overridden).toBe(true);
    expect(byScope.builtin?.overridden).toBe(true);

    // Also exercise the sort order: project first.
    const sharedEntries = skills.filter((s) => s.slug === 'shared');
    expect(sharedEntries[0]?.scope).toBe('project');
    expect(sharedEntries[sharedEntries.length - 1]?.scope).toBe('builtin');
  });

  it('saveSkill throws on builtin-scope skill', async () => {
    const file = await writeSkill(builtinSkillsDir, 'frozen');

    const { readSkill, saveSkill } = await import('@main/services/SkillsService');
    const skill = await readSkill(file);
    expect(skill.scope).toBe('builtin');

    await expect(saveSkill(skill)).rejects.toThrow(/read-only/);
  });

  it('duplicateSkill writes a copy at the target scope and roundtrips', async () => {
    const srcFile = await writeSkill(builtinSkillsDir, 'helper', 'BUILTIN-HELPER');

    const { duplicateSkill, readSkill } = await import(
      '@main/services/SkillsService'
    );
    const dup = await duplicateSkill(srcFile, 'project', projectDir);

    expect(dup.scope).toBe('project');
    expect(dup.slug).toBe('helper');
    expect(dup.path).toBe(
      path.join(projectDir, '.claude', 'skills', 'helper', 'SKILL.md'),
    );
    expect(dup.body).toContain('BUILTIN-HELPER');

    const original = await readFile(srcFile, 'utf8');
    const copied = await readFile(dup.path, 'utf8');
    expect(copied).toBe(original);

    const reread = await readSkill(dup.path);
    expect(reread.scope).toBe('project');

    // Refuses to overwrite.
    await expect(duplicateSkill(srcFile, 'project', projectDir)).rejects.toThrow(
      /already exists/,
    );
  });
});

// Silence unused-import warnings from typescript when homedir() isn't
// invoked at the top level — we read $HOME via process.env in setup.
void homedir;
