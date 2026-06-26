import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { createLogger } from '@shared/logger';
import type { CliProfile } from '@shared/types';

// Builds the DevSpace-managed OpenCode config that each opencode tab launches
// with (via OPENCODE_CONFIG_DIR). OpenCode MERGES this on top of the user's own
// ~/.config/opencode + auth.json, so we only ADD:
//   • an `mcp` section wiring OpenCode into the same brain Claude uses — the
//     user's MemPalace MCP server, mirrored from its Claude-plugin config so
//     both CLIs share one memory palace.
//   • a custom OpenAI-compatible `provider` when a CliProfile is selected.
// Nothing here mutates the user's own opencode config.

const logger = createLogger('opencode-config');

function devspaceConfigDir(key: string): string {
  return path.join(os.homedir(), '.devspace', 'opencode', key);
}

// Mirror the user's MemPalace MCP command from its installed Claude plugin so
// OpenCode talks to the SAME palace (same python, same --palace path). Returns
// the spawn argv (command + args) or null when MemPalace isn't installed.
export async function resolveMempalaceMcpCommand(): Promise<string[] | null> {
  try {
    const dir = path.join(
      os.homedir(),
      '.claude',
      'plugins',
      'cache',
      'mempalace',
      'mempalace',
    );
    // Newest version first — plugin dirs are semver-named.
    const versions = (await fs.promises.readdir(dir)).sort().reverse();
    for (const v of versions) {
      try {
        const raw = await fs.promises.readFile(
          path.join(dir, v, '.mcp.json'),
          'utf8',
        );
        const parsed = JSON.parse(raw) as {
          mempalace?: { command?: string; args?: string[] };
        };
        const mp = parsed.mempalace;
        if (mp?.command) return [mp.command, ...(mp.args ?? [])];
      } catch {
        // try the next version
      }
    }
  } catch {
    // MemPalace plugin not installed — fine, opencode just won't get memory.
  }
  return null;
}

async function buildMcpSection(): Promise<Record<string, unknown>> {
  const mcp: Record<string, unknown> = {};
  const mempalace = await resolveMempalaceMcpCommand();
  if (mempalace) {
    // OpenCode local-MCP schema: { type:'local', command:[bin,...args], enabled }.
    mcp.mempalace = { type: 'local', command: mempalace, enabled: true };
  }
  return mcp;
}

// Materialize the per-tab opencode.json. `profile` adds a custom provider; null
// = the user's own providers/auth (we still inject the MCP brain). Returns the
// dir to point OPENCODE_CONFIG_DIR at. Written 0o600 (holds the provider key).
export async function ensureOpenCodeConfig(
  profile: CliProfile | null,
): Promise<{ configDir: string }> {
  const configDir = devspaceConfigDir(profile ? profile.id : 'default');
  const config: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    mcp: await buildMcpSection(),
  };
  if (profile) {
    const providerId = 'custom';
    config.provider = {
      [providerId]: {
        npm: '@ai-sdk/openai-compatible',
        name: profile.name,
        options: {
          baseURL: profile.provider.baseURL,
          apiKey: profile.provider.apiKey,
        },
        models: { [profile.provider.model]: {} },
      },
    };
    config.model = `${providerId}/${profile.provider.model}`;
  }
  await atomicWriteAsync(
    path.join(configDir, 'opencode.json'),
    JSON.stringify(config, null, 2),
    { mode: 0o600, dirMode: 0o700 },
  );
  logger.info(
    `wrote opencode config (${profile ? `provider=${profile.name}` : 'default'}) → ${configDir}`,
  );
  return { configDir };
}
