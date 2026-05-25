import { mkdtemp, mkdir, writeFile, rm, readFile, access } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Surfacing the bundled design-packs skills as a SECOND builtin root.
// We mock both path resolvers so the test drives controlled temp fixtures
// rather than the real resources/ trees, and mock electron so SkillsService
// loads without an Electron app context (same approach as BuiltinScope.test.ts).
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

// Mirror SkillSeedingService.prefsFile: ~/.devspace/design-seeding.json.
// HOME is redirected to fakeHome in beforeEach, so this controls the value
// getSeedingEnabled() reads from inside listSkills.
async function setSeeding(home: string, enabled: boolean): Promise<void> {
  const dir = path.join(home, '.devspace');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'design-seeding.json'),
    JSON.stringify({ enabled }),
    'utf8',
  );
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

describe('SkillsService — design-packs builtin root', () => {
  let tmp = '';
  let fakeHome = '';
  let projectDir = '';
  // The design-packs skills live under `<designPacksDir>/skills`.
  let designSkillsDir = '';

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'devspace-design-skills-'));
    fakeHome = path.join(tmp, 'home');
    projectDir = path.join(tmp, 'project');
    builtinSkillsDir = path.join(tmp, 'builtin', 'skills');
    designPacksDir = path.join(tmp, 'design-packs');
    designSkillsDir = path.join(designPacksDir, 'skills');
    builtinExists = true;
    designExists = true;
    await mkdir(fakeHome, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    // v0.31: the design-packs builtin root is only surfaced in listSkills as a
    // FALLBACK when skill-seeding is disabled (when enabled, the same slugs are
    // seeded into ~/.claude/skills and collected as `global`, so listing the
    // builtin root too would double-list). Default these surfacing tests to
    // seeding-OFF; the dedicated test below flips it on.
    await setSeeding(fakeHome, false);
    vi.resetModules();
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tmp, { recursive: true, force: true });
  });

  it('surfaces design-packs skills as builtin scope', async () => {
    await writeSkill(designSkillsDir, 'ui-design');
    await writeSkill(designSkillsDir, 'brand-design-systems');

    const { listSkills } = await import('@main/services/SkillsService');
    const skills = await listSkills(null);

    const uiDesign = skills.find((s) => s.slug === 'ui-design');
    const brand = skills.find((s) => s.slug === 'brand-design-systems');
    expect(uiDesign?.scope).toBe('builtin');
    expect(brand?.scope).toBe('builtin');
  });

  it('lists both builtin roots together (builtin-packs + design-packs)', async () => {
    await writeSkill(builtinSkillsDir, 'starter');
    await writeSkill(designSkillsDir, 'ui-design');

    const { listSkills } = await import('@main/services/SkillsService');
    const skills = await listSkills(null);

    const slugs = skills.map((s) => s.slug).sort();
    expect(slugs).toContain('starter');
    expect(slugs).toContain('ui-design');
    for (const s of skills) {
      expect(s.scope).toBe('builtin');
    }
  });

  it('skips design-packs builtin root when seeding is ENABLED (avoids double-list)', async () => {
    // With seeding on, the same slugs are copied into ~/.claude/skills and
    // collected as global — so the builtin root must NOT also surface them.
    await setSeeding(fakeHome, true);
    await writeSkill(designSkillsDir, 'ui-design');

    const { listSkills } = await import('@main/services/SkillsService');
    const skills = await listSkills(null);
    expect(skills.find((s) => s.slug === 'ui-design')).toBeUndefined();
  });

  it('skips design-packs root when designPacksExist() is false', async () => {
    await writeSkill(designSkillsDir, 'ui-design');
    designExists = false;

    const { listSkills } = await import('@main/services/SkillsService');
    const skills = await listSkills(null);
    expect(skills.find((s) => s.slug === 'ui-design')).toBeUndefined();
  });

  it('readSkill classifies a design-packs file as builtin', async () => {
    const file = await writeSkill(designSkillsDir, 'ui-design', 'DESIGN-BODY');

    const { readSkill } = await import('@main/services/SkillsService');
    const skill = await readSkill(file);
    expect(skill.scope).toBe('builtin');
    expect(skill.body).toContain('DESIGN-BODY');
  });

  it('assertValidSkillPath accepts a design-packs skill path', async () => {
    const file = await writeSkill(designSkillsDir, 'ui-design');
    const { assertValidSkillPath } = await import(
      '@main/services/SkillsService'
    );
    expect(() => assertValidSkillPath(file)).not.toThrow();
  });

  it('saveSkill refuses to write into the design-packs root', async () => {
    const file = await writeSkill(designSkillsDir, 'ui-design');
    const { readSkill, saveSkill } = await import(
      '@main/services/SkillsService'
    );
    const skill = await readSkill(file);
    await expect(saveSkill(skill)).rejects.toThrow(/read-only/);
  });

  it('deleteSkill refuses to delete a design-packs skill', async () => {
    const file = await writeSkill(designSkillsDir, 'ui-design');
    const { deleteSkill } = await import('@main/services/SkillsService');
    await expect(deleteSkill(file)).rejects.toThrow(/refuse to delete/);
    // Still on disk after the rejected delete.
    await expect(access(file)).resolves.toBeUndefined();
  });

  it('duplicateSkill copies a design-packs skill into project scope', async () => {
    // Include a sibling reference asset to confirm the whole folder copies.
    const srcFile = await writeSkill(designSkillsDir, 'brand-design-systems', 'DS-BODY');
    const refsDir = path.join(designSkillsDir, 'brand-design-systems', 'references');
    await mkdir(refsDir, { recursive: true });
    await writeFile(path.join(refsDir, 'apple.md'), '# Apple\n');

    const { duplicateSkill, readSkill } = await import(
      '@main/services/SkillsService'
    );
    const dup = await duplicateSkill(srcFile, 'project', projectDir);

    expect(dup.scope).toBe('project');
    expect(dup.slug).toBe('brand-design-systems');
    expect(dup.path).toBe(
      path.join(projectDir, '.claude', 'skills', 'brand-design-systems', 'SKILL.md'),
    );
    expect(dup.body).toContain('DS-BODY');

    // SKILL.md bytes match the source.
    const original = await readFile(srcFile, 'utf8');
    const copied = await readFile(dup.path, 'utf8');
    expect(copied).toBe(original);

    // Sibling references/ came along with the copy.
    const copiedRef = await readFile(
      path.join(projectDir, '.claude', 'skills', 'brand-design-systems', 'references', 'apple.md'),
      'utf8',
    );
    expect(copiedRef).toContain('# Apple');

    // Re-read through readSkill: now project scope, editable.
    const reread = await readSkill(dup.path);
    expect(reread.scope).toBe('project');

    // Refuses to overwrite.
    await expect(duplicateSkill(srcFile, 'project', projectDir)).rejects.toThrow(
      /already exists/,
    );
  });
});

// homedir is mocked indirectly via $HOME; keep the import referenced.
void homedir;
