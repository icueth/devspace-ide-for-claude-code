import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { enrichedPath } from '@main/utils/setupPaths';
import { createLogger } from '@shared/logger';
import {
  RUFLO_CATALOG,
  type RufloActionResult,
  type RufloCatalogEntry,
  type RufloMarketplaceStatus,
  type RufloPlugin,
} from '@shared/ruflo';

/**
 * Wraps `claude plugin {list,install,uninstall,enable,disable,marketplace}`
 * for the Settings → Ruflo tab.
 *
 * Design notes:
 *   • Single-flight lock across install/uninstall/toggle/marketplaceAdd —
 *     the Claude CLI serializes plugin operations against `~/.claude/` so
 *     overlapping spawns produce unpredictable enable/version state.
 *   • All actions return `{ ok, error? }` instead of throwing so the
 *     renderer can surface inline row-level failures without an error
 *     boundary trip.
 *   • Catalog is exported from `@shared/ruflo` and re-exported here for
 *     symmetry — the renderer imports the constant directly, no IPC.
 */

const logger = createLogger('RufloPlugins');

let actionInFlight = false;

function withLock(): boolean {
  if (actionInFlight) return false;
  actionInFlight = true;
  return true;
}

function releaseLock(): void {
  actionInFlight = false;
}

// ---------------------------------------------------------------------------
// Binary resolution — mirror RufloService.whichBin so spawned `claude` calls
// pick up the same brew/Homebrew/user paths.
// ---------------------------------------------------------------------------

