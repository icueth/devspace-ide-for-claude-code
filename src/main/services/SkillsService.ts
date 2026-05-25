import { homedir } from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createLogger } from '@shared/logger';
import {
  builtinPacksExist,
  getBuiltinSkillsDir,
} from '@main/utils/builtinPackPaths';
import {
  designPacksExist,
  getBuiltinDesignPacksDir,
} from '@main/utils/designResourcePaths';
import { getSeedingEnabled } from '@main/services/SkillSeedingService';
import type { SkillDef, SkillScope } from '@shared/types';

const logger = createLogger('Skills');

function globalSkillsDir(): string {
  return path.join(homedir(), '.claude', 'skills');
}

function projectSkillsDir(projectPath: string): string {
  return path.join(projectPath, '.claude', 'skills');
}

function pluginMarketplacesDir(): string {
  return path.join(homedir(), '.claude', 'plugins', 'marketplaces');
}

// Second builtin skills root: the bundled design-packs ship 100+ design
// SKILL.md (layouts) under `design-packs/skills/`. These surface as the
// SAME `builtin` scope as the main builtin pack — listed in Settings →
// Skills, read-only, duplicate-to-use. Containment/scope checks below treat
// BOTH `builtin-packs/skills` and `design-packs/skills` as builtin roots.
function builtinDesignSkillsDir(): string {
  return path.join(getBuiltinDesignPacksDir(), 'skills');
}

// Same caps + slug regex as AgentsService — skills are markdown +
// optional helper directories, never huge files.
const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/i;

// Structural validation: `filePath` is a valid skill SKILL.md iff:
//   • basename is exactly 'SKILL.md'
//   • the immediate parent directory's basename matches SLUG_RE
//   • the resolved path sits under one of the known skill roots:
//       - builtin skills dir   (<resourcesPath>/builtin-packs/skills)
//       - <anyDir>/.claude/skills  (global + project + any nested layout
//         such as <root>/.claude/skills/design-skills/<slug>/SKILL.md)
//       - <homedir>/.claude/plugins/marketplaces/...     (plugin scope)
//
// Nesting inside `.claude/skills` is allowed because some skill
// collections (incl. the bundled design-packs) sub-categorize.
// The boundary that matters is: writes/deletes never escape one of the
// three known root subtrees and never name a file other than SKILL.md.
function isValidSkillPath(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  if (path.basename(resolved) !== 'SKILL.md') return false;
  const parent = path.dirname(resolved);
  const slug = path.basename(parent);
  if (!SLUG_RE.test(slug)) return false;

  // Walk parents looking for `.claude/skills` boundary or one of the
  // known absolute roots. Cap the walk at 12 levels so a pathological
  // input can't spin.
  const builtinDir = path.resolve(getBuiltinSkillsDir());
  const designSkillsDir = path.resolve(builtinDesignSkillsDir());
  const marketplacesDir = path.resolve(pluginMarketplacesDir());

  if (
    resolved === path.join(builtinDir, slug, 'SKILL.md') ||
    isUnderPrefix(resolved, builtinDir)
  ) {
    return true;
  }
  // The bundled design-packs skills are a second builtin root — accept them
  // so duplication + reading works exactly like the main builtin pack.
  if (
    resolved === path.join(designSkillsDir, slug, 'SKILL.md') ||
    isUnderPrefix(resolved, designSkillsDir)
  ) {
    return true;
  }
  if (isUnderPrefix(resolved, marketplacesDir)) {
    // Plugin marketplaces are user-controlled but read-only at write
    // time — list reads them, save/delete reject them later.
    return true;
  }

  let cursor = parent;
  for (let depth = 0; depth < 12; depth++) {
    const above = path.dirname(cursor);
    if (above === cursor) break;
    if (
      path.basename(cursor) === 'skills' &&
      path.basename(above) === '.claude'
    ) {
      return true;
    }
    cursor = above;
  }
  return false;
}

function isUnderPrefix(child: string, parent: string): boolean {
  const p = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(p);
}

