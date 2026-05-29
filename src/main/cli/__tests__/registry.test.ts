import { describe, expect, it, vi } from 'vitest';

import { detectAll, getAdapter, listAdapters } from '@main/cli/registry';
import { claudeAdapter } from '@main/cli/adapters/claude';

describe('CLI registry — getAdapter', () => {
  it('returns the claude adapter for cliId=claude', () => {
    expect(getAdapter('claude')).toBe(claudeAdapter);
  });

  it('throws for unknown cli ids', () => {
    // OpenCode and other alternative runtimes were removed with Chat mode —
    // claude is the only registered adapter now.
    expect(() => getAdapter('opencode' as unknown as 'claude')).toThrow(
      /Unknown CLI id/,
    );
  });
});

describe('CLI registry — listAdapters', () => {
  it('lists only the claude adapter', () => {
    const ids = listAdapters().map((a) => a.id);
    expect(ids).toEqual(['claude']);
  });

  it('returns a fresh array (mutation-safe)', () => {
    const a = listAdapters();
    const b = listAdapters();
    expect(a).not.toBe(b);
    a.pop();
    expect(listAdapters().length).toBe(1);
  });
});

describe('CLI registry — detectAll', () => {
  it('probes every adapter in parallel and returns one result per CLI', async () => {
    const claudeSpy = vi
      .spyOn(claudeAdapter, 'detect')
      .mockResolvedValue({ cliId: 'claude', installed: true, version: '4.7' });

    const results = await detectAll();
    expect(results).toHaveLength(1);
    expect(results.find((r) => r.cliId === 'claude')?.version).toBe('4.7');

    claudeSpy.mockRestore();
  });

  it('survives a single adapter throwing — reports it as uninstalled', async () => {
    const claudeSpy = vi
      .spyOn(claudeAdapter, 'detect')
      .mockRejectedValue(new Error('boom'));

    const results = await detectAll();
    const claudeResult = results.find((r) => r.cliId === 'claude');
    expect(claudeResult?.installed).toBe(false);

    claudeSpy.mockRestore();
  });
});
