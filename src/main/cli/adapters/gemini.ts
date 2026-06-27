// Gemini CLI adapter — DETECTION-ONLY stub.
//
// Gemini (Google) is an interactive terminal TUI, launched in a tmux-backed PTY
// (see launchGeminiCli) — it uses its own ~/.gemini config + auth, so there's no
// per-profile config path here yet. This adapter exists so cli:detect can report
// Gemini (installed / version / bin) for the new-tab CLI picker.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { promisify } from 'node:util';

import { createLogger } from '@shared/logger';
import type { CliDetectionResult, CliProfile } from '@shared/types';

import type { BuildSpawnArgsInput, CliAdapter, CliSpawnArgs } from '@main/cli/types';

const execFileP = promisify(execFile);
const logger = createLogger('gemini-adapter');

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
    const { stdout } = await execFileP(cmd, ['gemini'], {
      timeout: DETECT_TIMEOUT_MS,
      maxBuffer: 16 * 1024,
    });
    const first = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first && (await isExecutable(first))) return first;
  } catch {
    // No PATH match — Gemini CLI isn't installed.
  }
  return null;
}

async function detect(): Promise<CliDetectionResult> {
  const bin = await whichBinary();
  if (!bin) return { cliId: 'gemini', installed: false };
  let version: string | undefined;
  try {
    const { stdout } = await execFileP(bin, ['--version'], {
      timeout: DETECT_TIMEOUT_MS,
      maxBuffer: 8 * 1024,
      // GEMINI_CLI_NO_RELAUNCH: Gemini re-execs itself in non-TTY subprocesses,
      // which can spawn an orphaned relaunch loop that overloads the machine.
      env: { ...process.env, GEMINI_CLI_NO_RELAUNCH: '1' },
    });
    const raw = stdout.toString().trim();
    if (raw) version = raw.slice(0, VERSION_OUTPUT_CAP);
  } catch (err) {
    logger.warn(`gemini --version failed: ${(err as Error).message}`);
  }
  return { cliId: 'gemini', installed: true, bin, version };
}

function unsupported(): never {
  throw new Error(
    'gemini adapter: runs via launchGeminiCli (TUI), not the generic config/spawn path',
  );
}

export const geminiAdapter: CliAdapter = {
  id: 'gemini',
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
