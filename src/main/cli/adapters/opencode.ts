// OpenCode CLI adapter. Detection + per-profile config isolation + spawn
// args + stream-line parser.
//
// Config isolation strategy:
//   - opencode reads ~/.config/opencode/opencode.json BY DEFAULT.
//   - Setting OPENCODE_CONFIG_DIR=<path> makes it use <path>/opencode.json
//     instead. We use this env knob to give each DevSpace profile its own
//     config dir at ~/.devspace/cli-profiles/<id>/ so the user's
//     upstream opencode config is NEVER mutated.
//
// Stream parsing: opencode emits one JSON object per line when invoked
// with `--format json`. We translate the common event shapes (text /
// message / done) into ChatEvent. Tool-event coverage is intentionally
// minimal in v0.30 — the renderer chip reads "~90% tools" but the
// reality is mostly text streaming. Tool parsing is queued for v0.30.1.
// See parseStreamLine() comments for details.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { generateOpenCodeConfig } from '@main/services/CliConfigGenerator';
import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { createLogger } from '@shared/logger';
import type { ChatEvent, CliDetectionResult, CliProfile } from '@shared/types';

import type { BuildSpawnArgsInput, CliAdapter, CliSpawnArgs } from '@main/cli/types';

const execFileP = promisify(execFile);
const logger = createLogger('opencode-adapter');

// File mode caps mirror LlmChatProfilesService: 0o600 on credential
// files, 0o700 on the parent dir.
const SECRET_FILE_MODE = 0o600;
const SECRET_DIR_MODE = 0o700;

// Detection timeout + output cap. 4s is generous for `--version` on a
// healthy install but bounds the hang case (e.g. binary is on PATH but
// blocking on a stale download lock).
const DETECT_TIMEOUT_MS = 4000;
const VERSION_OUTPUT_CAP = 256;

// SEC-HIGH-3 fix: defense-in-depth path containment guard. CliProfilesService
// validates UUID at the read path, but profileConfigDir is also called by
// the runner via the adapter handle (cached from older detection results).
// Refusing anything that resolves outside the cli-profiles root means a
// stale profile id from disk can't escape — even if validation upstream
// were ever bypassed by a future code path.
function profileConfigDir(profileId: string): string {
  // ~/.devspace/cli-profiles/<id>/  → contains opencode.json
  const root = path.join(os.homedir(), '.devspace', 'cli-profiles');
  const dir = path.join(root, profileId);
  const resolved = path.resolve(dir);
  if (resolved !== dir || !resolved.startsWith(root + path.sep)) {
    throw new Error(`profileConfigDir: rejected unsafe profile id`);
  }
  return resolved;
}

/** Default candidate path — `~/.opencode/bin/opencode` from `curl … | sh`. */
function defaultInstallPath(): string {
  return path.join(os.homedir(), '.opencode', 'bin', 'opencode');
}

async function isExecutable(bin: string): Promise<boolean> {
  try {
    await fs.promises.access(bin, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function whichBinary(): Promise<string | null> {
  // PATH fallback via the shell — match how Claude detection works in
  // ClaudeCliLauncher (which / where / wsl which). Keep platform branches
  // light; opencode officially supports macOS / Linux / Windows.
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileP(cmd, ['opencode'], {
      timeout: DETECT_TIMEOUT_MS,
      maxBuffer: 16 * 1024,
    });
    const first = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first && (await isExecutable(first))) return first;
  } catch {
    // No PATH match — that's expected on a fresh install.
  }
  return null;
}

async function readVersion(bin: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileP(bin, ['--version'], {
      timeout: DETECT_TIMEOUT_MS,
      maxBuffer: 8 * 1024,
    });
    const raw = stdout.toString().trim();
    if (!raw) return undefined;
    // Cap so a hostile binary printing megabytes of noise can't blow up
    // the renderer toast / settings panel.
    return raw.slice(0, VERSION_OUTPUT_CAP);
  } catch (err) {
    logger.warn(`opencode --version failed: ${(err as Error).message}`);
    return undefined;
  }
}

async function detect(): Promise<CliDetectionResult> {
  // 1) Default install path first — curl-installer drops here, takes
  //    priority over a stale shim on PATH.
  // 2) PATH fallback for users who built from source or used a custom
  //    package manager.
  const candidates: string[] = [];
  const direct = defaultInstallPath();
  if (await isExecutable(direct)) candidates.push(direct);
  const onPath = await whichBinary();
  if (onPath && !candidates.includes(onPath)) candidates.push(onPath);

  const bin = candidates[0];
  if (!bin) {
    return { cliId: 'opencode', installed: false };
  }
  const version = await readVersion(bin);
  return { cliId: 'opencode', installed: true, bin, version };
}

async function ensureConfig(
  profile: CliProfile,
): Promise<{ configDir: string }> {
  if (profile.cliId !== 'opencode') {
    throw new Error(
      `opencode.ensureConfig: expected cliId='opencode', got '${profile.cliId}'`,
    );
  }
  const dir = profileConfigDir(profile.id);
  const file = path.join(dir, 'opencode.json');
  const cfg = generateOpenCodeConfig(profile);
  // Atomic write w/ secret-file perms. Same posture as the LLM chat
  // profiles store — a snoop on a shared machine can't read the apiKey
  // we're about to drop on disk.
  await atomicWriteAsync(file, JSON.stringify(cfg, null, 2), {
    mode: SECRET_FILE_MODE,
    dirMode: SECRET_DIR_MODE,
  });
  return { configDir: dir };
}

