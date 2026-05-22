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
} from '@main/services/LlmChatProfilesService';

// The service writes to `${os.homedir()}/.devspace/llm-chat-profiles.json`.
// os.homedir() honors $HOME on POSIX, so we redirect HOME to a tmpdir per
// test for full isolation — no real file is ever touched.

const ORIGINAL_HOME = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devspace-llm-profiles-'));
  process.env.HOME = tmpHome;
  __resetCacheForTests();
});

afterEach(() => {
  if (ORIGINAL_HOME !== undefined) process.env.HOME = ORIGINAL_HOME;
  else delete process.env.HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function profilesFile(): string {
  return path.join(tmpHome, '.devspace', 'llm-chat-profiles.json');
}

describe('LlmChatProfilesService — upsert', () => {
  it('creates a new profile with a UUID id + createdAt timestamp', async () => {
    const before = Date.now();
    const saved = await upsertProfile({
      name: 'OpenAI work',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
    });
    expect(saved.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(saved.createdAt).toBeGreaterThanOrEqual(before);
    expect(saved.name).toBe('OpenAI work');
    expect(saved.provider).toBe('openai');
    expect(saved.model).toBe('gpt-4o-mini');

    // Persisted on disk.
    const onDisk = JSON.parse(fs.readFileSync(profilesFile(), 'utf8'));
    expect(onDisk.profiles).toHaveLength(1);
    expect(onDisk.profiles[0].id).toBe(saved.id);
  });

  it('updates an existing profile in place, preserving createdAt', async () => {
    const first = await upsertProfile({
      name: 'Original',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-old',
      model: 'gpt-4o-mini',
    });

    // Sleep a tick so a regression that resets createdAt would be visible.
    await new Promise((r) => setTimeout(r, 5));

    const updated = await upsertProfile({
      id: first.id,
      name: 'Renamed',
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-new',
      model: 'claude-haiku-4-5',
    });

    expect(updated.id).toBe(first.id);
    expect(updated.createdAt).toBe(first.createdAt);
    expect(updated.name).toBe('Renamed');
    expect(updated.provider).toBe('anthropic');
    expect(updated.model).toBe('claude-haiku-4-5');

    const list = await listProfiles();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(first.id);
  });

  it('rejects upsert with empty name', async () => {
    await expect(
      upsertProfile({
        name: '   ',
        provider: 'openai',
        baseUrl: 'https://x',
        apiKey: 'k',
        model: 'm',
      }),
    ).rejects.toThrow(/name is required/);
  });

  it('rejects upsert with empty model', async () => {
    await expect(
      upsertProfile({
        name: 'x',
        provider: 'openai',
        baseUrl: 'https://x',
        apiKey: 'k',
        model: '   ',
      }),
    ).rejects.toThrow(/model is required/);
  });

  it('trims baseUrl + apiKey and caps name at 64 chars', async () => {
    const longName = 'a'.repeat(200);
    const saved = await upsertProfile({
      name: longName,
      provider: 'openai',
      baseUrl: '  https://api.openai.com/v1  ',
      apiKey: '  sk-key  ',
      model: 'gpt-4o-mini',
    });
    expect(saved.name).toBe('a'.repeat(64));
    expect(saved.baseUrl).toBe('https://api.openai.com/v1');
    expect(saved.apiKey).toBe('sk-key');
  });

  it('clamps temperature to 0..2 and maxTokens to 16..200000', async () => {
    // v0.29.1: cap raised from 32k → 200k to match Anthropic Claude 3.5+
    // context (and the renderer form's ceiling). Anything beyond 200k
    // still clamps so a fat-fingered value doesn't blow the JSON write.
    const tooHigh = await upsertProfile({
      name: 'high',
      provider: 'openai',
      baseUrl: 'https://example.com',
      apiKey: 'k',
      model: 'm',
      temperature: 5,
      maxTokens: 999_999,
    });
    expect(tooHigh.temperature).toBe(2);
    expect(tooHigh.maxTokens).toBe(200_000);

    const tooLow = await upsertProfile({
      name: 'low',
      provider: 'openai',
      baseUrl: 'https://example.com',
      apiKey: 'k',
      model: 'm',
      temperature: -3,
      maxTokens: 1,
    });
    expect(tooLow.temperature).toBe(0);
    expect(tooLow.maxTokens).toBe(16);
  });

  it('coerces unknown provider to openai', async () => {
    const saved = await upsertProfile({
      name: 'weird',
      // @ts-expect-error — testing the coercion path
      provider: 'gemini',
      baseUrl: 'https://x',
      apiKey: 'k',
      model: 'm',
    });
    expect(saved.provider).toBe('openai');
  });
});

describe('LlmChatProfilesService — delete', () => {
  it('removes a profile by id and persists', async () => {
    const a = await upsertProfile({
      name: 'A',
      provider: 'openai',
      baseUrl: 'https://x',
      apiKey: 'k',
      model: 'm',
    });
    const b = await upsertProfile({
      name: 'B',
      provider: 'openai',
      baseUrl: 'https://x',
      apiKey: 'k',
      model: 'm',
    });

    await deleteProfile(a.id);

    const remaining = await listProfiles();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe(b.id);

    const onDisk = JSON.parse(fs.readFileSync(profilesFile(), 'utf8'));
    expect(onDisk.profiles).toHaveLength(1);
    expect(onDisk.profiles[0].id).toBe(b.id);
  });

  it('is idempotent — unknown id is a no-op', async () => {
    await upsertProfile({
      name: 'A',
      provider: 'openai',
      baseUrl: 'https://x',
      apiKey: 'k',
      model: 'm',
    });
    await deleteProfile('00000000-0000-0000-0000-000000000000');
    const list = await listProfiles();
    expect(list).toHaveLength(1);
  });

  it('rejects empty id', async () => {
    await expect(deleteProfile('')).rejects.toThrow(/id is required/);
  });
});

describe('LlmChatProfilesService — load + sort', () => {
  it('returns profiles sorted by createdAt asc', async () => {
    // Seed disk directly with out-of-order createdAt so a load-then-sort
    // path is exercised end-to-end.
    const dir = path.join(tmpHome, '.devspace');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'llm-chat-profiles.json'),
      JSON.stringify({
        profiles: [
          {
            id: 'aaaa1111-1111-1111-1111-111111111111',
            name: 'newer',
            provider: 'openai',
            baseUrl: 'https://x',
            apiKey: 'k',
            model: 'm',
            createdAt: 2_000,
          },
          {
            id: 'bbbb2222-2222-2222-2222-222222222222',
            name: 'older',
            provider: 'openai',
            baseUrl: 'https://x',
            apiKey: 'k',
            model: 'm',
            createdAt: 1_000,
          },
        ],
      }),
    );

    const list = await loadProfiles();
    expect(list.map((p) => p.name)).toEqual(['older', 'newer']);
  });

  it('getProfile after load returns the cached profile sync', async () => {
    const saved = await upsertProfile({
      name: 'lookup',
      provider: 'openai',
      baseUrl: 'https://x',
      apiKey: 'k',
      model: 'm',
    });
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
    fs.writeFileSync(path.join(dir, 'llm-chat-profiles.json'), '{not json');
    const list = await loadProfiles();
    expect(list).toEqual([]);
  });
});

describe('LlmChatProfilesService — atomic write', () => {
  it('writes via tmp + rename (no partial file visible)', async () => {
    // After a successful upsert there should be no leftover .tmp.* files.
    await upsertProfile({
      name: 'atomic',
      provider: 'openai',
      baseUrl: 'https://x',
      apiKey: 'k',
      model: 'm',
    });
    const dir = path.join(tmpHome, '.devspace');
    const entries = fs.readdirSync(dir);
    const tmps = entries.filter((n) => n.startsWith('.tmp.'));
    expect(tmps).toHaveLength(0);
    // Final file exists and parses.
    const onDisk = JSON.parse(fs.readFileSync(profilesFile(), 'utf8'));
    expect(onDisk.profiles).toHaveLength(1);
  });
});
