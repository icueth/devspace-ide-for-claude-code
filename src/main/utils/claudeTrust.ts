import * as fs from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

import { atomicWriteAsync } from '@main/utils/atomicWrite';

function claudeConfigFile(): string {
  return path.join(homedir(), '.claude.json');
}

// Pure: mark `dir` as trusted in a Claude Code config object. Returns the config
// plus whether anything changed, so the caller can skip a redundant write.
// Exported for unit testing.
export function applyFolderTrust(
  cfg: Record<string, unknown>,
  dir: string,
): { cfg: Record<string, unknown>; changed: boolean } {
  const projects =
    (cfg.projects as Record<string, Record<string, unknown>> | undefined) ?? {};
  const entry = projects[dir] ?? {};
  if (entry.hasTrustDialogAccepted === true) return { cfg, changed: false };
  entry.hasTrustDialogAccepted = true;
  if (entry.hasCompletedProjectOnboarding === undefined) {
    entry.hasCompletedProjectOnboarding = true;
  }
  projects[dir] = entry;
  cfg.projects = projects;
  return { cfg, changed: true };
}

// Pre-accept Claude Code's per-folder "trust this folder" dialog for `dir` by
// seeding ~/.claude.json → projects[dir].hasTrustDialogAccepted = true.
// `--dangerously-skip-permissions` does NOT cover this dialog, so a fresh task
// worktree otherwise blocks the agent on it. DevSpace only ever launches claude
// in workspace-confined folders the user explicitly opened (and already passes
// --dangerously-skip-permissions), so auto-trusting is consistent and just
// removes a redundant prompt.
//
// Best-effort + idempotent: when already trusted it makes no write, so the
// launch hot path never rewrites the (large) config for an already-open project.
export async function ensureFolderTrusted(dir: string): Promise<void> {
  if (!dir) return;
  try {
    const file = claudeConfigFile();
    let cfg: Record<string, unknown> = {};
    try {
      cfg = JSON.parse(await fs.promises.readFile(file, 'utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      cfg = {}; // missing/corrupt → fresh object (claude re-merges its own keys)
    }
    const { changed } = applyFolderTrust(cfg, dir);
    if (!changed) return;
    // 2-space indent matches Claude Code's own writer, so we don't reformat the
    // whole file on each new folder.
    await atomicWriteAsync(file, `${JSON.stringify(cfg, null, 2)}\n`);
  } catch {
    /* best-effort — never block a CLI launch on the trust seed */
  }
}
