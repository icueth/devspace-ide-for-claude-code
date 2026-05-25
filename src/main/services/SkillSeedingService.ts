import { app } from 'electron';
import { homedir } from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createLogger } from '@shared/logger';
import {
  designPacksExist,
  getBuiltinDesignSkillsDir,
  getBuiltinDesignSystemsDir,
} from '@main/utils/designResourcePaths';

const logger = createLogger('SkillSeeding');

// ─────────────────────────────────────────────────────────────────────────
// Why this service exists
//
// v0.31 ships 132 design skills + 150 brand design-systems inside the .app
// (resources/design-packs, via electron-builder extraResources). BUT the
// Claude Code CLI only DISCOVERS skills under `~/.claude/skills` (+ project
// `.claude/skills`) — it never looks inside `<App>/Contents/Resources`. So
// to make Claude actually USE these skills when chatting, we must copy the
// bundled packs into `~/.claude/skills` on boot.
//
// Safety contract (this writes into the user's home — treat with care):
//   • NEVER clobber a user-authored skill. We only overwrite slugs we
//     previously seeded ourselves (tracked in the manifest). A name
//     collision with an unmanaged skill is skipped + logged.
//   • Idempotent. A manifest stamped with the current pack version short-
//     circuits re-seeding every boot.
//   • Clean upgrades. Managed slugs that disappear from a newer bundle are
//     removed; user skills are never touched.
//   • Containment-guarded. Every target path is asserted to sit directly
//     under the managed root before any write/delete.
// ─────────────────────────────────────────────────────────────────────────

// Lowercase-only (no `/i`): slugs are case-sensitive in the manifest Set but
// case-INsensitive on APFS, so accepting `Apple-HIG` could collide on disk
// with `apple-hig` and slip the collision check. CLI convention is lowercase.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MANIFEST_NAME = '.devspace-design-pack.json';

// design-systems land under a leading-underscore dir: `_design-systems` is
// not a valid skill slug (SLUG_RE requires a leading alphanumeric), so the
// CLI won't treat it as a skill — it's reference material the design skills
// Read by relative path (`../_design-systems/<brand>/DESIGN.md`).
const SYSTEMS_DIRNAME = '_design-systems';

export interface SeedManifest {
  packVersion: string;
  seededAt: string;
  managedSlugs: string[];
  managedSystems: string[];
}

export interface SeedResult {
  status:
    | 'seeded'
    | 'skipped-up-to-date'
    | 'skipped-no-bundle'
    | 'skipped-disabled';
  packVersion: string;
  seededSkills: number;
  seededSystems: number;
  /** user-owned skill names we refused to overwrite */
  skippedCollisions: string[];
  /** previously-managed entries removed because they left the bundle */
  removedStale: number;
}

export interface SeedOptions {
  /** default true — when false the service no-ops (settings toggle off) */
  enabled?: boolean;
  /** re-seed even when the manifest version matches (manual re-seed) */
  force?: boolean;
  /** pack version stamp; defaults to the app version */
  packVersion?: string;
  // ── test injection — point everything at temp dirs so tests never touch
  // the real ~/.claude. All optional; production passes none.
  homeSkillsDirOverride?: string;
  skillsBundleOverride?: string;
  systemsBundleOverride?: string;
}

function defaultHomeSkillsDir(): string {
  return path.join(homedir(), '.claude', 'skills');
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readManifest(file: string): Promise<SeedManifest | null> {
  try {
    const raw = await fs.promises.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SeedManifest>;
    // Defensive: a corrupt/old-shape manifest is treated as "no manifest"
    // (forces a clean re-seed) rather than trusting partial fields.
    if (
      typeof parsed.packVersion !== 'string' ||
      !Array.isArray(parsed.managedSlugs) ||
      !Array.isArray(parsed.managedSystems)
    ) {
      return null;
    }
    return {
      packVersion: parsed.packVersion,
      seededAt: typeof parsed.seededAt === 'string' ? parsed.seededAt : '',
      managedSlugs: parsed.managedSlugs.filter(
        (s): s is string => typeof s === 'string' && SLUG_RE.test(s),
      ),
      managedSystems: parsed.managedSystems.filter(
        (s): s is string => typeof s === 'string' && SLUG_RE.test(s),
      ),
    };
  } catch {
    return null;
  }
}

async function writeManifest(file: string, m: SeedManifest): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.promises.writeFile(tmp, JSON.stringify(m, null, 2), 'utf8');
  await fs.promises.rename(tmp, file);
}