// Re-exported so the IPC handler can enforce path validation BEFORE
// dispatching to any service function. Service functions stay
// validation-free so internal callers (e.g. the design-skill seeder)
// can use `readSkill` against the design-packs tree which lives outside
// the usual scope roots.
export function assertValidSkillPath(filePath: string): void {
  if (!isValidSkillPath(filePath)) {
    throw new Error(
      `refuse to operate on path outside skill scopes: ${filePath}`,
    );
  }
}

function isInBuiltinSkillsDir(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  const builtinDir = path.resolve(getBuiltinSkillsDir()) + path.sep;
  const designDir = path.resolve(builtinDesignSkillsDir()) + path.sep;
  // BOTH bundled roots are read-only builtins — save/delete must refuse to
  // mutate either, so the design-packs skills behave like every other
  // builtin (duplicate-to-edit only).
  return resolved.startsWith(builtinDir) || resolved.startsWith(designDir);
}

function isInPluginMarketplacesDir(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  const root = path.resolve(pluginMarketplacesDir()) + path.sep;
  return resolved.startsWith(root);
}

async function readSkillFile(filePath: string): Promise<string> {
  const st = await fs.promises.lstat(filePath);
  if (!st.isFile()) {
    throw new Error(`refusing non-regular skill file: ${filePath}`);
  }
  if (st.size > MAX_SKILL_FILE_BYTES) {
    throw new Error(`skill file too large (${st.size} bytes)`);
  }
  return fs.promises.readFile(filePath, 'utf8');
}

// ─── public API ─────────────────────────────────────────────────────────────

export async function listSkills(
  projectPath: string | null,
  options?: { includePlugins?: boolean },
): Promise<SkillDef[]> {
  const out: SkillDef[] = [];
  await collectFromDir(globalSkillsDir(), 'global', out);
  if (projectPath) {
    await collectFromDir(projectSkillsDir(projectPath), 'project', out);
  }
  if (options?.includePlugins) {
    await collectPluginSkills(out);
  }
  // v0.11: bundled starter pack. Same per-slug folder layout as the
  // user-facing dirs, so collectFromDir handles it without modification.
  // Skip silently when the directory hasn't been curated yet (fresh
  // clone of the repo before assets are copied).
  if (await builtinPacksExist()) {
    await collectFromDir(getBuiltinSkillsDir(), 'builtin', out);
  }
  // v0.31: bundled design-packs ship layout SKILL.md under
  // `design-packs/skills/`. When seeding is ENABLED (the default), those same
  // slugs are copied into `~/.claude/skills` and collected above as `global`
  // — so surfacing the builtin root too would list every design skill twice
  // (active-global + dimmed-builtin). We therefore only add the builtin root
  // as a *fallback* for visibility when seeding is disabled. Guarded by the
  // bundle existence check — a fresh clone without the design bundle skips it.
  if ((await designPacksExist()) && !(await getSeedingEnabled())) {
    await collectFromDir(builtinDesignSkillsDir(), 'builtin', out);
  }

  // Precedence: project > global > plugin > builtin. Lower-priority
  // entries with a shadowed slug get `overridden = true`; the winner is
  // left alone. We list ALL entries — UI decides what to dim/filter.
  markOverridden(out);

  out.sort((a, b) => {
    if (a.scope !== b.scope) {
      const order: Record<SkillScope, number> = {
        project: 0,
        global: 1,
        plugin: 2,
        builtin: 3,
      };
      return order[a.scope] - order[b.scope];
    }
    return a.slug.localeCompare(b.slug);
  });
  return out;
}

export async function readSkill(filePath: string): Promise<SkillDef> {
  // Path validation lives at the IPC boundary (ipc/skills.ts) — internal
  // callers walk known directories themselves and shouldn't be subject to
  // the IPC-shape rules.
  const raw = await readSkillFile(filePath);
  const slug = path.basename(path.dirname(filePath));
  // Scope inference uses resolved paths with directory boundaries so a
  // sibling like `~/.claude/skills-other/` can't masquerade as global.
  const resolved = path.resolve(filePath);
  const builtinPrefix = path.resolve(getBuiltinSkillsDir()) + path.sep;
  const designPrefix = path.resolve(builtinDesignSkillsDir()) + path.sep;
  const globalPrefix = path.resolve(globalSkillsDir()) + path.sep;
  let scope: SkillScope;
  if (resolved.startsWith(builtinPrefix) || resolved.startsWith(designPrefix)) {
    scope = 'builtin';
  } else if (isInPluginMarketplacesDir(resolved)) {
    scope = 'plugin';
  } else if (resolved.startsWith(globalPrefix)) {
    scope = 'global';
  } else {
    scope = 'project';
  }
  return parseSkill(filePath, scope, slug, raw);
}

