import { homedir } from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createLogger } from '@shared/logger';
import {
  builtinPacksExist,
  getBuiltinAgentsDir,
} from '@main/utils/builtinPackPaths';
import type { AgentDef, AgentScope } from '@shared/types';

const logger = createLogger('Agents');

// Claude Code's documented locations. `--print` mode discovers agents from
// the same two places the interactive CLI does:
//   • ~/.claude/agents/   — every project, every user
//   • <cwd>/.claude/agents/ — pinned to this repo
// Plus, v0.11 adds a third bundled location:
//   • <Resources>/builtin-packs/agents/ — read-only, ships with the app
function globalAgentsDir(): string {
  return path.join(homedir(), '.claude', 'agents');
}

function projectAgentsDir(projectPath: string): string {
  return path.join(projectPath, '.claude', 'agents');
}

// Hard upper bound for agent files. Real frontmatter+body never exceeds
// tens of KB; anything larger is either accidental dump or hostile input
// to slurp into memory and parse.
const MAX_AGENT_FILE_BYTES = 2 * 1024 * 1024;

// Slug must match this shape — derived from filename or duplicate-source
// path. Constrains the surface for path-traversal pollution and matches
// what claude's `/agents` CLI accepts.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/i;

// Structural path validation: `filePath` is a valid agent location iff
// it's a single .md file living directly inside one of three known shapes:
//   • <builtinDir>/<slug>.md
//   • <homedir>/.claude/agents/<slug>.md
//   • <anyDir>/.claude/agents/<slug>.md     (project-scoped)
//
// This is the security boundary for every IPC entry point that takes a
// caller-supplied path (read, save, delete, duplicate-source). Without
// it a compromised renderer can pivot the agents IPC into an arbitrary
// file-read / file-write / recursive-delete primitive.
function isValidAgentPath(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  if (!resolved.endsWith('.md')) return false;
  const parent = path.dirname(resolved);
  const base = path.basename(resolved, '.md');
  if (!SLUG_RE.test(base)) return false;

  // Direct child of builtin dir.
  const builtinDir = path.resolve(getBuiltinAgentsDir());
  if (parent === builtinDir) return true;

  // Direct child of `~/.claude/agents` or `<any>/.claude/agents`.
  if (
    path.basename(parent) === 'agents' &&
    path.basename(path.dirname(parent)) === '.claude'
  ) {
    return true;
  }

  return false;
}

// Re-exported so the IPC handler enforces path validation BEFORE
// dispatching. Service functions stay validation-free so internal
// callers can pass non-IPC-shape paths (none today, but kept consistent
// with SkillsService).
export function assertValidAgentPath(filePath: string): void {
  if (!isValidAgentPath(filePath)) {
    throw new Error(`refuse to operate on path outside agent scopes: ${filePath}`);
  }
}

function isInBuiltinAgentsDir(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  const builtinDir = path.resolve(getBuiltinAgentsDir()) + path.sep;
  return resolved.startsWith(builtinDir);
}

async function readAgentFile(filePath: string): Promise<string> {
  const st = await fs.promises.lstat(filePath);
  if (!st.isFile()) {
    throw new Error(`refusing non-regular agent file: ${filePath}`);
  }
  if (st.size > MAX_AGENT_FILE_BYTES) {
    throw new Error(`agent file too large (${st.size} bytes)`);
  }
  return fs.promises.readFile(filePath, 'utf8');
}

// ─── result cache ────────────────────────────────────────────────────────────
//
// listAgents reads every agent .md across global+project+builtin roots. We
// cache the assembled result per projectPath with a short TTL AND a cheap
// directory snapshot (mtime + entry count per root, mirroring DevlogService /
// SkillsService). On a hit with a matching snapshot we skip the N reads.
const LIST_CACHE_TTL_MS = 4000;

interface DirSnap {
  mtimeMs: number;
  count: number;
}
type RootsSnapshot = Record<string, DirSnap>;

interface AgentsCacheEntry {
  result: AgentDef[];
  snapshot: RootsSnapshot;
  expires: number;
}

const agentsListCache = new Map<string, AgentsCacheEntry>();

async function snapshotDir(dir: string): Promise<DirSnap> {
  try {
    const st = await fs.promises.stat(dir);
    const names = await fs.promises.readdir(dir);
    return { mtimeMs: st.mtimeMs, count: names.length };
  } catch {
    return { mtimeMs: -1, count: 0 };
  }
}

