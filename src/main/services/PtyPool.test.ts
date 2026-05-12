import { describe, expect, it } from 'vitest';

import { killProjectSessions, killPty, shutdownAll } from './PtyPool';

// PtyPool is heavily coupled to node-pty's native addon, so this suite
// only exercises the surface that is safe to call without spawning a
// real PTY: the unknown-key paths through the new async kill API. The
// regression we're guarding against is "killPty used to be void; if
// callers stopped awaiting it after the rename, shutdownAll would race
// with app.exit() and leak orphan processes." Verifying these return
// real promises that resolve in bounded time is enough to catch that.

describe('PtyPool — async kill surface', () => {
  it('killPty(unknownKey) returns a resolved promise immediately', async () => {
    const result = killPty('does-not-exist:foo:bar');
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
  });

  it('killProjectSessions(unknownProject) returns a resolved promise', async () => {
    const result = killProjectSessions('nonexistent-project-id');
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
  });

  it('shutdownAll() with empty pool resolves quickly', async () => {
    const start = Date.now();
    await shutdownAll();
    expect(Date.now() - start).toBeLessThan(100);
  });

  // Calling killPty twice on the same unknown key must not throw,
  // double-resolve, or leak microtask debt — important because
  // before-quit + window-all-closed can both invoke shutdownAll.
  it('killPty is idempotent for unknown keys', async () => {
    await expect(killPty('ghost:1')).resolves.toBeUndefined();
    await expect(killPty('ghost:1')).resolves.toBeUndefined();
  });
});
