import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { chatCompleteStreaming } from '@main/services/LlmClient';
import {
  EFFORT_BUDGET_TOKENS,
  modelSupportsThinking,
} from '@shared/types';
import type { ClaudeEffort, LlmChatProfile } from '@shared/types';

// v0.37: the effort knob maps to Anthropic Messages API
// `thinking.budget_tokens` and is silently dropped for OpenAI or
// non-thinking models. These tests pin both the model-whitelist and the
// body-shape guarantees.

function sseResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function anthropicProfile(model: string): LlmChatProfile {
  return {
    id: 'cccc3333-3333-3333-3333-333333333333',
    name: 'anthropic',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.test',
    apiKey: 'sk-ant',
    model,
    createdAt: 1,
  };
}

function openaiProfile(model: string): LlmChatProfile {
  return {
    id: 'dddd4444-4444-4444-4444-444444444444',
    name: 'openai',
    provider: 'openai',
    baseUrl: 'https://api.openai.test/v1',
    apiKey: 'sk-test',
    model,
    createdAt: 1,
  };
}

const STOP_STREAM = [
  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n',
  'data: {"type":"message_stop"}\n',
];

let fetchSpy: ReturnType<typeof vi.fn>;
let originalFetch: typeof fetch | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchSpy = vi.fn();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('EFFORT_BUDGET_TOKENS', () => {
  it('maps every tier to a budget >= 1024 (Anthropic API minimum)', () => {
    const tiers: ClaudeEffort[] = [
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'ultracode',
    ];
    for (const t of tiers) {
      expect(EFFORT_BUDGET_TOKENS[t]).toBeGreaterThanOrEqual(1024);
    }
  });

  it('ascends monotonically minimal < low < medium < high < xhigh < ultracode', () => {
    const order: ClaudeEffort[] = [
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'ultracode',
    ];
    for (let i = 1; i < order.length; i++) {
      expect(EFFORT_BUDGET_TOKENS[order[i]!]).toBeGreaterThan(
        EFFORT_BUDGET_TOKENS[order[i - 1]!],
      );
    }
  });

  it('caps ultracode at 64000 (matches public guidance)', () => {
    expect(EFFORT_BUDGET_TOKENS.ultracode).toBe(64000);
  });
});

describe('modelSupportsThinking', () => {
  it('accepts Opus 4.7 and 4.8', () => {
    expect(modelSupportsThinking('claude-opus-4-7')).toBe(true);
    expect(modelSupportsThinking('claude-opus-4-8')).toBe(true);
    expect(modelSupportsThinking('claude-opus-4-9-20260201')).toBe(true);
  });

  it('rejects Opus 4.0 through 4.5 (no thinking support)', () => {
    expect(modelSupportsThinking('claude-opus-4-0')).toBe(false);
    expect(modelSupportsThinking('claude-opus-4-5')).toBe(false);
    // 4.6 sits in the gap — not released, conservatively false to avoid
    // false-positives from a hypothetical interim build.
    expect(modelSupportsThinking('claude-opus-4-6')).toBe(false);
  });

  it('accepts Sonnet 4.6+ and rejects pre-4.6 Sonnet', () => {
    expect(modelSupportsThinking('claude-sonnet-4-6')).toBe(true);
    expect(modelSupportsThinking('claude-sonnet-4-7')).toBe(true);
    expect(modelSupportsThinking('claude-sonnet-4-5')).toBe(false);
    expect(modelSupportsThinking('claude-sonnet-4-0')).toBe(false);
  });

  it('rejects every Haiku version (no extended thinking)', () => {
    expect(modelSupportsThinking('claude-haiku-4-5')).toBe(false);
    expect(modelSupportsThinking('claude-haiku-5-0')).toBe(false);
  });

  it('rejects non-Claude / unknown models', () => {
    expect(modelSupportsThinking('gpt-4o')).toBe(false);
    expect(modelSupportsThinking('llama3.1:70b')).toBe(false);
    expect(modelSupportsThinking('')).toBe(false);
  });

  it('is case-insensitive on the model id', () => {
    expect(modelSupportsThinking('Claude-Opus-4-8')).toBe(true);
    expect(modelSupportsThinking('CLAUDE-SONNET-4-6')).toBe(true);
  });
});

describe('chatCompleteStreaming — effort → thinking budget (Anthropic)', () => {
  it('adds thinking block when model is in whitelist + effort set', async () => {
    fetchSpy.mockResolvedValueOnce(sseResponse(STOP_STREAM));
    await chatCompleteStreaming(
      anthropicProfile('claude-opus-4-8'),
      [{ role: 'user', content: 'hi' }],
      { onDelta: () => {}, effort: 'high' },
    );
    const [, init] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.thinking).toEqual({
      type: 'enabled',
      budget_tokens: EFFORT_BUDGET_TOKENS.high,
    });
  });

  it('auto-floors max_tokens to budget + 1024 when profile cap is too low', async () => {
    fetchSpy.mockResolvedValueOnce(sseResponse(STOP_STREAM));
    const profile = anthropicProfile('claude-opus-4-8');
    profile.maxTokens = 1024; // way too low for ultracode (64000) budget
    await chatCompleteStreaming(
      profile,
      [{ role: 'user', content: 'hi' }],
      { onDelta: () => {}, effort: 'ultracode' },
    );
    const [, init] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.max_tokens).toBeGreaterThan(body.thinking.budget_tokens);
    expect(body.max_tokens).toBe(EFFORT_BUDGET_TOKENS.ultracode + 1024);
  });

  it('preserves a higher user max_tokens when it already exceeds budget', async () => {
    fetchSpy.mockResolvedValueOnce(sseResponse(STOP_STREAM));
    const profile = anthropicProfile('claude-opus-4-8');
    profile.maxTokens = 100_000;
    await chatCompleteStreaming(
      profile,
      [{ role: 'user', content: 'hi' }],
      { onDelta: () => {}, effort: 'high' },
    );
    const [, init] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.max_tokens).toBe(100_000);
  });

  it('omits thinking block when model does not support it (Haiku)', async () => {
    fetchSpy.mockResolvedValueOnce(sseResponse(STOP_STREAM));
    await chatCompleteStreaming(
      anthropicProfile('claude-haiku-4-5'),
      [{ role: 'user', content: 'hi' }],
      { onDelta: () => {}, effort: 'high' },
    );
    const [, init] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.thinking).toBeUndefined();
  });

  it('omits thinking block when effort is undefined', async () => {
    fetchSpy.mockResolvedValueOnce(sseResponse(STOP_STREAM));
    await chatCompleteStreaming(
      anthropicProfile('claude-opus-4-8'),
      [{ role: 'user', content: 'hi' }],
      { onDelta: () => {} },
    );
    const [, init] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.thinking).toBeUndefined();
  });
});

describe('chatCompleteStreaming — effort silently ignored for OpenAI', () => {
  it('does not crash + does not add a thinking field for OpenAI provider', async () => {
    fetchSpy.mockResolvedValueOnce(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n',
        'data: [DONE]\n',
      ]),
    );
    const result = await chatCompleteStreaming(
      openaiProfile('gpt-4o'),
      [{ role: 'user', content: 'hi' }],
      { onDelta: () => {}, effort: 'high' },
    );
    expect(result.text).toBe('ok');
    expect(result.error).toBeUndefined();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.openai.test/v1/chat/completions');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.thinking).toBeUndefined();
  });
});