export async function saveSkill(skill: SkillDef): Promise<SkillDef> {
  if (skill.scope === 'plugin') {
    throw new Error('plugin skills are read-only — duplicate to user scope first');
  }
  if (skill.scope === 'builtin') {
    throw new Error(
      'builtin skills are read-only — duplicate to global or project scope first',
    );
  }
  // Path validation lives at IPC boundary (ipc/skills.ts).
  if (isInBuiltinSkillsDir(skill.path)) {
    throw new Error('refuse to write inside bundled builtin skills directory');
  }
  if (isInPluginMarketplacesDir(skill.path)) {
    throw new Error('refuse to write inside plugin marketplaces directory');
  }
  await fs.promises.mkdir(path.dirname(skill.path), { recursive: true });
  const text = serializeSkill(skill);
  await fs.promises.writeFile(skill.path, text);
  return readSkill(skill.path);
}

export async function createSkill(
  scope: 'global' | 'project',
  projectPath: string | null,
  slug: string,
): Promise<SkillDef> {
  const cleanSlug = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!cleanSlug) throw new Error('skill slug must contain letters or digits');
  const baseDir =
    scope === 'global' ? globalSkillsDir() : projectSkillsDir(projectPath ?? '');
  if (scope === 'project' && !projectPath) {
    throw new Error('project scope requires a projectPath');
  }
  const dir = path.join(baseDir, cleanSlug);
  await fs.promises.mkdir(dir, { recursive: true });
  const target = path.join(dir, 'SKILL.md');
  try {
    await fs.promises.access(target);
    throw new Error(`skill already exists: ${target}`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
  }
  const initial: SkillDef = {
    path: target,
    scope,
    slug: cleanSlug,
    name: cleanSlug,
    description: 'TODO: one-line description of when claude should load this skill.',
    extra: {},
    body:
      '\n# Skill\n\nDescribe how Claude should use this skill here.\n\n## When to use\n\n- bullet 1\n- bullet 2\n',
  };
  return saveSkill(initial);
}

export async function deleteSkill(filePath: string): Promise<void> {
  // CRITICAL: recursive directory removal. Path validation MUST happen
  // at the IPC boundary in `ipc/skills.ts` (assertValidSkillPath) before
  // we reach this point. Internal callers must not invoke deleteSkill on
  // unvalidated paths — there are currently none, but treat this as a
  // load-bearing invariant.
  // Refuse to touch read-only sources (builtin bundle, plugin marketplace).
  if (isInBuiltinSkillsDir(filePath)) {
    throw new Error('refuse to delete bundled builtin skill');
  }
  if (isInPluginMarketplacesDir(filePath)) {
    throw new Error('refuse to delete plugin-managed skill from a marketplace');
  }
  const dir = path.dirname(path.resolve(filePath));
  await fs.promises.rm(dir, { recursive: true, force: true });
}

