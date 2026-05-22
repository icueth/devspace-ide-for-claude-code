import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { chatCompleteStreaming } from '@main/services/LlmClient';
import type { LlmChatProfile } from '@shared/types';

// We stub global `fetch` to return a synthetic SSE Response. The streaming
// parser is the unit under test — it reads `Response.body` (a
// ReadableStream<Uint8Array>) chunk-by-chunk, splits on `\n`, decodes
// `data: …` payloads per-provider, and fires onDelta / onUsage.

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

function makeOpenAiProfile(): LlmChatProfile {
  return {
    id: 'aaaa1111-1111-1111-1111-111111111111',
    name: 'openai test',
    provider: 'openai',
    baseUrl: 'https://api.openai.test/v1',
    apiKey: 'sk-test',
    model: 'gpt-test',
    createdAt: 1,
  };
}

function makeAnthropicProfile(): LlmChatProfile {
  return {
    id: 'bbbb2222-2222-2222-2222-222222222222',
    name: 'anthropic test',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.test',
    apiKey: 'sk-ant',
    model: 'claude-test',
    createdAt: 1,
  };
}

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

describe('chatCompleteStreaming — OpenAI SSE', () => {
  it('fires onDelta per chunk and concatenates final text', async () => {
    fetchSpy.mockResolvedValueOnce(
      sseResponse([
        'data: {"model":"gpt-test","choices":[{"delta":{"content":"Hello"}}]}\n',
        'data: {"choices":[{"delta":{"content":", "}}]}\n',
        'data: {"choices":[{"delta":{"content":"world!"}}]}\n',
        'data: {"usage":{"prompt_tokens":10,"completion_tokens":3}}\n',
        'data: [DONE]\n',
      ]),
    );

    const deltas: string[] = [];
    let usage: { input: number; output: number } | undefined;
    const result = await chatCompleteStreaming(
      makeOpenAiProfile(),
      [{ role: 'user', content: 'hi' }],
      {
        onDelta: (t) => deltas.push(t),
        onUsage: (u) => {
          usage = u;
        },
      },
    );

    expect(deltas).toEqual(['Hello', ', ', 'world!']);
    expect(result.text).toBe('Hello, world!');
    expect(result.error).toBeUndefined();
    expect(result.modelEcho).toBe('gpt-test');
    expect(usage).toEqual({ input: 10, output: 3 });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.openai.test/v1/chat/completions');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('handles chunks that split mid-line across reads', async () => {
    // First chunk ends mid-JSON; second chunk completes it. The parser
    // must buffer until it sees the newline.
    fetchSpy.mockResolvedValueOnce(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"part',
        '1"}}]}\ndata: {"choices":[{"delta":{"content":"part2"}}]}\n',
        'data: [DONE]\n',
      ]),
    );

    const deltas: string[] = [];
    const result = await chatCompleteStreaming(
      makeOpenAiProfile(),
      [{ role: 'user', content: 'hi' }],
      { onDelta: (t) => deltas.push(t) },
    );

    expect(deltas).toEqual(['part1', 'part2']);
    expect(result.text).toBe('part1part2');
  });

  it('reports HTTP errors without throwing', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('rate limited', { status: 429, statusText: 'Too Many Requests' }),
    );

    const deltas: string[] = [];
    const result = await chatCompleteStreaming(
      makeOpenAiProfile(),
      [{ role: 'user', content: 'hi' }],
      { onDelta: (t) => deltas.push(t) },
    );

    expect(deltas).toEqual([]);
    expect(result.text).toBe('');
    expect(result.error).toMatch(/HTTP 429/);
  });

  it('returns empty + error when apiKey missing', async () => {
    const profile = { ...makeOpenAiProfile(), apiKey: '' };
    const result = await chatCompleteStreaming(profile, [{ role: 'user', content: 'hi' }], {
      onDelta: () => {},
    });
    expect(result.error).toMatch(/No API key/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('cancels cleanly when abort signal fires — partial text returned, no error', async () => {
    const controller = new AbortController();
    // Stream that hangs forever until the consumer aborts. We use a
    // ReadableStream whose pull() never enqueues so the reader.read()
    // promise pends; aborting the fetch signal trips the parser's abort
    // check and returns partial text.
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n'));
        // Don't close — leave the reader pending.
      },
    });
    fetchSpy.mockImplementationOnce(
      (_url: unknown, init: RequestInit | undefined): Promise<Response> => {
        // Wire the caller's signal: when it aborts, the parser bails on
        // its next read iteration.
        const sig = init?.signal as AbortSignal | undefined;
        sig?.addEventListener('abort', () => {
          // no-op; the parser checks signal.aborted in its loop
        });
        return Promise.resolve(
          new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          }),
        );
      },
    );

    const deltas: string[] = [];
    const promise = chatCompleteStreaming(
      makeOpenAiProfile(),
      [{ role: 'user', content: 'hi' }],
      {
        signal: controller.signal,
        onDelta: (t) => {
          deltas.push(t);
          // Abort after we receive the first delta.
          controller.abort();
        },
      },
    );

    const result = await promise;
    expect(deltas).toEqual(['partial']);
    // The streaming function returns partial text with NO error on
    // caller-initiated cancel — the caller (LlmChatRunner) decides
    // whether to treat this as a cancel or error.
    expect(result.text).toBe('partial');
    expect(result.error).toBeUndefined();
  });
});