// Returns valid slugs of immediate subdirectories that contain `marker`.
async function listBundleEntries(
  dir: string,
  marker: 'SKILL.md' | 'DESIGN.md',
): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!SLUG_RE.test(e.name)) continue;
    if (await pathExists(path.join(dir, e.name, marker))) {
      out.push(e.name);
    }
  }
  return out;
}

// Asserts `target` is a direct child of `root` (no traversal, no nesting).
function isDirectChild(target: string, root: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return path.dirname(resolvedTarget) === resolvedRoot;
}

/**
 * Copy bundled design skills + systems into `~/.claude/skills` so the Claude
 * Code CLI can discover them. Idempotent, user-skill-safe, version-stamped.
 *
 * Best-effort: never throws. Per-entry failures are logged and skipped so a
 * single bad file can't abort the whole seed (or block app boot).
 */
export async function seedDesignSkills(
  opts: SeedOptions = {},
): Promise<SeedResult> {
  const enabled = opts.enabled ?? true;
  const packVersion = opts.packVersion ?? safeAppVersion();
  const base: SeedResult = {
    status: 'seeded',
    packVersion,
    seededSkills: 0,
    seededSystems: 0,
    skippedCollisions: [],
    removedStale: 0,
  };

  if (!enabled) return { ...base, status: 'skipped-disabled' };

  const skillsBundle = opts.skillsBundleOverride ?? getBuiltinDesignSkillsDir();
  const systemsBundle =
    opts.systemsBundleOverride ?? getBuiltinDesignSystemsDir();
  const homeSkills = opts.homeSkillsDirOverride ?? defaultHomeSkillsDir();

  // Bundle presence: in dev a fresh clone may lack the packs; in prod the
  // dmg always has them. Either way, degrade silently.
  const haveBundle = opts.skillsBundleOverride
    ? await pathExists(skillsBundle)
    : await designPacksExist();
  if (!haveBundle) return { ...base, status: 'skipped-no-bundle' };

  const manifestFile = path.join(homeSkills, MANIFEST_NAME);
  const prev = await readManifest(manifestFile);
  if (!opts.force && prev && prev.packVersion === packVersion) {
    return { ...base, status: 'skipped-up-to-date' };
  }

  await fs.promises.mkdir(homeSkills, { recursive: true });

  const prevManaged = new Set(prev?.managedSlugs ?? []);
  const prevSystems = new Set(prev?.managedSystems ?? []);

  // ── seed skills (collision-safe) ──────────────────────────────────────
  const bundleSlugs = await listBundleEntries(skillsBundle, 'SKILL.md');
  const bundleSlugSet = new Set(bundleSlugs);
  const seededSlugs: string[] = [];
  const skippedCollisions: string[] = [];

  for (const slug of bundleSlugs) {
    const target = path.join(homeSkills, slug);
    if (!isDirectChild(target, homeSkills)) continue; // paranoia guard
    const exists = await pathExists(target);
    if (exists && !prevManaged.has(slug)) {
      // user-authored skill with a colliding name — never overwrite
      skippedCollisions.push(slug);
      continue;
    }
    try {
      if (exists) await fs.promises.rm(target, { recursive: true, force: true });
      await fs.promises.cp(path.join(skillsBundle, slug), target, {
        recursive: true,
        // Defense-in-depth: never materialize a symlink into ~/.claude even
        // if a (future/poisoned) bundle smuggled one in. Skip link entries.
        dereference: false,
        filter: (src) => !fs.lstatSync(src).isSymbolicLink(),
      });
      seededSlugs.push(slug);
    } catch (err) {
      logger.warn(`failed to seed skill ${slug}: ${(err as Error).message}`);
    }
  }

  let removedStale = 0;
  // managed slugs that left the bundle → remove (user skills never touched)
  for (const slug of prevManaged) {
    if (bundleSlugSet.has(slug)) continue;
    const target = path.join(homeSkills, slug);
    if (!isDirectChild(target, homeSkills)) continue;
    try {
      if (await pathExists(target)) {
        await fs.promises.rm(target, { recursive: true, force: true });
        removedStale++;
      }
    } catch (err) {
      logger.warn(`failed to remove stale skill ${slug}: ${(err as Error).message}`);
    }
  }

  // ── seed design-systems → _design-systems/<brand> ─────────────────────
  // Entirely under our managed dir, so overwrites are always safe (no user
  // content lives here).
  const systemsRoot = path.join(homeSkills, SYSTEMS_DIRNAME);
  await fs.promises.mkdir(systemsRoot, { recursive: true });
  const bundleSystems = await listBundleEntries(systemsBundle, 'DESIGN.md');
  const bundleSystemSet = new Set(bundleSystems);
  const seededSystems: string[] = [];

  for (const brand of bundleSystems) {
    const target = path.join(systemsRoot, brand);
    if (!isDirectChild(target, systemsRoot)) continue;
    try {
      if (await pathExists(target)) {
        await fs.promises.rm(target, { recursive: true, force: true });
      }
      await fs.promises.cp(path.join(systemsBundle, brand), target, {
        recursive: true,
        dereference: false,
        filter: (src) => !fs.lstatSync(src).isSymbolicLink(),
      });
      seededSystems.push(brand);
    } catch (err) {
      logger.warn(`failed to seed system ${brand}: ${(err as Error).message}`);
    }
  }

  for (const brand of prevSystems) {
    if (bundleSystemSet.has(brand)) continue;
    const target = path.join(systemsRoot, brand);
    if (!isDirectChild(target, systemsRoot)) continue;
    try {
      if (await pathExists(target)) {
        await fs.promises.rm(target, { recursive: true, force: true });
        removedStale++;
      }
    } catch (err) {
      logger.warn(`failed to remove stale system ${brand}: ${(err as Error).message}`);
    }
  }

  await writeManifest(manifestFile, {
    packVersion,
    seededAt: new Date().toISOString(),
    managedSlugs: seededSlugs,
    managedSystems: seededSystems,
  });

  logger.info(
    `seeded ${seededSlugs.length} skills + ${seededSystems.length} systems ` +
      `(skipped ${skippedCollisions.length} user collisions, removed ${removedStale} stale)`,
  );

  return {
    status: 'seeded',
    packVersion,
    seededSkills: seededSlugs.length,
    seededSystems: seededSystems.length,
    skippedCollisions,
    removedStale,
  };
}

