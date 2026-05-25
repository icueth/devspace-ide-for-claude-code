// v0.30.3 regression — WaitingPill used to hardcode "Waiting for claude"
// even when the active thread was bound to OpenCode or an LLM Chat
// profile. These tests pin the vendor-label derivation so that lie
// can't slip back in (any future contributor who breaks one of these
// branches sees a failing test before the user sees a wrong label).

import { describe, it, expect } from 'vitest';
import { deriveVendorLabel } from '../chatVendorLabel';

const llmProfiles = [
  { id: 'llm-1', name: 'GPT-4 (translator)' },
  { id: 'llm-2', name: 'Local Ollama' },
];
const cliProfiles = [
  { id: 'cli-1', name: 'AEON Qwen3.6', cliId: 'opencode' as const },
  { id: 'cli-2', name: 'OpenCode default', cliId: 'opencode' as const },
];

describe('deriveVendorLabel', () => {
  it('returns "claude" for unbound threads (default Claude path)', () => {
    expect(
      deriveVendorLabel({ meta: { cliId: undefined, llmProfileId: undefined }, chatProfiles: [], cliProfiles: [] }),
    ).toBe('claude');
  });

  it('returns "claude" when meta is null/undefined (no active thread)', () => {
    expect(deriveVendorLabel({ meta: null, chatProfiles: llmProfiles, cliProfiles })).toBe('claude');
    expect(deriveVendorLabel({ meta: undefined, chatProfiles: llmProfiles, cliProfiles })).toBe('claude');
  });

  it('returns the CLI profile name when thread is bound to a CLI runtime', () => {
    expect(
      deriveVendorLabel({
        meta: { cliId: 'opencode', cliProfileId: 'cli-1' },
        chatProfiles: llmProfiles,
        cliProfiles,
      }),
    ).toBe('AEON Qwen3.6');
  });

  it('returns the LLM profile name when thread is bound to an LLM profile', () => {
    expect(
      deriveVendorLabel({
        meta: { llmProfileId: 'llm-1' },
        chatProfiles: llmProfiles,
        cliProfiles,
      }),
    ).toBe('GPT-4 (translator)');
  });

  it('CLI binding wins over a stray LLM id on the same meta (CLI is more specific)', () => {
    // Defensive: if for some reason both fields are populated, the CLI
    // runtime is the active executor — its name should show.
    expect(
      deriveVendorLabel({
        meta: { cliId: 'opencode', cliProfileId: 'cli-1', llmProfileId: 'llm-1' },
        chatProfiles: llmProfiles,
        cliProfiles,
      }),
    ).toBe('AEON Qwen3.6');
  });

  it('falls back to the CLI runtime kind when the profile id is stale (deleted)', () => {
    // User deleted "cli-1" after the thread was created — we surface the
    // runtime ("opencode") instead of masquerading as "claude", which
    // would be an outright lie.
    expect(
      deriveVendorLabel({
        meta: { cliId: 'opencode', cliProfileId: 'gone' },
        chatProfiles: llmProfiles,
        cliProfiles,
      }),
    ).toBe('opencode');
  });

  it('falls back to "LLM" for a stale llmProfileId (better than lying with "claude")', () => {
    expect(
      deriveVendorLabel({
        meta: { llmProfileId: 'gone' },
        chatProfiles: llmProfiles,
        cliProfiles,
      }),
    ).toBe('LLM');
  });

  it('returns stable string for the same inputs (memo identity)', () => {
    const input = {
      meta: { cliId: 'opencode' as const, cliProfileId: 'cli-1' },
      chatProfiles: llmProfiles,
      cliProfiles,
    };
    // Same lookup twice on identical inputs — same primitive string =>
    // same reference (V8 interns short strings) so memoization upstream
    // works as expected.
    expect(deriveVendorLabel(input)).toBe(deriveVendorLabel(input));
  });
});
