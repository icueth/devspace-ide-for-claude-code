// LlmChatRunner — drop-in replacement for TmuxChatRunner when a chat thread
// is bound to an LlmChatProfile (OpenAI / Anthropic / openai-compatible
// local server). Simpler than the tmux path: no detached process, no
// subprocess lifecycle, just a streaming fetch we own end-to-end.
//
// Lifecycle:
//   1. caller (ChatService) builds the messages array (system prompts +
//      conversation history) and the profile
//   2. startLlmChatRun() kicks off chatCompleteStreaming under an internal
//      AbortController
//   3. delta chunks fire onDelta; on terminal success onDone(usage); on
//      failure onError(message)
//   4. kill() aborts the controller — onDone is still called with
//      cancelled=true so the caller's finalize logic runs uniformly
//
// We DON'T persist anything across app restart for LLM runs: closing the
// app cancels the fetch and the user can resend. Streaming HTTP doesn't
// resume cleanly anyway (no equivalent of tmux's tail-on-disk trick).

import { chatCompleteStreaming } from '@main/services/LlmClient';
import { createLogger } from '@shared/logger';
import type { LlmChatProfile } from '@shared/types';

const logger = createLogger('LlmChatRunner');

export interface LlmRunMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StartLlmChatRunOptions {
  profile: LlmChatProfile;
  messages: LlmRunMessage[];
  onDelta: (text: string) => void;
  onDone: (info: {
    cancelled: boolean;
    text: string;
    usage?: { input: number; output: number };
    modelEcho?: string;
  }) => void;
  onError: (message: string) => void;
  /**
   * Optional external abort signal. When fired (e.g. the renderer cancels
   * via the chat cancel button → ChatService.cancelActive → kill()), the
   * underlying fetch is aborted and onDone fires with cancelled=true.
   */
  signal?: AbortSignal;
}

export interface LlmRunHandle {
  /** Abort the in-flight stream. Idempotent — repeat calls are a no-op. */
  kill: () => Promise<void>;
  /** Resolves once the run terminates (success, error, or cancel). */
  promise: Promise<{ cancelled: boolean }>;
}

export function startLlmChatRun(opts: StartLlmChatRunOptions): LlmRunHandle {
  // System prompt prepend — profile.systemPrompt is the per-profile prose
  // the user configured in Settings → LLM → Chat profiles. The caller
  // (ChatService) has already stacked memory/devlog preamble into the
  // messages array as system messages, so we ADD profile.systemPrompt
  // as one more system message at the END of the system block (so the
  // profile prompt has the last word for tone / format).
  const messages: LlmRunMessage[] = [...opts.messages];
  if (opts.profile.systemPrompt && opts.profile.systemPrompt.trim()) {
    // Find the index of the last system message in the existing array
    // and insert our profile system AFTER it. If no system messages
    // exist yet, prepend ours.
    let insertAt = 0;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]!.role === 'system') insertAt = i + 1;
      else break;
    }
    messages.splice(insertAt, 0, {
      role: 'system',
      content: opts.profile.systemPrompt,
    });
  }

  const controller = new AbortController();
  // Chain caller's signal into our controller so an upstream abort
  // (cancelActive → state.activeRunHandle.kill) cleanly forwards.
  if (opts.signal) {
    if (opts.signal.aborted) {
      controller.abort();
    } else {
      const onAbort = (): void => controller.abort();
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  let cancelled = false;
  let usage: { input: number; output: number } | undefined;

  const promise = (async (): Promise<{ cancelled: boolean }> => {
    try {
      const result = await chatCompleteStreaming(
        opts.profile,
        messages,
        {
          signal: controller.signal,
          maxTokens: opts.profile.maxTokens,
          temperature: opts.profile.temperature,
          onDelta: (text) => {
            try {
              opts.onDelta(text);
            } catch (err) {
              logger.warn(`onDelta threw: ${(err as Error).message}`);
            }
          },
          onUsage: (u) => {
            usage = u;
          },
        },
      );

      cancelled = controller.signal.aborted;
      if (result.error && !cancelled) {
        try {
          opts.onError(result.error);
        } catch (err) {
          logger.warn(`onError threw: ${(err as Error).message}`);
        }
      }
      try {
        opts.onDone({
          cancelled,
          text: result.text,
          usage,
          modelEcho: result.modelEcho,
        });
      } catch (err) {
        logger.warn(`onDone threw: ${(err as Error).message}`);
      }
      return { cancelled };
    } catch (err) {
      // chatCompleteStreaming is supposed to never throw, but be defensive
      // — better to surface a runner error than dangle the assistant
      // message in 'streaming' forever.
      const message = (err as Error).message;
      logger.error(`stream threw: ${message}`);
      cancelled = controller.signal.aborted;
      if (!cancelled) {
        try {
          opts.onError(message);
        } catch {
          /* ignore secondary failure */
        }
      }
      try {
        opts.onDone({ cancelled, text: '', usage });
      } catch {
        /* ignore secondary failure */
      }
      return { cancelled };
    }
  })();

  return {
    promise,
    kill: async () => {
      if (!controller.signal.aborted) {
        controller.abort();
      }
      // Await promise so the caller can `await handle.kill()` and trust
      // that all listeners have fired before continuing — same contract
      // as TmuxChatRunner's kill().
      await promise.catch(() => undefined);
    },
  };
}
