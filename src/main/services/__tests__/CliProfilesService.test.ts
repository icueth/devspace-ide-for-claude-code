import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __resetCacheForTests,
  deleteProfile,
  getProfile,
  listProfiles,
  loadProfiles,
  upsertProfile,
} from '@main/services/CliProfilesService';

// Mirrors LlmChatProfilesService tests — redirects HOME to a tmpdir so
// no real ~/.devspace/ is touched. Each test starts with a fresh cache.

const ORIGINAL_HOME = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devspace-cli-profiles-'));
  process.env.HOME = tmpHome;
  __resetCacheForTests();
});

afterEach(() => {
  if (ORIGINAL_HOME !== undefined) process.env.HOME = ORIGINAL_HOME;
  else delete process.env.HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function profilesFile(): string {
  return path.join(tmpHome, '.devspace', 'cli-profiles.json');
}

const validProfile = {
  name: 'AEON Qwen3.6',
  cliId: 'opencode' as const,
  provider: {
    baseURL: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    model: 'AEON-7/Qwen3.6-27B',
  },
};

describe('CliProfilesService — upsert', () => {
  it('creates a new profile with a UUID id + createdAt', async () => {
    const before = Date.now();
    const saved = await upsertProfile(validProfile);
    expect(saved.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(saved.createdAt).toBeGreaterThanOrEqual(before);
    expect(saved.cliId).toBe('opencode');
    expect(saved.name).toBe('AEON Qwen3.6');
    expect(saved.provider.baseURL).toBe('https://api.example.com/v1');
    expect(saved.provider.model).toBe('AEON-7/Qwen3.6-27B');

    const onDisk = JSON.parse(fs.readFileSync(profilesFile(), 'utf8'));
    expect(onDisk.profiles).toHaveLength(1);
    expect(onDisk.profiles[0].id).toBe(saved.id);
    expect(onDisk.profiles[0].cliId).toBe('opencode');
  });

  it('updates existing profile in place, preserving id + createdAt', async () => {
    const first = await upsertProfile(validProfile);
    await new Promise((r) => setTimeout(r, 5));

    const updated = await upsertProfile({
      id: first.id,
      name: 'Renamed',
      cliId: 'opencode',
      provider: {
        baseURL: 'https://api.other.com/v1',
        apiKey: 'sk-new',
        model: 'gpt-oss-20b',
      },
    });

    expect(updated.id).toBe(first.id);
    expect(updated.createdAt).toBe(first.createdAt);
    expect(updated.name).toBe('Renamed');
    expect(updated.provider.model).toBe('gpt-oss-20b');

    const list = await listProfiles();
    expect(list).toHaveLength(1);
  });

  it('rejects upsert without a name', async () => {
    await expect(
      upsertProfile({ ...validProfile, name: '   ' }),
    ).rejects.toThrow(/name is required/);
  });

  it('rejects upsert with a non-allowlist cliId', async () => {
    await expect(
      upsertProfile({
        // @ts-expect-error — testing rejection of unknown cli ids
        cliId: 'claude',
        name: 'x',
        provider: {
          baseURL: 'https://x',
          apiKey: 'k',
          model: 'm',
        },
      }),
    ).rejects.toThrow(/cliId must be one of/);
    await expect(
      upsertProfile({
        // @ts-expect-error — testing rejection of fictional ids
        cliId: 'codex',
        name: 'x',
        provider: { baseURL: 'https://x', apiKey: 'k', model: 'm' },
      }),
    ).rejects.toThrow(/cliId must be one of/);
  });

  it('rejects upsert without a baseURL', async () => {
    await expect(
      upsertProfile({
        name: 'x',
        cliId: 'opencode',
        provider: { baseURL: '', apiKey: 'k', model: 'm' },
      }),
    ).rejects.toThrow(/baseURL is required/);
  });

  it('rejects upsert without a model', async () => {
    await expect(
      upsertProfile({
        name: 'x',
        cliId: 'opencode',
        provider: { baseURL: 'https://x', apiKey: 'k', model: '   ' },
      }),
    ).rejects.toThrow(/model is required/);
  });

  it('blocks SSRF baseURL: cloud metadata', async () => {
    await expect(
      upsertProfile({
        ...validProfile,
        provider: { ...validProfile.provider, baseURL: 'http://169.254.169.254' },
      }),
    ).rejects.toThrow(/blocked/);
  });

  it('blocks SSRF baseURL: private IPs', async () => {
    await expect(
      upsertProfile({
        ...validProfile,
        provider: { ...validProfile.provider, baseURL: 'http://10.0.0.1/v1' },
      }),
    ).rejects.toThrow(/private/);
  });

  it('allows loopback for local OpenAI-compat servers', async () => {
    const saved = await upsertProfile({
      ...validProfile,
      provider: { ...validProfile.provider, baseURL: 'http://localhost:8000/v1' },
    });
    expect(saved.provider.baseURL).toBe('http://localhost:8000/v1');
  });

  it('allows plain HTTP for user-hosted endpoints (the v0.30 use case)', async () => {
    const saved = await upsertProfile({
      ...validProfile,
      provider: {
        ...validProfile.provider,
        baseURL: 'http://123.253.61.68:8000/v1',
      },
    });
    expect(saved.provider.baseURL).toBe('http://123.253.61.68:8000/v1');
  });

  it('caps name at 64 chars and trims whitespace', async () => {
    const saved = await upsertProfile({
      ...validProfile,
      name: '  ' + 'a'.repeat(200) + '  ',
    });
    expect(saved.name).toBe('a'.repeat(64));
  });

  it('caps apiKey at 8192 chars', async () => {
    const longKey = 'x'.repeat(20_000);
    const saved = await upsertProfile({
      ...validProfile,
      provider: { ...validProfile.provider, apiKey: longKey },
    });
    expect(saved.provider.apiKey.length).toBe(8192);
  });

  it('caps systemPrompt at 4096 chars', async () => {
    const longPrompt = 'p'.repeat(10_000);
    const saved = await upsertProfile({
      ...validProfile,
      systemPrompt: longPrompt,
    });
    expect(saved.systemPrompt?.length).toBe(4096);
  });

  it('clamps contextLimit + outputLimit to sane bounds', async () => {
    const saved = await upsertProfile({
      ...validProfile,
      provider: {
        ...validProfile.provider,
        contextLimit: 99_999_999,
        outputLimit: 999_999,
      },
    });
    expect(saved.provider.contextLimit).toBe(2_000_000);
    expect(saved.provider.outputLimit).toBe(200_000);

    const low = await upsertProfile({
      ...validProfile,
      name: 'low',
      provider: {
        ...validProfile.provider,
        contextLimit: 1,
        outputLimit: 1,
      },
    });
    expect(low.provider.contextLimit).toBe(1024);
    expect(low.provider.outputLimit).toBe(16);
  });

  it('preserves existing systemPrompt when undefined; clears on explicit empty', async () => {
    const created = await upsertProfile({
      ...validProfile,
      systemPrompt: 'You are a senior backend developer.',
    });
    expect(created.systemPrompt).toBe('You are a senior backend developer.');

    const preserved = await upsertProfile({
      id: created.id,
      name: created.name,
      cliId: created.cliId,
      provider: created.provider,
    });
    expect(preserved.systemPrompt).toBe('You are a senior backend developer.');

    const cleared = await upsertProfile({
      id: created.id,
      name: created.name,
      cliId: created.cliId,
      provider: created.provider,
      systemPrompt: '',
    });
    expect(cleared.systemPrompt).toBeUndefined();
  });

  it('rejects payload that is not an object', async () => {
    // @ts-expect-error — testing the runtime branch
    await expect(upsertProfile(null)).rejects.toThrow(/invalid payload/);
  });
});

describe('CliProfilesService — delete', () => {
  it('removes by id and persists', async () => {
    const a = await upsertProfile(validProfile);
    const b = await upsertProfile({ ...validProfile, name: 'second' });

    await deleteProfile(a.id);

    const remaining = await listProfiles();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe(b.id);
  });

  it('is idempotent — unknown id is a no-op', async () => {
    await upsertProfile(validProfile);
    await deleteProfile('00000000-0000-0000-0000-000000000000');
    const list = await listProfiles();
    expect(list).toHaveLength(1);
  });

  it('rejects empty id', async () => {
    await expect(deleteProfile('')).rejects.toThrow(/id is required/);
  });
});

describe('CliProfilesService — load + sort', () => {
  it('returns profiles sorted by createdAt asc', async () => {
    const dir = path.join(tmpHome, '.devspace');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'cli-profiles.json'),
      JSON.stringify({
        profiles: [
          {
            id: 'aaaa1111-1111-1111-1111-111111111111',
            name: 'newer',
            cliId: 'opencode',
            provider: { baseURL: 'https://x', apiKey: 'k', model: 'm' },
            createdAt: 2_000,
          },
          {
            id: 'bbbb2222-2222-2222-2222-222222222222',
            name: 'older',
            cliId: 'opencode',
            provider: { baseURL: 'https://x', apiKey: 'k', model: 'm' },
            createdAt: 1_000,
          },
        ],
      }),
    );

    const list = await loadProfiles();
    expect(list.map((p) => p.name)).toEqual(['older', 'newer']);
  });

  it('sanitize: drops entries with disallowed cliId on read', async () => {
    const dir = path.join(tmpHome, '.devspace');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'cli-profiles.json'),
      JSON.stringify({
        profiles: [
          {
            id: 'aaaa1111-1111-1111-1111-111111111111',
            name: 'good',
            cliId: 'opencode',
            provider: { baseURL: 'https://x', apiKey: 'k', model: 'm' },
            createdAt: 1_000,
          },
          {
            id: 'bbbb2222-2222-2222-2222-222222222222',
            name: 'bad',
            cliId: 'claude',
            provider: { baseURL: 'https://x', apiKey: 'k', model: 'm' },
            createdAt: 2_000,
          },
        ],
      }),
    );
    const list = await loadProfiles();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('good');
  });

  it('sanitize: blanks unsafe baseURL on read (loopback allowed on read)', async () => {
    const dir = path.join(tmpHome, '.devspace');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'cli-profiles.json'),
      JSON.stringify({
        profiles: [
          {
            id: 'aaaa1111-1111-1111-1111-111111111111',
            name: 'hostile',
            cliId: 'opencode',
            provider: {
              baseURL: 'http://169.254.169.254',
              apiKey: 'k',
              model: 'm',
            },
            createdAt: 1,
          },
        ],
      }),
    );
    const list = await loadProfiles();
    expect(list).toHaveLength(1);
    expect(list[0]!.provider.baseURL).toBe('');
  });

  it('getProfile after load returns cached profile sync', async () => {
    const saved = await upsertProfile(validProfile);
    const found = getProfile(saved.id);
    expect(found?.id).toBe(saved.id);
    expect(getProfile('nope')).toBeUndefined();
  });

  it('returns empty list when file missing', async () => {
    const list = await loadProfiles();
    expect(list).toEqual([]);
  });

  it('survives corrupt JSON — returns empty list without throwing', async () => {
    const dir = path.join(tmpHome, '.devspace');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cli-profiles.json'), '{not json');
    const list = await loadProfiles();
    expect(list).toEqual([]);
  });
});

