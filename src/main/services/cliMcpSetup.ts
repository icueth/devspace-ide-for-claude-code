import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { resolveMempalaceMcpCommand } from '@main/services/openCodeConfig';
import { createLogger } from '@shared/logger';

// Registers the MemPalace MCP server in Codex's / Gemini's own global config so
// those CLIs share the same memory brain Claude + OpenCode use. Uses each CLI's
// official `mcp add` command (the config formats differ — Codex TOML, Gemini
// JSON), gated on a fast file check so it runs at most once. Best-effort: never
// throws, never blocks a tab launch for long.

const execFileP = promisify(execFile);
const logger = createLogger('cli-mcp-setup');

async function onPath(name: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP(
      process.platform === 'win32' ? 'where' : 'which',
      [name],
      { timeout: 3000 },
    );
    return stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

function fileContains(file: string, needle: string): boolean {
  try {
    return fs.readFileSync(file, 'utf8').includes(needle);
  } catch {
    return false;
  }
}

// Codex: `~/.codex/config.toml` → [mcp_servers.mempalace].
export async function ensureCodexMcp(): Promise<void> {
  try {
    const bin = await onPath('codex');
    if (!bin) return;
    const cmd = await resolveMempalaceMcpCommand();
    if (!cmd) return;
    const cfg = path.join(os.homedir(), '.codex', 'config.toml');
    if (fileContains(cfg, 'mempalace')) return;
    await execFileP(bin, ['mcp', 'add', 'mempalace', '--', ...cmd], {
      timeout: 8000,
    });
    logger.info('registered mempalace MCP for codex');
  } catch (err) {
    logger.warn(`ensureCodexMcp: ${(err as Error).message}`);
  }
}

// Gemini: `~/.gemini/settings.json` → mcpServers.mempalace (user scope).
export async function ensureGeminiMcp(): Promise<void> {
  try {
    const bin = await onPath('gemini');
    if (!bin) return;
    const cmd = await resolveMempalaceMcpCommand();
    if (!cmd) return;
    const cfg = path.join(os.homedir(), '.gemini', 'settings.json');
    if (fileContains(cfg, 'mempalace')) return;
    await execFileP(
      bin,
      ['mcp', 'add', '-s', 'user', 'mempalace', cmd[0], ...cmd.slice(1)],
      { timeout: 8000 },
    );
    logger.info('registered mempalace MCP for gemini');
  } catch (err) {
    logger.warn(`ensureGeminiMcp: ${(err as Error).message}`);
  }
}
