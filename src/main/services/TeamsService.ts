import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

import { createLogger } from '@shared/logger';
import type { TeamDef, TeamScope } from '@shared/types';

const logger = createLogger('Teams');

// Two scopes — same pattern as agents/skills:
//   • global  — ~/.devspace/teams.json, available to every project
//   • project — <projectPath>/.devspace/teams.json, scoped to this repo
function globalTeamsFile(): string {
  return path.join(homedir(), '.devspace', 'teams.json');
}

function projectTeamsFile(projectPath: string): string {
  return path.join(projectPath, '.devspace', 'teams.json');
}

interface TeamsFileShape {
  teams: TeamDef[];
}

// ─── public API ─────────────────────────────────────────────────────────────

export async function listTeams(
  projectPath: string | null,
): Promise<TeamDef[]> {
  const out: TeamDef[] = [];
  const global = await readFile(globalTeamsFile());
  for (const t of global.teams) {
    out.push({ ...t, scope: 'global' });
  }
  if (projectPath) {
    const proj = await readFile(projectTeamsFile(projectPath));
    for (const t of proj.teams) {
      out.push({ ...t, scope: 'project' });
    }
  }
  // Global first, then project; within each scope sorted by name.
  out.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === 'global' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

export async function getTeam(
  projectPath: string | null,
  teamId: string,
): Promise<TeamDef | null> {
  // Search both scopes so callers don't have to know where the team
  // lives. Project takes precedence over global on id collision (rare —
  // ids are UUIDs — but if it ever happens project wins).
  const all = await listTeams(projectPath);
  return all.find((t) => t.id === teamId) ?? null;
}

export async function saveTeam(
  scope: TeamScope,
  projectPath: string | null,
  team: TeamDef,
): Promise<TeamDef> {
  if (scope === 'project' && !projectPath) {
    throw new Error('project scope requires a projectPath');
  }
  // Defensive copy — caller (renderer) may keep mutating the passed
  // object after the IPC return.
  const next: TeamDef = {
    id: team.id || randomUUID(),
    name: team.name.trim() || 'Unnamed team',
    mode: team.mode,
    members: team.members.map((m) => ({
      agentSlug: m.agentSlug,
      ...(m.modelOverride ? { modelOverride: m.modelOverride } : {}),
    })),
    ...(team.aggregatorSlug ? { aggregatorSlug: team.aggregatorSlug } : {}),
  };
  const file =
    scope === 'global'
      ? globalTeamsFile()
      : projectTeamsFile(projectPath!);
  const cfg = await readFile(file);
  const idx = cfg.teams.findIndex((t) => t.id === next.id);
  if (idx >= 0) cfg.teams[idx] = next;
  else cfg.teams.push(next);
  await writeFile(file, cfg);
  return { ...next, scope };
}

export async function deleteTeam(
  scope: TeamScope,
  projectPath: string | null,
  teamId: string,
): Promise<void> {
  if (scope === 'project' && !projectPath) {
    throw new Error('project scope requires a projectPath');
  }
  const file =
    scope === 'global'
      ? globalTeamsFile()
      : projectTeamsFile(projectPath!);
  const cfg = await readFile(file);
  const before = cfg.teams.length;
  cfg.teams = cfg.teams.filter((t) => t.id !== teamId);
  if (cfg.teams.length !== before) {
    await writeFile(file, cfg);
  }
}

// ─── internals ──────────────────────────────────────────────────────────────

async function readFile(file: string): Promise<TeamsFileShape> {
  try {
    const raw = await fs.promises.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as TeamsFileShape;
    if (!Array.isArray(parsed.teams)) return { teams: [] };
    return parsed;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn(`failed to read ${file}: ${(err as Error).message}`);
    }
    return { teams: [] };
  }
}

async function writeFile(
  file: string,
  cfg: TeamsFileShape,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  // Atomic rename — keeps a partial write from corrupting the file if
  // the process dies mid-save.
  const tmp = `${file}.tmp-${Date.now()}`;
  await fs.promises.writeFile(tmp, JSON.stringify(cfg, null, 2));
  await fs.promises.rename(tmp, file);
}
