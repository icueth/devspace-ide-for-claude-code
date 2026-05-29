import { describe, expect, it } from 'vitest';

import {
  buildCliPickerOptions,
  capabilityChipClassName,
  resolveCliPickerSelection,
} from '@renderer/components/Dock/cliPickerOptions';
import type { CliProfile, LlmChatProfile } from '@shared/types';

const opencodeProfile: CliProfile = {
  id: 'cli-1',
  name: 'AEON Qwen3.6',
  cliId: 'opencode',
  provider: {
    baseURL: 'http://123.253.61.68:8000/v1',
    apiKey: 'Y1SMkXbuBswv1G8X',
    model: 'AEON-7/Qwen3.6-27B-AEON-Ultimate-Uncensored-BF16',
  },
  createdAt: 1,
};

const llmProfile: LlmChatProfile = {
  id: 'llm-1',
  name: 'GPT-4o (work)',
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-x',
  model: 'gpt-4o',
  createdAt: 2,
};

describe('buildCliPickerOptions', () => {
  it('always includes Claude as the first option', () => {
    const opts = buildCliPickerOptions(true, [], []);
    expect(opts[0]?.id).toBe('claude');
    expect(opts[0]?.group).toBe('claude');
    expect(opts[0]?.capabilityChip).toBe('Full');
    expect(opts[0]?.disabled).toBeFalsy();
  });

  it('marks Claude disabled when the binary is not installed', () => {
    const opts = buildCliPickerOptions(false, [], []);
    expect(opts[0]?.disabled).toBe(true);
    expect(opts[0]?.reason).toMatch(/claude/i);
  });

  it('orders groups: claude → cli → llm → action', () => {
    const opts = buildCliPickerOptions(
      true,
      [opencodeProfile],
      [llmProfile],
      new Set(['claude', 'opencode']),
    );
    expect(opts.map((o) => o.group)).toEqual([
      'claude',
      'cli',
      'llm',
      'action',
    ]);
  });

  it('emits CLI options with the cli:<id> key prefix', () => {
    const opts = buildCliPickerOptions(
      true,
      [opencodeProfile],
      [],
      new Set(['claude', 'opencode']),
    );
    const cli = opts.find((o) => o.group === 'cli');
    expect(cli?.id).toBe('cli:cli-1');
    expect(cli?.label).toBe('AEON Qwen3.6');
    // Arch H3: honest v0.30 chip — tool events parser is deferred to
    // v0.30.1 so OpenCode threads are 'Plain text' (matches adapter
    // capabilities). Flip back to '~90% tools' the same PR that lands
    // the tool-event parser.
    expect(cli?.capabilityChip).toBe('Plain text');
    expect(cli?.disabled).toBeFalsy();
  });

  it('disables CLI options whose runtime binary is missing', () => {
    // OpenCode profile present, but opencode binary not in detection set.
    const opts = buildCliPickerOptions(
      true,
      [opencodeProfile],
      [],
      new Set(['claude']),
    );
    const cli = opts.find((o) => o.group === 'cli');
    expect(cli?.disabled).toBe(true);
    expect(cli?.reason).toMatch(/opencode/);
  });

  it('emits LLM options with the llm:<id> key prefix', () => {
    const opts = buildCliPickerOptions(true, [], [llmProfile]);
    const llm = opts.find((o) => o.group === 'llm');
    expect(llm?.id).toBe('llm:llm-1');
    expect(llm?.label).toBe('GPT-4o (work)');
    expect(llm?.capabilityChip).toBe('Plain text'); // HTTP chat = no tools
  });

  it('handles empty profile lists (Claude + background-run action)', () => {
    const opts = buildCliPickerOptions(true, [], []);
    expect(opts).toHaveLength(2);
    expect(opts[0]?.id).toBe('claude');
    expect(opts[1]?.id).toBe('action:bg-claude');
  });

  // v0.37: background-run action row
  it('emits the action:bg-claude entry enabled when claude is installed', () => {
    const opts = buildCliPickerOptions(true, [], []);
    const action = opts.find((o) => o.id === 'action:bg-claude');
    expect(action).toBeDefined();
    expect(action?.group).toBe('action');
    expect(action?.disabled).toBeFalsy();
  });

  it('disables the background-run action when claude binary is missing', () => {
    const opts = buildCliPickerOptions(false, [], []);
    const action = opts.find((o) => o.id === 'action:bg-claude');
    expect(action?.disabled).toBe(true);
    expect(action?.reason).toMatch(/claude/i);
  });
});

describe('capabilityChipClassName', () => {
  it('uses success colors for Full', () => {
    expect(capabilityChipClassName('Full')).toMatch(/semantic-success/);
  });

  it('uses accent colors for ~90% tools', () => {
    expect(capabilityChipClassName('~90% tools')).toMatch(/accent/);
  });

  it('uses warning colors for Bash only', () => {
    expect(capabilityChipClassName('Bash only')).toMatch(/semantic-warning/);
  });

  it('uses muted/gray colors for Plain text', () => {
    expect(capabilityChipClassName('Plain text')).toMatch(/text-muted/);
  });
});

describe('resolveCliPickerSelection', () => {
  it('returns "claude" for a thread with no provider lock', () => {
    expect(resolveCliPickerSelection({}, [], [])).toBe('claude');
  });

  it('returns "claude" for null/undefined threads', () => {
    expect(resolveCliPickerSelection(null, [], [])).toBe('claude');
    expect(resolveCliPickerSelection(undefined, [], [])).toBe('claude');
  });

  it('returns cli:<id> when the cliProfileId matches a known profile', () => {
    expect(
      resolveCliPickerSelection(
        { cliProfileId: 'cli-1' },
        [opencodeProfile],
        [],
      ),
    ).toBe('cli:cli-1');
  });

  it('returns llm:<id> when the llmProfileId matches a known profile', () => {
    expect(
      resolveCliPickerSelection({ llmProfileId: 'llm-1' }, [], [llmProfile]),
    ).toBe('llm:llm-1');
  });

  it('falls back to "claude" when the cliProfileId is stale (deleted)', () => {
    expect(
      resolveCliPickerSelection({ cliProfileId: 'missing' }, [], []),
    ).toBe('claude');
  });

  it('falls back to "claude" when the llmProfileId is stale (deleted)', () => {
    expect(
      resolveCliPickerSelection({ llmProfileId: 'missing' }, [], []),
    ).toBe('claude');
  });
});