async function whichClaude(): Promise<string | null> {
  const segments = enrichedPath().split(':').filter(Boolean);
  for (const dir of segments) {
    const full = path.join(dir, 'claude');
    try {
      const st = await fsp.stat(full);
      if (st.isFile()) {
        // eslint-disable-next-line no-bitwise
        await fsp.access(full, fs.constants.X_OK);
        return full;
      }
    } catch {
      // try next
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Spawn helpers
// ---------------------------------------------------------------------------

interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCapture(args: string[]): Promise<SpawnResult> {
  const bin = await whichClaude();
  if (!bin) {
    return {
      code: -1,
      stdout: '',
      stderr: 'claude CLI not found on PATH',
    };
  }
  return await new Promise<SpawnResult>((resolve) => {
    const child = spawn(bin, args, {
      env: { ...process.env, PATH: enrichedPath() },
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      resolve({ code: -1, stdout, stderr: stderr || err.message });
    });
    child.on('exit', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// list — parse `claude plugin list --json`. Exported separately so tests
// can pin the parser without spawning a real binary.
// ---------------------------------------------------------------------------

interface RawPluginRecord {
  id?: unknown;
  version?: unknown;
  scope?: unknown;
  enabled?: unknown;
  installPath?: unknown;
  installedAt?: unknown;
}

/**
 * Split `name@marketplace` into its two parts. Defensive: handles missing
 * `@`, multiple `@` (npm-style scoped names like `@scope/pkg@mp`), and
 * empty strings.
 */
export function parsePluginId(raw: string): { name: string; marketplace: string } {
  if (!raw || typeof raw !== 'string') {
    return { name: '', marketplace: '' };
  }
  // Split on the LAST `@` so scoped npm names (`@org/foo@mp`) parse correctly.
  const at = raw.lastIndexOf('@');
  if (at <= 0) {
    // No `@` or it's the leading scope-marker — treat the whole thing as the
    // name with an empty marketplace. The renderer renders `?` for unknown.
    return { name: raw, marketplace: '' };
  }
  return {
    name: raw.slice(0, at),
    marketplace: raw.slice(at + 1),
  };
}

/**
 * Parse `claude plugin list --json` stdout into structured RufloPlugin[].
 * Tolerant of malformed JSON (returns []) and missing optional fields.
 * Exported for unit tests.
 */
export function parsePluginListJson(json: string): RufloPlugin[] {
  if (!json || !json.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    logger.warn(`plugin list JSON parse failed: ${(err as Error).message}`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    logger.warn(`plugin list JSON not an array: ${typeof parsed}`);
    return [];
  }
  const out: RufloPlugin[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue;
    const rec = raw as RawPluginRecord;
    const id = typeof rec.id === 'string' ? rec.id : '';
    if (!id) continue;
    const { name, marketplace } = parsePluginId(id);
    const isRuflo = marketplace === 'ruflo' || name.startsWith('ruflo-');
    out.push({
      id,
      name,
      marketplace,
      version: typeof rec.version === 'string' ? rec.version : '',
      scope: typeof rec.scope === 'string' ? rec.scope : '',
      enabled: typeof rec.enabled === 'boolean' ? rec.enabled : true,
      installPath:
        typeof rec.installPath === 'string' ? rec.installPath : undefined,
      installedAt:
        typeof rec.installedAt === 'string' ? rec.installedAt : undefined,
      isRuflo,
    });
  }
  return out;
}

export async function listPlugins(): Promise<RufloPlugin[]> {
  const res = await runCapture(['plugin', 'list', '--json']);
  if (res.code !== 0) {
    if (res.stderr) logger.warn(`plugin list exited ${res.code}: ${res.stderr.trim()}`);
    return [];
  }
  return parsePluginListJson(res.stdout);
}

// ---------------------------------------------------------------------------
// install / uninstall / toggle — guarded by the single-flight lock.
// ---------------------------------------------------------------------------

export async function installPlugin(name: string): Promise<RufloActionResult> {
  if (!name || typeof name !== 'string') {
    return { ok: false, error: 'plugin name required' };
  }
  if (!withLock()) {
    return { ok: false, error: 'Another plugin action is running' };
  }
  try {
    const res = await runCapture(['plugin', 'install', `${name}@ruflo`]);
    if (res.code !== 0) {
      const err = (res.stderr || res.stdout).trim() || `claude exited ${res.code}`;
      return { ok: false, error: err };
    }
    return { ok: true };
  } finally {
    releaseLock();
  }
}

export async function uninstallPlugin(id: string): Promise<RufloActionResult> {
  if (!id || typeof id !== 'string') {
    return { ok: false, error: 'plugin id required' };
  }
  if (!withLock()) {
    return { ok: false, error: 'Another plugin action is running' };
  }
  try {
    const res = await runCapture(['plugin', 'uninstall', id]);
    if (res.code !== 0) {
      const err = (res.stderr || res.stdout).trim() || `claude exited ${res.code}`;
      return { ok: false, error: err };
    }
    return { ok: true };
  } finally {
    releaseLock();
  }
}

export async function togglePlugin(
  id: string,
  enable: boolean,
): Promise<RufloActionResult> {
  if (!id || typeof id !== 'string') {
    return { ok: false, error: 'plugin id required' };
  }
  if (!withLock()) {
    return { ok: false, error: 'Another plugin action is running' };
  }
  try {
    const sub = enable ? 'enable' : 'disable';
    const res = await runCapture(['plugin', sub, id]);
    if (res.code !== 0) {
      const err = (res.stderr || res.stdout).trim() || `claude exited ${res.code}`;
      return { ok: false, error: err };
    }
    return { ok: true };
  } finally {
    releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Marketplace status + add. `marketplace list` doesn't exist on every claude
// version so detection is best-effort — when the subcommand fails we fail
// open (added: true) so the UI doesn't show a useless Add button.
// ---------------------------------------------------------------------------

/**
 * Inspect raw `claude plugin marketplace list` stdout for the ruflo entry.
 * Exported for tests.
 */
export function parseMarketplaceListed(stdout: string): boolean {
  if (!stdout) return false;
  const text = stdout.toLowerCase();
  if (!text.includes('ruflo')) return false;
  // Match either the GitHub slug or the full URL form. We deliberately don't
  // accept a bare `ruflo` token without one of those — too easy to false-
  // positive on output that mentions another plugin from this marketplace.
  return text.includes('ruvnet/ruflo') || text.includes('github.com/ruvnet/ruflo');
}

export async function getMarketplaceStatus(): Promise<RufloMarketplaceStatus> {
  const res = await runCapture(['plugin', 'marketplace', 'list']);
  if (res.code !== 0) {
    // `marketplace list` doesn't exist on older claude versions — treat as
    // "added" so the UI doesn't push a redundant Add button.
    logger.info(
      `marketplace list unavailable (code ${res.code}); failing open`,
    );
    return { added: true };
  }
  return { added: parseMarketplaceListed(res.stdout) };
}

export async function addMarketplace(): Promise<RufloActionResult> {
  if (!withLock()) {
    return { ok: false, error: 'Another plugin action is running' };
  }
  try {
    const res = await runCapture(['plugin', 'marketplace', 'add', 'ruvnet/ruflo']);
    if (res.code !== 0) {
      const err = (res.stderr || res.stdout).trim() || `claude exited ${res.code}`;
      return { ok: false, error: err };
    }
    return { ok: true };
  } finally {
    releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Catalog — re-export the static list. The renderer can import either, but
// the service-side export keeps the IPC layer's options open if we ever
// want to enrich the catalog at runtime (e.g. fetch from a registry).
// ---------------------------------------------------------------------------

export function getCatalog(): readonly RufloCatalogEntry[] {
  return RUFLO_CATALOG;
}

/** Test-only: reset module-level lock between vitest cases. */
export function __resetForTests(): void {
  actionInFlight = false;
}
