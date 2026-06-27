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
      // GEMINI_CLI_NO_RELAUNCH stops Gemini re-execing in this non-TTY call
      // (which can loop/hang and stall the tab launch).
      { timeout: 8000, env: { ...process.env, GEMINI_CLI_NO_RELAUNCH: '1' } },
    );
    logger.info('registered mempalace MCP for gemini');
  } catch (err) {
    logger.warn(`ensureGeminiMcp: ${(err as Error).message}`);
  }
}

// The DevSpace guidance block written into each CLI's GLOBAL instruction file
// (Codex ~/.codex/AGENTS.md, Gemini ~/.gemini/GEMINI.md) so the MemPalace brain
// is used automatically + commands go through rtk — the same behavior Claude +
// OpenCode get. Per-project learnings stay Claude/OpenCode-only (these files are
// global; Codex/Gemini have no per-tab config that survives their auth).
const MARK_START = '<!-- DEVSPACE:START (managed — edit outside these markers) -->';
const MARK_END = '<!-- DEVSPACE:END -->';
const DEVSPACE_GUIDANCE = `# DevSpace — Memory (MemPalace) + Tooling (rtk)

You have a persistent memory palace via the \`mempalace\` MCP tools — your
long-term memory across sessions. Storage ≠ memory; storage + this protocol =
memory.

1. WAKE-UP: at the start of each session, call the mempalace **status** tool first.
2. BEFORE answering about any project, person, past event, or prior decision:
   call the mempalace **search** tool first. Never guess from training data.
3. AFTER meaningful work (a feature, a decision, a lesson): call mempalace **diary write**.
4. WHEN facts change: invalidate the old fact, then add the new one.

\`rtk\` is a token-optimizing CLI proxy installed here: ALWAYS prefix shell
commands with \`rtk\` (e.g. \`rtk git status\`, \`rtk ls\`, \`rtk grep\`). It is
always safe — it passes commands through unchanged when it has no filter.`;

// Codex variant: MemPalace's MCP tools aren't exposed to custom-provider models,
// so route memory through the `mempalace` CLI (Codex has exec_command). VERIFIED
// the model runs `rtk mempalace status/search` and grounds answers in the palace.
const CODEX_GUIDANCE = `# Memory (MemPalace) — your long-term brain, via the mempalace CLI

You have a persistent memory palace. Access it through shell commands:

- WAKE-UP: run \`rtk mempalace status\` once at the start to load the palace.
- BEFORE answering about any project, person, past event, or prior decision:
  run \`rtk mempalace search "<query>"\` FIRST and ground your answer in the
  results. Never guess from training data.

# Tooling (rtk)

ALWAYS prefix shell commands with \`rtk\` (e.g. \`rtk git status\`, \`rtk ls\`).
rtk is a token-optimizing proxy — always safe (passes through unchanged when it
has no filter).`;

// Idempotently upsert the managed block into a markdown instruction file,
// preserving everything the user wrote outside the markers.
function upsertManagedSection(file: string, body: string): void {
  const block = `${MARK_START}\n${body}\n${MARK_END}`;
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch {
    // file doesn't exist yet — we'll create it
  }
  const re = new RegExp(
    `${MARK_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${MARK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
  );
  const next = re.test(existing)
    ? existing.replace(re, block)
    : (existing.trim() ? `${existing.trimEnd()}\n\n` : '') + `${block}\n`;
  if (next !== existing) fs.writeFileSync(file, next, 'utf8');
}

// Codex: ~/.codex/AGENTS.md (global guidance Codex reads on every session).
async function ensureCodexInstructions(): Promise<void> {
  try {
    if (!(await onPath('codex'))) return;
    upsertManagedSection(
      path.join(os.homedir(), '.codex', 'AGENTS.md'),
      CODEX_GUIDANCE,
    );
  } catch (err) {
    logger.warn(`ensureCodexInstructions: ${(err as Error).message}`);
  }
}

// Gemini: ~/.gemini/GEMINI.md (global context file Gemini loads on every session).
async function ensureGeminiInstructions(): Promise<void> {
  try {
    if (!(await onPath('gemini'))) return;
    upsertManagedSection(
      path.join(os.homedir(), '.gemini', 'GEMINI.md'),
      DEVSPACE_GUIDANCE,
    );
  } catch (err) {
    logger.warn(`ensureGeminiInstructions: ${(err as Error).message}`);
  }
}

// Codex parity: rtk guidance ONLY. MemPalace is intentionally NOT registered for
// Codex — it doesn't expose MCP server tools to custom-provider models (verified),
// so it would spawn an unusable server and waste model turns. (Gemini keeps it.)
export async function ensureCodexParity(): Promise<void> {
  await ensureCodexInstructions();
}

export async function ensureGeminiParity(): Promise<void> {
  await ensureGeminiMcp();
  await ensureGeminiInstructions();
}
