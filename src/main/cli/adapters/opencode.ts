// OpenCode CLI adapter.
//
// OpenCode is an interactive terminal TUI (`opencode [project]`), so the dock
// launches it in a tmux-backed PTY just like Claude (see launchOpenCodeCli) —
// the interactive path does NOT use buildSpawnArgs. detect() backs the
// cli:detect IPC (the new-tab CLI picker). ensureConfig/buildSpawnArgs exist
// for a future headless/per-provider path: OpenCode reads a per-profile config
// dir via OPENCODE_CONFIG_DIR, so each CliProfile stays isolated from the
// user's own ~/.config/opencode/.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { createLogger } from '@shared/logger';
import type { CliDetectionResult, CliProfile } from '@shared/types';

import type { BuildSpawnArgsInput, CliAdapter, CliSpawnArgs } from '@main/cli/types';

const execFileP = promisify(execFile);
const logger = createLogger('opencode-adapter');

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
    const { stdout } = await execFileP(cmd, ['opencode'], {
      timeout: DETECT_TIMEOUT_MS,
      maxBuffer: 16 * 1024,
    });
    const first = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first && (await isExecutable(first))) return first;
  } catch {
    // No PATH match — expected on a host without opencode.
  }
  return null;
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

// Per-profile config dir — keeps each provider isolated and never touches the
// user's own ~/.config/opencode/. Pointed at via OPENCODE_CONFIG_DIR.
export function opencodeConfigDir(profileId: string): string {
  return path.join(os.homedir(), '.devspace', 'cli-profiles', profileId);
}

// Materialize the OpenCode config for a CliProfile as `opencode.json` in the
// per-profile dir. Maps the OpenAI-compatible provider (baseURL/apiKey/model)
// to OpenCode's `@ai-sdk/openai-compatible` provider schema.
async function ensureConfig(profile: CliProfile): Promise<{ configDir: string }> {
  const configDir = opencodeConfigDir(profile.id);
  const providerId = 'custom';
  const config = {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      [providerId]: {
        npm: '@ai-sdk/openai-compatible',
        options: {
          baseURL: profile.provider.baseURL,
          apiKey: profile.provider.apiKey,
        },
        models: { [profile.provider.model]: {} },
      },
    },
    model: `${providerId}/${profile.provider.model}`,
  };
  await atomicWriteAsync(
    path.join(configDir, 'opencode.json'),
    JSON.stringify(config, null, 2),
    { mode: 0o600, dirMode: 0o700 },
  );
  return { configDir };
}

function buildSpawnArgs(
  profile: CliProfile,
  opts: BuildSpawnArgsInput,
): CliSpawnArgs {
  return {
    bin: 'opencode',
    args: ['run', opts.prompt],
    env: {
      ...process.env,
      OPENCODE_CONFIG_DIR: opencodeConfigDir(profile.id),
    },
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
  ensureConfig,
  buildSpawnArgs,
};
