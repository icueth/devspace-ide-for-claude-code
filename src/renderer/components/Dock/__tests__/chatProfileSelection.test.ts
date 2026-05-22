import { describe, expect, it } from 'vitest';

import {
  profileNameForBadge,
  resolveProfileSelection,
} from '@renderer/components/Dock/chatProfileSelection';
import type { LlmChatProfile } from '@shared/types';

const profileA: LlmChatProfile = {
  id: 'p-a',
  name: 'GPT-4o',
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o',
  createdAt: 1,
};

const profileB: LlmChatProfile = {
  id: 'p-b',
  name: 'Claude Haiku Direct',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-ant-test',
  model: 'claude-haiku-4-5',
  createdAt: 2,
};

describe('resolveProfileSelection', () => {
  it('returns null for a Claude-only thread (no llmProfileId)', () => {
    expect(resolveProfileSelection({ llmProfileId: undefined }, [profileA])).toBe(
      null,
    );
  });

  it('returns the id when the thread points at a profile still in the list', () => {
    expect(
      resolveProfileSelection({ llmProfileId: 'p-a' }, [profileA, profileB]),
    ).toBe('p-a');
  });

  it('returns null for a stale llmProfileId (profile was deleted)', () => {
    // Profile id present on the thread, but not in the current list.
    expect(
      resolveProfileSelection({ llmProfileId: 'p-deleted' }, [profileA]),
    ).toBe(null);
  });

  it('returns null when given a null thread', () => {
    expect(resolveProfileSelection(null, [profileA])).toBe(null);
  });

  it('returns null when given an undefined thread', () => {
    expect(resolveProfileSelection(undefined, [profileA])).toBe(null);
  });

  it('handles an empty profiles list (treats every llmProfileId as stale)', () => {
    expect(resolveProfileSelection({ llmProfileId: 'p-a' }, [])).toBe(null);
  });
});

describe('profileNameForBadge', () => {
  it('returns null when there is no llmProfileId', () => {
    expect(profileNameForBadge(undefined, [profileA])).toBe(null);
  });

  it('returns the profile name when the id resolves', () => {
    expect(profileNameForBadge('p-a', [profileA, profileB])).toBe('GPT-4o');
  });

  it('returns the stale-fallback string when the profile is missing', () => {
    expect(profileNameForBadge('p-deleted', [profileA])).toBe('unknown LLM');
  });
});
