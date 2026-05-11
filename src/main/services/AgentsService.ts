import { homedir } from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createLogger } from '@shared/logger';
import type { AgentDef, AgentScope } from '@shared/types';

const logger = createLogger('Agents');

// Claude Code's documented locations. `--print` mode discovers agents from
// the same two places the interactive CLI does:
//   • ~/.claude/agents/   — every project, every user
//   • <cwd>/.claude/agents/ — pinned to this repo
function globalAgentsDir(): string {
  return path.join(homedir(), '.claude', 'agents');
}

function projectAgentsDir(projectPath: string): string {
  return path.join(projectPath, '.claude', 'agents');
}

// ─── public API ─────────────────────────────────────────────────────────────

export async function listAgents(projectPath: string | null): Promise<AgentDef[]> {
  const dirs: Array<{ dir: string; scope: AgentScope }> = [
    { dir: globalAgentsDir(), scope: 'global' },
  ];
  if (projectPath) {
    dirs.push({ dir: projectAgentsDir(projectPath), scope: 'project' });
  }

  const out: AgentDef[] = [];
  for (const { dir, scope } of dirs) {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.warn(`failed to read ${dir}: ${(err as Error).message}`);
      }
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      const filePath = path.join(dir, e.name);
      try {
        const raw = await fs.promises.readFile(filePath, 'utf8');
        out.push(parseAgent(filePath, scope, raw));
      } catch (err) {
        logger.warn(`failed to parse ${filePath}: ${(err as Error).message}`);
      }
    }
  }
  // Stable sort: scope (global before project) then slug.
  out.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === 'global' ? -1 : 1;
    return a.slug.localeCompare(b.slug);
  });
  return out;
}

export async function readAgent(filePath: string): Promise<AgentDef> {
  const raw = await fs.promises.readFile(filePath, 'utf8');
  // Infer scope from the path — anything under the user's home counts as
  // global, otherwise project. Edge case: a project rooted at the home
  // dir collapses to global, which is fine for our purposes.
  const home = homedir();
  const scope: AgentScope =
    filePath.startsWith(path.join(home, '.claude', 'agents'))
      ? 'global'
      : 'project';
  return parseAgent(filePath, scope, raw);
}

export async function saveAgent(agent: AgentDef): Promise<AgentDef> {
  await fs.promises.mkdir(path.dirname(agent.path), { recursive: true });
  const text = serializeAgent(agent);
  await fs.promises.writeFile(agent.path, text);
  // Re-read to normalize (whitespace, key ordering) so the renderer sees
  // exactly what landed on disk.
  return readAgent(agent.path);
}

