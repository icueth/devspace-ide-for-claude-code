import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getPresentCounts,
  getSeedingEnabled,
  readAgentManifest,
  readSeedManifest,
  seedBuiltinAgents,
  seedDesignSkills,
  setSeedingEnabled,
} from '@main/services/SkillSeedingService';

// The seeder writes into ~/.claude/skills — the riskiest surface in this
// feature. These tests point every path at tmpdirs via the override opts so
// no real home dir is ever touched, and pin the safety contract:
//   • copies skills + systems, writes manifest
//   • idempotent (version match short-circuits)
//   • force / version-change re-seeds
//   • NEVER clobbers a user-authored skill
//   • overwrites previously-managed skills
//   • removes managed slugs that left the bundle; leaves user skills alone

let tmp: string;
let bundleSkills: string;
let bundleSystems: string;
let homeSkills: string;

function writeSkill(root: string, slug: string, body = 'v1'): void {
  const dir = path.join(root, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${slug}\ndescription: ${slug} skill\n---\n${body}\n`,
  );
}

function writeSystem(root: string, brand: string): void {
  const dir = path.join(root, brand);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'DESIGN.md'), `# ${brand}\n`);
}

function seedOpts(extra: Record<string, unknown> = {}) {
  return {
    skillsBundleOverride: bundleSkills,
    systemsBundleOverride: bundleSystems,
    homeSkillsDirOverride: homeSkills,
    packVersion: '1.0.0',
    ...extra,
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devspace-seed-'));
  bundleSkills = path.join(tmp, 'bundle', 'skills');
  bundleSystems = path.join(tmp, 'bundle', 'design-systems');
  homeSkills = path.join(tmp, 'home', '.claude', 'skills');
  fs.mkdirSync(bundleSkills, { recursive: true });
  fs.mkdirSync(bundleSystems, { recursive: true });
  // baseline bundle: 3 skills + 2 systems
  writeSkill(bundleSkills, 'apple-hig');
  writeSkill(bundleSkills, 'artifacts-builder');
  writeSkill(bundleSkills, 'design-review');
  writeSystem(bundleSystems, 'apple');
  writeSystem(bundleSystems, 'airbnb');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('seedDesignSkills', () => {
  it('seeds all skills + systems and writes a manifest on first run', async () => {
    const r = await seedDesignSkills(seedOpts());
    expect(r.status).toBe('seeded');
    expect(r.seededSkills).toBe(3);
    expect(r.seededSystems).toBe(2);

    expect(fs.existsSync(path.join(homeSkills, 'apple-hig', 'SKILL.md'))).toBe(true);
    expect(
      fs.existsSync(path.join(homeSkills, '_design-systems', 'apple', 'DESIGN.md')),
    ).toBe(true);

    const manifest = await readSeedManifest(homeSkills);
    expect(manifest?.packVersion).toBe('1.0.0');
    expect(manifest?.managedSlugs.sort()).toEqual([
      'apple-hig',
      'artifacts-builder',
      'design-review',
    ]);
    expect(manifest?.managedSystems.sort()).toEqual(['airbnb', 'apple']);
  });

  it('is idempotent — same version short-circuits', async () => {
    await seedDesignSkills(seedOpts());
    const second = await seedDesignSkills(seedOpts());
    expect(second.status).toBe('skipped-up-to-date');
    expect(second.seededSkills).toBe(0);
  });

  it('re-seeds when the pack version changes', async () => {
    await seedDesignSkills(seedOpts({ packVersion: '1.0.0' }));
    const upgraded = await seedDesignSkills(seedOpts({ packVersion: '1.1.0' }));
    expect(upgraded.status).toBe('seeded');
    expect(upgraded.seededSkills).toBe(3);
  });

  it('re-seeds when force=true even at the same version', async () => {
    await seedDesignSkills(seedOpts());
    const forced = await seedDesignSkills(seedOpts({ force: true }));
    expect(forced.status).toBe('seeded');
  });

  it('NEVER clobbers a user-authored skill with a colliding name', async () => {
    // user creates their own skill named 'apple-hig' BEFORE any seed
    writeSkill(homeSkills, 'apple-hig', 'USER-CONTENT');
    const r = await seedDesignSkills(seedOpts());
    expect(r.skippedCollisions).toContain('apple-hig');
    // user content preserved untouched
    const content = fs.readFileSync(
      path.join(homeSkills, 'apple-hig', 'SKILL.md'),
      'utf8',
    );
    expect(content).toContain('USER-CONTENT');
    // other (non-colliding) skills still seeded
    expect(fs.existsSync(path.join(homeSkills, 'design-review', 'SKILL.md'))).toBe(true);
    // manifest does NOT claim the user skill as managed
    const manifest = await readSeedManifest(homeSkills);
    expect(manifest?.managedSlugs).not.toContain('apple-hig');
  });

  it('overwrites a previously-managed skill on re-seed', async () => {
    await seedDesignSkills(seedOpts({ packVersion: '1.0.0' }));
    // bundle ships a new body for apple-hig
    writeSkill(bundleSkills, 'apple-hig', 'v2-UPDATED');
    await seedDesignSkills(seedOpts({ packVersion: '1.1.0' }));
    const content = fs.readFileSync(
      path.join(homeSkills, 'apple-hig', 'SKILL.md'),
      'utf8',
    );
    expect(content).toContain('v2-UPDATED');
  });

  it('removes managed slugs that left the bundle, but never user skills', async () => {
    await seedDesignSkills(seedOpts({ packVersion: '1.0.0' }));
    // user adds their own skill after first seed
    writeSkill(homeSkills, 'my-custom-skill', 'MINE');
    // new bundle drops 'design-review'
    fs.rmSync(path.join(bundleSkills, 'design-review'), { recursive: true });
    const r = await seedDesignSkills(seedOpts({ packVersion: '1.1.0' }));
    // managed-but-removed slug is gone
    expect(fs.existsSync(path.join(homeSkills, 'design-review'))).toBe(false);
    expect(r.removedStale).toBeGreaterThanOrEqual(1);
    // user skill survives
    expect(fs.existsSync(path.join(homeSkills, 'my-custom-skill', 'SKILL.md'))).toBe(true);
  });

  it('skips when seeding disabled', async () => {
    const r = await seedDesignSkills(seedOpts({ enabled: false }));
    expect(r.status).toBe('skipped-disabled');
    expect(fs.existsSync(path.join(homeSkills, 'apple-hig'))).toBe(false);
  });

  it('skips when the bundle is missing', async () => {
    fs.rmSync(bundleSkills, { recursive: true, force: true });
    const r = await seedDesignSkills(seedOpts());
    expect(r.status).toBe('skipped-no-bundle');
  });

  it('seeds the union of design + builtin skills, design wins on a dup slug', async () => {
    // Fresh, minimal bundles so the union is deterministic.
    const designBundle = path.join(tmp, 'union', 'design', 'skills');
    const builtinBundle = path.join(tmp, 'union', 'builtin', 'skills');
    const unionHome = path.join(tmp, 'union', 'home', '.claude', 'skills');
    fs.mkdirSync(designBundle, { recursive: true });
    fs.mkdirSync(builtinBundle, { recursive: true });
    // design: 2 skills (one — 'shared' — also in builtin)
    writeSkill(designBundle, 'design-only', 'DESIGN-ONLY');
    writeSkill(designBundle, 'shared', 'DESIGN-WINS');
    // builtin: 3 skills (incl. the dup 'shared' + 2 unique)
    writeSkill(builtinBundle, 'shared', 'BUILTIN-LOSES');
    writeSkill(builtinBundle, 'builtin-a', 'BUILTIN-A');
    writeSkill(builtinBundle, 'builtin-b', 'BUILTIN-B');

    const r = await seedDesignSkills({
      skillsBundleOverride: designBundle,
      builtinSkillsBundleOverride: builtinBundle,
      systemsBundleOverride: bundleSystems,
      homeSkillsDirOverride: unionHome,
      packVersion: '1.0.0',
    });

    // union = design-only, shared, builtin-a, builtin-b = 4
    expect(r.status).toBe('seeded');
    expect(r.seededSkills).toBe(4);

    // dup slug carries the DESIGN body
    const shared = fs.readFileSync(
      path.join(unionHome, 'shared', 'SKILL.md'),
      'utf8',
    );
    expect(shared).toContain('DESIGN-WINS');
    expect(shared).not.toContain('BUILTIN-LOSES');

    const manifest = await readSeedManifest(unionHome);
    expect(manifest?.managedSlugs.sort()).toEqual([
      'builtin-a',
      'builtin-b',
      'design-only',
      'shared',
    ]);
  });
});

describe('seedBuiltinAgents', () => {
  let agentsBundle: string;
  let homeAgents: string;

  function writeAgent(root: string, slug: string, body = 'v1'): void {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, `${slug}.md`),
      `---\nname: ${slug}\ndescription: ${slug} agent\n---\n${body}\n`,
    );
  }

  function agentOpts(extra: Record<string, unknown> = {}) {
    return {
      agentsBundleOverride: agentsBundle,
      homeAgentsDirOverride: homeAgents,
      packVersion: '1.0.0',
      ...extra,
    };
  }

  beforeEach(() => {
    agentsBundle = path.join(tmp, 'agent-bundle');
    homeAgents = path.join(tmp, 'home', '.claude', 'agents');
    writeAgent(agentsBundle, 'backend-developer');
    writeAgent(agentsBundle, 'frontend-developer');
    writeAgent(agentsBundle, 'api-tester');
  });

  it('seeds flat .md agents and writes a manifest on first run', async () => {
    const r = await seedBuiltinAgents(agentOpts());
    expect(r.status).toBe('seeded');
    expect(r.seededAgents).toBe(3);
    expect(fs.existsSync(path.join(homeAgents, 'backend-developer.md'))).toBe(true);
    expect(fs.statSync(path.join(homeAgents, 'backend-developer.md')).isFile()).toBe(true);

    const manifest = await readAgentManifest(homeAgents);
    expect(manifest?.packVersion).toBe('1.0.0');
    expect(manifest?.managedAgents.sort()).toEqual([
      'api-tester',
      'backend-developer',
      'frontend-developer',
    ]);
  });

  it('is idempotent — same version short-circuits', async () => {
    await seedBuiltinAgents(agentOpts());
    const second = await seedBuiltinAgents(agentOpts());
    expect(second.status).toBe('skipped-up-to-date');
    expect(second.seededAgents).toBe(0);
  });

  it('re-seeds when force=true even at the same version', async () => {
    await seedBuiltinAgents(agentOpts());
    const forced = await seedBuiltinAgents(agentOpts({ force: true }));
    expect(forced.status).toBe('seeded');
    expect(forced.seededAgents).toBe(3);
  });

  it('NEVER clobbers a pre-existing unmanaged agent', async () => {
    writeAgent(homeAgents, 'backend-developer', 'USER-AGENT');
    const r = await seedBuiltinAgents(agentOpts());
    expect(r.skippedCollisions).toContain('backend-developer');
    const content = fs.readFileSync(
      path.join(homeAgents, 'backend-developer.md'),
      'utf8',
    );
    expect(content).toContain('USER-AGENT');
    // non-colliding agents still seeded
    expect(fs.existsSync(path.join(homeAgents, 'api-tester.md'))).toBe(true);
    const manifest = await readAgentManifest(homeAgents);
    expect(manifest?.managedAgents).not.toContain('backend-developer');
  });

  it('removes a managed agent that left the bundle, but never user agents', async () => {
    await seedBuiltinAgents(agentOpts({ packVersion: '1.0.0' }));
    // user adds their own agent after first seed
    writeAgent(homeAgents, 'my-custom-agent', 'MINE');
    // new bundle drops 'api-tester'
    fs.rmSync(path.join(agentsBundle, 'api-tester.md'));
    const r = await seedBuiltinAgents(agentOpts({ packVersion: '1.1.0' }));
    expect(fs.existsSync(path.join(homeAgents, 'api-tester.md'))).toBe(false);
    expect(r.removedStale).toBeGreaterThanOrEqual(1);
    // user agent survives
    expect(fs.existsSync(path.join(homeAgents, 'my-custom-agent.md'))).toBe(true);
  });

  it('skips when seeding disabled', async () => {
    const r = await seedBuiltinAgents(agentOpts({ enabled: false }));
    expect(r.status).toBe('skipped-disabled');
    expect(fs.existsSync(path.join(homeAgents, 'backend-developer.md'))).toBe(false);
  });

  it('skips when the bundle is missing', async () => {
    fs.rmSync(agentsBundle, { recursive: true, force: true });
    const r = await seedBuiltinAgents(agentOpts());
    expect(r.status).toBe('skipped-no-bundle');
  });
});

describe('seeding preference', () => {
  it('defaults to enabled when no prefs file exists', async () => {
    const home = path.join(tmp, 'devspace-home');
    expect(await getSeedingEnabled(home)).toBe(true);
  });

  it('round-trips a disabled flag', async () => {
    const home = path.join(tmp, 'devspace-home');
    await setSeedingEnabled(false, home);
    expect(await getSeedingEnabled(home)).toBe(false);
    await setSeedingEnabled(true, home);
    expect(await getSeedingEnabled(home)).toBe(true);
  });
});

describe('getPresentCounts (v0.35.5: report what is PRESENT, not managed)', () => {
  let root: string;
  let homeSkills: string;
  let homeAgents: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-present-'));
    homeSkills = path.join(root, 'skills');
    homeAgents = path.join(root, 'agents');
    fs.mkdirSync(homeSkills, { recursive: true });
    fs.mkdirSync(homeAgents, { recursive: true });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('counts skills + agents + systems actually present (regardless of who seeded them)', async () => {
    // Mix of "seeded" and "user-authored" — getPresentCounts must not care.
    writeSkill(homeSkills, 'ui-design');
    writeSkill(homeSkills, 'my-own-skill');
    writeSkill(homeSkills, 'backend-architect');
    // design-systems live under the leading-underscore dir and must NOT be
    // counted as skills.
    writeSystem(path.join(homeSkills, '_design-systems'), 'apple');
    writeSystem(path.join(homeSkills, '_design-systems'), 'stripe');
    // agents are flat .md files
    fs.writeFileSync(path.join(homeAgents, 'code-reviewer.md'), '---\nname: code-reviewer\n---\n');
    fs.writeFileSync(path.join(homeAgents, 'my-agent.md'), '---\nname: my-agent\n---\n');

    const counts = await getPresentCounts({
      homeSkillsDirOverride: homeSkills,
      homeAgentsDirOverride: homeAgents,
    });
    expect(counts).toEqual({ skills: 3, agents: 2, systems: 2 });
  });

  it('returns zeros for missing dirs (never throws)', async () => {
    const counts = await getPresentCounts({
      homeSkillsDirOverride: path.join(root, 'nope-skills'),
      homeAgentsDirOverride: path.join(root, 'nope-agents'),
    });
    expect(counts).toEqual({ skills: 0, agents: 0, systems: 0 });
  });
});
