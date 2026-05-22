import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openCodeAdapter, __testing } from '@main/cli/adapters/opencode';
import type { ChatEvent, CliProfile } from '@shared/types';

const ORIGINAL_HOME = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devspace-opencode-adapter-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (ORIGINAL_HOME !== undefined) process.env.HOME = ORIGINAL_HOME;
  else delete process.env.HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function profile(): CliProfile {
  return {
    id: '99999999-9999-9999-9999-999999999999',
    name: 'test',
    cliId: 'opencode',
    provider: {
      baseURL: 'http://10.20.30.40:8000/v1',
      apiKey: 'sk-test',
      model: 'AEON-7/Qwen3.6-27B',
    },
    createdAt: 0,
  };
}

describe('openCodeAdapter — capabilities', () => {
  // v0.30.2: tool_use / tool_result parsing landed, so toolCards +
  // diffPreview + devlogAutoCapture flip to true. askUserQuestion stays
  // false (Claude-specific MCP tool), skills stays false (Claude-only
  // directory convention).
  it('reports tool-card support for v0.30.2 (parser landed)', () => {
    expect(openCodeAdapter.capabilities).toEqual({
      toolCards: true,
      diffPreview: true,
      askUserQuestion: false,
      skills: false,
      devlogAutoCapture: true,
      summaryLabel: 'Tools enabled (beta)',
    });
  });
});

