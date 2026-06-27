// Antigravity CLI (`agy`) adapter — DETECTION-ONLY stub.
//
// Antigravity (Google) is where Gemini's free tier moved after the Gemini CLI
// individual tiers were retired (June 2026). It's an interactive terminal agent
// launched in a tmux-backed PTY (see launchAntigravityCli). Auth = browser
// Google Sign-In (Apple Keychain). MCP is configured via ~/.gemini/config/
// mcp_config.json (see cliMcpSetup.ensureAntigravityMcp). detect() backs the
// cli:detect IPC for the new-tab picker.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { promisify } from 'node:util';

import { createLogger } from '@shared/logger';
import type { CliDetectionResult, CliProfile } from '@shared/types';

import type { BuildSpawnArgsInput, CliAdapter, CliSpawnArgs } from '@main/cli/types';

const execFileP = promisify(execFile);
const logger = createLogger('antigravity-adapter');

const DETECT_TIMEOUT_MS = 4000;
const VERSION_OUTPUT_CAP = 256;

async function isExecutable(bin: string): Promise<boolean> {
  try {
    await fs.promises.access(bin, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function whichBinary(): Promise<string | null> {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileP(cmd, ['agy'], {
      timeout: DETECT_TIMEOUT_MS,
      maxBuffer: 16 * 1024,
    });
    const first = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first && (await isExecutable(first))) return first;
  } catch {
    // No PATH match — Antigravity CLI isn't installed.
  }
  return null;
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
