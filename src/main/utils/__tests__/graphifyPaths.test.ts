import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/fake/app' },
}));

import { getBundledGraphifyDir, getBundledGraphifyBinary } from '../graphifyPaths';

describe('graphifyPaths', () => {
  it('resolves the per-platform dir under resources/ in dev', () => {
    const dir = getBundledGraphifyDir();
    expect(dir).toContain('/fake/app/resources/graphify/');
    // platformKey is one of the four supported slugs (or host fallback)
    expect(dir).toMatch(/graphify\/(darwin-arm64|darwin-x64|linux-x64|win32-x64|[a-z0-9]+-[a-z0-9]+)$/);
  });

  it('appends the platform-correct executable name', () => {
    const bin = getBundledGraphifyBinary();
    expect(bin.endsWith('graphify') || bin.endsWith('graphify.exe')).toBe(true);
  });
});