describe('CliProfilesService — atomic write + permissions', () => {
  it('writes via tmp + rename (no partial file visible)', async () => {
    await upsertProfile(validProfile);
    const dir = path.join(tmpHome, '.devspace');
    const entries = fs.readdirSync(dir);
    const tmps = entries.filter((n) => n.startsWith('.tmp.'));
    expect(tmps).toHaveLength(0);
    const onDisk = JSON.parse(fs.readFileSync(profilesFile(), 'utf8'));
    expect(onDisk.profiles).toHaveLength(1);
  });

  // v0.30 Wave 2 review fixes — regression pins
  describe('SEC-CRIT-1: non-UUID profile ids on disk are quarantined', () => {
    it('rejects a hand-edited id with path-traversal payload', async () => {
      // Simulate a tampered cli-profiles.json with a poisoned id field —
      // upsert always generates UUIDs but the READ path must defend
      // against a planted file or corrupted entry.
      const dir = path.join(tmpHome, '.devspace');
      fs.mkdirSync(dir, { recursive: true });
      const tampered = {
        profiles: [
          {
            id: '../../.ssh',
            name: 'evil',
            cliId: 'opencode',
            provider: {
              baseURL: 'https://example.com',
              apiKey: 'sk',
              model: 'm',
            },
            createdAt: Date.now(),
          },
          {
            id: 'not-a-uuid',
            name: 'also-evil',
            cliId: 'opencode',
            provider: {
              baseURL: 'https://example.com',
              apiKey: 'sk',
              model: 'm',
            },
            createdAt: Date.now(),
          },
        ],
      };
      fs.writeFileSync(profilesFile(), JSON.stringify(tampered));
      __resetCacheForTests();
      const list = await loadProfiles();
      expect(list).toHaveLength(0);
    });

    it('accepts a valid UUID id round-tripped through disk', async () => {
      const saved = await upsertProfile(validProfile);
      __resetCacheForTests();
      const list = await loadProfiles();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(saved.id);
    });
  });

  describe('Arch H6: deleteProfile cleans the per-profile config dir', () => {
    it('rm -rfs the apiKey-bearing opencode.json directory', async () => {
      const saved = await upsertProfile(validProfile);
      // Simulate ensureConfig having run (the adapter writes here at
      // spawn time; deleteProfile must clean even if the user never
      // spawned a turn).
      const profileDir = path.join(
        tmpHome,
        '.devspace',
        'cli-profiles',
        saved.id,
      );
      fs.mkdirSync(profileDir, { recursive: true });
      fs.writeFileSync(
        path.join(profileDir, 'opencode.json'),
        '{"apiKey":"sk-leaked"}',
        { mode: 0o600 },
      );
      expect(fs.existsSync(profileDir)).toBe(true);
      await deleteProfile(saved.id);
      expect(fs.existsSync(profileDir)).toBe(false);
    });

    it('no-op on unknown id (does not delete a similarly-named dir)', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const fakeDir = path.join(
        tmpHome,
        '.devspace',
        'cli-profiles',
        fakeId,
      );
      fs.mkdirSync(fakeDir, { recursive: true });
      fs.writeFileSync(path.join(fakeDir, 'unrelated'), 'keep');
      await deleteProfile(fakeId); // not in profile list = no-op
      // Dir is left alone because the no-op branch returns before cleanup
      expect(fs.existsSync(fakeDir)).toBe(true);
    });
  });

  it('writes credentials file with 0o600 mode (POSIX only)', async () => {
    // Windows doesn't honor POSIX mode bits — skip there. On macOS/Linux
    // the SECRET_FILE_MODE constant in CliProfilesService must propagate
    // to the on-disk inode permissions.
    if (process.platform === 'win32') return;
    await upsertProfile(validProfile);
    const stat = fs.statSync(profilesFile());
    // umask can affect bits ABOVE 0o600 in theory; only assert the
    // owner-read/write bits and the absence of group/other read.
    const mode = stat.mode & 0o777;
    expect(mode & 0o600).toBe(0o600);
    expect(mode & 0o077).toBe(0);
  });
});
