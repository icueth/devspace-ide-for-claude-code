import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openCodeAdapter, __testing } from '@main/cli/adapters/opencode';
import type { CliProfile } from '@shared/types';

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
  // Arch H3: HONEST capabilities for v0.30 — tool_use/tool_result events
  // are deferred to v0.30.1 so toolCards/diffPreview/devlogAutoCapture
  // must report false until the parser lands. Flipping these back without
  // also implementing the parser would put a `~90% tools` chip on plain-
  // text output. This test pins the honest values.
  it('reports plain-text-only for v0.30 (tool events deferred to 0.30.1)', () => {
    expect(openCodeAdapter.capabilities).toEqual({
      toolCards: false,
      diffPreview: false,
      askUserQuestion: false,
      skills: false,
      devlogAutoCapture: false,
      summaryLabel: 'Plain text (v0.30)',
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

  it('returns null for unknown event types (tool events deferred to v0.30.1)', () => {
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
