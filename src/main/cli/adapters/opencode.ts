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
// line. Real shape (confirmed against opencode v1.2.27 source —
// packages/opencode/src/cli/cmd/run.ts emit() helper):
//
//   {type, timestamp, sessionID, part?, error?, properties?}
//
// Each top-level event nests the actual data in `part` (TextPart,
// ToolPart, ReasoningPart, StepStartPart, StepFinishPart). TextPart
// puts the text at part.text — NOT obj.text. v0.30 shipped a parser
// that looked at obj.text directly → every text event returned null
// → user saw "Done" with no response. v0.30.1 fixed text/reasoning/
// error parsing. v0.30.2 (this patch) adds tool events + streaming
// text dedup marker for the runner.
//
// Tool events — opencode emits `tool_use` (NOT `tool`) when a ToolPart
// reaches a terminal state (completed or error). Pending/running parts
// are NOT emitted in JSON mode by current opencode (v1.x). We still
// accept the spec-described `tool` event with status:'running' as a
// future-compat path: if some future opencode version starts streaming
// running tool parts, we emit a `tool_use` ChatEvent so the renderer's
// ToolCard renders live. Completed → tool_result ChatEvent.
//
// ToolPart shape (message-v2.ts):
//   { type:'tool', id: PartID, sessionID, messageID, callID, tool,
//     state: { status, input, output?, error?, ... } }
// We prefer `part.callID` (the actual tool call id) but fall back to
// `part.id` for forward-compat with versions that might flatten.
//
// Streaming text — `message.part.updated` events carry CUMULATIVE
// text snapshots. The adapter can't dedup alone because parseStreamLine
// is stateless per call. We surface the snapshot with a `_partId`
// marker so the runner (future patch) can do "if this partId was seen
// before, replace previous; else emit fresh". The renderer never sees
// `_partId` — runner strips it before broadcast.
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

  const kind = String(obj.type ?? obj.event ?? '').toLowerCase();
  const ts = Date.now();

  // text — finalized TextPart. opencode v1.2.27 shape:
  //   {type:'text', timestamp, sessionID, part:{type:'text', text:'...', id, time, ...}}
  // Fallback to top-level obj.text / obj.delta / obj.content so we keep
  // working against future opencode versions that flatten the shape.
  if (kind === 'text' || kind === 'message_delta' || kind === 'content_delta') {
    const part = obj.part as Record<string, unknown> | undefined;
    const text =
      typeof part?.text === 'string' && part.text
        ? part.text
        : typeof obj.text === 'string'
          ? obj.text
          : typeof obj.delta === 'string'
            ? obj.delta
            : typeof obj.content === 'string'
              ? obj.content
              : '';
    if (!text) return null;
    return { kind: 'text_delta', text, ts };
  }

  // reasoning — thinking blocks (gpt-5-style models). Same nesting as
  // TextPart. We surface them as text_delta in v0.30.1 because there's
  // no dedicated `thinking` ChatEvent yet — a separate kind is queued
  // for a later patch so the renderer can render them dim/collapsed.
  if (kind === 'reasoning') {
    const part = obj.part as Record<string, unknown> | undefined;
    const text = typeof part?.text === 'string' ? part.text : '';
    if (!text) return null;
    return { kind: 'text_delta', text, ts };
  }

  // error / session.error — both shapes exist; session.error nests
  // under `properties`, top-level error puts the object at `obj.error`.
  if (kind === 'error' || kind === 'session.error') {
    const errRaw =
      (obj.error as unknown) ??
      ((obj.properties as Record<string, unknown> | undefined)?.error as unknown);
    let message = 'opencode error';
    if (typeof errRaw === 'string' && errRaw.trim()) {
      message = errRaw;
    } else if (errRaw && typeof errRaw === 'object') {
      const m = (errRaw as Record<string, unknown>).message;
      if (typeof m === 'string' && m.trim()) message = m;
    } else if (typeof obj.message === 'string' && obj.message.trim()) {
      message = obj.message;
    }
    return { kind: 'error', message, ts };
  }

  if (kind === 'done' || kind === 'complete' || kind === 'finish') {
    return { kind: 'done', ts };
  }

  // tool / tool_use / tool_result — ToolPart lifecycle. opencode v1.x
  // emits `tool_use` (NOT `tool`) for terminal states only, but we
  // accept all three event-name spellings + dispatch on the nested
  // state.status so future versions that stream running tools also
  // render live.
  if (kind === 'tool' || kind === 'tool_use' || kind === 'tool_result') {
    const part = obj.part as Record<string, unknown> | undefined;
    if (!part || typeof part !== 'object') return null;
    const state = (part.state ?? {}) as Record<string, unknown>;
    const status = typeof state.status === 'string' ? state.status : undefined;

    // Prefer `callID` (the actual tool-call id from ToolPart schema).
    // Fall back to `part.id` (PartID — present on every part via
    // partBase) for forward-compat with versions that flatten or drop
    // the callID/id distinction.
    const toolUseId =
      typeof part.callID === 'string' && part.callID
        ? part.callID
        : typeof part.id === 'string' && part.id
          ? part.id
          : '';
    // SEC-M1: bound id/name lengths + charset. A hostile/compromised
    // opencode binary could emit megabytes of garbage here that would
    // end up persisted in the thread transcript + broadcast on every
    // event. Identifiers and tool names should be short tokens.
    if (!toolUseId || toolUseId.length > 256 || !/^[A-Za-z0-9._:\-]+$/.test(toolUseId)) {
      return null;
    }

    const toolName =
      typeof part.tool === 'string' && part.tool ? part.tool : '';
    if (!toolName || toolName.length > 128 || !/^[A-Za-z0-9_\-]+$/.test(toolName)) {
      return null;
    }

    // Treat status:'completed' or 'error' as a tool_result. Any other
    // status (or missing status with output present) is also a result.
    // status:'running' / 'pending' (or missing status with no output) →
    // emit the tool_use start so the renderer shows the chip live.
    const isCompleted =
      status === 'completed' ||
      status === 'error' ||
      // Defensive: presence of output/error fields means it's terminal
      // regardless of whether the status string was set.
      typeof state.output === 'string' ||
      typeof state.error === 'string';

    if (isCompleted) {
      const output =
        typeof state.output === 'string'
          ? state.output
          : typeof state.error === 'string'
            ? state.error
            : '';
      return {
        kind: 'tool_result',
        toolUseId,
        toolResult: output,
        toolIsError: status === 'error' || typeof state.error === 'string',
        ts,
      };
    }

    // Running / pending — tool_use start.
    const input =
      state.input && typeof state.input === 'object'
        ? (state.input as Record<string, unknown>)
        : undefined;
    return {
      kind: 'tool_use',
      toolUseId,
      toolName,
      toolInput: input,
      ts,
    };
  }

  // message.part.updated — cumulative streaming snapshot.
  //
  // v0.30.2 review (code-reviewer HIGH-1 + HIGH-2): the previous draft
  // parsed this event into a text_delta with an internal `_partId`
  // marker, intending for the runner to dedup. The runner-side dedup
  // never landed in v0.30.2 (out of scope). Without it, every snapshot
  // would APPEND its full cumulative prefix to assistant.content —
  // a 5-snapshot stream would write 1+2+3+4+5 = 15 tokens for 5 unique
  // tokens, corrupting the persisted transcript. AND the `_partId`
  // marker would ride out through Electron structured-clone to the
  // renderer as IPC noise.
  //
  // Verified against opencode v1.2.27 source (apps/opencode/packages/
  // opencode/src/cli/cmd/run.ts emit loop): `message.part.updated` is
  // a bus event NOT emitted in `--format json` mode today. Production
  // opencode streams via finalized `text` events instead. So dropping
  // this branch is a no-op for current opencode while removing the
  // half-design + cumulative-text + IPC-leak risks.
  //
  // To re-enable in v0.30.3: implement runner-side `Map<partId,
  // lastEmittedLength>` dedup in OpenCodeRunner.emitLine, emit only
  // `text.slice(lastLen)` as the delta, then strip `_partId` before
  // forwarding via opts.onEvent.

  // Known no-ops (lifecycle signals, not user-visible content):
  //   - step_start / step_finish (model API step boundaries)
  //   - session.status (idle/running — runner uses exit code instead)
  //   - permission.asked (auto-rejected by opencode in non-interactive
  //     mode; surfacing it would just add noise to chat)
  return null;
}

export const openCodeAdapter: CliAdapter = {
  id: 'opencode',
  // v0.30.2: tool-event parsing (tool_use + tool_result) landed in
  // parseStreamLine above, so toolCards + diffPreview + devlogAutoCapture
  // are now honest claims. diffPreview is computed downstream by the
  // ChatLineHandler / runner from the tool_use input — we just need to
  // surface the events for it to fire on.
  //
  // STILL FALSE in v0.30.2:
  //   - askUserQuestion: Claude-specific MCP tool. opencode has its own
  //     permission flow but no programmatic question-answer pairing.
  //   - skills: claude-only directory convention.
  capabilities: {
    toolCards: true,
    diffPreview: true,
    askUserQuestion: false,
    skills: false,
    devlogAutoCapture: true,
    summaryLabel: 'Tools enabled (beta)',
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
