// Antigravity CLI (`agy`) adapter — DETECTION-ONLY stub.
//
// Antigravity (Google) is where Gemini's free tier moved after the Gemini CLI
// individual tiers were retired (June 2026). It's an interactive terminal agent
// launched in a tmux-backed PTY (see launchAntigravityCli). Auth = browser
// Google Sign-In (Apple Keychain). MCP is configured via ~/.gemini/config/
// mcp_config.json (see cliMcpSetup.ensureAntigravityMcp). detect() backs the
// cli:detect IPC for the new-tab picker.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createLogger } from '@shared/logger';
import type { CliDetectionResult, CliProfile } from '@shared/types';

import type { BuildSpawnArgsInput, CliAdapter, CliSpawnArgs } from '@main/cli/types';
import { findExecutable } from '@main/utils/setupPaths';

const execFileP = promisify(execFile);
const logger = createLogger('antigravity-adapter');

const DETECT_TIMEOUT_MS = 4000;
const VERSION_OUTPUT_CAP = 256;

// Robust lookup — well-known install dirs + enriched PATH, so `agy` in
// ~/.local/bin isn't missed under the minimal launchd PATH.
async function whichBinary(): Promise<string | null> {
  return findExecutable('agy');
}

async function detect(): Promise<CliDetectionResult> {
  const bin = await whichBinary();
  if (!bin) return { cliId: 'antigravity', installed: false };
  let version: string | undefined;
  try {
    const { stdout } = await execFileP(bin, ['--version'], {
      timeout: DETECT_TIMEOUT_MS,
      maxBuffer: 8 * 1024,
    });
    const raw = stdout.toString().trim();
    if (raw) version = raw.slice(0, VERSION_OUTPUT_CAP);
  } catch (err) {
    logger.warn(`agy --version failed: ${(err as Error).message}`);
  }
  return { cliId: 'antigravity', installed: true, bin, version };
}

function unsupported(): never {
  throw new Error(
    'antigravity adapter: runs via launchAntigravityCli (TUI), not the generic config/spawn path',
  );
}

export const antigravityAdapter: CliAdapter = {
  id: 'antigravity',
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