function buildSpawnArgs(
  profile: CliProfile,
  opts: BuildSpawnArgsInput,
): CliSpawnArgs {
  if (profile.cliId !== 'opencode') {
    throw new Error(
      `opencode.buildSpawnArgs: expected cliId='opencode', got '${profile.cliId}'`,
    );
  }
  if (!opts.cwd || typeof opts.cwd !== 'string') {
    throw new Error('opencode.buildSpawnArgs: cwd is required');
  }
  // `opencode run` reads the message from positional args. Larger prompts
  // (full chat history + memory preamble) would blow the argv cap, so we
  // PASS THE PROMPT VIA STDIN — see OpenCodeRunner. The argv stays small
  // and uniform. `--format json` switches to line-delimited JSON events
  // for the stream parser.
  const args = ['run', '--format', 'json', '--print-logs'];
  // SEC-HIGH-2: OPENCODE_BIN override is test-only — a parent shell env
  // (or imported `.zshrc` exporting OPENCODE_BIN=/tmp/attacker) must NOT
  // be able to redirect the binary in prod. The detected path from
  // detect() is the source of truth for production runs.
  const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST;
  const bin =
    isTest && process.env.OPENCODE_BIN
      ? process.env.OPENCODE_BIN
      : defaultInstallPath();

  // SEC-HIGH-1: do NOT inherit the full parent env. DevSpace's parent
  // shell typically has ANTHROPIC_API_KEY / OPENAI_API_KEY / GITHUB_TOKEN
  // exported (and resolveInteractiveShellEnv imports more on launch).
  // Forwarding them to a third-party CLI binary that dials a user-
  // configured endpoint = credential exfiltration risk. Allow only an
  // explicit set of operationally-required vars; opencode-specific
  // config goes through OPENCODE_CONFIG_DIR + OPENCODE_FORMAT below.
  const PASSTHROUGH_KEYS = [
    'PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM', 'SHELL',
  ];
  const baseEnv: NodeJS.ProcessEnv = {};
  for (const k of PASSTHROUGH_KEYS) {
    const v = process.env[k];
    if (typeof v === 'string') baseEnv[k] = v;
  }
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    // Per-profile isolation. opencode reads <dir>/opencode.json instead
    // of ~/.config/opencode/opencode.json when this is set.
    OPENCODE_CONFIG_DIR: profileConfigDir(profile.id),
    // Force JSON line output even if user has a `format: pretty` in their
    // global config — defense in depth, --format json on argv already
    // wins but env can't hurt.
    OPENCODE_FORMAT: 'json',
  };

  return { bin, args, env };
}

// Stream-line parser. opencode --format json emits one JSON event per
// line. The exact schema is evolving across opencode releases; we
// pattern-match on a few well-known shapes and gracefully ignore
// anything else. v0.30 ships text-delta + done; tool events are
// deferred to v0.30.1 (see TODO below).
function parseStreamLine(line: string): ChatEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  // Heartbeats / non-JSON prefix lines (banner ASCII art on first start)
  // shouldn't crash the parser.
  if (trimmed[0] !== '{' && trimmed[0] !== '[') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  // Common shape: { type: 'text' | 'message' | 'done' | 'error', ... }
  // We treat `text` / `message_delta` / `content` as streaming text and
  // `done` / `complete` as terminal. Anything else returns null — the
  // runner is lenient about unknown event types.
  const kind = String(obj.type ?? obj.event ?? '').toLowerCase();
  const ts = Date.now();

  if (kind === 'text' || kind === 'message_delta' || kind === 'content_delta') {
    const text =
      typeof obj.text === 'string'
        ? obj.text
        : typeof obj.delta === 'string'
          ? obj.delta
          : typeof obj.content === 'string'
            ? obj.content
            : '';
    if (!text) return null;
    return { kind: 'text_delta', text, ts };
  }

  if (kind === 'error') {
    const message =
      typeof obj.message === 'string'
        ? obj.message
        : typeof obj.error === 'string'
          ? obj.error
          : 'opencode error';
    return { kind: 'error', message, ts };
  }

  if (kind === 'done' || kind === 'complete' || kind === 'finish') {
    return { kind: 'done', ts };
  }

  // TODO(v0.30.1): map opencode tool events (`tool_use`, `tool_result`)
  // into ChatEvent.tool_use / tool_result so the renderer's existing
  // ToolCard component can render them. v0.30 ships text-only — the
  // summaryLabel chip says "~90% tools" because the underlying CLI
  // supports tools, but DevSpace doesn't render them yet.

  return null;
}

export const openCodeAdapter: CliAdapter = {
  id: 'opencode',
  // Arch H3: HONEST capabilities for v0.30. OpenCode's stream-json
  // protocol CAN carry tool events, but parseStreamLine above only maps
  // text-delta / done — tool_use/tool_result are deferred to v0.30.1.
  // Until that parser ships, claiming toolCards/diffPreview/devlogAuto
  // would set users up for the "I asked it to edit a file, nothing
  // visible happened" surprise. Flip these back to true the same PR
  // that lands tool-event parsing.
  capabilities: {
    toolCards: false,
    diffPreview: false,
    askUserQuestion: false,
    skills: false,
    devlogAutoCapture: false,
    summaryLabel: 'Plain text (v0.30)',
  },
  detect,
  ensureConfig,
  buildSpawnArgs,
  parseStreamLine,
};

// Test-only helpers — exported through the bottom of the file so the
// public surface stays tight.
export const __testing = {
  defaultInstallPath,
  profileConfigDir,
};
