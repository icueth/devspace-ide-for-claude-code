import { describe, expect, it, vi } from 'vitest';

import { detectAll, getAdapter, listAdapters } from '@main/cli/registry';
import { claudeAdapter } from '@main/cli/adapters/claude';
import { openCodeAdapter } from '@main/cli/adapters/opencode';

describe('CLI registry — getAdapter', () => {
  it('returns the claude adapter for cliId=claude', () => {
    expect(getAdapter('claude')).toBe(claudeAdapter);
  });

  it('returns the opencode adapter for cliId=opencode', () => {
    expect(getAdapter('opencode')).toBe(openCodeAdapter);
  });

  it('throws for unknown cli ids', () => {
    expect(() => getAdapter('codex' as unknown as 'opencode')).toThrow(
      /Unknown CLI id/,
    );
  });
});

describe('CLI registry — listAdapters', () => {
  it('lists Claude first, then OpenCode', () => {
    const ids = listAdapters().map((a) => a.id);
    expect(ids).toEqual(['claude', 'opencode']);
  });

  it('returns a fresh array (mutation-safe)', () => {
    const a = listAdapters();
    const b = listAdapters();
    expect(a).not.toBe(b);
    a.pop();
    expect(listAdapters().length).toBe(2);
  });
});

describe('CLI registry — detectAll', () => {
  it('probes every adapter in parallel and returns one result per CLI', async () => {
    const claudeSpy = vi
      .spyOn(claudeAdapter, 'detect')
      .mockResolvedValue({ cliId: 'claude', installed: true, version: '4.7' });
    const opencodeSpy = vi
      .spyOn(openCodeAdapter, 'detect')
      .mockResolvedValue({ cliId: 'opencode', installed: true, version: '1.2.27' });

    const results = await detectAll();
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.cliId === 'claude')?.version).toBe('4.7');
    expect(results.find((r) => r.cliId === 'opencode')?.version).toBe('1.2.27');

    claudeSpy.mockRestore();
    opencodeSpy.mockRestore();
  });

  it('survives a single adapter throwing — reports it as uninstalled', async () => {
    const claudeSpy = vi
      .spyOn(claudeAdapter, 'detect')
      .mockRejectedValue(new Error('boom'));
    const opencodeSpy = vi
      .spyOn(openCodeAdapter, 'detect')
      .mockResolvedValue({ cliId: 'opencode', installed: true, version: '1.0.0' });

    const results = await detectAll();
    const claudeResult = results.find((r) => r.cliId === 'claude');
    const opencodeResult = results.find((r) => r.cliId === 'opencode');
    expect(claudeResult?.installed).toBe(false);
    expect(opencodeResult?.installed).toBe(true);

    claudeSpy.mockRestore();
    opencodeSpy.mockRestore();
  });
});