export async function createAgent(
  scope: AgentScope,
  projectPath: string | null,
  slug: string,
): Promise<AgentDef> {
  const cleanSlug = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!cleanSlug) throw new Error('agent slug must contain letters or digits');
  const dir =
    scope === 'global' ? globalAgentsDir() : projectAgentsDir(projectPath ?? '');
  if (scope === 'project' && !projectPath) {
    throw new Error('project scope requires a projectPath');
  }
  await fs.promises.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${cleanSlug}.md`);
  try {
    await fs.promises.access(target);
    throw new Error(`agent already exists: ${target}`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
  }
  const initial: AgentDef = {
    path: target,
    scope,
    slug: cleanSlug,
    name: cleanSlug,
    description: 'TODO: describe when Claude should dispatch to this agent.',
    extra: {},
    body: '\nYou are a specialized agent. Replace this body with the system prompt that defines this agent\'s behavior.\n',
  };
  return saveAgent(initial);
}

export async function deleteAgent(filePath: string): Promise<void> {
  await fs.promises.unlink(filePath);
}

// ─── parser / serializer ────────────────────────────────────────────────────
//
// We don't pull in a YAML library — the frontmatter we support is a
// constrained subset that hand-rolls cleanly. Format:
//
//   ---
//   name: value
//   description: free-form text or "quoted, possibly with: colon"
//   model: sonnet
//   tools:
//     - Read
//     - Edit
//   color: blue
//   ---
//   <markdown body…>
//
// We preserve unknown scalar/array keys via `extra` so user-custom fields
// like `skills:` or `memory:` survive a round trip through the editor.

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

interface ParsedFrontmatter {
  known: {
    name?: string;
    description?: string;
    model?: string;
    tools?: string[];
    color?: string;
  };
  extra: Record<string, unknown>;
}

function parseAgent(filePath: string, scope: AgentScope, raw: string): AgentDef {
  const slug = path.basename(filePath, '.md');
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) {
    // No frontmatter — treat the whole file as body with empty metadata.
    // Lets us still render and edit malformed files instead of dropping
    // them on the floor.
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
  const fm = parseFrontmatter(m[1]!);
  return {
    path: filePath,
    scope,
    slug,
    name: fm.known.name ?? slug,
    description: fm.known.description ?? '',
    model: fm.known.model,
    tools: fm.known.tools,
    color: fm.known.color,
    extra: fm.extra,
    body: m[2] ?? '',
  };
}

function parseFrontmatter(block: string): ParsedFrontmatter {
  const known: ParsedFrontmatter['known'] = {};
  const extra: Record<string, unknown> = {};
  const lines = block.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    // Inline list: `tools: [a, b]`
    const inlineList = /^([A-Za-z0-9_-]+):\s*\[(.*)\]\s*$/.exec(line);
    if (inlineList) {
      const key = inlineList[1]!;
      const items = parseInlineList(inlineList[2]!);
      assignField(key, items, known, extra);
      continue;
    }
    // Block list start: `tools:` followed by `  - item` lines
    const blockListStart = /^([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (blockListStart && i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1]!)) {
      const key = blockListStart[1]!;
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^\s+-\s/.test(lines[j]!)) {
        const item = lines[j]!.replace(/^\s+-\s/, '').trim();
        items.push(stripQuotes(item));
        j++;
      }
      assignField(key, items, known, extra);
      i = j - 1;
      continue;
    }
    // Scalar: `key: value`
    const scalar = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (scalar) {
      const key = scalar[1]!;
      const rawVal = scalar[2]!;
      const value = stripQuotes(rawVal.trim());
      assignField(key, value, known, extra);
      continue;
    }
    // Anything we can't parse becomes a comment in `extra` so it isn't lost.
    extra[`__line_${i}`] = line;
  }

  return { known, extra };
}

function parseInlineList(s: string): string[] {
  // Simple comma split, then trim + strip quotes. Doesn't handle quoted
  // strings containing commas — none of the agent files in the wild use
  // that form, and we can always upgrade later.
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

function assignField(
  key: string,
  value: string | string[],
  known: ParsedFrontmatter['known'],
  extra: Record<string, unknown>,
): void {
  switch (key) {
    case 'name':
      if (typeof value === 'string') known.name = value;
      break;
    case 'description':
      if (typeof value === 'string') known.description = value;
      break;
    case 'model':
      if (typeof value === 'string') known.model = value;
      break;
    case 'color':
      if (typeof value === 'string') known.color = value;
      break;
    case 'tools':
      if (Array.isArray(value)) known.tools = value;
      else if (typeof value === 'string' && value !== '') {
        // tolerate `tools: Read,Edit` written as scalar
        known.tools = value.split(/[,\s]+/).filter(Boolean);
      }
      break;
    default:
      extra[key] = value;
  }
}

function serializeAgent(agent: AgentDef): string {
  const out: string[] = ['---'];
  // Required first
  out.push(`name: ${agent.name || agent.slug}`);
  out.push(`description: ${quoteIfNeeded(agent.description ?? '')}`);
  if (agent.model) out.push(`model: ${agent.model}`);
  if (agent.color) out.push(`color: ${agent.color}`);
  if (agent.tools && agent.tools.length > 0) {
    out.push('tools:');
    for (const t of agent.tools) out.push(`  - ${t}`);
  }
  // Round-trip unknown keys.
  for (const [k, v] of Object.entries(agent.extra)) {
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
  // Ensure a newline between frontmatter and body — most editors add one
  // implicitly but explicit normalization keeps diffs clean.
  const body = agent.body.startsWith('\n') ? agent.body : `\n${agent.body}`;
  return `${out.join('\n')}${body.endsWith('\n') ? body : `${body}\n`}`;
}

function quoteIfNeeded(s: string): string {
  // Wrap in double-quotes if the string contains a colon followed by
  // space (YAML scalar trap) or starts with a YAML-reserved character.
  if (/:\s/.test(s) || /^[-?:|>!@`#%&*,{}[\]]/.test(s)) {
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  return s;
}
