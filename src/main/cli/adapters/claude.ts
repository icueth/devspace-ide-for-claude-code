// Claude CLI adapter — DETECTION-ONLY stub.
//
// Claude is not driven through the generic CliAdapter / OpenCodeRunner
// path; it has its own well-tested TmuxChatRunner pipeline (chat history
// over stdin, --output-format stream-json, AskUserQuestion early-
// finalize, tool cards, devlog auto-capture, …). This adapter exists
// SOLELY so the cli:detect IPC can report Claude alongside other CLIs
// in the Settings UI — installed-or-not, version, resolved bin path.
//
// ensureConfig / buildSpawnArgs throw because there's no per-profile
// concept for Claude (it uses the global ~/.claude/ config and the
// user's logged-in account). Callers that mistakenly route a Claude
// thread through this adapter will surface a loud error instead of
// silently corrupting state.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { promisify } from 'node:util';

import { createLogger } from '@shared/logger';
import type { CliDetectionResult, CliProfile } from '@shared/types';

import type { BuildSpawnArgsInput, CliAdapter, CliSpawnArgs } from '@main/cli/types';

// v0.37: parsed semver tuple for the installed claude binary. Used by
// the renderer's version-gate to disable UI for new commands (Effort,
// Goal, Reload-skills, Ultra-Review, Background-run) when the user's
// claude is older than 2.1.154. Defaults to "unknown" = fail-open.
export interface ClaudeSemver {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Extract a {major, minor, patch} triple from `claude --version` output.
 * Accepts the common forms emitted across versions:
 *   "2.1.154 (Claude Code)"
 *   "claude 2.1.154"
 *   "v2.1.154"
 *   "2.1"               → patch = 0
 *   "2"                 → minor = patch = 0
 * Returns null when no numeric leading triple is present.
 */
export function parseClaudeVersion(raw: string): ClaudeSemver | null {
  if (!raw) return null;
  // Match the FIRST `<digits>.<digits>(.<digits>)?` token, allowing an
  // optional leading `v` and any preceding non-digit text ("claude ", …).
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(raw);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2] ?? '0'),
    patch: Number(m[3] ?? '0'),
  };
}

/**
 * Compare-aware semver predicate. Returns true when `actual` >= `min`.
 * Major beats minor beats patch; pure numeric, ignores prerelease tags.
 */
export function meetsClaudeVersion(
  actual: ClaudeSemver | null,
  min: ClaudeSemver,
): boolean {
  if (!actual) return false;
  if (actual.major !== min.major) return actual.major > min.major;
  if (actual.minor !== min.minor) return actual.minor > min.minor;
  return actual.patch >= min.patch;
}

const execFileP = promisify(execFile);
const logger = createLogger('claude-adapter');

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
    const { stdout } = await execFileP(cmd, ['claude'], {
      timeout: DETECT_TIMEOUT_MS,
      maxBuffer: 16 * 1024,
    });
    const first = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first && (await isExecutable(first))) return first;
  } catch {
    // No PATH match — expected on a host that hasn't installed claude.
  }
  return null;
}

async function detect(): Promise<CliDetectionResult> {
  const bin = await whichBinary();
  if (!bin) return { cliId: 'claude', installed: false };
  // `claude --version` round-trip. Best-effort — a missing version
  // shouldn't flip installed to false (the binary IS on PATH and X).
  let version: string | undefined;
  try {
    const { stdout } = await execFileP(bin, ['--version'], {
      timeout: DETECT_TIMEOUT_MS,
      maxBuffer: 8 * 1024,
    });
    const raw = stdout.toString().trim();
    if (raw) version = raw.slice(0, VERSION_OUTPUT_CAP);
  } catch (err) {
    logger.warn(`claude --version failed: ${(err as Error).message}`);
  }
  return { cliId: 'claude', installed: true, bin, version };
}

function ensureConfigUnsupported(): never {
  throw new Error(
    "claude adapter: ensureConfig is unsupported — Claude uses ~/.claude/ global config, not per-profile dirs",
  );
}

function buildSpawnArgsUnsupported(): never {
  throw new Error(
    "claude adapter: buildSpawnArgs is unsupported — Claude chat threads route through TmuxChatRunner, not the generic CliRunner",
  );
}

export const claudeAdapter: CliAdapter = {
  id: 'claude',
  capabilities: {
    toolCards: true,
    diffPreview: true,
    askUserQuestion: true,
    skills: true,
    summaryLabel: 'Full',
  },
  detect,
  // The unused parameter linter would complain about the discarded args;
  // wrap to absorb them without surfacing typings noise.
  ensureConfig: async (_profile: CliProfile) => ensureConfigUnsupported(),
  buildSpawnArgs: (_profile: CliProfile, _opts: BuildSpawnArgsInput): CliSpawnArgs =>
    buildSpawnArgsUnsupported(),
};