describe('openCodeAdapter — ensureConfig', () => {
  it('writes opencode.json under ~/.devspace/cli-profiles/<id>/', async () => {
    const p = profile();
    const { configDir } = await openCodeAdapter.ensureConfig(p);
    expect(configDir).toBe(
      path.join(tmpHome, '.devspace', 'cli-profiles', p.id),
    );
    const file = path.join(configDir, 'opencode.json');
    expect(fs.existsSync(file)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(cfg.provider['devspace-openai']).toBeDefined();
    expect(cfg.provider['devspace-openai'].options.baseURL).toBe(
      'http://10.20.30.40:8000/v1',
    );
    expect(cfg.model).toBe('devspace-openai/AEON-7/Qwen3.6-27B');
  });

  it('writes the config file with 0o600 mode (POSIX)', async () => {
    if (process.platform === 'win32') return;
    const p = profile();
    const { configDir } = await openCodeAdapter.ensureConfig(p);
    const file = path.join(configDir, 'opencode.json');
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode & 0o600).toBe(0o600);
    expect(mode & 0o077).toBe(0);
  });

  it('throws when cliId is not opencode', async () => {
    await expect(
      openCodeAdapter.ensureConfig({
        ...profile(),
        // @ts-expect-error — runtime guard
        cliId: 'claude',
      }),
    ).rejects.toThrow(/expected cliId='opencode'/);
  });

  it('is idempotent — re-running overwrites in place', async () => {
    const p = profile();
    await openCodeAdapter.ensureConfig(p);
    await openCodeAdapter.ensureConfig({
      ...p,
      provider: { ...p.provider, model: 'updated-model' },
    });
    const file = path.join(__testing.profileConfigDir(p.id), 'opencode.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(cfg.model).toBe('devspace-openai/updated-model');
  });
});

describe('openCodeAdapter — buildSpawnArgs', () => {
  it('builds argv for `opencode run --format json` with stdin prompt', () => {
    const args = openCodeAdapter.buildSpawnArgs(profile(), {
      prompt: 'hello',
      cwd: '/tmp/project',
    });
    expect(args.args[0]).toBe('run');
    expect(args.args).toContain('--format');
    expect(args.args).toContain('json');
    // prompt itself must NOT appear in argv — it goes through stdin so
    // long chat histories don't blow the argv cap.
    expect(args.args.join(' ')).not.toContain('hello');
  });

  it('injects OPENCODE_CONFIG_DIR pointing at the per-profile dir', () => {
    const p = profile();
    const args = openCodeAdapter.buildSpawnArgs(p, {
      prompt: 'x',
      cwd: '/tmp/project',
    });
    expect(args.env.OPENCODE_CONFIG_DIR).toBe(
      path.join(tmpHome, '.devspace', 'cli-profiles', p.id),
    );
  });

  it('passes through allowlisted env vars but NOT arbitrary parent env', () => {
    // SEC-HIGH-1 fix: opencode is third-party and routes to a user-
    // configured endpoint, so we must NOT forward the parent shell's
    // ANTHROPIC_API_KEY / OPENAI_API_KEY / GITHUB_TOKEN. Allowlist is
    // PATH/HOME/USER/LANG/LC_ALL/TMPDIR/TERM/SHELL + opencode-specific
    // overrides. This test pins the allowlist by injecting both a
    // passthrough var (HOME, already set in beforeEach) and a sensitive
    // one (ANTHROPIC_API_KEY) and asserting only the former survives.
    process.env.ANTHROPIC_API_KEY = 'sk-should-not-leak';
    try {
      const args = openCodeAdapter.buildSpawnArgs(profile(), {
        prompt: 'x',
        cwd: '/tmp/project',
      });
      // PATH/HOME survive (operationally required).
      expect(args.env.HOME).toBe(tmpHome);
      // Sensitive keys do NOT survive.
      expect(args.env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('throws when cwd is missing', () => {
    expect(() =>
      openCodeAdapter.buildSpawnArgs(profile(), {
        prompt: 'x',
        // @ts-expect-error — runtime guard
        cwd: undefined,
      }),
    ).toThrow(/cwd is required/);
  });

  it('throws when cliId is not opencode', () => {
    expect(() =>
      openCodeAdapter.buildSpawnArgs(
        { ...profile(), cliId: 'claude' as unknown as 'opencode' },
        { prompt: 'x', cwd: '/tmp' },
      ),
    ).toThrow(/expected cliId='opencode'/);
  });

  it('falls back to the default install path when no env override', () => {
    delete process.env.OPENCODE_BIN;
    const args = openCodeAdapter.buildSpawnArgs(profile(), {
      prompt: 'x',
      cwd: '/tmp/project',
    });
    expect(args.bin).toBe(path.join(tmpHome, '.opencode', 'bin', 'opencode'));
  });

  it('honors OPENCODE_BIN env override', () => {
    process.env.OPENCODE_BIN = '/usr/local/bin/opencode-test';
    try {
      const args = openCodeAdapter.buildSpawnArgs(profile(), {
        prompt: 'x',
        cwd: '/tmp/project',
      });
      expect(args.bin).toBe('/usr/local/bin/opencode-test');
    } finally {
      delete process.env.OPENCODE_BIN;
    }
  });
});

describe('openCodeAdapter — parseStreamLine', () => {
  it('returns null for blank lines', () => {
    expect(openCodeAdapter.parseStreamLine!('')).toBeNull();
    expect(openCodeAdapter.parseStreamLine!('   ')).toBeNull();
  });

  it('returns null for non-JSON banner lines (opencode ASCII art)', () => {
    expect(openCodeAdapter.parseStreamLine!('opencode v1.2.27')).toBeNull();
    expect(openCodeAdapter.parseStreamLine!('███')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(openCodeAdapter.parseStreamLine!('{not json')).toBeNull();
  });

  it('parses text events into text_delta', () => {
    const event = openCodeAdapter.parseStreamLine!(
      '{"type":"text","text":"hello"}',
    );
    expect(event?.kind).toBe('text_delta');
    expect(event?.text).toBe('hello');
  });

  it('parses message_delta events with delta field', () => {
    const event = openCodeAdapter.parseStreamLine!(
      '{"type":"message_delta","delta":"more"}',
    );
    expect(event?.kind).toBe('text_delta');
    expect(event?.text).toBe('more');
  });

  it('parses content_delta events', () => {
    const event = openCodeAdapter.parseStreamLine!(
      '{"type":"content_delta","content":"chunk"}',
    );
    expect(event?.kind).toBe('text_delta');
    expect(event?.text).toBe('chunk');
  });

  it('parses error events', () => {
    const event = openCodeAdapter.parseStreamLine!(
      '{"type":"error","message":"upstream 500"}',
    );
    expect(event?.kind).toBe('error');
    expect(event?.message).toBe('upstream 500');
  });

  it('parses done events', () => {
    const event = openCodeAdapter.parseStreamLine!('{"type":"done"}');
    expect(event?.kind).toBe('done');
  });

  it('parses complete/finish as terminal events', () => {
    expect(openCodeAdapter.parseStreamLine!('{"type":"complete"}')?.kind).toBe(
      'done',
    );
    expect(openCodeAdapter.parseStreamLine!('{"type":"finish"}')?.kind).toBe(
      'done',
    );
  });

  it('returns null for malformed tool_use events (no part / no tool name)', () => {
    // v0.30.2: tool_use events ARE parsed when properly structured, but
    // a flat shape with no `part` and no `tool` is unrecognizable and
    // must drop silently rather than emit a broken ToolCard.
    expect(
      openCodeAdapter.parseStreamLine!(
        '{"type":"tool_use","name":"Read","input":{}}',
      ),
    ).toBeNull();
  });

  it('returns null when text event carries no text payload', () => {
    expect(openCodeAdapter.parseStreamLine!('{"type":"text"}')).toBeNull();
  });
});

describe('openCodeAdapter — parseStreamLine (opencode v1.2.27 real shapes)', () => {
  // v0.30 bug: opencode emits text inside obj.part.text, NOT obj.text directly.
  // The first ship of the parser missed this and every text event returned
  // null → user saw "Done" with no response visible. v0.30.1 pins all four
  // production shapes (text/reasoning/error/session.error) against regression.

  it('parses text event with nested part.text (the v0.30 regression)', () => {
    const event = openCodeAdapter.parseStreamLine!(
      JSON.stringify({
        type: 'text',
        timestamp: 1000,
        sessionID: 'ses_abc',
        part: {
          type: 'text',
          id: 'prt_xyz',
          sessionID: 'ses_abc',
          messageID: 'msg_123',
          text: 'Hello from opencode',
          time: { start: 1000, end: 1100 },
        },
      }),
    );
    expect(event?.kind).toBe('text_delta');
    expect(event?.text).toBe('Hello from opencode');
  });

  it('keeps the flat-shape fallback for forward compatibility', () => {
    // If opencode ever flattens the shape, we don't want to regress users.
    const event = openCodeAdapter.parseStreamLine!(
      JSON.stringify({ type: 'text', text: 'flat shape' }),
    );
    expect(event?.kind).toBe('text_delta');
    expect(event?.text).toBe('flat shape');
  });

  it('parses reasoning events as text_delta (thinking blocks)', () => {
    const event = openCodeAdapter.parseStreamLine!(
      JSON.stringify({
        type: 'reasoning',
        timestamp: 2000,
        sessionID: 'ses_abc',
        part: { type: 'reasoning', text: 'Let me think...', time: { start: 2000 } },
      }),
    );
    expect(event?.kind).toBe('text_delta');
    expect(event?.text).toBe('Let me think...');
  });

  it('parses session.error with nested error.message', () => {
    const event = openCodeAdapter.parseStreamLine!(
      JSON.stringify({
        type: 'session.error',
        timestamp: 3000,
        sessionID: 'ses_abc',
        properties: {
          error: { name: 'ProviderAuthError', message: 'invalid api key' },
        },
      }),
    );
    expect(event?.kind).toBe('error');
    expect(event?.message).toBe('invalid api key');
  });

  it('parses top-level error with error.message object shape', () => {
    const event = openCodeAdapter.parseStreamLine!(
      JSON.stringify({
        type: 'error',
        error: { message: 'upstream timeout' },
      }),
    );
    expect(event?.kind).toBe('error');
    expect(event?.message).toBe('upstream timeout');
  });

  it('drops message.part.updated entirely (v0.30.2 review HIGH-1+2 regression)', () => {
    // The previous draft parsed message.part.updated into text_delta with
    // an internal `_partId` marker, but the runner-side dedup that would
    // have made that safe never landed in v0.30.2. Without dedup, every
    // cumulative snapshot would APPEND the full prefix to assistant.content
    // (1+2+3+4+5 tokens for a 5-snapshot stream). AND the `_partId` marker
    // would leak to the renderer via IPC.
    //
    // Production opencode v1.2.27 does NOT emit this event in --format json
    // (verified against opencode source apps/opencode/packages/opencode/
    // src/cli/cmd/run.ts) so dropping costs us nothing today. v0.30.3 may
    // re-enable with proper runner-side dedup state.
    //
    // This test PINS the dropped behavior so a future contributor can't
    // re-add the half-design without also wiring the dedup.
    expect(
      openCodeAdapter.parseStreamLine!(
        JSON.stringify({
          type: 'message.part.updated',
          properties: {
            part: { type: 'text', id: 'prt_xyz', text: 'cumulative text' },
          },
        }),
      ),
    ).toBeNull();
    expect(
      openCodeAdapter.parseStreamLine!(
        JSON.stringify({
          type: 'message.part.updated',
          part: { type: 'text', id: 'prt_flat', text: 'hi flat' },
        }),
      ),
    ).toBeNull();
  });

  it('returns null for step_start / step_finish (lifecycle, not content)', () => {
    expect(
      openCodeAdapter.parseStreamLine!(
        JSON.stringify({ type: 'step_start', part: {} }),
      ),
    ).toBeNull();
    expect(
      openCodeAdapter.parseStreamLine!(
        JSON.stringify({
          type: 'step_finish',
          part: { type: 'step-finish', reason: 'stop', cost: 0.001 },
        }),
      ),
    ).toBeNull();
  });
});

describe('openCodeAdapter — parseStreamLine (tool events, v0.30.2)', () => {
  // ToolPart shape from opencode message-v2.ts:
  //   { type:'tool', id, sessionID, messageID, callID, tool,
  //     state:{ status, input, output?, error?, ... } }
  // Event wrapper (run.ts emit()):
  //   { type:'tool_use'|'tool', timestamp, sessionID, part: ToolPart }
  //
  // opencode v1.x only emits `tool_use` for terminal states (completed/
  // error) — running tool parts stay silent in JSON mode. We still
  // accept the spec-described `tool` + status:'running' shape so a
  // future opencode version that streams running tools renders live
  // chips without an adapter patch.

  it('parses tool_use event with completed state into a tool_result ChatEvent', () => {
    // The dominant real-world case: opencode v1.x emit() for a finished
    // file read. callID is the tool-call id, state.output is the result.
    const event = openCodeAdapter.parseStreamLine!(
      JSON.stringify({
        type: 'tool_use',
        timestamp: 1000,
        sessionID: 'ses_abc',
        part: {
          type: 'tool',
          id: 'prt_001',
          callID: 'call_xyz_42',
          tool: 'read',
          sessionID: 'ses_abc',
          messageID: 'msg_1',
          state: {
            status: 'completed',
            input: { path: '/tmp/foo.txt' },
            output: 'file contents here',
            title: 'read /tmp/foo.txt',
            metadata: {},
            time: { start: 1000, end: 1100 },
          },
        },
      }),
    );
    expect(event?.kind).toBe('tool_result');
    expect(event?.toolUseId).toBe('call_xyz_42');
    expect(event?.toolResult).toBe('file contents here');
    expect(event?.toolIsError).toBe(false);
  });

  it('parses tool_use event with error state into tool_result with toolIsError=true', () => {
    const event = openCodeAdapter.parseStreamLine!(
      JSON.stringify({
        type: 'tool_use',
        sessionID: 'ses_abc',
        part: {
          type: 'tool',
          callID: 'call_err_1',
          tool: 'edit',
          state: {
            status: 'error',
            input: { path: '/tmp/missing.txt', new_string: 'x' },
            error: 'file not found',
            time: { start: 1, end: 2 },
          },
        },
      }),
    );
    expect(event?.kind).toBe('tool_result');
    expect(event?.toolUseId).toBe('call_err_1');
    expect(event?.toolResult).toBe('file not found');
    expect(event?.toolIsError).toBe(true);
  });

  it('parses `tool` event with status:running into a tool_use ChatEvent (forward-compat)', () => {
    // opencode v1.x doesn't emit this shape in JSON mode today, but the
    // spec-described `tool` event with status:'running' is the natural
    // place to surface a live ToolCard if/when opencode adds it. Wiring
    // it now means a future version "just works" without an adapter
    // bump.
    const event = openCodeAdapter.parseStreamLine!(
      JSON.stringify({
        type: 'tool',
        sessionID: 'ses_abc',
        part: {
          type: 'tool',
          callID: 'call_run_1',
          tool: 'bash',
          state: {
            status: 'running',
            input: { command: 'ls -la' },
            time: { start: 1000 },
          },
        },
      }),
    );
    expect(event?.kind).toBe('tool_use');
    expect(event?.toolUseId).toBe('call_run_1');
    expect(event?.toolName).toBe('bash');
    expect(event?.toolInput).toEqual({ command: 'ls -la' });
  });

  it('falls back to part.id when callID is absent (flat-shape forward-compat)', () => {
    // Defensive: if a future opencode flattens away the callID/id
    // distinction or omits callID entirely, we still need a stable id
    // to pair tool_use ↔ tool_result. part.id (PartID from partBase)
    // is the second-best candidate.
    const event = openCodeAdapter.parseStreamLine!(
      JSON.stringify({
        type: 'tool_use',
        part: {
          type: 'tool',
          id: 'prt_fallback',
          tool: 'write',
          state: { status: 'completed', input: {}, output: 'done' },
        },
      }),
    );
    expect(event?.kind).toBe('tool_result');
    expect(event?.toolUseId).toBe('prt_fallback');
  });

  it('drops tool events with neither callID nor id (unrecoverable)', () => {
    // Without any stable id we cannot pair a future tool_result back to
    // its tool_use, so emitting a half-broken event would corrupt the
    // renderer's ToolCard state. Drop silently.
    const event = openCodeAdapter.parseStreamLine!(
      JSON.stringify({
        type: 'tool_use',
        part: { type: 'tool', tool: 'read', state: { status: 'completed' } },
      }),
    );
    expect(event).toBeNull();
  });

  it('drops tool events with no tool name (unrecoverable)', () => {
    // Without the tool name the renderer has nothing to label the chip
    // with. Drop silently rather than show a blank ToolCard.
    const event = openCodeAdapter.parseStreamLine!(
      JSON.stringify({
        type: 'tool_use',
        part: { type: 'tool', callID: 'c1', state: { status: 'completed' } },
      }),
    );
    expect(event).toBeNull();
  });

  it('treats presence of state.output as terminal even when status is missing', () => {
    // Defensive: a future shape change that drops the status discriminator
    // string but keeps output should still surface the tool_result so the
    // renderer doesn't get stuck on a "running" chip.
    const event = openCodeAdapter.parseStreamLine!(
      JSON.stringify({
        type: 'tool_use',
        part: {
          type: 'tool',
          callID: 'c_no_status',
          tool: 'read',
          state: { input: { path: '/x' }, output: 'contents' },
        },
      }),
    );
    expect(event?.kind).toBe('tool_result');
    expect(event?.toolResult).toBe('contents');
    expect(event?.toolIsError).toBe(false);
  });

  // ── SEC-M1 regression: unbounded id/name input from a hostile opencode ─

  it('SEC-M1: rejects toolUseId longer than 256 chars', () => {
    // A compromised opencode binary could emit megabytes of garbage here
    // which would end up persisted in the thread transcript + broadcast on
    // every event. Reject anything beyond a sane identifier length.
    const longId = 'a'.repeat(257);
    const event = openCodeAdapter.parseStreamLine!(
      JSON.stringify({
        type: 'tool_use',
        part: {
          type: 'tool',
          callID: longId,
          tool: 'read',
          state: { status: 'completed', output: 'ok' },
        },
      }),
    );
    expect(event).toBeNull();
  });

  it('SEC-M1: rejects toolUseId with disallowed characters (path traversal, shell metachars)', () => {
    // Restrict to [A-Za-z0-9._:-] so a fake id like "../../../etc/passwd"
    // or "; rm -rf /" cannot ride through into renderer state.
    for (const badId of ['../../../etc/passwd', '$(rm -rf /)', 'a/b', 'has space']) {
      const event = openCodeAdapter.parseStreamLine!(
        JSON.stringify({
          type: 'tool_use',
          part: {
            type: 'tool',
            callID: badId,
            tool: 'read',
            state: { status: 'completed', output: 'ok' },
          },
        }),
      );
      expect(event).toBeNull();
    }
  });

  it('SEC-M1: rejects toolName longer than 128 chars or with disallowed characters', () => {
    const longName = 'A'.repeat(129);
    const eventA = openCodeAdapter.parseStreamLine!(
      JSON.stringify({
        type: 'tool_use',
        part: {
          type: 'tool',
          callID: 'c1',
          tool: longName,
          state: { status: 'completed', output: 'ok' },
        },
      }),
    );
    expect(eventA).toBeNull();
    for (const badName of ['rm -rf', 'a.b', 'a/b', '$(x)']) {
      const event = openCodeAdapter.parseStreamLine!(
        JSON.stringify({
          type: 'tool_use',
          part: {
            type: 'tool',
            callID: 'c1',
            tool: badName,
            state: { status: 'completed', output: 'ok' },
          },
        }),
      );
      expect(event).toBeNull();
    }
  });
});
