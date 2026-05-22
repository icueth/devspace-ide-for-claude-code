import { describe, expect, it } from 'vitest';

import {
  type CliProfileDraft,
  cliProfileFromDraft,
  draftFromCliProfile,
  isInsecureHttpUrl,
  newCliProfileDraft,
  validateCliProfile,
} from '@renderer/components/Settings/cliProfileForm';
import type { CliProfile } from '@shared/types';

function makeDraft(overrides: Partial<CliProfileDraft> = {}): CliProfileDraft {
  return {
    ...newCliProfileDraft(),
    name: 'AEON Qwen3.6',
    baseURL: 'http://123.253.61.68:8000/v1',
    apiKey: 'Y1SMkXbuBswv1G8X',
    model: 'AEON-7/Qwen3.6-27B-AEON-Ultimate-Uncensored-BF16',
    ...overrides,
  };
}

describe('validateCliProfile', () => {
  it('passes a valid draft (the spec example endpoint)', () => {
    expect(validateCliProfile(makeDraft())).toEqual({});
  });

  it('flags missing name', () => {
    expect(validateCliProfile(makeDraft({ name: '   ' })).name).toBeDefined();
  });

  it('flags overlong name', () => {
    expect(
      validateCliProfile(makeDraft({ name: 'x'.repeat(65) })).name,
    ).toMatch(/64/);
  });

  it('accepts name at the 64 char boundary', () => {
    expect(
      validateCliProfile(makeDraft({ name: 'x'.repeat(64) })).name,
    ).toBeUndefined();
  });

  it('flags missing base URL', () => {
    expect(
      validateCliProfile(makeDraft({ baseURL: '' })).baseURL,
    ).toBeDefined();
  });

  it('flags base URL without an http(s) protocol', () => {
    expect(
      validateCliProfile(makeDraft({ baseURL: 'api.example.com' })).baseURL,
    ).toMatch(/http/);
  });

  it('accepts both http and https URLs (http is a warning, not a block)', () => {
    expect(
      validateCliProfile(makeDraft({ baseURL: 'http://localhost:8000/v1' }))
        .baseURL,
    ).toBeUndefined();
    expect(
      validateCliProfile(makeDraft({ baseURL: 'https://api.openai.com/v1' }))
        .baseURL,
    ).toBeUndefined();
  });

  it('flags missing model', () => {
    expect(validateCliProfile(makeDraft({ model: '' })).model).toBeDefined();
  });

  it('flags whitespace-only API key but accepts empty (local server use case)', () => {
    expect(validateCliProfile(makeDraft({ apiKey: '' })).apiKey).toBeUndefined();
    expect(
      validateCliProfile(makeDraft({ apiKey: '   ' })).apiKey,
    ).toBeDefined();
  });

  it('flags non-integer context limit', () => {
    expect(
      validateCliProfile(makeDraft({ contextLimit: '128.5' })).contextLimit,
    ).toBeDefined();
  });

  it('flags context limit below 1', () => {
    expect(
      validateCliProfile(makeDraft({ contextLimit: '0' })).contextLimit,
    ).toBeDefined();
  });

  it('flags absurdly large context limit', () => {
    expect(
      validateCliProfile(makeDraft({ contextLimit: '3000000' })).contextLimit,
    ).toBeDefined();
  });

  it('allows empty optional context/output limits (uses runner defaults)', () => {
    const errors = validateCliProfile(
      makeDraft({ contextLimit: '', outputLimit: '' }),
    );
    expect(errors.contextLimit).toBeUndefined();
    expect(errors.outputLimit).toBeUndefined();
  });

  it('flags system prompt longer than 4096 chars', () => {
    expect(
      validateCliProfile(makeDraft({ systemPrompt: 'x'.repeat(4097) }))
        .systemPrompt,
    ).toBeDefined();
  });
});

describe('isInsecureHttpUrl', () => {
  it('detects http:// URLs (spec example endpoint triggers this)', () => {
    expect(isInsecureHttpUrl('http://123.253.61.68:8000/v1')).toBe(true);
  });

  it('does not flag https://', () => {
    expect(isInsecureHttpUrl('https://api.openai.com/v1')).toBe(false);
  });

  it('does not flag empty / non-url strings', () => {
    expect(isInsecureHttpUrl('')).toBe(false);
    expect(isInsecureHttpUrl('ftp://x')).toBe(false);
  });

  it('handles leading whitespace', () => {
    expect(isInsecureHttpUrl('  http://x  ')).toBe(true);
  });
});

describe('cliProfileFromDraft', () => {
  it('nests baseURL/apiKey/model under provider', () => {
    const p = cliProfileFromDraft(makeDraft());
    expect(p.provider.baseURL).toBe('http://123.253.61.68:8000/v1');
    expect(p.provider.apiKey).toBe('Y1SMkXbuBswv1G8X');
    expect(p.provider.model).toBe(
      'AEON-7/Qwen3.6-27B-AEON-Ultimate-Uncensored-BF16',
    );
  });

  it('coerces numeric strings into integers under provider', () => {
    const p = cliProfileFromDraft(
      makeDraft({ contextLimit: '128000', outputLimit: '4096' }),
    );
    expect(p.provider.contextLimit).toBe(128000);
    expect(p.provider.outputLimit).toBe(4096);
  });

  it('drops empty optional fields entirely', () => {
    const p = cliProfileFromDraft(
      makeDraft({ contextLimit: '', outputLimit: '', systemPrompt: '   ' }),
    );
    expect(p.provider.contextLimit).toBeUndefined();
    expect(p.provider.outputLimit).toBeUndefined();
    expect(p.systemPrompt).toBeUndefined();
  });

  it('trims name + baseURL + model on save', () => {
    const p = cliProfileFromDraft(
      makeDraft({
        name: '  Spaced  ',
        baseURL: '  https://api.openai.com/v1  ',
        model: '  some/model  ',
      }),
    );
    expect(p.name).toBe('Spaced');
    expect(p.provider.baseURL).toBe('https://api.openai.com/v1');
    expect(p.provider.model).toBe('some/model');
  });

  it('preserves the draft id, cliId, and createdAt on round trip', () => {
    const draft = makeDraft({ id: 'fixed-id', createdAt: 12345 });
    const p = cliProfileFromDraft(draft);
    expect(p.id).toBe('fixed-id');
    expect(p.cliId).toBe('opencode');
    expect(p.createdAt).toBe(12345);
  });

  it('round-trips through draftFromCliProfile', () => {
    const profile: CliProfile = {
      id: 'p1',
      name: 'Round Trip',
      cliId: 'opencode',
      provider: {
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'sk-x',
        model: 'gpt-4o',
        contextLimit: 128000,
        outputLimit: 4096,
      },
      systemPrompt: 'be concise',
      createdAt: 5,
    };
    const back = cliProfileFromDraft(draftFromCliProfile(profile));
    expect(back).toEqual(profile);
  });
});
