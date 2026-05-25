import * as nodeFs from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Controlled temp fixtures rather than the real resources/ trees; mock
// electron + the path resolvers so SkillsService loads without an Electron app
// context (same approach as SkillsService.designPacks.test.ts).
let builtinSkillsDir = '';
let designPacksDir = '';
let builtinExists = true;
let designExists = true;

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
}));
vi.mock('@main/utils/builtinPackPaths', () => ({
  getBuiltinAgentsDir: () => path.join(path.dirname(builtinSkillsDir), 'agents'),
  getBuiltinSkillsDir: () => builtinSkillsDir,
  builtinPacksExist: async () => builtinExists,
}));
vi.mock('@main/utils/designResourcePaths', () => ({
  getBuiltinDesignPacksDir: () => designPacksDir,
  designPacksExist: async () => designExists,
}));

let originalHome: string | undefined;

async function setSeeding(home: string, enabled: boolean): Promise<void> {
  const dir = path.join(home, '.devspace');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'design-seeding.json'),
    JSON.stringify({ enabled }),
    'utf8',
  );
}

async function writeSkill(dir: string, slug: string, tag = slug): Promise<string> {
  const folder = path.join(dir, slug);
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, 'SKILL.md');
  await writeFile(
    file,
    `---\nname: ${slug}\ndescription: skill ${slug}\n---\n\nBODY-${tag}\n`,
    'utf8',
  );
  return file;
}

describe('SkillsService — listSkills parallel read + cache (FIX 4)', () => {
  let tmp = '';
  let fakeHome = '';
  let globalSkillsDir = '';

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'devspace-skills-cache-'));
    fakeHome = path.join(tmp, 'home');
    builtinSkillsDir = path.join(tmp, 'builtin', 'skills');
    designPacksDir = path.join(tmp, 'design-packs');
    globalSkillsDir = path.join(fakeHome, '.claude', 'skills');
    builtinExists = true;
    designExists = false; // keep this suite focused on global + builtin
    await mkdir(fakeHome, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    await setSeeding(fakeHome, false);
    vi.resetModules();
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tmp, { recursive: true, force: true });
  });

  it('parallel read returns the same set, scope, and ordering as before', async () => {
    await writeSkill(globalSkillsDir, 'beta');
    await writeSkill(globalSkillsDir, 'alpha');
    await writeSkill(builtinSkillsDir, 'starter');

    const { listSkills, __resetSkillsCacheForTests } = await import(
      '@main/services/SkillsService'
    );
    __resetSkillsCacheForTests();
    const skills = await listSkills(null);

    // global sorted before builtin; within global, slug-sorted.
    expect(skills.map((s) => s.slug)).toEqual(['alpha', 'beta', 'starter']);
    expect(skills.find((s) => s.slug === 'alpha')?.scope).toBe('global');
    expect(skills.find((s) => s.slug === 'starter')?.scope).toBe('builtin');
  });

  it('preserves slug-collision precedence (global wins over builtin)', async () => {
    await writeSkill(globalSkillsDir, 'shared', 'GLOBAL');
    await writeSkill(builtinSkillsDir, 'shared', 'BUILTIN');

    const { listSkills, __resetSkillsCacheForTests } = await import(
      '@main/services/SkillsService'
    );
    __resetSkillsCacheForTests();
    const skills = await listSkills(null);

    const both = skills.filter((s) => s.slug === 'shared');
    expect(both).toHaveLength(2);
    const winner = both.find((s) => !s.overridden);
    const loser = both.find((s) => s.overridden);
    expect(winner?.scope).toBe('global');
    expect(loser?.scope).toBe('builtin');
  });

  it('cache hit avoids re-reading SKILL.md files on a second call', async () => {
    await writeSkill(globalSkillsDir, 'alpha');
    await writeSkill(globalSkillsDir, 'beta');

    const { listSkills, __resetSkillsCacheForTests } = await import(
      '@main/services/SkillsService'
    );
    __resetSkillsCacheForTests();
    await listSkills(null); // populate cache

    const readFileSpy = vi.spyOn(nodeFs.promises, 'readFile');
    const second = await listSkills(null);
    expect(second.map((s) => s.slug)).toEqual(['alpha', 'beta']);
    // A genuine hit serves the stored result without re-reading any SKILL.md.
    // (listSkills still reads the cheap seeding-prefs file to decide design
    // inclusion, so we assert specifically that no SKILL.md was re-read.)
    const skillReads = readFileSpy.mock.calls.filter((c) =>
      String(c[0]).endsWith('SKILL.md'),
    );
    expect(skillReads).toHaveLength(0);
    readFileSpy.mockRestore();
  });

  it('snapshot change (new skill) busts the cache', async () => {
    await writeSkill(globalSkillsDir, 'alpha');

    const { listSkills, __resetSkillsCacheForTests } = await import(
      '@main/services/SkillsService'
    );
    __resetSkillsCacheForTests();
    const first = await listSkills(null);
    expect(first.map((s) => s.slug)).toEqual(['alpha']);

    await writeSkill(globalSkillsDir, 'gamma');
    const second = await listSkills(null);
    expect(second.map((s) => s.slug).sort()).toEqual(['alpha', 'gamma']);
  });

  it('returns a fresh array on cache hit (caller mutation does not leak)', async () => {
    await writeSkill(globalSkillsDir, 'alpha');
    const { listSkills, __resetSkillsCacheForTests } = await import(
      '@main/services/SkillsService'
    );
    __resetSkillsCacheForTests();
    const first = await listSkills(null);
    first.pop();
    const second = await listSkills(null);
    expect(second.map((s) => s.slug)).toEqual(['alpha']);
  });

  it('in-place edit via saveSkill is reflected immediately (cache invalidated)', async () => {
    await writeSkill(globalSkillsDir, 'alpha');
    const { listSkills, saveSkill, __resetSkillsCacheForTests } = await import(
      '@main/services/SkillsService'
    );
    __resetSkillsCacheForTests();
    const first = await listSkills(null);
    expect(first.find((s) => s.slug === 'alpha')?.description).toBe('skill alpha');

    // Overwrite SKILL.md in place: the root skills dir's mtime + entry count
    // are unchanged, so the snapshot alone cannot detect it. Only the
    // explicit invalidateSkillsCache() inside saveSkill makes the next list
    // reflect the edit within the TTL window (the bug this guards against).
    const alpha = first.find((s) => s.slug === 'alpha')!;
    await saveSkill({ ...alpha, description: 'EDITED description' });

    const second = await listSkills(null);
    expect(second.find((s) => s.slug === 'alpha')?.description).toBe(
      'EDITED description',
    );
  });
});
