import { homedir } from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { assertInWorkspace, assertSafeKey } from '@main/utils/pathScope';
import { createLogger } from '@shared/logger';
import type {
  McpScope,
  McpServer,
  McpServerEntry,
  McpStdioServer,
  McpHttpServer,
} from '@shared/types';

const logger = createLogger('Mcp');

function globalConfigFile(): string {
  return path.join(homedir(), '.claude.json');
}

function projectConfigFile(projectPath: string): string {
  return path.join(projectPath, '.mcp.json');
}

/**
 * Resolve the file to write to, validating that:
 *  - global scope always writes ~/.claude.json (renderer cannot redirect)
 *  - project scope requires a projectPath that lives under an open workspace
 *
 * Note: legacy callers pass `filePath` from `listMcpServers`, but we never
 * trust it — we always rebuild the path from scope + projectPath.
 */
async function resolveConfigFile(
  scope: McpScope,
  projectPath: string | null | undefined,
): Promise<string> {
  if (scope === 'global') return globalConfigFile();
  if (!projectPath || typeof projectPath !== 'string') {
    throw new Error('project scope requires a projectPath');
  }
  const safe = await assertInWorkspace(projectPath);
  return projectConfigFile(safe);
}

interface RawConfig {
  mcpServers?: Record<string, RawMcpServer>;
  [key: string]: unknown;
}

interface RawMcpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  transport?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

// ─── per-file mutex to defeat read-modify-write races ───────────────────────

const writeLocks = new Map<string, Promise<void>>();

async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(file) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  writeLocks.set(file, prev.then(() => next));
  try {
    await prev;
    return await fn();
  } finally {
    release();
    // Free the map slot when the chain has drained.
    if (writeLocks.get(file) === next) writeLocks.delete(file);
  }
}

// ─── public API ─────────────────────────────────────────────────────────────

export async function listMcpServers(
  projectPath: string | null,
): Promise<McpServerEntry[]> {
  const out: McpServerEntry[] = [];
  const sources: Array<{ file: string; scope: McpScope }> = [
    { file: globalConfigFile(), scope: 'global' },
  ];
  if (projectPath && typeof projectPath === 'string') {
    // Listing doesn't write; permit any project workspace path the user added.
    try {
      const safe = await assertInWorkspace(projectPath);
      sources.push({ file: projectConfigFile(safe), scope: 'project' });
    } catch {
      // not a known workspace — quietly skip; renderer may pass a stale path
    }
  }

  for (const { file, scope } of sources) {
    const cfg = await readConfig(file);
    const servers = cfg.mcpServers ?? {};
    for (const [name, raw] of Object.entries(servers)) {
      if (typeof name !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
        continue; // skip malformed entries on read
      }
      out.push({
        name,
        scope,
        filePath: file,
        server: normalizeServer(raw),
      });
    }
  }
  out.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === 'global' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

export async function saveMcpServer(entry: McpServerEntry): Promise<McpServerEntry> {
  assertSafeKey(entry.name);
  const projectPath = entry.scope === 'project'
    ? path.dirname(entry.filePath ?? '')
    : null;
  const file = await resolveConfigFile(entry.scope, projectPath);
  return withFileLock(file, async () => {
    const cfg = await readConfig(file);
    if (!cfg.mcpServers) cfg.mcpServers = Object.create(null) as Record<string, RawMcpServer>;
    cfg.mcpServers[entry.name] = denormalizeServer(entry.server);
    await writeConfig(file, cfg);
    return { ...entry, filePath: file };
  });
}

export async function renameMcpServer(
  scope: McpScope,
  filePath: string,
  oldName: string,
  newName: string,
): Promise<void> {
  if (oldName === newName) return;
  assertSafeKey(oldName);
  assertSafeKey(newName);
  const projectPath = scope === 'project' ? path.dirname(filePath) : null;
  const file = await resolveConfigFile(scope, projectPath);
  await withFileLock(file, async () => {
    const cfg = await readConfig(file);
    if (!cfg.mcpServers?.[oldName]) {
      throw new Error(`mcp server not found: ${oldName}`);
    }
    if (cfg.mcpServers[newName]) {
      throw new Error(`mcp server already exists: ${newName}`);
    }
    cfg.mcpServers[newName] = cfg.mcpServers[oldName];
    delete cfg.mcpServers[oldName];
    await writeConfig(file, cfg);
  });
}

export async function deleteMcpServer(
  scope: McpScope,
  filePath: string,
  name: string,
): Promise<void> {
  assertSafeKey(name);
  const projectPath = scope === 'project' ? path.dirname(filePath) : null;
  const file = await resolveConfigFile(scope, projectPath);
  await withFileLock(file, async () => {
    const cfg = await readConfig(file);
    if (cfg.mcpServers) {
      delete cfg.mcpServers[name];
      await writeConfig(file, cfg);
    }
  });
}

export async function createMcpServer(
  scope: McpScope,
  projectPath: string | null,
  name: string,
  server: McpServer,
): Promise<McpServerEntry> {
  assertSafeKey(name);
  const file = await resolveConfigFile(scope, projectPath);
  return withFileLock(file, async () => {
    const cfg = await readConfig(file);
    if (!cfg.mcpServers) cfg.mcpServers = Object.create(null) as Record<string, RawMcpServer>;
    if (cfg.mcpServers[name]) {
      throw new Error(`mcp server already exists: ${name}`);
    }
    cfg.mcpServers[name] = denormalizeServer(server);
    await writeConfig(file, cfg);
    return { name, scope, filePath: file, server };
  });
}

// ─── internals ──────────────────────────────────────────────────────────────

async function readConfig(file: string): Promise<RawConfig> {
  try {
    const raw = await fs.promises.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as RawConfig;
    // Reseat mcpServers map into a null-prototype object so __proto__ keys
    // can never be assigned through downstream `cfg.mcpServers[name] = …`.
    if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
      const clean = Object.create(null) as Record<string, RawMcpServer>;
      for (const [k, v] of Object.entries(parsed.mcpServers)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        clean[k] = v;
      }
      parsed.mcpServers = clean;
    }
    return parsed;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return {};
    logger.warn(`failed to read ${file}: ${(err as Error).message}`);
    throw err;
  }
}

async function writeConfig(file: string, cfg: RawConfig): Promise<void> {
  const json = JSON.stringify(cfg, null, 2);
  await atomicWriteAsync(file, json);
}

function normalizeServer(raw: RawMcpServer): McpServer {
  if (raw.command) {
    return {
      transport: 'stdio',
      command: raw.command,
      args: raw.args && raw.args.length > 0 ? [...raw.args] : undefined,
      env: raw.env && Object.keys(raw.env).length > 0 ? { ...raw.env } : undefined,
    };
  }
  if (raw.url) {
    const t = raw.transport === 'sse' ? 'sse' : 'http';
    return {
      transport: t,
      url: raw.url,
      headers:
        raw.headers && Object.keys(raw.headers).length > 0
          ? { ...raw.headers }
          : undefined,
    };
  }
  return { transport: 'stdio', command: '' };
}

function denormalizeServer(server: McpServer): RawMcpServer {
  if (server.transport === 'stdio') {
    const s = server as McpStdioServer;
    const out: RawMcpServer = { command: s.command };
    if (s.args && s.args.length > 0) out.args = s.args;
    if (s.env && Object.keys(s.env).length > 0) out.env = s.env;
    return out;
  }
  const s = server as McpHttpServer;
  const out: RawMcpServer = { url: s.url };
  if (s.transport === 'sse') out.transport = 'sse';
  if (s.headers && Object.keys(s.headers).length > 0) out.headers = s.headers;
  return out;
}
