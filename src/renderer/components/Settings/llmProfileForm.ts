import type { ClaudeEffort, LlmChatProfile } from '@shared/types';

// v0.37: empty string in the draft means "no effort" (undefined on save).
// The dropdown renders that as "Default (no thinking)".
export type EffortDraft = '' | ClaudeEffort;

const VALID_EFFORTS: ReadonlySet<string> = new Set<EffortDraft>([
  '',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'ultracode',
]);

// Editor draft shape — same as LlmChatProfile but with the optional
// numeric knobs typed as user-facing strings (the inputs render strings
// even when type="number"). Coerced to numbers on save.
export interface LlmChatProfileDraft {
  id: string;
  name: string;
  provider: LlmChatProfile['provider'];
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: string;
  maxTokens: string;
  // v0.37: Anthropic extended-thinking budget tier. '' = unset (default).
  effort: EffortDraft;
  systemPrompt: string;
  createdAt: number;
}

export interface ProfileFormErrors {
  name?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  temperature?: string;
  maxTokens?: string;
  effort?: string;
}

// Default values for a fresh profile draft. Mirrors the runner defaults
// the backend uses when these fields are undefined (1024 / 0.7).
export function newProfileDraft(): LlmChatProfileDraft {
  return {
    id: crypto.randomUUID(),
    name: '',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: '0.7',
    maxTokens: '1024',
    effort: '',
    systemPrompt: '',
    createdAt: Date.now(),
  };
}

// Hydrate a draft from an existing profile so the editor's controlled
// inputs can mount with string values.
export function draftFromProfile(profile: LlmChatProfile): LlmChatProfileDraft {
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    model: profile.model,
    temperature: profile.temperature !== undefined ? String(profile.temperature) : '0.7',
    maxTokens: profile.maxTokens !== undefined ? String(profile.maxTokens) : '1024',
    effort: profile.effort ?? '',
    systemPrompt: profile.systemPrompt ?? '',
    createdAt: profile.createdAt,
  };
}

// Pure validation — no side effects, no network. Returns a map of
// per-field error messages; empty object means the draft is ready to
// save. Tests assert this exact contract.
export function validateProfileForm(draft: LlmChatProfileDraft): ProfileFormErrors {
  const errors: ProfileFormErrors = {};

  const trimmedName = draft.name.trim();
  if (!trimmedName) {
    errors.name = 'Name is required';
  } else if (trimmedName.length > 64) {
    errors.name = 'Name must be 64 characters or less';
  }

  const trimmedUrl = draft.baseUrl.trim();
  if (!trimmedUrl) {
    errors.baseUrl = 'Base URL is required';
  } else if (!/^https?:\/\//i.test(trimmedUrl)) {
    errors.baseUrl = 'Base URL must start with http:// or https://';
  }

  if (!draft.model.trim()) {
    errors.model = 'Model is required';
  }

  // API key is technically optional (local Ollama / LM Studio don't need
  // one) so we only flag clearly-invalid shapes — e.g. all whitespace.
  if (draft.apiKey.length > 0 && draft.apiKey.trim().length === 0) {
    errors.apiKey = 'API key cannot be just whitespace';
  }

  const tempStr = draft.temperature.trim();
  if (tempStr) {
    const temp = Number(tempStr);
    if (!Number.isFinite(temp)) {
      errors.temperature = 'Temperature must be a number';
    } else if (temp < 0 || temp > 2) {
      errors.temperature = 'Temperature must be between 0 and 2';
    }
  }

  const maxStr = draft.maxTokens.trim();
  if (maxStr) {
    const max = Number(maxStr);
    if (!Number.isInteger(max)) {
      errors.maxTokens = 'Max tokens must be an integer';
    } else if (max < 1) {
      errors.maxTokens = 'Max tokens must be at least 1';
    } else if (max > 200000) {
      errors.maxTokens = 'Max tokens cannot exceed 200000';
    }
  }

  // v0.37: reject any value not in the union. The UI dropdown only emits
  // valid values, but a draft restored from corrupt persistence could
  // carry garbage.
  if (!VALID_EFFORTS.has(draft.effort)) {
    errors.effort = 'Invalid effort tier';
  }

  return errors;
}

// Coerce a validated draft back into the persisted profile shape. Numbers
// are parsed; empty optional fields are dropped from the payload entirely
// (undefined) so the backend falls back to its runner defaults.
export function profileFromDraft(draft: LlmChatProfileDraft): LlmChatProfile {
  const profile: LlmChatProfile = {
    id: draft.id,
    name: draft.name.trim(),
    provider: draft.provider,
    baseUrl: draft.baseUrl.trim(),
    apiKey: draft.apiKey,
    model: draft.model.trim(),
    createdAt: draft.createdAt,
  };
  const tempStr = draft.temperature.trim();
  if (tempStr) {
    const temp = Number(tempStr);
    if (Number.isFinite(temp)) profile.temperature = temp;
  }
  const maxStr = draft.maxTokens.trim();
  if (maxStr) {
    const max = Number(maxStr);
    if (Number.isInteger(max)) profile.maxTokens = max;
  }
  const sp = draft.systemPrompt.trim();
  if (sp) profile.systemPrompt = sp;
  // v0.37: persist effort only when explicitly set (empty string drops to
  // undefined → "default / no thinking" on the wire).
  if (draft.effort) profile.effort = draft.effort;
  return profile;
}
