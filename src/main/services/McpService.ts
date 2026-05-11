import { homedir } from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createLogger } from '@shared/logger';
import type {
  McpScope,
  McpServer,
  McpServerEntry,
  McpStdioServer,
  McpHttpServer,
} from '@shared/types';

const logger = createLogger('Mcp');

// Locations Claude Code consults for MCP definitions. We intentionally
// leave the auto-managed `~/.claude/mcp.json` alone — `claude mcp add`
// writes there itself, and double-managing it from two writers
// invites a race.
function globalConfigFile(): string {
  return path.join(homedir(), '.claude.json');
}

function projectConfigFile(projectPath: string): string {
  return path.join(projectPath, '.mcp.json');
}

interface RawConfig {
  mcpServers?: Record<string, RawMcpServer>;
  // Everything else in the file is preserved verbatim on write so we
  // don't accidentally clobber unrelated claude settings (the global
  // file is 100KB+ of mixed settings).
  [key: string]: unknown;
}

interface RawMcpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  transport?: string;
  headers?: Record<string, string>;
  // Unknown fields kept around so a save round-trip doesn't drop them.
  [key: string]: unknown;
}

// ─── public API ─────────────────────────────────────────────────────────────

export async function listMcpServers(
  projectPath: string | null,
): Promise<McpServerEntry[]> {
  const out: McpServerEntry[] = [];
  const sources: Array<{ file: string; scope: McpScope }> = [
    { file: globalConfigFile(), scope: 'global' },
  ];
  if (projectPath) {
    sources.push({ file: projectConfigFile(projectPath), scope: 'project' });
  }

  for (const { file, scope } of sources) {
    const cfg = await readConfig(file);
    const servers = cfg.mcpServers ?? {};
    for (const [name, raw] of Object.entries(servers)) {
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
  const file =
    entry.scope === 'global'
      ? globalConfigFile()
      : entry.filePath;
  const cfg = await readConfig(file);
  if (!cfg.mcpServers) cfg.mcpServers = {};
  cfg.mcpServers[entry.name] = denormalizeServer(entry.server);
  await writeConfig(file, cfg);
  return { ...entry, filePath: file };
}

export async function renameMcpServer(
  scope: McpScope,
  filePath: string,
  oldName: string,
  newName: string,
): Promise<void> {
  if (oldName === newName) return;
  const file = scope === 'global' ? globalConfigFile() : filePath;
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
}

export async function deleteMcpServer(
  scope: McpScope,
  filePath: string,
  name: string,
): Promise<void> {
  const file = scope === 'global' ? globalConfigFile() : filePath;
  const cfg = await readConfig(file);
  if (cfg.mcpServers) {
    delete cfg.mcpServers[name];
    await writeConfig(file, cfg);
  }
}

export async function createMcpServer(
  scope: McpScope,
  projectPath: string | null,
  name: string,
  server: McpServer,
): Promise<McpServerEntry> {
  if (scope === 'project' && !projectPath) {
    throw new Error('project scope requires a projectPath');
  }
  const file =
    scope === 'global'
      ? globalConfigFile()
      : projectConfigFile(projectPath ?? '');
  const cfg = await readConfig(file);
  if (!cfg.mcpServers) cfg.mcpServers = {};
  if (cfg.mcpServers[name]) {
    throw new Error(`mcp server already exists: ${name}`);
  }
  cfg.mcpServers[name] = denormalizeServer(server);
  await writeConfig(file, cfg);
  return { name, scope, filePath: file, server };
}

// ─── internals ──────────────────────────────────────────────────────────────

async function readConfig(file: string): Promise<RawConfig> {
  try {
    const raw = await fs.promises.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as RawConfig;
    return parsed;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return {};
    // Corrupt JSON in the global file is dangerous — we should NOT
    // overwrite it on save. Re-throw so the UI surfaces the error.
    logger.warn(`failed to read ${file}: ${(err as Error).message}`);
    throw err;
  }
}

async function writeConfig(file: string, cfg: RawConfig): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  // Pretty-print to match how Claude writes the file. The global file is
  // edited by multiple tools (claude CLI itself, claude desktop, this app)
  // and they all use 2-space indentation by convention.
  const json = JSON.stringify(cfg, null, 2);
  // Atomic write: stage to a sibling then rename. Without this a crash
  // mid-write could leave the user with an unparseable ~/.claude.json
  // and a broken claude install.
  const tmp = `${file}.tmp-${Date.now()}`;
  await fs.promises.writeFile(tmp, json);
  await fs.promises.rename(tmp, file);
}

function normalizeServer(raw: RawMcpServer): McpServer {
  // Heuristic: presence of `command` = stdio, presence of `url` = http/sse.
  // If both are present, prefer command (stdio is closer to most claude
  // setups and shows up more often in the wild).
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
  // Garbage entry — fall back to a stub stdio shape so the UI can still
  // render and the user can fix it manually.
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
  // Only write `transport` field for sse — claude defaults http when
  // absent. Keeps generated JSON minimal.
  if (s.transport === 'sse') out.transport = 'sse';
  if (s.headers && Object.keys(s.headers).length > 0) out.headers = s.headers;
  return out;
}
