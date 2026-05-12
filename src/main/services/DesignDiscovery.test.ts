import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// We need to mock both `electron` and the resource-path resolver so the
// service can run under vitest without an Electron app context, and so we
// can point the built-in pack at a temp directory the test controls.
let builtinDir = '';
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
}));
vi.mock('@main/utils/designResourcePaths', () => ({
  getBuiltinDesignPacksDir: () => builtinDir,
}));

describe('listSkills — discovery rules', () => {
  let tmp = '';
  let projectDir = '';

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'devspace-discovery-'));
    builtinDir = path.join(tmp, 'design-packs');
    projectDir = path.join(tmp, 'project');
    await mkdir(builtinDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function writeSkill(
    dir: string,
    slug: string,
    frontmatter = '',
  ): Promise<void> {
    await mkdir(dir, { recursive: true });
    const body = `---\nname: ${slug}\ndescription: test\n${frontmatter}---\nbody`;
    await writeFile(path.join(dir, 'SKILL.md'), body, 'utf8');
  }

  it('accepts built-in skills without requiring a design marker', async () => {
    // Bundled layout: design-packs/skills/<slug>/SKILL.md (no design-skills
    // subtree, no `category: design` frontmatter). The original bug: zero
    // built-in skills appeared in the picker.
    await writeSkill(path.join(builtinDir, 'skills', 'dashboard'), 'dashboard');
    await writeSkill(path.join(builtinDir, 'skills', 'landing'), 'landing');

    const { listSkills } = await import('@main/services/DesignService');
    const skills = await listSkills(null);

    const builtinSlugs = skills.filter((s) => s.scope === 'builtin').map((s) => s.slug);
    expect(builtinSlugs).toEqual(['dashboard', 'landing']);
  });

  it('rejects project skills without a design marker', async () => {
    // A user dropping a non-design skill into .claude/skills/ should NOT
    // appear in the design picker. This guards against picker pollution.
    await writeSkill(path.join(projectDir, '.claude', 'skills', 'random'), 'random');

    const { listSkills } = await import('@main/services/DesignService');
    const skills = await listSkills(projectDir);

    expect(skills.find((s) => s.slug === 'random')).toBeUndefined();
  });

  it('accepts project skills with category: design frontmatter', async () => {
    await writeSkill(
      path.join(projectDir, '.claude', 'skills', 'custom-dash'),
      'custom-dash',
      'category: design\n',
    );

    const { listSkills } = await import('@main/services/DesignService');
    const skills = await listSkills(projectDir);

    expect(skills.find((s) => s.slug === 'custom-dash')?.scope).toBe('project');
  });

  it('accepts project skills under a design-skills/ subtree', async () => {
    await writeSkill(
      path.join(projectDir, '.claude', 'skills', 'design-skills', 'gallery'),
      'gallery',
    );

    const { listSkills } = await import('@main/services/DesignService');
    const skills = await listSkills(projectDir);

    expect(skills.find((s) => s.slug === 'gallery')?.scope).toBe('project');
  });
});
