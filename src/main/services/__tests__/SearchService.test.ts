import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock shell-env resolution to a deterministic PATH so findRg's scan is
// predictable, and stub child_process.spawn so grepProject doesn't actually
// launch ripgrep.
vi.mock('@main/utils/shellEnv', () => ({
  resolveInteractiveShellEnv: vi.fn(async () => ({ PATH: '/usr/bin:/bin' })),
}));

const existsSyncMock = vi.fn();
vi.mock('node:fs', () => ({
  existsSync: (p: string) => existsSyncMock(p),
}));

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { resolveInteractiveShellEnv } from '@main/utils/shellEnv';

import {
  __resetRgPathCacheForTests,
  grepProject,
} from '@main/services/SearchService';

// A fake rg child process that immediately closes with no matches.
function fakeRgChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  // Close on next tick so the Promise in grepProject resolves.
  setImmediate(() => child.emit('close'));
  return child;
}

beforeEach(() => {
  __resetRgPathCacheForTests();
  existsSyncMock.mockReset();
  spawnMock.mockReset();
  (resolveInteractiveShellEnv as ReturnType<typeof vi.fn>).mockClear();
  // First PATH dir (/usr/bin) has rg; the resolver finds it there.
  existsSyncMock.mockImplementation((p: string) => p === '/usr/bin/rg');
  spawnMock.mockImplementation(() => fakeRgChild());
});

afterEach(() => {
  __resetRgPathCacheForTests();
});

describe('SearchService — ripgrep path memoization (FIX 3)', () => {
  it('resolves rg via a PATH scan on the first search', async () => {
    await grepProject('/proj', 'needle');
    // First scan probes /usr/bin/rg (found there immediately).
    expect(existsSyncMock).toHaveBeenCalledWith('/usr/bin/rg');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]![0]).toBe('/usr/bin/rg');
  });

  it('reuses the cached rg path on the second search without re-scanning', async () => {
    await grepProject('/proj', 'needle');
    const scansAfterFirst = existsSyncMock.mock.calls.length;
    expect(scansAfterFirst).toBeGreaterThan(0);

    await grepProject('/proj', 'again');
    // No additional existsSync scan — served from the memoized path.
    expect(existsSyncMock.mock.calls.length).toBe(scansAfterFirst);
    // But rg was still spawned with the same cached path.
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[1]![0]).toBe('/usr/bin/rg');
  });

  it('does not cache a failed lookup — retries on the next search', async () => {
    // rg not present anywhere.
    existsSyncMock.mockImplementation(() => false);
    const r1 = await grepProject('/proj', 'needle');
    const scansAfterFirst = existsSyncMock.mock.calls.length;
    expect(r1.engine).toBe('node'); // findRg returned null → disabled

    await grepProject('/proj', 'needle');
    // A failed lookup is not memoized, so the second search re-scans.
    expect(existsSyncMock.mock.calls.length).toBeGreaterThan(scansAfterFirst);
  });
});
