import { assertSafeBaseUrl } from '@main/utils/urlSafety';
import { createLogger } from '@shared/logger';
import {
  EFFORT_BUDGET_TOKENS,
  modelSupportsThinking,
} from '@shared/types';
import type {
  ClaudeEffort,
  LlmChatProfile,
  LlmCompleteRequest,
  LlmCompleteResponse,
  LlmConfig,
  LlmEditRequest,
  LlmEditResponse,
  LlmTestResult,
} from '@shared/types';

const logger = createLogger('LlmClient');

// SSE safety caps — defense against hostile/buggy upstream that streams
// forever, never emits a newline, or sends a single 1-GB "line". Hitting
// either cap throws and is converted to `{ error }` by the caller's
// non-throwing contract.
const MAX_SSE_LINE_BYTES = 1 << 20;        // 1 MB per line
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024; // 16 MB aggregate text

// All call sites allow loopback by default so users running local
// Ollama / LM Studio / vLLM aren't broken. The metadata/private-network
// blocks still apply (AWS IMDS, 10/8, 192.168/16, IPv6 ULA).
const URL_SAFETY_OPTS = { allowLoopback: true } as const;

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Send a chat-style request to whichever provider the config selects.
 * Returns the assistant's response text and the round-trip latency.
 * Errors from the API surface as `{ error }` instead of throwing — the
 * autocomplete code path swallows errors silently anyway, and the test
 * UI wants the failure message to display.
 */
export async function chatComplete(
  config: LlmConfig,
  messages: ChatMessage[],
  opts?: { signal?: AbortSignal; maxTokens?: number; temperature?: number },
): Promise<{ text: string; latencyMs: number; error?: string; modelEcho?: string }> {
  const t0 = Date.now();
  const maxTokens = opts?.maxTokens ?? config.maxTokens ?? 256;
  const temperature = opts?.temperature ?? config.temperature ?? 0.2;

  if (!config.apiKey) {
    return { text: '', latencyMs: 0, error: 'No API key configured.' };
  }
  // SSRF gate — block private / metadata / non-http(s) baseUrls before
  // any apiKey hits the wire. Returning the error keeps the never-throw
  // contract; the autocomplete path will surface it through its usual
  // error display (Settings → LLM Test button / inline diagnostic).
  try {
    assertSafeBaseUrl(config.baseUrl, URL_SAFETY_OPTS);
  } catch (err) {
    return { text: '', latencyMs: 0, error: (err as Error).message };
  }

  if (config.provider === 'anthropic') {
    return anthropicMessages(config, messages, {
      signal: opts?.signal,
      maxTokens,
      temperature,
    }).then((r) => ({ ...r, latencyMs: Date.now() - t0 }));
  }
  return openaiChat(config, messages, {
    signal: opts?.signal,
    maxTokens,
    temperature,
  }).then((r) => ({ ...r, latencyMs: Date.now() - t0 }));
}

/**
 * Strip chain-of-thought wrappers that thinking-mode models (Qwen3,
 * DeepSeek-R1, Claude with thinking enabled, gpt-oss reasoning mode,
 * etc.) emit *inside* the content string. Without this:
 *   - Autocomplete inserts the model's reasoning prose instead of code.
 *   - Cmd+K's diff view shows `<think>let me analyze the user's…</think>`
 *     where the replacement should be.
 *
 * Servers like vLLM hosting Qwen3 also return reasoning in a separate
 * `reasoning_content` field (DeepSeek convention). We never read that
 * field, so it gets dropped automatically — only the inline tag form
 * needs explicit stripping here.
 */
export function stripThinkingTags(text: string): string {
  if (!text) return text;
  let out = text;
  // Closed think/thinking blocks anywhere in the text. Multi-line.
  out = out.replace(/<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>/gi, '');
  // Unclosed leading block — happens when max_tokens cuts off mid-reason.
  // If the entire response is a runaway think block with no answer,
  // drop everything; the autocomplete path will then surface this as
  // an empty completion ("model burned its budget on thinking").
  out = out.replace(/^\s*<think(?:ing)?\b[^>]*>[\s\S]*$/i, '');
  return out.trim();
}

