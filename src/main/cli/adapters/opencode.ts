// OpenCode CLI adapter.
//
// OpenCode is an interactive terminal TUI (`opencode [project]`), so the dock
// launches it in a tmux-backed PTY (see launchOpenCodeCli) — the interactive
// path doesn't use buildSpawnArgs. detect() backs the cli:detect IPC (the new-
// tab CLI picker). ensureConfig delegates to the shared openCodeConfig builder
// (custom provider + MemPalace MCP brain) written to a per-profile
// OPENCODE_CONFIG_DIR that OpenCode merges over the user's own config.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { ensureOpenCodeConfig } from '@main/services/openCodeConfig';
import { createLogger } from '@shared/logger';
import type { CliDetectionResult, CliProfile } from '@shared/types';

import type { BuildSpawnArgsInput, CliAdapter, CliSpawnArgs } from '@main/cli/types';
import { findExecutable } from '@main/utils/setupPaths';

const execFileP = promisify(execFile);
const logger = createLogger('opencode-adapter');

const DETECT_TIMEOUT_MS = 4000;
const VERSION_OUTPUT_CAP = 256;

// Robust lookup — well-known install dirs + enriched PATH, so a CLI in
// ~/.opencode/bin or /opt/homebrew/bin isn't missed under the minimal launchd PATH.
async function whichBinary(): Promise<string | null> {
  return findExecutable('opencode');
}

async function detect(): Promise<CliDetectionResult> {
  const bin = await whichBinary();
  if (!bin) return { cliId: 'opencode', installed: false };
  let version: string | undefined;
  try {
    const { stdout } = await execFileP(bin, ['--version'], {
      timeout: DETECT_TIMEOUT_MS,
      maxBuffer: 8 * 1024,
    });
    const raw = stdout.toString().trim();
    if (raw) version = raw.slice(0, VERSION_OUTPUT_CAP);
  } catch (err) {
    logger.warn(`opencode --version failed: ${(err as Error).message}`);
  }
  return { cliId: 'opencode', installed: true, bin, version };
}

// Future headless `opencode run` path — the interactive dock pane doesn't use
// this. Points at the per-profile config dir via OPENCODE_CONFIG_DIR.
function buildSpawnArgs(
  _profile: CliProfile,
  opts: BuildSpawnArgsInput,
): CliSpawnArgs {
  return {
    bin: 'opencode',
    args: ['run', opts.prompt],
    env: { ...process.env },
  };
}

export const opencodeAdapter: CliAdapter = {
  id: 'opencode',
  capabilities: {
    toolCards: false,
    diffPreview: false,
    askUserQuestion: false,
    skills: false,
    summaryLabel: '~90% tools',
  },
  detect,
  ensureConfig: (profile: CliProfile) => ensureOpenCodeConfig(profile),
  buildSpawnArgs,
};