// v0.11: duplicate any-scope skill (typically builtin) into global/project
// so the user can edit it. Copies SKILL.md plus any sibling assets the
// skill ships with (references/, examples/, scripts/, etc.) so the
// duplicate is a complete, working copy that doesn't depend on the
// original folder.
export async function duplicateSkill(
  filePath: string,
  targetScope: 'global' | 'project',
  projectPath: string | null,
): Promise<SkillDef> {
  if (targetScope === 'project' && !projectPath) {
    throw new Error('project scope requires a projectPath');
  }
  // Source path validation lives at IPC boundary (ipc/skills.ts). Slug
  // shape is still enforced here so an internal caller can't accidentally
  // create folders with traversal-like names.
  const slug = path.basename(path.dirname(filePath));
  if (!SLUG_RE.test(slug)) {
    throw new Error(`invalid skill slug derived from source: ${slug}`);
  }

  const baseDir =
    targetScope === 'global' ? globalSkillsDir() : projectSkillsDir(projectPath ?? '');
  const destDir = path.join(baseDir, slug);

  // Belt-and-braces dest containment check.
  const resolvedDest = path.resolve(destDir);
  const resolvedBase = path.resolve(baseDir) + path.sep;
  if (!resolvedDest.startsWith(resolvedBase)) {
    throw new Error('duplicate destination escapes target scope');
  }

  // Fail fast if destination already exists — we never overwrite.
  try {
    await fs.promises.access(destDir);
    throw new Error(`skill already exists at destination: ${destDir}`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
  }

  // Recursive copy of the entire skill folder. fs.cp preserves directory
  // structure so siblings (references/, examples/, assets/, scripts/) all
  // come along. We pre-size-check the SKILL.md before copying to surface
  // a clean error rather than failing mid-copy.
  await readSkillFile(filePath); // throws if too large
  const srcDir = path.dirname(path.resolve(filePath));
  await fs.promises.mkdir(path.dirname(destDir), { recursive: true });
  await fs.promises.cp(srcDir, destDir, { recursive: true, errorOnExist: true });

  return readSkill(path.join(destDir, 'SKILL.md'));
}

// ─── internals ──────────────────────────────────────────────────────────────

async function collectFromDir(
  baseDir: string,
  scope: SkillScope,
  out: SkillDef[],
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(baseDir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn(`failed to read ${baseDir}: ${(err as Error).message}`);
    }
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    // Slug shape gate — defense in depth against unusual folder names
    // on disk (symlinks, leftover from manual edits). Folders that don't
    // match the slug regex are silently skipped rather than parsed.
    if (!SLUG_RE.test(e.name)) continue;
    const skillFile = path.join(baseDir, e.name, 'SKILL.md');
    try {
      const raw = await readSkillFile(skillFile);
      out.push(parseSkill(skillFile, scope, e.name, raw));
    } catch {
      // No SKILL.md in that folder — skip silently. Some users keep stray
      // folders here (e.g. archived skills) and warning per-skip would
      // be noisy.
    }
  }
}

async function collectPluginSkills(out: SkillDef[]): Promise<void> {
  // Walk marketplaces/<mkt>/.../skills/<name>/SKILL.md. The marketplace
  // layout is up to each plugin author, so we look for any skills/
  // subdirectory at depth >= 2 under marketplaces/.
  const root = pluginMarketplacesDir();
  let marketplaces: fs.Dirent[];
  try {
    marketplaces = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const mkt of marketplaces) {
    if (!mkt.isDirectory()) continue;
    const mktDir = path.join(root, mkt.name);
    // Look for skills/ either at the marketplace root or one level down
    // (some marketplaces nest by plugin name first).
    const candidates = [mktDir];
    try {
      const entries = await fs.promises.readdir(mktDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) candidates.push(path.join(mktDir, e.name));
      }
    } catch {
      /* skip */
    }
    for (const candidate of candidates) {
      const skillsDir = path.join(candidate, 'skills');
      let skillFolders: fs.Dirent[];
      try {
        skillFolders = await fs.promises.readdir(skillsDir, {
          withFileTypes: true,
        });
      } catch {
        continue;
      }
      for (const s of skillFolders) {
        if (!s.isDirectory()) continue;
        if (!SLUG_RE.test(s.name)) continue;
        const skillFile = path.join(skillsDir, s.name, 'SKILL.md');
        try {
          const raw = await readSkillFile(skillFile);
          const skill = parseSkill(skillFile, 'plugin', s.name, raw);
          skill.pluginSource = `${mkt.name}${candidate === mktDir ? '' : `/${path.basename(candidate)}`}`;
          out.push(skill);
        } catch {
          /* not a skill */
        }
      }
    }
  }
}