async function snapshotRoots(roots: string[]): Promise<RootsSnapshot> {
  const snap: RootsSnapshot = {};
  await Promise.all(
    roots.map(async (r) => {
      snap[r] = await snapshotDir(r);
    }),
  );
  return snap;
}

function snapshotsEqual(a: RootsSnapshot, b: RootsSnapshot): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    const av = a[k];
    const bv = b[k];
    if (!bv || !av) return false;
    if (av.mtimeMs !== bv.mtimeMs || av.count !== bv.count) return false;
  }
  return true;
}

/**
 * Drop all cached listAgents results. MUST be called after every agent
 * mutation (save/create/delete/duplicate) — an in-place edit to an agent .md
 * changes neither the parent dir's mtime nor its entry count, so the
 * snapshot-based TTL cache cannot detect it and would serve a stale
 * name/description to the Settings list + agent pickers within the TTL.
 */
export function invalidateAgentsCache(): void {
  agentsListCache.clear();
}

/** Test-only alias. */
export const __resetAgentsCacheForTests = invalidateAgentsCache;

// ─── public API ─────────────────────────────────────────────────────────────

export async function listAgents(projectPath: string | null): Promise<AgentDef[]> {
  const dirs: Array<{ dir: string; scope: AgentScope }> = [
    { dir: globalAgentsDir(), scope: 'global' },
  ];
  if (projectPath) {
    dirs.push({ dir: projectAgentsDir(projectPath), scope: 'project' });
  }

  // Builtin pack ships under <Resources>/builtin-packs/agents/. In rare dev
  // cases (fresh clone before curation) the directory may not exist — skip
  // silently in that case rather than spam warnings.
  if (await builtinPacksExist()) {
    dirs.push({ dir: getBuiltinAgentsDir(), scope: 'builtin' });
  }

  const snapRoots = dirs.map((d) => path.resolve(d.dir));
  const key = path.resolve(projectPath ?? '');
  const now = Date.now();
  const cached = agentsListCache.get(key);
  if (cached && cached.expires > now) {
    const fresh = await snapshotRoots(snapRoots);
    if (snapshotsEqual(cached.snapshot, fresh)) {
      // Fresh array so callers can't mutate the cached list; AgentDef
      // entries themselves are treated as read-only.
      return cached.result.slice();
    }
  }

  const snapshot = await snapshotRoots(snapRoots);

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
    // Read every candidate agent file in parallel rather than awaiting each
    // sequentially. The .md filter, isValidAgentPath gate (symlink/slug
    // defense in depth), and lstat/size guards in readAgentFile are all
    // preserved per file; parse failures still log + skip.
    const candidates = entries.filter(
      (e) =>
        e.isFile() &&
        e.name.endsWith('.md') &&
        isValidAgentPath(path.join(dir, e.name)),
    );
    const parsed = await Promise.all(
      candidates.map(async (e) => {
        const filePath = path.join(dir, e.name);
        try {
          const raw = await readAgentFile(filePath);
          return parseAgent(filePath, scope, raw);
        } catch (err) {
          logger.warn(`failed to parse ${filePath}: ${(err as Error).message}`);
          return null;
        }
      }),
    );
    for (const a of parsed) {
      if (a) out.push(a);
    }
  }

  // Precedence: project > global > builtin. The lower-priority entry of
  // any shadowed slug gets `overridden = true`; the winning entry is left
  // untouched. We list ALL entries — the Settings UI dims overrides, the
  // picker can filter as it likes.
  markOverridden(out);

  // Stable sort: project first, then global, then builtin; within a scope
  // sort by slug. Matches the original two-scope ordering and tacks
  // builtin on the bottom.
  const scopeOrder: Record<AgentScope, number> = {
    project: 0,
    global: 1,
    builtin: 2,
  };
  out.sort((a, b) => {
    if (a.scope !== b.scope) return scopeOrder[a.scope] - scopeOrder[b.scope];
    return a.slug.localeCompare(b.slug);
  });

  // Store a copy so a caller mutating the returned array can't corrupt the
  // cached list (the cache hit path also returns a copy).
  agentsListCache.set(key, {
    result: out.slice(),
    snapshot,
    expires: now + LIST_CACHE_TTL_MS,
  });
  return out;
}

