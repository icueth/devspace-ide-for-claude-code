import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { resolveMempalaceMcpCommand } from '@main/services/openCodeConfig';
import type { CliProfile } from '@shared/types';

// Builds an isolated CODEX_HOME for a Codex tab that runs on a custom provider
// (a CliProfile). Codex custom providers use their own API key, so this needs NO
// ChatGPT login — it also sidesteps Codex's auth entirely. The config holds the
// OpenAI-compatible provider (Responses API), the MemPalace MCP brain, and an
// AGENTS.md with the usage protocol + rtk rule. The key is passed via env (the
// launcher sets keyEnv=keyValue) so it never lands in config.toml on disk.

// Fixed env var name Codex reads the provider key from (config.toml env_key).
const KEY_ENV = 'DEVSPACE_CODEX_KEY';

// TOML basic strings escape the same as JSON strings for our values (URLs,
// names, paths) — reuse JSON.stringify for correct quoting/escaping.
function toml(value: string): string {
  return JSON.stringify(value);
}

const GUIDANCE = `# DevSpace — Memory (MemPalace) + Tooling (rtk)

You have a persistent memory palace via the \`mempalace\` MCP tools — your
long-term memory across sessions. Storage + this protocol = memory.

1. WAKE-UP: call the mempalace **status** tool first each session.
2. BEFORE answering about any project, person, or past event: call mempalace
   **search** first. Never guess from training data.
3. AFTER meaningful work: call mempalace **diary write**.

\`rtk\` is a token-optimizing CLI proxy: ALWAYS prefix shell commands with
\`rtk\` (e.g. \`rtk git status\`). It is always safe — passes through unchanged
when it has no filter.
`;

export async function ensureCodexConfig(
  profile: CliProfile,
  projectPath: string,
): Promise<{ configDir: string; keyEnv: string; keyValue: string }> {
  const hash = createHash('sha1').update(projectPath).digest('hex').slice(0, 12);
  const configDir = path.join(
    os.homedir(),
    '.devspace',
    'codex',
    `${hash}-${profile.id}`,
  );

  let body =
    `model = ${toml(profile.provider.model)}\n` +
    `model_provider = "custom"\n\n` +
    `[model_providers.custom]\n` +
    `name = ${toml(profile.name)}\n` +
    `base_url = ${toml(profile.provider.baseURL)}\n` +
    `env_key = ${toml(KEY_ENV)}\n` +
    // Codex dropped wire_api="chat"; "responses" is required (the provider must
    // implement OpenAI's Responses API — verified working for the qwen endpoint).
    `wire_api = "responses"\n`;

  const mempalace = await resolveMempalaceMcpCommand();
  if (mempalace) {
    const args = mempalace.slice(1).map(toml).join(', ');
    // NOTE: Codex exposes MCP servers as resources (list_mcp_resources), not as
    // direct tool functions, so MemPalace's tools don't always reach the model
    // in-session the way they do for Claude/OpenCode — a known Codex MCP quirk.
    // The server is still registered (generous startup timeout for the heavy
    // palace load) so it works if/when Codex's MCP tool exposure improves.
    body +=
      `\n[mcp_servers.mempalace]\n` +
      `command = ${toml(mempalace[0])}\n` +
      `args = [${args}]\n` +
      `startup_timeout_sec = 30\n`;
  }

  await atomicWriteAsync(path.join(configDir, 'config.toml'), body, {
    mode: 0o600,
    dirMode: 0o700,
  });
  // $CODEX_HOME/AGENTS.md is the global guidance Codex loads each session.
  await atomicWriteAsync(path.join(configDir, 'AGENTS.md'), GUIDANCE, {
    mode: 0o600,
    dirMode: 0o700,
  });

  return { configDir, keyEnv: KEY_ENV, keyValue: profile.provider.apiKey };
}