describe('chatCompleteStreaming — Anthropic SSE', () => {
  it('parses content_block_delta + message_delta usage', async () => {
    fetchSpy.mockResolvedValueOnce(
      sseResponse([
        'event: message_start\n',
        'data: {"type":"message_start","message":{"model":"claude-test","usage":{"input_tokens":12,"output_tokens":0}}}\n',
        'event: content_block_delta\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n',
        'event: content_block_delta\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}\n',
        'event: message_delta\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n',
        'event: message_stop\n',
        'data: {"type":"message_stop"}\n',
      ]),
    );

    const deltas: string[] = [];
    let usage: { input: number; output: number } | undefined;
    const result = await chatCompleteStreaming(
      makeAnthropicProfile(),
      [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
      {
        onDelta: (t) => deltas.push(t),
        onUsage: (u) => {
          usage = u;
        },
      },
    );

    expect(deltas).toEqual(['Hi', ' there']);
    expect(result.text).toBe('Hi there');
    expect(result.modelEcho).toBe('claude-test');
    expect(usage).toEqual({ input: 12, output: 2 });

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.test/v1/messages');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.system).toBe('be brief');
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('strips <think> tags from streamed deltas', async () => {
    // Some openai-compatible servers (Qwen/DeepSeek behind anthropic
    // proxy) leak chain-of-thought tags into text_delta. stripThinkingTags
    // catches CLOSED think blocks; the streaming path strips per-delta.
    fetchSpy.mockResolvedValueOnce(
      sseResponse([
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"<think>noise</think>real"}}\n',
        'data: {"type":"message_stop"}\n',
      ]),
    );

    const deltas: string[] = [];
    const result = await chatCompleteStreaming(
      makeAnthropicProfile(),
      [{ role: 'user', content: 'hi' }],
      { onDelta: (t) => deltas.push(t) },
    );

    expect(deltas).toEqual(['real']);
    expect(result.text).toBe('real');
  });

  it('surfaces error events as result.error', async () => {
    fetchSpy.mockResolvedValueOnce(
      sseResponse([
        'event: error\n',
        'data: {"type":"error","error":{"type":"overloaded_error","message":"server busy"}}\n',
      ]),
    );

    const result = await chatCompleteStreaming(
      makeAnthropicProfile(),
      [{ role: 'user', content: 'hi' }],
      { onDelta: () => {} },
    );

    expect(result.error).toMatch(/server busy/);
  });
});

// v0.29 regression — SSRF + SSE caps. These pin the security fixes
// applied during the v0.29.0 pre-commit review pass.
describe('chatCompleteStreaming — security caps', () => {
  it('rejects private-network baseUrl before any fetch', async () => {
    const profile = makeOpenAiProfile();
    profile.baseUrl = 'http://169.254.169.254/latest/meta-data/';
    const result = await chatCompleteStreaming(
      profile,
      [{ role: 'user', content: 'hi' }],
      { onDelta: () => {} },
    );
    expect(result.error).toMatch(/blocked|private|baseUrl/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects RFC-1918 private IPv4', async () => {
    const profile = makeOpenAiProfile();
    profile.baseUrl = 'http://192.168.1.1:8080/v1';
    const result = await chatCompleteStreaming(
      profile,
      [{ role: 'user', content: 'hi' }],
      { onDelta: () => {} },
    );
    expect(result.error).toMatch(/private/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows loopback (Ollama / LM Studio use case)', async () => {
    const profile = makeOpenAiProfile();
    profile.baseUrl = 'http://localhost:11434/v1';
    fetchSpy.mockResolvedValueOnce(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n',
        'data: [DONE]\n',
      ]),
    );
    const result = await chatCompleteStreaming(
      profile,
      [{ role: 'user', content: 'hi' }],
      { onDelta: () => {} },
    );
    expect(result.text).toBe('ok');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('aborts when a single SSE line exceeds the buffer cap', async () => {
    // Emit one giant 2MB line with NO newline — without the cap this
    // would buffer forever and OOM the main process.
    const giantLine = 'data: ' + 'x'.repeat(2 * 1024 * 1024);
    fetchSpy.mockResolvedValueOnce(sseResponse([giantLine]));

    const result = await chatCompleteStreaming(
      makeOpenAiProfile(),
      [{ role: 'user', content: 'hi' }],
      { onDelta: () => {} },
    );
    expect(result.error).toMatch(/sse:|exceeds/);
  });
});
