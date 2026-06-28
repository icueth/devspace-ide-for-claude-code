// Codex CLI adapter — DETECTION-ONLY stub.
//
// Codex (OpenAI) is an interactive terminal TUI, launched in a tmux-backed PTY
// (see launchCodexCli) — it uses its own ~/.codex config + auth, so there's no
// per-profile config path here yet. This adapter exists so cli:detect can report
// Codex (installed / version / bin) for the new-tab CLI picker.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createLogger } from '@shared/logger';
import type { CliDetectionResult, CliProfile } from '@shared/types';

import type { BuildSpawnArgsInput, CliAdapter, CliSpawnArgs } from '@main/cli/types';
import { findExecutable } from '@main/utils/setupPaths';

const execFileP = promisify(execFile);
const logger = createLogger('codex-adapter');

const DETECT_TIMEOUT_MS = 4000;
const VERSION_OUTPUT_CAP = 256;

// Robust lookup — checks well-known install dirs + an enriched PATH, so a CLI
// in /opt/homebrew/bin or ~/.local/bin isn't missed when the app runs with the
// minimal launchd PATH (which a bare `which` would inherit).
async function whichBinary(): Promise<string | null> {
  return findExecutable('codex');
}

async function detect(): Promise<CliDetectionResult> {
  const bin = await whichBinary();
  if (!bin) return { cliId: 'codex', installed: false };
  let version: string | undefined;
  try {
    const { stdout } = await execFileP(bin, ['--version'], {
      timeout: DETECT_TIMEOUT_MS,
      maxBuffer: 8 * 1024,
    });
    const raw = stdout.toString().trim();
    if (raw) version = raw.slice(0, VERSION_OUTPUT_CAP);
  } catch (err) {
    logger.warn(`codex --version failed: ${(err as Error).message}`);
  }
  return { cliId: 'codex', installed: true, bin, version };
}

function unsupported(): never {
  throw new Error(
    'codex adapter: runs via launchCodexCli (TUI), not the generic config/spawn path',
  );
}

export const codexAdapter: CliAdapter = {
  id: 'codex',
  capabilities: {
    toolCards: false,
    diffPreview: false,
    askUserQuestion: false,
    skills: false,
    summaryLabel: 'Full',
  },
  detect,
  ensureConfig: async (_profile: CliProfile) => unsupported(),
  buildSpawnArgs: (_profile: CliProfile, _opts: BuildSpawnArgsInput): CliSpawnArgs =>
    unsupported(),
};
