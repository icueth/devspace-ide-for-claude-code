import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

import { atomicWriteAsync } from '@main/utils/atomicWrite';
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

// Codex doesn't expose MemPalace's MCP TOOLS to custom-provider models, but the
// `mempalace` CLI is on PATH and Codex has exec_command — so memory is routed
// through the CLI. VERIFIED: the model runs `rtk mempalace status/search` and
// grounds its answer in real palace data.
const GUIDANCE = `# Memory (MemPalace) — your long-term brain, via the mempalace CLI

You have a persistent memory palace. Access it through shell commands:

- WAKE-UP: run \`rtk mempalace status\` once at the start to load the palace.
- BEFORE answering about any project, person, past event, or prior decision:
  run \`rtk mempalace search "<query>"\` FIRST and ground your answer in the
  results. Never guess from training data.

# Tooling (rtk)

ALWAYS prefix shell commands with \`rtk\` (e.g. \`rtk git status\`, \`rtk ls\`).
rtk is a token-optimizing proxy — always safe (passes through unchanged when it
has no filter).
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
