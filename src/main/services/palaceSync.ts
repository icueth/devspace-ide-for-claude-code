import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { createLogger } from '@shared/logger';
import type { PalaceSyncResult, PalaceSyncStatus } from '@shared/mempalace';

// Git-backed sync of the MemPalace vault across machines. Single-writer model
// (the user's workflow: pull before use, push after use, one machine at a
// time). The vault is SQLite (Chroma + knowledge graph) which can't be merged,
// so we NEVER auto-merge: pull = fast-forward/reset to the remote (guarded so
// un-pushed local knowledge is never silently discarded); push = consolidate
// the WAL, then amend a single snapshot commit + force-with-lease so the repo
// doesn't bloat with a new 48 MB blob per sync.

const execFileP = promisify(execFile);
const logger = createLogger('palace-sync');

// SQLite WAL files that must be flushed before snapshotting the vault.
const VAULT_DBS = ['chroma.sqlite3', 'knowledge_graph.sqlite3'];

function vaultPath(): string | null {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), '.mempalace', 'config.json'), 'utf8'),
    ) as { palace_path?: unknown };
    return typeof cfg.palace_path === 'string' && cfg.palace_path
      ? cfg.palace_path
      : null;
  } catch {
    return null;
  }
}

async function git(
  cwd: string,
  args: string[],
  timeout = 120_000,
): Promise<{ ok: boolean; stdout: string; err?: string }> {
  try {
    const { stdout } = await execFileP('git', args, {
      cwd,
      timeout,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout.toString() };
  } catch (e) {
    return { ok: false, stdout: '', err: (e as Error).message };
  }
}

async function currentBranch(vault: string): Promise<string> {
  const r = await git(vault, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.ok && r.stdout.trim() ? r.stdout.trim() : 'main';
}

export async function getPalaceSyncStatus(): Promise<PalaceSyncStatus> {
  const vault = vaultPath();
  const base: PalaceSyncStatus = {
    enabled: false,
    vaultPath: vault ?? '',
    remoteUrl: null,
    branch: 'main',
    ahead: 0,
    behind: 0,
    dirty: false,
    lastSync: null,
  };
  if (!vault || !fs.existsSync(path.join(vault, '.git'))) return base;

  const remote = await git(vault, ['remote', 'get-url', 'origin']);
  if (!remote.ok) return { ...base, vaultPath: vault };
  const remoteUrl = remote.stdout.trim();
  const branch = await currentBranch(vault);

  await git(vault, ['fetch', 'origin', branch], 60_000); // best-effort

  const dirtyR = await git(vault, ['status', '--porcelain']);
  const dirty = dirtyR.ok && dirtyR.stdout.trim().length > 0;

  let ahead = 0;
  let behind = 0;
  const counts = await git(vault, [
    'rev-list',
    '--left-right',
    '--count',
    `origin/${branch}...HEAD`,
  ]);
  if (counts.ok) {
    const [b, a] = counts.stdout.trim().split(/\s+/).map((n) => Number(n) || 0);
    behind = b ?? 0;
    ahead = a ?? 0;
  }

  const lastR = await git(vault, ['log', '-1', '--format=%cI']);
  return {
    enabled: true,
    vaultPath: vault,
    remoteUrl,
    branch,
    ahead,
    behind,
    dirty,
    lastSync: lastR.ok ? lastR.stdout.trim() : null,
  };
}

export async function pullPalace(): Promise<PalaceSyncResult> {
  const vault = vaultPath();
  if (!vault || !fs.existsSync(path.join(vault, '.git'))) {
    return { ok: false, message: 'MemPalace vault is not a synced git repo.' };
  }
  // Guard: never discard un-pushed local knowledge with a hard reset.
  const dirty = await git(vault, ['status', '--porcelain']);
  if (dirty.ok && dirty.stdout.trim()) {
    return {
      ok: false,
      message:
        'Local palace has unpushed changes — Push first (single-writer: push after use on each machine), or they would be lost.',
      status: await getPalaceSyncStatus(),
    };
  }
  const branch = await currentBranch(vault);
  const fetch = await git(vault, ['fetch', 'origin', branch]);
  if (!fetch.ok) return { ok: false, message: `git fetch failed: ${fetch.err}` };
  const reset = await git(vault, ['reset', '--hard', `origin/${branch}`]);
  if (!reset.ok) return { ok: false, message: `git reset failed: ${reset.err}` };
  logger.info('pulled palace from remote');
  return {
    ok: true,
    message: 'Pulled the latest palace from the repo.',
    status: await getPalaceSyncStatus(),
  };
}

export async function pushPalace(): Promise<PalaceSyncResult> {
  const vault = vaultPath();
  if (!vault || !fs.existsSync(path.join(vault, '.git'))) {
    return { ok: false, message: 'MemPalace vault is not a synced git repo.' };
  }
  // Flush each DB's WAL so the committed snapshot is internally consistent.
  for (const db of VAULT_DBS) {
    const p = path.join(vault, db);
    if (fs.existsSync(p)) {
      await execFileP('sqlite3', [p, 'PRAGMA wal_checkpoint(TRUNCATE);'], {
        timeout: 30_000,
      }).catch(() => undefined);
    }
  }
  const branch = await currentBranch(vault);
  await git(vault, ['add', '-A']);
  const dirty = await git(vault, ['status', '--porcelain']);
  if (!dirty.stdout.trim()) {
    return {
      ok: true,
      message: 'Already up to date — nothing new to push.',
      status: await getPalaceSyncStatus(),
    };
  }
  // Latest-only: amend the snapshot commit so .git doesn't grow a 48 MB blob
  // every sync, then force-with-lease (fails safely if another machine pushed).
  const commit = await git(vault, ['commit', '--amend', '-m', 'palace snapshot']);
  if (!commit.ok) return { ok: false, message: `git commit failed: ${commit.err}` };
  const push = await git(vault, ['push', '--force-with-lease', 'origin', branch]);
  if (!push.ok) {
    return {
      ok: false,
      message: `git push failed (re-Pull if another machine pushed): ${push.err}`,
      status: await getPalaceSyncStatus(),
    };
  }
  await git(vault, ['gc', '--prune=now', '--quiet'], 60_000); // keep .git small
  logger.info('pushed palace to remote');
  return {
    ok: true,
    message: 'Pushed the palace to the repo.',
    status: await getPalaceSyncStatus(),
  };
}
