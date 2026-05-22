// LlmChatProfilesService — per-profile chat-only LLM connections.
//
// Storage: ~/.devspace/llm-chat-profiles.json
// Shape:   { profiles: LlmChatProfile[] }
//
// Mirrors the pattern of LlmConfigService (atomic write, in-memory cache,
// validation on save) but holds a LIST of profiles instead of one singleton.
// The chat panel's provider dropdown reads these and a selected profile gets
// pinned onto a new ChatThread.llmProfileId so the thread routes to
// LlmChatRunner instead of TmuxChatRunner.
//
// Why a separate file/store from llm-config.json:
//   - llm-config.json is single-tenant and powers editor autocomplete +
//     Cmd+K. Chat needs N profiles (work OpenAI, personal OpenAI, local
//     Ollama, Anthropic-direct, …) and pins one per thread.
//   - Keeping them split means a corrupted profiles file can't break
//     autocomplete and vice versa.
//   - apiKey lives in plaintext at ~/.devspace/ — same posture as
//     llm-config.json. We don't pretend to do secret management.

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { assertSafeBaseUrl, isSafeBaseUrl } from '@main/utils/urlSafety';
import { createLogger } from '@shared/logger';
import type { LlmChatProfile, LlmProvider } from '@shared/types';

const logger = createLogger('LlmChatProfiles');

// Chat use defaults — different from autocomplete's 256/0.2 because chat
// turns want more headroom and more creative sampling.
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 1024;
const NAME_CAP = 64;
const MIN_MAX_TOKENS = 16;
// 200000 = Anthropic Claude 3.5+ context. Renderer form caps at the
// same value so the dropdown values match the persisted ceiling.
const MAX_MAX_TOKENS = 200000;
// Capped to prevent a hostile / fat-fingered apiKey from blowing up the
// JSON write (and ballooning the persisted file across all profiles).
// Real provider keys are <200 chars; 8KB is generous headroom.
const API_KEY_CAP = 8192;
const BASE_URL_CAP = 2048;
const SYSTEM_PROMPT_CAP = 32000;
// Mode used when persisting credential files. 0o600 = owner read/write
// only; matches the posture other Electron apps use for token caches.
const SECRET_FILE_MODE = 0o600;
const SECRET_DIR_MODE = 0o700;

function profilesFile(): string {
  return path.join(os.homedir(), '.devspace', 'llm-chat-profiles.json');
}

interface ProfilesFileShape {
  profiles: LlmChatProfile[];
}

let cache: LlmChatProfile[] | null = null;

function normalizeProvider(p: unknown): LlmProvider {
  return p === 'anthropic' ? 'anthropic' : 'openai';
}

function clampNumber(
  v: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

// Defensive parse — drop anything that doesn't look like a profile so a
// hand-edited / corrupt file can't crash the rest of the service.
// Defense-in-depth on load: a hostile baseUrl that slipped past an older
// build / hand-edit is neutered here too (replaced with '' so the user
// sees an obvious "missing endpoint" UI cue instead of an exploitable
// fetch target). Loopback is permitted on read because the user already
// has a profile they presumably configured intentionally — the upsert
// path is the one that enforces the public-only default.
function sanitizeProfile(raw: unknown): LlmChatProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : null;
  if (!id) return null;
  const model =
    typeof o.model === 'string' && o.model.trim()
      ? o.model.trim().slice(0, NAME_CAP)
      : null;
  if (!model) return null;
  const name =
    typeof o.name === 'string' && o.name.trim()
      ? o.name.trim().slice(0, NAME_CAP)
      : 'Untitled profile';
  const rawBaseUrl =
    typeof o.baseUrl === 'string'
      ? o.baseUrl.trim().slice(0, BASE_URL_CAP)
      : '';
  // Allow loopback on READ — user-set Ollama/LM Studio profiles are
  // legit; the upsert path is where the public-only default lives.
  const safeBaseUrl =
    rawBaseUrl && isSafeBaseUrl(rawBaseUrl, { allowLoopback: true })
      ? rawBaseUrl
      : '';
  const profile: LlmChatProfile = {
    id,
    name,
    provider: normalizeProvider(o.provider),
    baseUrl: safeBaseUrl,
    apiKey:
      typeof o.apiKey === 'string'
        ? o.apiKey.trim().slice(0, API_KEY_CAP)
        : '',
    model,
    createdAt:
      typeof o.createdAt === 'number' && Number.isFinite(o.createdAt)
        ? o.createdAt
        : Date.now(),
  };
  if (typeof o.temperature === 'number' && Number.isFinite(o.temperature)) {
    profile.temperature = clampNumber(
      o.temperature,
      0,
      2,
      DEFAULT_TEMPERATURE,
    );
  }
  if (typeof o.maxTokens === 'number' && Number.isFinite(o.maxTokens)) {
    profile.maxTokens = clampNumber(
      o.maxTokens,
      MIN_MAX_TOKENS,
      MAX_MAX_TOKENS,
      DEFAULT_MAX_TOKENS,
    );
  }
  if (typeof o.systemPrompt === 'string' && o.systemPrompt.trim()) {
    profile.systemPrompt = o.systemPrompt.slice(0, SYSTEM_PROMPT_CAP);
  }
  return profile;
}