async function openaiChat(
  config: LlmConfig,
  messages: ChatMessage[],
  opts: { signal?: AbortSignal; maxTokens: number; temperature: number },
): Promise<{ text: string; error?: string; modelEcho?: string }> {
  const url = stripTrailingSlash(config.baseUrl) + '/chat/completions';
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature,
        stream: false,
        // Qwen-3/Qwen-2.5-Coder vLLM servers honor this to disable
        // chain-of-thought emission. OpenAI proper, Together, OpenRouter,
        // Ollama, etc. ignore unknown fields, so it's safe to always
        // send. Saves output tokens AND avoids the ghost-text pollution
        // when reasoning tags leak into `content`.
        enable_thinking: false,
        // Same idea for `chat_template_kwargs` style servers.
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: opts.signal,
    });
  } catch (err) {
    return { text: '', error: `network: ${(err as Error).message}` };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return {
      text: '',
      error: `HTTP ${res.status}: ${body.slice(0, 400) || res.statusText}`,
    };
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch (err) {
    return { text: '', error: `bad json: ${(err as Error).message}` };
  }
  const d = data as {
    model?: string;
    choices?: {
      finish_reason?: string;
      message?: {
        content?: string;
        // DeepSeek-R1 / Xiaomi MiMo / some Qwen vLLM servers put chain-
        // of-thought in this separate field instead of inline in
        // `content`. We only consume `content`, so reasoning is dropped
        // automatically — but its presence is the signal we use to
        // produce a useful diagnostic when content is empty.
        reasoning_content?: string;
      };
    }[];
    error?: { message?: string; code?: string; type?: string };
  };

  // Some servers (Xiaomi MiMo's gateway among them) return a JSON
  // schema-shaped error description on bad routes / model ids with
  // HTTP 200, so we have to inspect the body rather than rely on
  // status codes alone.
  if (d.error?.message) {
    return { text: '', error: `${d.error.code ?? 'error'}: ${d.error.message}` };
  }
  if (!d.choices || d.choices.length === 0) {
    return {
      text: '',
      error: `unexpected response shape — check model id "${config.model}". /v1/models lists the names that work for this server.`,
    };
  }

  const choice = d.choices[0]!;
  const raw = choice.message?.content ?? '';
  const reasoning = choice.message?.reasoning_content ?? '';
  const text = stripThinkingTags(raw);

  if (!text && reasoning) {
    // Reasoning ate the entire token budget. Surface a clear,
    // actionable error rather than a mystery empty result.
    const finish = choice.finish_reason ?? '';
    return {
      text: '',
      error:
        `Model emitted ${reasoning.length}-char reasoning but no answer (${finish}).` +
        ' Increase Max tokens in Settings → LLM (try 2048+), or use a non-thinking model for fast operations like autocomplete.',
    };
  }

  return { text, modelEcho: d.model };
}

