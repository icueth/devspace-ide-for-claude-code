import { homedir } from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createLogger } from '@shared/logger';
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
  out.sort((a, b) => {
    if (a.scope !== b.scope) {
      const order: Record<SkillScope, number> = {
        global: 0,
        project: 1,
        plugin: 2,
      };
      return order[a.scope] - order[b.scope];
    }
    return a.slug.localeCompare(b.slug);
  });
  return out;
}

export async function readSkill(filePath: string): Promise<SkillDef> {
  const raw = await fs.promises.readFile(filePath, 'utf8');
  const home = homedir();
  const slug = path.basename(path.dirname(filePath));
  const scope: SkillScope = filePath.includes(
    path.join(home, '.claude', 'plugins'),
  )
    ? 'plugin'
    : filePath.startsWith(path.join(home, '.claude', 'skills'))
      ? 'global'
      : 'project';
  return parseSkill(filePath, scope, slug, raw);
}

export async function saveSkill(skill: SkillDef): Promise<SkillDef> {
  if (skill.scope === 'plugin') {
    throw new Error('plugin skills are read-only — duplicate to user scope first');
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
  // Remove the entire skill folder. SKILL.md is the marker file but the
  // folder may also hold assets (templates, helpers). Refusing to touch
  // plugin-managed skills since their lifecycle is owned elsewhere.
  const dir = path.dirname(filePath);
  if (dir.includes(pluginMarketplacesDir())) {
    throw new Error('refuse to delete plugin-managed skill from a marketplace');
  }
  await fs.promises.rm(dir, { recursive: true, force: true });
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
    const skillFile = path.join(baseDir, e.name, 'SKILL.md');
    try {
      const raw = await fs.promises.readFile(skillFile, 'utf8');
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
        const skillFile = path.join(skillsDir, s.name, 'SKILL.md');
        try {
          const raw = await fs.promises.readFile(skillFile, 'utf8');
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
