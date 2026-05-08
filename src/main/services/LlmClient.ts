import { createLogger } from '@shared/logger';
import type {
  LlmCompleteRequest,
  LlmCompleteResponse,
  LlmConfig,
  LlmEditRequest,
  LlmEditResponse,
  LlmTestResult,
} from '@shared/types';

const logger = createLogger('LlmClient');

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
    choices?: { message?: { content?: string } }[];
  };
  const text = d.choices?.[0]?.message?.content ?? '';
  return { text: text.trim(), modelEcho: d.model };
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
  const text =
    d.content?.find((c) => c.type === 'text')?.text ?? '';
  return { text: text.trim(), modelEcho: d.model };
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

  const system =
    'You are a code-completion engine. Given the code BEFORE the cursor and the code AFTER the cursor, output ONLY the code that should be inserted at the cursor. Continue the user\'s style and indentation. Output a SHORT, single useful insertion — usually one line, occasionally a short block. NEVER repeat code that already exists in the prefix or suffix. NEVER output explanations, markdown fences, or commentary. If no useful completion exists, output nothing.';

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
      maxTokens: 128,
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

  const system =
    'You rewrite a snippet of code to satisfy the user\'s instruction. Output ONLY the replacement code — no markdown fences, no commentary, no preamble or trailing text. Preserve the surrounding code\'s style, indentation, and language conventions. The replacement should be a drop-in substitute for the original snippet.';

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
    { signal, maxTokens: 1024, temperature: 0.2 },
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
