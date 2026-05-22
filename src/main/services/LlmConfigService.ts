import { app } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { createLogger } from '@shared/logger';
import type { LlmConfig } from '@shared/types';

const logger = createLogger('LlmConfig');

const DEFAULT_CONFIG: LlmConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  temperature: 0.2,
  maxTokens: 256,
  autocompleteEnabled: false,
  autocompleteDebounceMs: 500,
};

function configFile(): string {
  // Live alongside the existing tmux config in the user's home dir, NOT in
  // electron's userData. Putting it in ~/.devspace/ means a CLI tool or a
  // sibling process can read or hand-edit it without spelunking through
  // ~/Library/Application Support.
  return path.join(os.homedir(), '.devspace', 'llm-config.json');
}

let cache: LlmConfig | null = null;

export async function loadLlmConfig(): Promise<LlmConfig> {
  if (cache) return cache;
  try {
    const raw = await fs.promises.readFile(configFile(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<LlmConfig>;
    // Merge over defaults so a partial / older config gets every field
    // populated. `provider` and other enum-like fields validated here so a
    // malformed config doesn't crash a downstream call site.
    cache = {
      ...DEFAULT_CONFIG,
      ...parsed,
      provider:
        parsed.provider === 'anthropic' ? 'anthropic' : 'openai',
    };
    return cache;
  } catch {
    cache = { ...DEFAULT_CONFIG };
    return cache;
  }
}

export async function saveLlmConfig(next: LlmConfig): Promise<LlmConfig> {
  const sanitized: LlmConfig = {
    provider: next.provider === 'anthropic' ? 'anthropic' : 'openai',
    baseUrl: String(next.baseUrl ?? '').trim() || DEFAULT_CONFIG.baseUrl,
    apiKey: String(next.apiKey ?? ''),
    model: String(next.model ?? '').trim() || DEFAULT_CONFIG.model,
    temperature: clampNumber(next.temperature, 0, 2, DEFAULT_CONFIG.temperature),
    maxTokens: clampNumber(next.maxTokens, 16, 8192, DEFAULT_CONFIG.maxTokens),
    autocompleteEnabled: !!next.autocompleteEnabled,
    autocompleteDebounceMs:
      clampNumber(
        next.autocompleteDebounceMs,
        100,
        5000,
        DEFAULT_CONFIG.autocompleteDebounceMs,
      ) ?? DEFAULT_CONFIG.autocompleteDebounceMs,
  };
  // SECRET file — apiKey lives here. 0o600 + 0o700 dir so a shared-system
  // snoop (or any process running as another local user) can't lift the
  // key. atomicWriteAsync inherits the tmp file's mode on rename, so
  // setting it once at write time is sufficient.
  await atomicWriteAsync(configFile(), JSON.stringify(sanitized, null, 2), {
    mode: 0o600,
    dirMode: 0o700,
  });
  cache = sanitized;
  logger.info(
    `saved: provider=${sanitized.provider} model=${sanitized.model} autocomplete=${sanitized.autocompleteEnabled}`,
  );
  return sanitized;
}

function clampNumber(
  v: number | undefined,
  min: number,
  max: number,
  fallback: number | undefined,
): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

export function getCachedLlmConfig(): LlmConfig {
  return cache ?? { ...DEFAULT_CONFIG };
}

// Pre-warm the cache on app boot so the first autocomplete tick doesn't
// pay the I/O cost. Best-effort.
export function preloadLlmConfig(): void {
  void loadLlmConfig().catch((err) =>
    logger.warn(`preload failed: ${(err as Error).message}`),
  );
}

// Expose for IPC layer.
export { DEFAULT_CONFIG as DEFAULT_LLM_CONFIG };

// Quick-and-dirty user-data path resolver (not currently used but kept so
// future migrations can move ~/.devspace into Electron's userData if we
// decide secrets shouldn't sit in $HOME).
export function userDataDir(): string {
  return app.getPath('userData');
}
