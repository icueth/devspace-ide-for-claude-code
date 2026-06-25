import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { listWorkspaces } from '@main/services/WorkspaceService';

const HOME = os.homedir();
const GLOBAL_CLAUDE = path.join(HOME, '.claude');

let cachedRoots: string[] | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5_000;

async function getWorkspaceRoots(): Promise<string[]> {
  const now = Date.now();
  if (cachedRoots && now < cacheExpiry) return cachedRoots;
  const { workspaces } = await listWorkspaces();
  cachedRoots = workspaces.map((w) => path.resolve(w.path));
  cacheExpiry = now + CACHE_TTL_MS;
  return cachedRoots;
}

export function invalidateWorkspaceRootsCache(): void {
  cachedRoots = null;
  cacheExpiry = 0;
}

// v2 — active task worktrees live outside workspace roots
// (~/.devspace/worktrees). TaskService registers each live worktree here so the
// FileTree/diff/watcher can read inside it; unregistered on teardown.
// Module-level Set (not the TTL cache) because it changes on explicit lifecycle
// events, not on a timer.
const worktreeScopes = new Set<string>();

export function addWorktreeScope(p: string): void {
  worktreeScopes.add(path.resolve(p));
}

export function removeWorktreeScope(p: string): void {
  worktreeScopes.delete(path.resolve(p));
}

function rejectIfTraversal(p: string): void {
  if (typeof p !== 'string' || p.length === 0) {
    throw new Error('path must be a non-empty string');
  }
  if (p.includes('\0')) throw new Error('path contains null byte');
}

function isUnder(child: string, parent: string): boolean {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p + path.sep);
}

/**
 * Reject paths that do not resolve under any workspace the user has added.
 * Callers should use the returned resolved path (not the original).
 */
export async function assertInWorkspace(p: unknown): Promise<string> {
  rejectIfTraversal(p as string);
  const resolved = path.resolve(p as string);
  const roots = await getWorkspaceRoots();
  for (const root of roots) {
    if (isUnder(resolved, root)) return resolved;
  }
  for (const wt of worktreeScopes) {
    if (isUnder(resolved, wt)) return resolved;
  }
  throw new Error(`path outside any open workspace: ${p}`);
}

/**
 * Settings/agents/skills/teams/mcp paths are allowed in:
 *   - ~/.claude/**  (global)
 *   - <projectPath>/.claude/**  (project)
 *   - <projectPath>/.devspace/**  (project — for design + chat artifacts)
 *   - <projectPath>/.mcp.json   (project MCP)
 *   - <projectPath>/CLAUDE.md   (project memory)
 */
export function assertAllowedSettingsPath(
  p: unknown,
  projectPath: string | null,
): string {
  rejectIfTraversal(p as string);
  const r = path.resolve(p as string);

  if (isUnder(r, GLOBAL_CLAUDE)) return r;

  if (projectPath && typeof projectPath === 'string') {
    const pr = path.resolve(projectPath);
    if (isUnder(r, path.join(pr, '.claude'))) return r;
    if (isUnder(r, path.join(pr, '.devspace'))) return r;
    if (r === path.join(pr, '.mcp.json')) return r;
    if (r === path.join(pr, 'CLAUDE.md')) return r;
  }
  throw new Error(`settings path outside allowed scopes: ${p}`);
}

/**
 * Defeat symlink ambushes when reading files supplied by the renderer
 * or sourced from disk in service code. Returns the lstat result so callers
 * can also check file size without a second syscall.
 */
export async function assertRegularFile(p: string): Promise<fs.Stats> {
  const lst = await fs.promises.lstat(p);
  if (!lst.isFile()) {
    throw new Error(`refusing non-regular file: ${p}`);
  }
  return lst;
}

const REF_RE = /^(?!-)[A-Za-z0-9._/-]{1,200}$/;

/** Reject git refs that start with '-' (flag injection) or contain '..' */
export function assertGitRef(name: unknown): string {
  if (typeof name !== 'string' || !REF_RE.test(name) || name.includes('..')) {
    throw new Error(`invalid git ref: ${String(name)}`);
  }
  return name;
}

const REL_PATH_RE = /^[^\0\n\r]{1,1024}$/;

/** Reject relative paths that are absolute, contain newlines, or traverse */
export function assertRelativePath(p: unknown): string {
  if (typeof p !== 'string' || !REL_PATH_RE.test(p)) {
    throw new Error(`invalid relative path: ${String(p)}`);
  }
  if (p.startsWith('/') || p.startsWith('-') || p.includes('..')) {
    throw new Error(`relative path escapes or starts with flag: ${p}`);
  }
  return p;
}

const SAFE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Reject names that could trigger prototype pollution or invalid IDs */
export function assertSafeKey(name: unknown): string {
  if (typeof name !== 'string' || !SAFE_NAME_RE.test(name)) {
    throw new Error(`invalid key: ${String(name)}`);
  }
  if (RESERVED_KEYS.has(name)) {
    throw new Error(`reserved key: ${name}`);
  }
  return name;
}
