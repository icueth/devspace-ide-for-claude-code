import { describe, expect, it } from 'vitest';

import {
  type LlmChatProfileDraft,
  newProfileDraft,
  profileFromDraft,
  validateProfileForm,
} from '@renderer/components/Settings/llmProfileForm';

function makeDraft(overrides: Partial<LlmChatProfileDraft> = {}): LlmChatProfileDraft {
  return {
    ...newProfileDraft(),
    name: 'Test',
    apiKey: 'sk-test',
    ...overrides,
  };
}

describe('validateProfileForm', () => {
  it('passes a valid draft', () => {
    expect(validateProfileForm(makeDraft())).toEqual({});
  });

  it('flags missing name', () => {
    const errors = validateProfileForm(makeDraft({ name: '   ' }));
    expect(errors.name).toBeDefined();
  });

  it('flags overlong name', () => {
    const errors = validateProfileForm(makeDraft({ name: 'x'.repeat(65) }));
    expect(errors.name).toMatch(/64/);
  });

  it('accepts name at the 64 char boundary', () => {
    expect(
      validateProfileForm(makeDraft({ name: 'x'.repeat(64) })).name,
    ).toBeUndefined();
  });

  it('flags missing base url', () => {
    expect(validateProfileForm(makeDraft({ baseUrl: '' })).baseUrl).toBeDefined();
  });

  it('flags base url without protocol', () => {
    expect(
      validateProfileForm(makeDraft({ baseUrl: 'api.example.com' })).baseUrl,
    ).toMatch(/http/);
  });

  it('accepts http and https urls', () => {
    expect(
      validateProfileForm(makeDraft({ baseUrl: 'http://localhost:11434/v1' }))
        .baseUrl,
    ).toBeUndefined();
    expect(
      validateProfileForm(makeDraft({ baseUrl: 'https://api.openai.com/v1' }))
        .baseUrl,
    ).toBeUndefined();
  });

  it('flags missing model', () => {
    expect(validateProfileForm(makeDraft({ model: '' })).model).toBeDefined();
  });

  it('flags negative temperature', () => {
    expect(
      validateProfileForm(makeDraft({ temperature: '-0.5' })).temperature,
    ).toBeDefined();
  });

  it('flags temperature above 2', () => {
    expect(
      validateProfileForm(makeDraft({ temperature: '2.5' })).temperature,
    ).toBeDefined();
  });

  it('accepts temperature at the 0 and 2 boundaries', () => {
    expect(
      validateProfileForm(makeDraft({ temperature: '0' })).temperature,
    ).toBeUndefined();
    expect(
      validateProfileForm(makeDraft({ temperature: '2' })).temperature,
    ).toBeUndefined();
  });

  it('flags non-numeric temperature', () => {
    expect(
      validateProfileForm(makeDraft({ temperature: 'hot' })).temperature,
    ).toBeDefined();
  });

  it('allows empty temperature (falls back to default)', () => {
    expect(
      validateProfileForm(makeDraft({ temperature: '' })).temperature,
    ).toBeUndefined();
  });

  it('flags non-integer max tokens', () => {
    expect(
      validateProfileForm(makeDraft({ maxTokens: '512.5' })).maxTokens,
    ).toBeDefined();
  });

  it('flags max tokens below 1', () => {
    expect(
      validateProfileForm(makeDraft({ maxTokens: '0' })).maxTokens,
    ).toBeDefined();
  });

  it('flags absurdly large max tokens', () => {
    expect(
      validateProfileForm(makeDraft({ maxTokens: '999999' })).maxTokens,
    ).toBeDefined();
  });

  it('accepts whitespace-only api key as empty (local server use case)', () => {
    // No apiKey is fine for local Ollama / LM Studio, but a key that
    // is JUST spaces is almost certainly a typo paste.
    expect(
      validateProfileForm(makeDraft({ apiKey: '' })).apiKey,
    ).toBeUndefined();
    expect(
      validateProfileForm(makeDraft({ apiKey: '   ' })).apiKey,
    ).toBeDefined();
  });
});

describe('profileFromDraft', () => {
  it('coerces numeric strings to numbers', () => {
    const p = profileFromDraft(
      makeDraft({ temperature: '0.5', maxTokens: '2048' }),
    );
    expect(p.temperature).toBe(0.5);
    expect(p.maxTokens).toBe(2048);
  });

  it('drops empty optional fields entirely', () => {
    const p = profileFromDraft(
      makeDraft({ temperature: '', maxTokens: '', systemPrompt: '   ' }),
    );
    expect(p.temperature).toBeUndefined();
    expect(p.maxTokens).toBeUndefined();
    expect(p.systemPrompt).toBeUndefined();
  });

  it('trims name, base url, and model on save', () => {
    const p = profileFromDraft(
      makeDraft({
        name: '  Spaced  ',
        baseUrl: '  https://api.openai.com/v1  ',
        model: '  gpt-4o  ',
      }),
    );
    expect(p.name).toBe('Spaced');
    expect(p.baseUrl).toBe('https://api.openai.com/v1');
    expect(p.model).toBe('gpt-4o');
  });

  it('preserves the draft id and createdAt on round trip', () => {
    const draft = makeDraft({ id: 'fixed-id', createdAt: 12345 });
    const p = profileFromDraft(draft);
    expect(p.id).toBe('fixed-id');
    expect(p.createdAt).toBe(12345);
  });

  // v0.37: effort field round-trip
  it('persists every effort tier and drops empty effort to undefined', () => {
    const tiers = ['minimal', 'low', 'medium', 'high', 'xhigh', 'ultracode'] as const;
    for (const t of tiers) {
      expect(profileFromDraft(makeDraft({ effort: t })).effort).toBe(t);
    }
    expect(profileFromDraft(makeDraft({ effort: '' })).effort).toBeUndefined();
  });

  it('validateProfileForm flags garbage effort values', () => {
    // Garbage shouldn't normally reach the validator (dropdown emits union
    // values only), but a draft restored from corrupt persistence could.
    const errors = validateProfileForm(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeDraft({ effort: 'turbo' as any }),
    );
    expect(errors.effort).toBeDefined();
  });
});
