import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { createLogger } from '@shared/logger';
import type { CliProfile } from '@shared/types';

const execFileP = promisify(execFile);

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

// Injected into opencode's `instructions` so it uses the memory brain the same
// way Claude does — Claude gets this protocol via a SessionStart hook; OpenCode
// has no equivalent, so we wire it through config. Verified end-to-end: with
// this present, opencode auto-calls the mempalace search tool before answering
// project questions (no explicit prompt needed).
const MEMPALACE_PROTOCOL = `# Memory Protocol (MemPalace) — FOLLOW ON EVERY SESSION

You have a persistent memory palace via the \`mempalace\` MCP tools — your
long-term memory across sessions. Storage ≠ memory; storage + this protocol =
memory.

1. WAKE-UP: at the start of each session, call the mempalace **status** tool
   FIRST to load the palace overview (wings, rooms, drawer counts).
2. BEFORE answering about any person, project, past event, or prior decision:
   call the mempalace **search** tool FIRST. Never guess from training data.
3. AFTER meaningful work (finishing a feature, a decision, learning something):
   call the mempalace **diary write** tool to record what changed and why.
4. WHEN facts change: invalidate the old fact, then add the new one.
`;

// Mirrors the Claude Code RTK hook for OpenCode: when the token-optimizing
// `rtk` proxy is installed, instruct OpenCode to prefix shell commands with it.
// rtk is always safe — it passes commands through unchanged when it has no
// dedicated filter, and compacts verbose output (build/test/git) otherwise.
const RTK_RULE = `# Shell tooling (RTK) — token-optimized commands

\`rtk\` is a token-optimizing CLI proxy installed on this machine. ALWAYS prefix
shell commands with \`rtk\` — it compacts verbose output (build, test, git, ls,
grep, …) and passes through unchanged when it has no filter, so it is always
safe. Use it even inside && chains.

Examples: \`rtk git status\`, \`rtk git diff\`, \`rtk vitest run\`, \`rtk ls <path>\`,
\`rtk grep <pattern>\`, \`rtk git add . && rtk git commit -m "msg"\`.
`;

// rtk presence gate — only instruct OpenCode to use rtk when it's actually on
// PATH (otherwise the prefix would be a command-not-found for every command).
async function isRtkInstalled(): Promise<boolean> {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    await execFileP(cmd, ['rtk'], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

// Materialize the per-tab opencode.json. `profile` adds a custom provider; null
// = the user's own providers/auth (we still inject the MCP brain + protocol).
// Returns the dir to point OPENCODE_CONFIG_DIR at. 0o600 (holds the key).
export async function ensureOpenCodeConfig(
  profile: CliProfile | null,
): Promise<{ configDir: string }> {
  const configDir = devspaceConfigDir(profile ? profile.id : 'default');
  const config: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
  };

  // Same brain Claude uses: the MemPalace MCP server (mirrored from its Claude
  // plugin) + its usage protocol as `instructions`, so OpenCode uses memory
  // automatically rather than only having the tools available.
  const instructions: string[] = [];
  const mempalace = await resolveMempalaceMcpCommand();
  if (mempalace) {
    config.mcp = {
      mempalace: { type: 'local', command: mempalace, enabled: true },
    };
    const protocolPath = path.join(configDir, 'mempalace-protocol.md');
    await atomicWriteAsync(protocolPath, MEMPALACE_PROTOCOL, {
      mode: 0o600,
      dirMode: 0o700,
    });
    instructions.push(protocolPath);
  }
  if (await isRtkInstalled()) {
    const rtkPath = path.join(configDir, 'rtk-rule.md');
    await atomicWriteAsync(rtkPath, RTK_RULE, { mode: 0o600, dirMode: 0o700 });
    instructions.push(rtkPath);
  }
  if (instructions.length > 0) config.instructions = instructions;

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
