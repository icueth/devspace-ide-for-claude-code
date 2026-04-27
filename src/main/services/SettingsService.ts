import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { createLogger } from '@shared/logger';

const logger = createLogger('SettingsService');

export type SettingsFileKind = 'json' | 'markdown' | 'text';

export interface SettingsFile {
  label: string;
  path: string;
  kind: SettingsFileKind;
}

export interface SettingsCategory {
  id: string;
  label: string;
  scope: 'global' | 'project';
  files: SettingsFile[];
}

function kindFor(filePath: string): SettingsFileKind {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  return 'text';
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Shallow listing of one folder (no recursion). Returns absolute paths for
 * regular files matching the optional extension filter. Sorted alphabetically.
 */
async function listFiles(
  dir: string,
  exts: string[] | null = null,
): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn(`readdir ${dir} failed: ${(err as Error).message}`);
    }
    return [];
  }
  const names = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((n) => !n.startsWith('.')) // drop hidden artefacts (.DS_Store etc.)
    .filter(
      (n) =>
        !exts || exts.some((ext) => n.toLowerCase().endsWith(ext.toLowerCase())),
    )
    .sort((a, b) => a.localeCompare(b));
  return names.map((n) => path.join(dir, n));
}

/**
 * Build the categorized list the renderer's Settings dialog renders. Includes
 * global ~/.claude/* well-known files plus an inventory of agents / teams /
 * mcp configs by scanning the relevant subfolders. When projectPath is
 * given, also surface that project's .claude/* files alongside .mcp.json.
 *
 * Files that don't yet exist are still listed (so the user can click,
 * type, save → file gets created on the first write). The renderer
 * decides what placeholder to seed.
 */
export async function listSettings(
  projectPath: string | null,
): Promise<SettingsCategory[]> {
  const home = os.homedir();
  const homeClaude = path.join(home, '.claude');

  const cats: SettingsCategory[] = [];

  // ─── Global · core config files in ~/.claude/
  const globalCore: SettingsFile[] = [];
  for (const name of [
    'settings.json',
    'settings.local.json',
    'config.json',
    'mcp.json',
    'CLAUDE.md',
  ]) {
    const abs = path.join(homeClaude, name);
    globalCore.push({ label: name, path: abs, kind: kindFor(abs) });
  }
  cats.push({
    id: 'global-core',
    label: 'Global · Settings',
    scope: 'global',
    files: globalCore,
  });

  // ─── Global · agents (~/.claude/agents/*.md)
  const globalAgentsDir = path.join(homeClaude, 'agents');
  const globalAgentFiles = await listFiles(globalAgentsDir, ['.md']);
  if (globalAgentFiles.length > 0) {
    cats.push({
      id: 'global-agents',
      label: `Global · Agents (${globalAgentFiles.length})`,
      scope: 'global',
      files: globalAgentFiles.map((p) => ({
        label: path.basename(p),
        path: p,
        kind: kindFor(p),
      })),
    });
  }

  // ─── Global · teams (~/.claude/teams/<team>/*)
  const globalTeamsDir = path.join(homeClaude, 'teams');
  let teamSubdirs: import('node:fs').Dirent[] = [];
  try {
    teamSubdirs = (await fs.readdir(globalTeamsDir, { withFileTypes: true })).filter(
      (d) => d.isDirectory() && !d.name.startsWith('.'),
    );
  } catch {
    /* no teams dir yet */
  }
  for (const d of teamSubdirs) {
    const teamDir = path.join(globalTeamsDir, d.name);
    const files = await listFiles(teamDir, ['.json', '.md']);
    if (files.length === 0) continue;
    cats.push({
      id: `global-team-${d.name}`,
      label: `Team · ${d.name}`,
      scope: 'global',
      files: files.map((p) => ({
        label: path.basename(p),
        path: p,
        kind: kindFor(p),
      })),
    });
  }

  // ─── Global · MCP configs (~/.claude/mcp-configs/*.json)
  const mcpDir = path.join(homeClaude, 'mcp-configs');
  const mcpFiles = await listFiles(mcpDir, ['.json']);
  if (mcpFiles.length > 0) {
    cats.push({
      id: 'global-mcp',
      label: `Global · MCP Configs (${mcpFiles.length})`,
      scope: 'global',
      files: mcpFiles.map((p) => ({
        label: path.basename(p),
        path: p,
        kind: kindFor(p),
      })),
    });
  }

  // ─── Project-scoped (when one is active)
  if (projectPath) {
    const projClaude = path.join(projectPath, '.claude');
    const projCore: SettingsFile[] = [];
    for (const name of ['settings.json', 'settings.local.json', 'CLAUDE.md']) {
      const abs = path.join(projClaude, name);
      projCore.push({ label: name, path: abs, kind: kindFor(abs) });
    }
    // .mcp.json lives at the project root (not inside .claude/)
    const projMcp = path.join(projectPath, '.mcp.json');
    projCore.push({ label: '.mcp.json', path: projMcp, kind: kindFor(projMcp) });
    cats.push({
      id: 'project-core',
      label: 'Project · Settings',
      scope: 'project',
      files: projCore,
    });

    const projAgentsDir = path.join(projClaude, 'agents');
    const projAgentFiles = await listFiles(projAgentsDir, ['.md']);
    if (projAgentFiles.length > 0) {
      cats.push({
        id: 'project-agents',
        label: `Project · Agents (${projAgentFiles.length})`,
        scope: 'project',
        files: projAgentFiles.map((p) => ({
          label: path.basename(p),
          path: p,
          kind: kindFor(p),
        })),
      });
    }
  }

  return cats;
}

/** Read a settings file. Returns empty string when the file doesn't exist
 *  yet, so the editor can present a blank canvas the user fills + saves. */
export async function readSettingsFile(filePath: string): Promise<string> {
  if (!(await exists(filePath))) return '';
  return fs.readFile(filePath, 'utf8');
}

/** Write a settings file, creating any missing parent directories. */
export async function writeSettingsFile(
  filePath: string,
  content: string,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}
