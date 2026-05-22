import type { CliId, CliProfile } from '@shared/types';

// v0.30: pure helpers for the Settings → CLI section editor. Mirrors the
// shape of llmProfileForm.ts so the test-driven form logic stays
// consistent — no React imports, no IPC, no network. Test-friendly.
//
// Note: CliProfile sits in a *flat* draft shape here (baseURL/apiKey/model
// at the top level) — the runtime CliProfile shape nests these under
// `provider`. The flat draft is what controlled inputs bind to; we lift +
// nest at save time in `cliProfileFromDraft`.
export interface CliProfileDraft {
  id: string;
  name: string;
  cliId: Exclude<CliId, 'claude'>;
  baseURL: string;
  apiKey: string;
  model: string;
  // Optional numeric knobs — rendered as user-facing strings even when
  // <input type="number"> so we can distinguish empty (= "use runner
  // default") from 0.
  contextLimit: string;
  outputLimit: string;
  systemPrompt: string;
  createdAt: number;
}

export interface CliProfileFormErrors {
  name?: string;
  baseURL?: string;
  apiKey?: string;
  model?: string;
  contextLimit?: string;
  outputLimit?: string;
  systemPrompt?: string;
}

// Defaults targeted at the OpenCode-on-OpenAI-compatible-endpoint use
// case described in the v0.30 spec. The example HTTP endpoint is left
// blank so the user must paste their own — but the placeholder hints at
// the documented shape.
export function newCliProfileDraft(
  cliId: Exclude<CliId, 'claude'> = 'opencode',
): CliProfileDraft {
  return {
    id: crypto.randomUUID(),
    name: '',
    cliId,
    baseURL: '',
    apiKey: '',
    model: '',
    contextLimit: '',
    outputLimit: '',
    systemPrompt: '',
    createdAt: Date.now(),
  };
}

// Hydrate a draft from an existing profile so the editor's controlled
// inputs can mount with string values for the optional numeric fields.
export function draftFromCliProfile(profile: CliProfile): CliProfileDraft {
  return {
    id: profile.id,
    name: profile.name,
    cliId: profile.cliId,
    baseURL: profile.provider.baseURL,
    apiKey: profile.provider.apiKey,
    model: profile.provider.model,
    contextLimit:
      profile.provider.contextLimit !== undefined
        ? String(profile.provider.contextLimit)
        : '',
    outputLimit:
      profile.provider.outputLimit !== undefined
        ? String(profile.provider.outputLimit)
        : '',
    systemPrompt: profile.systemPrompt ?? '',
    createdAt: profile.createdAt,
  };
}

// Pure validation. Returns a map of per-field error messages; an empty
// object means the draft is ready to save. Tests assert this exact
// contract — keep error keys stable.
export function validateCliProfile(draft: CliProfileDraft): CliProfileFormErrors {
  const errors: CliProfileFormErrors = {};

  const trimmedName = draft.name.trim();
  if (!trimmedName) {
    errors.name = 'Name is required';
  } else if (trimmedName.length > 64) {
    errors.name = 'Name must be 64 characters or less';
  }

  const trimmedUrl = draft.baseURL.trim();
  if (!trimmedUrl) {
    errors.baseURL = 'Base URL is required';
  } else if (!/^https?:\/\//i.test(trimmedUrl)) {
    errors.baseURL = 'Base URL must start with http:// or https://';
  }

  if (!draft.model.trim()) {
    errors.model = 'Model is required';
  }

  // API key may technically be omitted for self-hosted endpoints — same
  // as the LLM chat profile — but if the user typed only whitespace
  // it's almost certainly a botched paste.
  if (draft.apiKey.length > 0 && draft.apiKey.trim().length === 0) {
    errors.apiKey = 'API key cannot be just whitespace';
  }

  const ctxStr = draft.contextLimit.trim();
  if (ctxStr) {
    const ctx = Number(ctxStr);
    if (!Number.isInteger(ctx)) {
      errors.contextLimit = 'Context limit must be an integer';
    } else if (ctx < 1) {
      errors.contextLimit = 'Context limit must be at least 1';
    } else if (ctx > 2_000_000) {
      errors.contextLimit = 'Context limit cannot exceed 2000000';
    }
  }

  const outStr = draft.outputLimit.trim();
  if (outStr) {
    const out = Number(outStr);
    if (!Number.isInteger(out)) {
      errors.outputLimit = 'Output limit must be an integer';
    } else if (out < 1) {
      errors.outputLimit = 'Output limit must be at least 1';
    } else if (out > 200_000) {
      errors.outputLimit = 'Output limit cannot exceed 200000';
    }
  }

  // System prompt is capped at 4096 chars by the service layer — flag
  // ahead of the save round-trip so the user sees the error inline.
  if (draft.systemPrompt.length > 4096) {
    errors.systemPrompt = 'System prompt must be 4096 characters or less';
  }

  return errors;
}

// True when the URL is plain HTTP (not HTTPS). Renderer uses this to
// surface a warning banner under the field — NOT a block, because the
// user's actual reference endpoint in the spec is HTTP and we don't
// want to block self-hosted setups.
export function isInsecureHttpUrl(url: string): boolean {
  return /^http:\/\//i.test(url.trim());
}

// Coerce a validated draft back into the persisted profile shape.
// Empty optional numeric fields drop OUT of the payload (undefined) so
// the backend falls back to its runner defaults — matches the LLM
// chat profile pattern.
export function cliProfileFromDraft(draft: CliProfileDraft): CliProfile {
  const provider: CliProfile['provider'] = {
    baseURL: draft.baseURL.trim(),
    apiKey: draft.apiKey,
    model: draft.model.trim(),
  };
  const ctxStr = draft.contextLimit.trim();
  if (ctxStr) {
    const ctx = Number(ctxStr);
    if (Number.isInteger(ctx)) provider.contextLimit = ctx;
  }
  const outStr = draft.outputLimit.trim();
  if (outStr) {
    const out = Number(outStr);
    if (Number.isInteger(out)) provider.outputLimit = out;
  }
  const profile: CliProfile = {
    id: draft.id,
    name: draft.name.trim(),
    cliId: draft.cliId,
    provider,
    createdAt: draft.createdAt,
  };
  const sp = draft.systemPrompt.trim();
  if (sp) profile.systemPrompt = sp;
  return profile;
}