// Walk the collected skills and stamp `overridden = true` on the
// lower-priority duplicate for any slug that exists at more than one
// scope. Precedence: project > global > plugin > builtin.
function markOverridden(skills: SkillDef[]): void {
  const priority: Record<SkillScope, number> = {
    project: 4,
    global: 3,
    plugin: 2,
    builtin: 1,
  };
  const winners = new Map<string, SkillDef>();
  for (const s of skills) {
    const existing = winners.get(s.slug);
    if (!existing) {
      winners.set(s.slug, s);
      continue;
    }
    if (priority[s.scope] > priority[existing.scope]) {
      existing.overridden = true;
      winners.set(s.slug, s);
    } else {
      s.overridden = true;
    }
  }
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function parseSkill(
  filePath: string,
  scope: SkillScope,
  slug: string,
  raw: string,
): SkillDef {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) {
    return {
      path: filePath,
      scope,
      slug,
      name: slug,
      description: '',
      extra: {},
      body: raw,
    };
  }
  const known: {
    name?: string;
    description?: string;
    model?: string;
    allowedTools?: string[];
  } = {};
  const extra: Record<string, unknown> = {};
  const lines = m[1]!.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    const inlineList = /^([A-Za-z0-9_-]+):\s*\[(.*)\]\s*$/.exec(line);
    if (inlineList) {
      assign(inlineList[1]!, parseInlineList(inlineList[2]!), known, extra);
      continue;
    }
    const blockListStart = /^([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (
      blockListStart &&
      i + 1 < lines.length &&
      /^\s+-\s/.test(lines[i + 1]!)
    ) {
      const key = blockListStart[1]!;
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^\s+-\s/.test(lines[j]!)) {
        items.push(stripQuotes(lines[j]!.replace(/^\s+-\s/, '').trim()));
        j++;
      }
      assign(key, items, known, extra);
      i = j - 1;
      continue;
    }
    const scalar = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (scalar) {
      assign(scalar[1]!, stripQuotes(scalar[2]!.trim()), known, extra);
      continue;
    }
    extra[`__line_${i}`] = line;
  }

  return {
    path: filePath,
    scope,
    slug,
    name: known.name ?? slug,
    description: known.description ?? '',
    model: known.model,
    allowedTools: known.allowedTools,
    extra,
    body: m[2] ?? '',
  };
}

function assign(
  key: string,
  value: string | string[],
  known: {
    name?: string;
    description?: string;
    model?: string;
    allowedTools?: string[];
  },
  extra: Record<string, unknown>,
): void {
  // Skills use the hyphenated `allowed-tools` form on disk. The list /
  // comma-string distinction is normalized into a string[] either way.
  if (key === 'name' && typeof value === 'string') known.name = value;
  else if (key === 'description' && typeof value === 'string')
    known.description = value;
  else if (key === 'model' && typeof value === 'string') known.model = value;
  else if (key === 'allowed-tools' || key === 'allowedTools') {
    if (Array.isArray(value)) known.allowedTools = value;
    else if (typeof value === 'string' && value !== '') {
      known.allowedTools = value.split(/[,\s]+/).filter(Boolean);
    }
  } else extra[key] = value;
}

function parseInlineList(s: string): string[] {
  return s
    .split(',')
    .map((x) => stripQuotes(x.trim()))
    .filter((x) => x.length > 0);
}

function stripQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function serializeSkill(skill: SkillDef): string {
  const out: string[] = ['---'];
  out.push(`name: ${skill.name || skill.slug}`);
  out.push(`description: ${quoteIfNeeded(skill.description ?? '')}`);
  if (skill.allowedTools && skill.allowedTools.length > 0) {
    out.push(`allowed-tools: ${skill.allowedTools.join(', ')}`);
  }
  if (skill.model) out.push(`model: ${skill.model}`);
  for (const [k, v] of Object.entries(skill.extra)) {
    if (k.startsWith('__line_')) {
      out.push(String(v));
      continue;
    }
    if (Array.isArray(v)) {
      out.push(`${k}:`);
      for (const item of v) out.push(`  - ${String(item)}`);
    } else {
      out.push(`${k}: ${quoteIfNeeded(String(v))}`);
    }
  }
  out.push('---');
  const body = skill.body.startsWith('\n') ? skill.body : `\n${skill.body}`;
  return `${out.join('\n')}${body.endsWith('\n') ? body : `${body}\n`}`;
}

function quoteIfNeeded(s: string): string {
  if (/:\s/.test(s) || /^[-?:|>!@`#%&*,{}[\]]/.test(s)) {
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  return s;
}