async function readFromDisk(): Promise<LlmChatProfile[]> {
  try {
    const raw = await fs.promises.readFile(profilesFile(), 'utf8');
    const parsed = JSON.parse(raw) as ProfilesFileShape;
    const list = Array.isArray(parsed.profiles) ? parsed.profiles : [];
    const sanitized: LlmChatProfile[] = [];
    for (const p of list) {
      const s = sanitizeProfile(p);
      if (s) sanitized.push(s);
    }
    return sanitized;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn(`profiles read failed: ${(err as Error).message}`);
    }
    return [];
  }
}

async function writeToDisk(profiles: LlmChatProfile[]): Promise<void> {
  const payload: ProfilesFileShape = { profiles };
  // SECRET file — credentials live in this JSON. 0o600 + 0o700 dir so a
  // shared-system snoop or another local user can't read the keys.
  await atomicWriteAsync(profilesFile(), JSON.stringify(payload, null, 2), {
    mode: SECRET_FILE_MODE,
    dirMode: SECRET_DIR_MODE,
  });
}

function sortByCreated(list: LlmChatProfile[]): LlmChatProfile[] {
  return [...list].sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Return all profiles sorted by createdAt ascending. The renderer's
 * dropdown depends on stable order so a Save doesn't reshuffle.
 */
export async function loadProfiles(): Promise<LlmChatProfile[]> {
  if (cache) return sortByCreated(cache);
  cache = await readFromDisk();
  return sortByCreated(cache);
}

/** Synchronous IPC alias — returns the sorted list. */
export async function listProfiles(): Promise<LlmChatProfile[]> {
  return loadProfiles();
}

/**
 * Upsert a profile. If `input.id` matches an existing entry → in-place
 * update (preserves the original createdAt). Otherwise a fresh UUID + new
 * createdAt are assigned. Returns the saved/canonical profile.
 *
 * Validation:
 *   - `name` required, trimmed, capped at NAME_CAP (64)
 *   - `provider` coerced to 'openai' | 'anthropic'
 *   - `model` required, trimmed — throws if empty
 *   - `baseUrl` + `apiKey` trimmed (apiKey may be empty for not-yet-configured)
 *   - `temperature` clamped 0..2 (default 0.7 when undefined)
 *   - `maxTokens` clamped 16..32000 (default 1024 when undefined)
 */
export async function upsertProfile(
  input: Partial<LlmChatProfile>,
): Promise<LlmChatProfile> {
  await loadProfiles();
  const list = cache ?? [];

  if (!input || typeof input !== 'object') {
    throw new Error('upsertProfile: invalid payload');
  }

  const trimmedName =
    typeof input.name === 'string' ? input.name.trim() : '';
  if (!trimmedName) {
    throw new Error('upsertProfile: name is required');
  }
  const trimmedModel =
    typeof input.model === 'string' ? input.model.trim() : '';
  if (!trimmedModel) {
    throw new Error('upsertProfile: model is required');
  }
  // SSRF gate: throw early on hostile baseUrl so the renderer sees a
  // clear validation error before anything reaches disk. Loopback is
  // permitted because local LLM servers (Ollama, LM Studio, llama.cpp,
  // vLLM) are a primary use case for this feature. Cloud-metadata
  // endpoints + private IPs are still blocked.
  const trimmedBaseUrl =
    typeof input.baseUrl === 'string'
      ? input.baseUrl.trim().slice(0, BASE_URL_CAP)
      : '';
  if (!trimmedBaseUrl) {
    throw new Error('upsertProfile: baseUrl is required');
  }
  assertSafeBaseUrl(trimmedBaseUrl, { allowLoopback: true });
  // Bounded apiKey — see API_KEY_CAP rationale at top.
  const trimmedApiKey =
    typeof input.apiKey === 'string'
      ? input.apiKey.trim().slice(0, API_KEY_CAP)
      : '';

  const existing =
    typeof input.id === 'string' && input.id.trim()
      ? list.find((p) => p.id === input.id)
      : undefined;

  const next: LlmChatProfile = {
    id: existing?.id ?? randomUUID(),
    name: trimmedName.slice(0, NAME_CAP),
    provider: normalizeProvider(input.provider),
    baseUrl: trimmedBaseUrl,
    apiKey: trimmedApiKey,
    model: trimmedModel.slice(0, NAME_CAP),
    createdAt: existing?.createdAt ?? Date.now(),
  };

  if (input.temperature !== undefined) {
    next.temperature = clampNumber(
      input.temperature,
      0,
      2,
      DEFAULT_TEMPERATURE,
    );
  } else if (existing?.temperature !== undefined) {
    next.temperature = existing.temperature;
  }

  if (input.maxTokens !== undefined) {
    next.maxTokens = clampNumber(
      input.maxTokens,
      MIN_MAX_TOKENS,
      MAX_MAX_TOKENS,
      DEFAULT_MAX_TOKENS,
    );
  } else if (existing?.maxTokens !== undefined) {
    next.maxTokens = existing.maxTokens;
  }

  if (typeof input.systemPrompt === 'string' && input.systemPrompt.trim()) {
    next.systemPrompt = input.systemPrompt.slice(0, SYSTEM_PROMPT_CAP);
  } else if (
    input.systemPrompt === undefined &&
    existing?.systemPrompt !== undefined
  ) {
    next.systemPrompt = existing.systemPrompt;
  }
  // explicit '' / whitespace clears the prompt

  let updatedList: LlmChatProfile[];
  if (existing) {
    updatedList = list.map((p) => (p.id === existing.id ? next : p));
  } else {
    updatedList = [...list, next];
  }

  await writeToDisk(updatedList);
  cache = updatedList;
  logger.info(
    `upsert profile id=${next.id.slice(0, 8)} provider=${next.provider} model=${next.model}`,
  );
  return next;
}

/** Remove a profile by id. Idempotent — missing ids are a no-op. */
export async function deleteProfile(id: string): Promise<void> {
  if (typeof id !== 'string' || !id.trim()) {
    throw new Error('deleteProfile: id is required');
  }
  await loadProfiles();
  const list = cache ?? [];
  const next = list.filter((p) => p.id !== id);
  if (next.length === list.length) return;
  await writeToDisk(next);
  cache = next;
  logger.info(`delete profile id=${id.slice(0, 8)}`);
}

/**
 * Sync lookup from the in-memory cache. Used by LlmChatRunner / ChatService
 * so we don't pay an async hop on every chat turn. Returns undefined when
 * the cache is empty or the id is unknown — callers must handle that.
 */
export function getProfile(id: string): LlmChatProfile | undefined {
  if (!cache) return undefined;
  return cache.find((p) => p.id === id);
}

/** Async variant: forces hydrate before lookup. */
export async function getProfileAsync(
  id: string,
): Promise<LlmChatProfile | undefined> {
  await loadProfiles();
  return cache?.find((p) => p.id === id);
}

/**
 * Pre-warm the cache on app boot so the first chat-panel mount doesn't
 * pay the I/O cost. Best-effort; failures log but never throw.
 */
export function preloadProfiles(): void {
  void loadProfiles().catch((err) =>
    logger.warn(`preload failed: ${(err as Error).message}`),
  );
}

// Testing-only — reset the module cache so each test starts clean.
export function __resetCacheForTests(): void {
  cache = null;
}
