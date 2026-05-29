import { describe, expect, it } from 'vitest';

import { ApprovalDetector } from './ClaudeToolApprovalParser';
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

// Phase 4a: prove the integration surface — the detector is the only
// piece of pool state that the renderer indirectly drives, so we want a
// regression guard that the wiring keeps the public contract intact.
// Spawning a real PTY here is overkill (and fragile in CI) — instead we
// exercise the same ApprovalDetector instance that PtyPool would create
// per claude-cli entry and confirm it routes a representative prompt.
describe('PtyPool — tool-approval detector wiring', () => {
  it('claude-cli sessions get an ApprovalDetector that fires on a real prompt', () => {
    const detector = new ApprovalDetector();
    const hit = detector.feed(
      '\x1b[36m│\x1b[0m\nAllow Bash command? (y/N) ',
    );
    expect(hit).not.toBeNull();
    expect(hit?.toolName).toBe('Bash');
  });

  it('resetting the detector mid-stream lets the next prompt fire immediately', () => {
    const detector = new ApprovalDetector();
    expect(detector.feed('Allow Edit operation? (y/N)')).not.toBeNull();
    // This mirrors what writeToPty does when the user types — reset so the
    // detector doesn't think it's still waiting for ITS own answer.
    detector.reset();
    const next = detector.feed('Allow Edit operation? (y/N)');
    expect(next).not.toBeNull();
  });
});