/** Reads the current seed manifest (null if never seeded). */
export async function readSeedManifest(
  homeSkillsDirOverride?: string,
): Promise<SeedManifest | null> {
  const home = homeSkillsDirOverride ?? defaultHomeSkillsDir();
  return readManifest(path.join(home, MANIFEST_NAME));
}

function safeAppVersion(): string {
  try {
    return app.getVersion();
  } catch {
    // app may be unavailable in non-Electron test contexts
    return '0.0.0';
  }
}

// ── seeding preference (default on, user opt-out) ─────────────────────────
// Stored in the app config home (~/.devspace) alongside memory + llm
// profiles — independent of the manifest, which the seeder rewrites.

function prefsFile(homeOverride?: string): string {
  const home = homeOverride ?? path.join(homedir(), '.devspace');
  return path.join(home, 'design-seeding.json');
}

export async function getSeedingEnabled(devspaceHomeOverride?: string): Promise<boolean> {
  try {
    const raw = await fs.promises.readFile(prefsFile(devspaceHomeOverride), 'utf8');
    const parsed = JSON.parse(raw) as { enabled?: unknown };
    return parsed.enabled !== false; // default on for any non-explicit-false
  } catch {
    return true; // no prefs file → default on
  }
}

export async function setSeedingEnabled(
  enabled: boolean,
  devspaceHomeOverride?: string,
): Promise<void> {
  const file = prefsFile(devspaceHomeOverride);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.promises.writeFile(tmp, JSON.stringify({ enabled }, null, 2), 'utf8');
  await fs.promises.rename(tmp, file);
}