async function anthropicMessages(
  config: LlmConfig,
  messages: ChatMessage[],
  opts: { signal?: AbortSignal; maxTokens: number; temperature: number },
): Promise<{ text: string; error?: string; modelEcho?: string }> {
  const url = stripTrailingSlash(config.baseUrl) + '/v1/messages';
  // Anthropic's /v1/messages doesn't take a `system` role inside the
  // messages array — system goes at the top level. Split here.
  const systemMessages = messages.filter((m) => m.role === 'system');
  const conversation = messages.filter((m) => m.role !== 'system');
  const system = systemMessages.map((m) => m.content).join('\n\n');

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        // Some self-hosted Anthropic-compatible proxies (Bedrock-Anthropic
        // adapters, etc.) don't require this header; harmless when extra.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature,
        ...(system ? { system } : {}),
        messages: conversation.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      }),
      signal: opts.signal,
    });
  } catch (err) {
    return { text: '', error: `network: ${(err as Error).message}` };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return {
      text: '',
      error: `HTTP ${res.status}: ${body.slice(0, 400) || res.statusText}`,
    };
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch (err) {
    return { text: '', error: `bad json: ${(err as Error).message}` };
  }
  const d = data as {
    model?: string;
    content?: { type?: string; text?: string }[];
  };
  // Anthropic returns thinking as a separate `type: 'thinking'` block
  // in the content array. We pull only `type: 'text'` blocks, which
  // implicitly drops thinking. Stripping inline `<think>` tags too in
  // case the user routed a non-Anthropic model through an Anthropic-
  // style proxy.
  const text = stripThinkingTags(
    d.content?.find((c) => c.type === 'text')?.text ?? '',
  );
  return { text, modelEcho: d.model };
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

/**
 * Health-check the configured endpoint by sending the cheapest possible
 * prompt and timing the round trip. Returns a structured report so the
 * Settings UI can show "✓ 320ms · echo: gpt-4o-mini" or the exact error.
 */
export async function testLlm(config: LlmConfig): Promise<LlmTestResult> {
  if (!config.apiKey) {
    return { ok: false, error: 'No API key configured.' };
  }
  const t0 = Date.now();
  const result = await chatComplete(config, [
    {
      role: 'user',
      content: 'Reply with the single word "ok".',
    },
  ], { maxTokens: 10, temperature: 0 });
  const latencyMs = Date.now() - t0;
  if (result.error) {
    return { ok: false, error: result.error, latencyMs };
  }
  return {
    ok: true,
    latencyMs,
    modelEcho: result.modelEcho,
    sample: result.text.slice(0, 40),
  };
}

/**
 * The actual editor-autocomplete entry point. Builds a fill-in-the-middle
 * style prompt from the prefix/suffix the renderer captured around the
 * cursor, asks the LLM for a short continuation, and trims aggressively
 * to a single useful insertion. Errors swallow into an empty response so
 * the editor never sees a thrown rejection.
 */
export async function completeForEditor(
  config: LlmConfig,
  req: LlmCompleteRequest,
  signal?: AbortSignal,
): Promise<LlmCompleteResponse> {
  const t0 = Date.now();
  if (!config.apiKey) {
    return { text: '', latencyMs: 0, error: 'No API key configured.' };
  }

  const language = guessLanguageFromFilename(req.filename);
  // Keep the prompt tight — autocomplete should be fast. Cut prefix/suffix
  // so the request stays under ~3KB regardless of file size.
  const prefix = req.prefix.slice(-1500);
  const suffix = req.suffix.slice(0, 500);

  const system = [
    'You are a code-completion engine inside an IDE. Given the code BEFORE the cursor (`<prefix>`) and the code AFTER the cursor (`<suffix>`), output the code that should be inserted at the cursor.',
    '',
    'Hard rules:',
    '- Output ONLY the raw insertion code. No prose, no commentary, no apology, no introduction.',
    '- Do NOT wrap output in markdown fences (```), XML tags (<code>, <answer>), or any other delimiters.',
    '- Do NOT emit `<think>`, `<thinking>`, reasoning, or chain-of-thought. Skip straight to the answer. If you must reason, do it silently — only the final insertion goes in your response.',
    '- Do NOT repeat code that already exists in the prefix or suffix. The user has already typed the prefix; your output continues from the cursor.',
    '- Continue the user\'s exact indentation, naming, quote style, and syntax conventions.',
    '- Prefer SHORT insertions — one line, occasionally a short block. Long completions are rejected by the IDE.',
    '- If no useful completion exists for this position, output nothing (an empty string).',
    '',
    'Good output:',
    '  prefix: "function add(a, b) {"  → output: "\\n  return a + b;\\n}"',
    '  prefix: "const items = ["       → output: "1, 2, 3];"',
    'Bad output (DO NOT DO THIS):',
    '  "Sure! Here is the completion:\\n```ts\\nreturn a + b;\\n```"',
    '  "<think>The user wants to add two numbers...</think>return a + b;"',
  ].join('\n');

  const user = [
    `File: ${req.filename}${language ? ` (${language})` : ''}`,
    '',
    '<prefix>',
    prefix,
    '</prefix>',
    '<suffix>',
    suffix,
    '</suffix>',
    '',
    'Output the insertion code only.',
  ].join('\n');

  const result = await chatComplete(
    config,
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    {
      signal,
      // 128 is plenty for the actual code to insert. We bump to whatever
      // the user configured (default 256), and at least 512 — thinking-
      // mode models (Xiaomi MiMo, DeepSeek-R1, Qwen3) ALWAYS emit
      // reasoning regardless of `enable_thinking: false`, and a small
      // budget gets entirely consumed by their chain-of-thought,
      // leaving content empty.
      maxTokens: Math.max(config.maxTokens ?? 256, 512),
      temperature: 0.1,
    },
  );

  if (result.error) {
    logger.warn(`autocomplete error: ${result.error}`);
    return { text: '', latencyMs: Date.now() - t0, error: result.error };
  }

  // Strip code-fence wrappers a model might emit despite the prompt
  // ("```ts\nfoo\n```").
  let text = result.text.replace(/^\s*```[\w]*\s*\n?/, '').replace(/\n?```\s*$/, '');
  // Heuristic: drop everything after a blank line — keeps single-line
  // suggestions tight, lets short blocks through.
  const blankIdx = text.indexOf('\n\n');
  if (blankIdx > 0 && blankIdx < text.length - 1) {
    text = text.slice(0, blankIdx);
  }
  return { text: text.replace(/\s+$/, ''), latencyMs: Date.now() - t0 };
}

/**
 * Cmd+K entry point. Sends the user's selection + instruction + the
 * surrounding file context, asks for a drop-in replacement, and
 * trims the response down to just the code (no markdown fences, no
 * commentary).
 */
export async function editForSelection(
  config: LlmConfig,
  req: LlmEditRequest,
  signal?: AbortSignal,
): Promise<LlmEditResponse> {
  const t0 = Date.now();
  if (!config.apiKey) {
    return { text: '', latencyMs: 0, error: 'No API key configured.' };
  }

  const language = guessLanguageFromFilename(req.filename);
  // Cap context to keep request size bounded — Cmd+K calls can run on
  // 50KB files and we don't want to ship the whole thing each time.
  const context = req.context.slice(0, 6000);

  const system = [
    'You rewrite a snippet of code to satisfy the user\'s instruction. The output is fed directly into a code editor and replaces the original snippet — it must be a clean, drop-in substitute.',
    '',
    'Hard rules:',
    '- Output ONLY the replacement code. No prose, no commentary, no preamble, no trailing explanation.',
    '- Do NOT wrap output in markdown fences (```), XML tags, or any other delimiters.',
    '- Do NOT emit `<think>`, `<thinking>`, reasoning, or chain-of-thought. Reason silently if you must — only the final code goes in your response.',
    '- Preserve the surrounding code\'s style, indentation, naming, and quote conventions.',
    '- If the instruction asks for a function, return only the function. If it asks for a class method, return only the method.',
    '- The replacement must be syntactically complete on its own — it slots in where the original lived.',
  ].join('\n');

  const user = [
    `File: ${req.filename}${language ? ` (${language})` : ''}`,
    `Lines ${req.startLine}-${req.endLine}.`,
    '',
    '## Surrounding file context (for style + imports — do not reproduce)',
    context,
    '',
    '## Original snippet',
    req.selection,
    '',
    '## Instruction',
    req.instruction.trim() || 'Improve / fix this snippet.',
    '',
    'Output the replacement snippet only.',
  ].join('\n');

  const result = await chatComplete(
    config,
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    {
      signal,
      // Cmd+K editing is user-triggered and modal-blocking, so we
      // budget generously: 2048 by default, more if the user has
      // configured a higher cap. Thinking-mode models need the
      // headroom — reasoning + a non-trivial replacement easily blows
      // through 1024.
      maxTokens: Math.max(config.maxTokens ?? 1024, 2048),
      temperature: 0.2,
    },
  );

  if (result.error) {
    logger.warn(`edit error: ${result.error}`);
    return { text: '', latencyMs: Date.now() - t0, error: result.error };
  }

  // Strip code-fence wrappers if the model emitted them. Be lenient:
  // some models will emit a fence with a language tag, others without.
  let text = result.text;
  const fenceMatch = text.match(/^```[\w]*\s*\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch) text = fenceMatch[1] ?? text;
  return { text, latencyMs: Date.now() - t0 };
}

// ─── Streaming chat (v0.29) ────────────────────────────────────────────────
//
// SSE-driven variant of chatComplete for the new LlmChatRunner. Streams
// text deltas + final usage to the caller as they arrive instead of
// returning one giant string at the end. Mirrors chatComplete's branching
// on provider — OpenAI's /chat/completions and Anthropic's /v1/messages
// both speak SSE but with different event shapes.
//
// IMPORTANT: kept SIBLING to chatComplete (not a replacement). chatComplete
// is used by autocomplete + Cmd+K and is intentionally NON-streaming —
// callers consume one terminal result. This streaming variant ONLY backs
// chat-panel turns where the renderer paints deltas as they arrive.

export interface StreamingChatOpts {
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  // v0.37: when set AND provider is anthropic AND the model is whitelisted
  // (modelSupportsThinking), the request body includes
  // `thinking: { type: 'enabled', budget_tokens: EFFORT_BUDGET_TOKENS[effort] }`
  // and max_tokens is auto-floored to budget_tokens + 1024. Silently ignored
  // for OpenAI / non-thinking models — no error.
  effort?: ClaudeEffort;
  onDelta: (text: string) => void;
  onUsage?: (u: { input: number; output: number }) => void;
}

export interface StreamingChatResult {
  text: string;
  latencyMs: number;
  error?: string;
  modelEcho?: string;
}

interface StreamingChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Stream a chat completion. Aggregates deltas into the returned `text` so
 * the caller can persist the full response without re-stitching events,
 * AND fires opts.onDelta for each incremental chunk so the renderer
 * paints live. Returns `{ error }` on failure (matches chatComplete's
 * never-throw contract); abort via opts.signal cleanly cancels.
 *
 * Cancellation: opts.signal is passed straight to fetch. When the signal
 * aborts mid-stream, the reader read() throws AbortError which we catch
 * and surface as `{ cancelled }` semantics by returning the partial text
 * with no error — the caller (LlmChatRunner) decides whether to broadcast
 * an error or a clean cancel based on whether IT initiated the abort.
 */
export async function chatCompleteStreaming(
  config: LlmConfig | LlmChatProfile,
  messages: StreamingChatMessage[],
  opts: StreamingChatOpts,
): Promise<StreamingChatResult> {
  const t0 = Date.now();
  let maxTokens = opts.maxTokens ?? config.maxTokens ?? 1024;
  const temperature = opts.temperature ?? config.temperature ?? 0.7;

  if (!config.apiKey) {
    return { text: '', latencyMs: Date.now() - t0, error: 'No API key configured.' };
  }
  // SSRF gate — same posture as chatComplete. Loopback allowed for
  // local Ollama/LM Studio; metadata + private networks blocked.
  try {
    assertSafeBaseUrl(config.baseUrl, URL_SAFETY_OPTS);
  } catch (err) {
    return { text: '', latencyMs: Date.now() - t0, error: (err as Error).message };
  }

  // v0.37: extended-thinking budget — anthropic-only, whitelist-gated.
  // budget_tokens must be < max_tokens per Anthropic's API contract, so
  // bump max_tokens up if the configured cap is too low.
  let thinkingBudget: number | undefined;
  if (
    opts.effort &&
    config.provider === 'anthropic' &&
    modelSupportsThinking(config.model)
  ) {
    thinkingBudget = EFFORT_BUDGET_TOKENS[opts.effort];
    maxTokens = Math.max(maxTokens, thinkingBudget + 1024);
  }

  if (config.provider === 'anthropic') {
    return anthropicStream(config, messages, {
      signal: opts.signal,
      maxTokens,
      temperature,
      thinkingBudget,
      onDelta: opts.onDelta,
      onUsage: opts.onUsage,
    }).then((r) => ({ ...r, latencyMs: Date.now() - t0 }));
  }
  return openaiStream(config, messages, {
    signal: opts.signal,
    maxTokens,
    temperature,
    onDelta: opts.onDelta,
    onUsage: opts.onUsage,
  }).then((r) => ({ ...r, latencyMs: Date.now() - t0 }));
}

// Iterate a fetch response body line-by-line. We can't use a TextDecoder
// in the stream pipe directly because SSE events can span multiple chunks
// — manual buffering is simplest. Lines come back WITHOUT trailing '\n'.
async function* iterSseLines(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) {
        if (buffer.length > 0) yield buffer;
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      // Per-line cap — hostile/buggy upstream that never emits \n would
      // otherwise grow `buffer` until V8 OOMs the main process, taking
      // every open project's renderer down with it.
      if (buffer.length > MAX_SSE_LINE_BYTES) {
        throw new Error(
          `sse: line exceeds ${MAX_SSE_LINE_BYTES} bytes (no newline)`,
        );
      }
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        // Strip trailing \r so CRLF SSE servers parse the same.
        yield line.endsWith('\r') ? line.slice(0, -1) : line;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

async function openaiStream(
  config: LlmConfig | LlmChatProfile,
  messages: StreamingChatMessage[],
  opts: {
    signal?: AbortSignal;
    maxTokens: number;
    temperature: number;
    onDelta: (text: string) => void;
    onUsage?: (u: { input: number; output: number }) => void;
  },
): Promise<{ text: string; error?: string; modelEcho?: string }> {
  const url = stripTrailingSlash(config.baseUrl) + '/chat/completions';
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature,
        stream: true,
        // Streaming responses also benefit from disabled thinking when
        // talking to vLLM-hosted Qwen3 / DeepSeek-R1 / etc. — same
        // reasoning as the non-streaming path.
        stream_options: { include_usage: true },
        enable_thinking: false,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: opts.signal,
    });
  } catch (err) {
    // AbortError from caller-driven cancel — surface empty text + no
    // error so the caller decides whether to flag this as a cancel or
    // error based on whether THEY aborted.
    if ((err as Error).name === 'AbortError') {
      return { text: '' };
    }
    return { text: '', error: `network: ${(err as Error).message}` };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return {
      text: '',
      error: `HTTP ${res.status}: ${body.slice(0, 400) || res.statusText}`,
    };
  }
  if (!res.body) {
    return { text: '', error: 'no response body (stream)' };
  }

  let full = '';
  let modelEcho: string | undefined;
  let lastUsage: { input: number; output: number } | undefined;

  try {
    for await (const line of iterSseLines(res.body, opts.signal)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      if (data === '[DONE]') break;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        // Some proxies emit comment/keepalive lines; skip silently.
        continue;
      }
      const d = parsed as {
        model?: string;
        choices?: {
          delta?: { content?: string; reasoning_content?: string };
          finish_reason?: string | null;
        }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      if (d.model && !modelEcho) modelEcho = d.model;
      const delta = d.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        // stripThinkingTags trims whitespace, which would corrupt
        // per-chunk streaming (a delta of ", " becomes ","). Only invoke
        // it when the chunk actually contains a think tag — the common
        // path is a no-op pass-through that preserves spaces.
        const safe = /<think/i.test(delta) ? stripThinkingTags(delta) : delta;
        if (safe.length > 0) {
          if (full.length + safe.length > MAX_RESPONSE_BYTES) {
            throw new Error(
              `sse: response exceeds ${MAX_RESPONSE_BYTES} bytes — runaway stream aborted`,
            );
          }
          full += safe;
          opts.onDelta(safe);
        }
      }
      if (d.usage) {
        lastUsage = {
          input: d.usage.prompt_tokens ?? 0,
          output: d.usage.completion_tokens ?? 0,
        };
      }
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      // Caller-initiated abort. Return whatever we collected; caller
      // decides cancel-vs-error.
      if (lastUsage) opts.onUsage?.(lastUsage);
      return { text: full, modelEcho };
    }
    return { text: full, error: `stream read: ${(err as Error).message}` };
  }

  if (lastUsage) opts.onUsage?.(lastUsage);
  return { text: full, modelEcho };
}

async function anthropicStream(
  config: LlmConfig | LlmChatProfile,
  messages: StreamingChatMessage[],
  opts: {
    signal?: AbortSignal;
    maxTokens: number;
    temperature: number;
    // v0.37: extended-thinking budget_tokens. Caller already gated on
    // provider + model whitelist + max_tokens > budget_tokens.
    thinkingBudget?: number;
    onDelta: (text: string) => void;
    onUsage?: (u: { input: number; output: number }) => void;
  },
): Promise<{ text: string; error?: string; modelEcho?: string }> {
  const url = stripTrailingSlash(config.baseUrl) + '/v1/messages';
  const systemMessages = messages.filter((m) => m.role === 'system');
  const conversation = messages.filter((m) => m.role !== 'system');
  const system = systemMessages.map((m) => m.content).join('\n\n');

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature,
        stream: true,
        ...(system ? { system } : {}),
        ...(opts.thinkingBudget
          ? {
              thinking: {
                type: 'enabled',
                budget_tokens: opts.thinkingBudget,
              },
            }
          : {}),
        messages: conversation.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      }),
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      return { text: '' };
    }
    return { text: '', error: `network: ${(err as Error).message}` };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return {
      text: '',
      error: `HTTP ${res.status}: ${body.slice(0, 400) || res.statusText}`,
    };
  }
  if (!res.body) {
    return { text: '', error: 'no response body (stream)' };
  }

  let full = '';
  let modelEcho: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    for await (const line of iterSseLines(res.body, opts.signal)) {
      // Anthropic SSE format: `event: <name>\ndata: {...}\n\n` — we only
      // care about the data lines, the event lines are advisory (the JSON
      // payload always carries its own `type` field).
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      const ev = parsed as {
        type?: string;
        delta?: {
          type?: string;
          text?: string;
          stop_reason?: string;
          usage?: { input_tokens?: number; output_tokens?: number };
        };
        message?: {
          model?: string;
          usage?: { input_tokens?: number; output_tokens?: number };
        };
        usage?: { input_tokens?: number; output_tokens?: number };
      };

      if (ev.type === 'message_start') {
        if (ev.message?.model) modelEcho = ev.message.model;
        if (ev.message?.usage) {
          inputTokens = ev.message.usage.input_tokens ?? 0;
          outputTokens = ev.message.usage.output_tokens ?? 0;
        }
      } else if (ev.type === 'content_block_delta') {
        // delta.type === 'text_delta' carries .text; 'thinking_delta'
        // and 'input_json_delta' don't go into the visible turn.
        if (ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
          const txt = ev.delta.text;
          // Same per-chunk-trim guard as the OpenAI branch: only strip
          // when a think tag is actually present so a leading space in
          // a regular delta isn't swallowed.
          const safe = /<think/i.test(txt) ? stripThinkingTags(txt) : txt;
          if (safe.length > 0) {
            if (full.length + safe.length > MAX_RESPONSE_BYTES) {
              throw new Error(
                `sse: response exceeds ${MAX_RESPONSE_BYTES} bytes — runaway stream aborted`,
              );
            }
            full += safe;
            opts.onDelta(safe);
          }
        }
      } else if (ev.type === 'message_delta') {
        if (ev.usage) {
          // message_delta carries cumulative output_tokens.
          if (typeof ev.usage.input_tokens === 'number')
            inputTokens = ev.usage.input_tokens;
          if (typeof ev.usage.output_tokens === 'number')
            outputTokens = ev.usage.output_tokens;
        }
      } else if (ev.type === 'message_stop') {
        break;
      } else if (ev.type === 'error') {
        // Anthropic's error event carries a message envelope.
        const errEv = parsed as { error?: { message?: string; type?: string } };
        return {
          text: full,
          error: errEv.error?.message ?? 'anthropic stream error',
          modelEcho,
        };
      }
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      if (inputTokens || outputTokens) {
        opts.onUsage?.({ input: inputTokens, output: outputTokens });
      }
      return { text: full, modelEcho };
    }
    return { text: full, error: `stream read: ${(err as Error).message}` };
  }

  if (inputTokens || outputTokens) {
    opts.onUsage?.({ input: inputTokens, output: outputTokens });
  }
  return { text: full, modelEcho };
}

function guessLanguageFromFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return (
    {
      ts: 'TypeScript',
      tsx: 'TypeScript JSX',
      js: 'JavaScript',
      jsx: 'JavaScript JSX',
      py: 'Python',
      go: 'Go',
      rs: 'Rust',
      rb: 'Ruby',
      php: 'PHP',
      java: 'Java',
      kt: 'Kotlin',
      swift: 'Swift',
      cpp: 'C++',
      c: 'C',
      cs: 'C#',
      lua: 'Lua',
      sh: 'Bash',
      html: 'HTML',
      css: 'CSS',
      scss: 'SCSS',
      json: 'JSON',
      yaml: 'YAML',
      yml: 'YAML',
      md: 'Markdown',
      sql: 'SQL',
    }[ext] ?? ''
  );
}