export async function readAgent(filePath: string): Promise<AgentDef> {
  // Path validation lives at the IPC boundary (ipc/agents.ts).
  const raw = await readAgentFile(filePath);
  // Infer scope from the resolved path with directory-boundary checks
  // (string startsWith would accept `~/.claude/agents-other/...`).
  const resolved = path.resolve(filePath);
  const builtinDir = path.resolve(getBuiltinAgentsDir()) + path.sep;
  const globalDir = path.resolve(globalAgentsDir()) + path.sep;
  let scope: AgentScope = 'project';
  if (resolved.startsWith(builtinDir)) scope = 'builtin';
  else if (resolved.startsWith(globalDir)) scope = 'global';
  return parseAgent(filePath, scope, raw);
}

export async function saveAgent(agent: AgentDef): Promise<AgentDef> {
  if (agent.scope === 'builtin') {
    throw new Error(
      'builtin agents are read-only — duplicate to global or project scope first',
    );
  }
  // Path validation lives at the IPC boundary (ipc/agents.ts).
  if (isInBuiltinAgentsDir(agent.path)) {
    throw new Error('refuse to write inside bundled builtin agents directory');
  }
  await fs.promises.mkdir(path.dirname(agent.path), { recursive: true });
  const text = serializeAgent(agent);
  await fs.promises.writeFile(agent.path, text);
  invalidateAgentsCache();
  // Re-read to normalize (whitespace, key ordering) so the renderer sees
  // exactly what landed on disk.
  return readAgent(agent.path);
}

export async function createAgent(
  scope: AgentScope,
  projectPath: string | null,
  slug: string,
): Promise<AgentDef> {
  if (scope === 'builtin') {
    throw new Error('cannot create builtin agents — they ship with the app');
  }
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
  // Path validation lives at the IPC boundary (ipc/agents.ts).
  // Refuse to delete bundled builtin agents — they live inside the .app's
  // resources and would be restored on next launch anyway. Use the resolved
  // path so a symlink can't sneak through (same string-prefix bypass we
  // closed for readAgent's scope inference).
  if (isInBuiltinAgentsDir(filePath)) {
    throw new Error('refuse to delete bundled builtin agent');
  }
  await fs.promises.unlink(path.resolve(filePath));
  invalidateAgentsCache();
}

// v0.11: duplicate a builtin (or any-scope) agent into global/project so
// the user can edit it. Preserves frontmatter + body verbatim, refuses to
// overwrite an existing slug at the destination.
export async function duplicateAgent(
  filePath: string,
  targetScope: 'global' | 'project',
  projectPath: string | null,
): Promise<AgentDef> {
  if (targetScope === 'project' && !projectPath) {
    throw new Error('project scope requires a projectPath');
  }
  // Source path validation lives at the IPC boundary (ipc/agents.ts).
  const slug = path.basename(filePath, '.md');
  if (!SLUG_RE.test(slug)) {
    throw new Error(`invalid agent slug derived from source: ${slug}`);
  }
  const raw = await readAgentFile(filePath);

  const destDir =
    targetScope === 'global' ? globalAgentsDir() : projectAgentsDir(projectPath ?? '');
  await fs.promises.mkdir(destDir, { recursive: true });
  const destPath = path.join(destDir, `${slug}.md`);

  // Belt-and-braces: confirm dest stays inside destDir after resolution.
  const resolvedDest = path.resolve(destPath);
  const resolvedDestDir = path.resolve(destDir) + path.sep;
  if (!resolvedDest.startsWith(resolvedDestDir)) {
    throw new Error('duplicate destination escapes target scope');
  }

  try {
    await fs.promises.access(destPath);
    throw new Error(`agent already exists at destination: ${destPath}`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
  }

  await fs.promises.writeFile(destPath, raw);
  invalidateAgentsCache();
  return readAgent(destPath);
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

// Walk the collected agents and stamp `overridden = true` on the
// lower-priority duplicate for any slug that exists at more than one
// scope. Precedence: project > global > builtin.
function markOverridden(agents: AgentDef[]): void {
  const priority: Record<AgentScope, number> = {
    project: 3,
    global: 2,
    builtin: 1,
  };
  // bySlug holds the current "winner" — the highest-priority scope seen
  // for that slug so far. Every other entry with the same slug gets
  // tagged `overridden`.
  const winners = new Map<string, AgentDef>();
  for (const a of agents) {
    const existing = winners.get(a.slug);
    if (!existing) {
      winners.set(a.slug, a);
      continue;
    }
    if (priority[a.scope] > priority[existing.scope]) {
      existing.overridden = true;
      winners.set(a.slug, a);
    } else {
      a.overridden = true;
    }
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
