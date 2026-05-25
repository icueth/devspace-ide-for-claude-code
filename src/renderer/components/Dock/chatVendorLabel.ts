// v0.30.3: derive a human-readable vendor label for an active chat thread.
// Used by WaitingPill so the pre-first-output indicator says the right
// vendor name instead of always "claude" — the previous hardcode broke
// the illusion the moment a user switched to an LLM / OpenCode thread.
//
// Pure helper (no React, no hooks) so it can be tested in isolation and
// memoized at the call site without identity churn.

import type { ChatThreadMeta, LlmChatProfile, CliProfile } from '@shared/types';

export interface VendorLabelInput {
  meta: Pick<ChatThreadMeta, 'cliId' | 'cliProfileId' | 'llmProfileId'> | null | undefined;
  chatProfiles: ReadonlyArray<Pick<LlmChatProfile, 'id' | 'name'>>;
  cliProfiles: ReadonlyArray<Pick<CliProfile, 'id' | 'name' | 'cliId'>>;
}

/**
 * Derive a short label describing which model/CLI is answering this thread:
 *   - non-Claude CLI (e.g. opencode + AEON profile) → "AEON Qwen3.6"
 *   - LLM chat profile (e.g. OpenAI GPT-4)           → "GPT-4 (translator)"
 *   - default Claude path                             → "claude"
 *
 * Falls back gracefully when the bound profile id no longer matches a
 * known profile (deleted between thread creation and now) — returns the
 * runtime kind so the user still sees something meaningful instead of an
 * empty label or "claude" (which would be a lie).
 */
export function deriveVendorLabel(input: VendorLabelInput): string {
  const { meta, chatProfiles, cliProfiles } = input;
  if (!meta) return 'claude';

  // CLI runtime takes precedence — it's the most specific binding.
  if (meta.cliId && meta.cliProfileId) {
    const cli = cliProfiles.find((p) => p.id === meta.cliProfileId);
    if (cli) return cli.name;
    // Stale binding — surface the runtime kind so we don't masquerade as
    // claude when we're actually waiting on opencode/etc.
    return meta.cliId;
  }

  if (meta.llmProfileId) {
    const profile = chatProfiles.find((p) => p.id === meta.llmProfileId);
    if (profile) return profile.name;
    // Stale binding — better than silently saying "claude".
    return 'LLM';
  }

  return 'claude';
}
