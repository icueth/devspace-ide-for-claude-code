import { ipcMain } from 'electron';

import {
  loadLlmConfig,
  saveLlmConfig,
} from '@main/services/LlmConfigService';
import {
  completeForEditor,
  editForSelection,
  testLlm,
} from '@main/services/LlmClient';
import { IPC } from '@shared/ipc-channels';
import { createLogger } from '@shared/logger';
import type {
  LlmCompleteRequest,
  LlmConfig,
  LlmEditRequest,
  LlmTestResult,
} from '@shared/types';

const logger = createLogger('IPC:llm');

// Rate limit LLM_TEST per webContents: 6 calls per minute. Cheap to
// implement and prevents the renderer from being weaponized into a
// fingerprinting / credential-spray oracle against attacker-controlled
// baseUrls. Each WebContents id maps to its own bucket; renderer
// reload clears it naturally (new id).
const TEST_RATE_WINDOW_MS = 60_000;
const TEST_RATE_MAX = 6;
const testRateBuckets = new Map<number, number[]>();

function checkTestRateLimit(senderId: number): { ok: boolean; retryMs: number } {
  const now = Date.now();
  const bucket = testRateBuckets.get(senderId) ?? [];
  const recent = bucket.filter((t) => now - t < TEST_RATE_WINDOW_MS);
  if (recent.length >= TEST_RATE_MAX) {
    // Oldest entry tells us when the bucket will free a slot.
    const oldest = recent[0]!;
    return { ok: false, retryMs: TEST_RATE_WINDOW_MS - (now - oldest) };
  }
  recent.push(now);
  testRateBuckets.set(senderId, recent);
  return { ok: true, retryMs: 0 };
}

/**
 * Coerce an arbitrary IPC payload into a minimally-valid LlmConfig
 * shape for testing. Drops unknown fields, enforces string types,
 * preserves only the 4 fields LlmClient.testLlm actually reads. The
 * baseUrl SSRF gate runs inside LlmClient itself; rejecting hostile
 * URLs here as well would be defense-in-depth but the call-site
 * coverage is already complete after the LlmClient hardening.
 */
function sanitizeTestPayload(raw: unknown): LlmConfig {
  if (!raw || typeof raw !== 'object') {
    throw new Error('test: payload must be an object');
  }
  const o = raw as Record<string, unknown>;
  const baseUrl = typeof o.baseUrl === 'string' ? o.baseUrl.trim() : '';
  const apiKey = typeof o.apiKey === 'string' ? o.apiKey.trim() : '';
  const model = typeof o.model === 'string' ? o.model.trim() : '';
  if (!baseUrl) throw new Error('test: baseUrl required');
  if (!apiKey) throw new Error('test: apiKey required');
  if (!model) throw new Error('test: model required');
  return {
    provider: o.provider === 'anthropic' ? 'anthropic' : 'openai',
    baseUrl: baseUrl.slice(0, 2048),
    apiKey: apiKey.slice(0, 8192),
    model: model.slice(0, 256),
    temperature:
      typeof o.temperature === 'number' && Number.isFinite(o.temperature)
        ? Math.max(0, Math.min(2, o.temperature))
        : undefined,
    maxTokens:
      typeof o.maxTokens === 'number' && Number.isFinite(o.maxTokens)
        ? Math.max(16, Math.min(200000, o.maxTokens))
        : undefined,
    // testLlm doesn't read autocomplete fields, but the LlmConfig type
    // requires them — set safe placeholders.
    autocompleteEnabled: false,
    autocompleteDebounceMs: 500,
  };
}

export function registerLlmIpc(): void {
  ipcMain.handle(IPC.LLM_GET_CONFIG, () => loadLlmConfig());

  ipcMain.handle(IPC.LLM_SET_CONFIG, async (_e, next: LlmConfig) => {
    return saveLlmConfig(next);
  });

  ipcMain.handle(IPC.LLM_TEST, async (event, candidate: unknown) => {
    // Rate limit first — even invalid payloads count against the bucket
    // so the cheapest possible attack (spam with `null`) doesn't get a
    // free pass.
    const limit = checkTestRateLimit(event.sender.id);
    if (!limit.ok) {
      const result: LlmTestResult = {
        ok: false,
        error: `Too many test requests. Wait ${Math.ceil(limit.retryMs / 1000)}s and retry.`,
      };
      return result;
    }
    let sanitized: LlmConfig;
    try {
      sanitized = sanitizeTestPayload(candidate);
    } catch (err) {
      const result: LlmTestResult = { ok: false, error: (err as Error).message };
      return result;
    }
    // The Settings UI tests the form's CURRENT value, which may not have
    // been saved yet — accept the candidate config as the test target so
    // users don't have to commit an unverified API key first.
    return testLlm(sanitized);
  });

  ipcMain.handle(
    IPC.LLM_COMPLETE,
    async (_e, req: LlmCompleteRequest) => {
      const config = await loadLlmConfig();
      if (!config.autocompleteEnabled) {
        logger.warn(
          'autocomplete request received but master switch is OFF — open Settings → LLM and toggle "Editor inline autocomplete"',
        );
        return { text: '', latencyMs: 0, error: 'autocomplete disabled' };
      }
      if (!config.apiKey) {
        logger.warn(
          'autocomplete request received but no API key configured — fill it in Settings → LLM',
        );
        return { text: '', latencyMs: 0, error: 'no api key' };
      }
      const res = await completeForEditor(config, req);
      logger.info(
        `complete: model=${config.model} prefix=${req.prefix.length}b reply=${res.text.length}b latency=${res.latencyMs}ms${res.error ? ` error=${res.error}` : ''}`,
      );
      return res;
    },
  );

  ipcMain.handle(IPC.LLM_EDIT, async (_e, req: LlmEditRequest) => {
    // Cmd+K is explicitly user-triggered, so we don't gate on the
    // autocomplete master switch — only on the API key being set.
    const config = await loadLlmConfig();
    if (!config.apiKey) {
      return {
        text: '',
        latencyMs: 0,
        error: 'No LLM API key configured. Open Settings → LLM to set one.',
      };
    }
    return editForSelection(config, req);
  });
}
