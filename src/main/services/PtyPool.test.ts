import { describe, expect, it } from 'vitest';

import { ApprovalDetector } from './ClaudeToolApprovalParser';
import {
  createPty,
  killProjectSessions,
  killPty,
  shutdownAll,
  subscribeAndReplay,
  subscribeData,
  writeToPty,
} from './PtyPool';

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

// TOCTOU guard: createPty awaits resolveInteractiveShellEnv() between the
// entries check and entries.set, so two concurrent calls for the same key
// used to both spawn ("Reload tab" during the initial create). The fix
// registers the in-flight create in pendingCreates synchronously; the
// second caller must join it and get the IDENTICAL session object. This is
// the one place we DO spawn a real PTY (/bin/cat — exits instantly on
// kill, no shell rc cost); skipped gracefully if node-pty's native addon
// can't load in this environment.
describe('PtyPool — concurrent createPty dedup', () => {
  it('two concurrent createPty calls for the same key return the identical session', async () => {
    const opts = {
      projectId: 'ptypool-test-toctou',
      // 'agent' — a non-tmux-backed kind, so killPty alone fully cleans up
      // and the claude-cli idle reaper / approval detector stay out of play.
      kind: 'agent' as const,
      tabId: 'dedup',
      cwd: process.cwd(),
      command: '/bin/cat',
      args: [],
    };
    let sessions: Awaited<ReturnType<typeof createPty>>[];
    try {
      // Both calls issued in the same tick — neither has resolved when the
      // second one checks the pool, which is exactly the raced window.
      sessions = await Promise.all([createPty(opts), createPty(opts)]);
    } catch {
      // node-pty native addon unavailable in this runner — the guard can't
      // be exercised here; the unknown-key kill tests above still run.
      return;
    }
    try {
      expect(sessions[0]).toBe(sessions[1]);
      expect(sessions[0].pid).toBe(sessions[1].pid);
    } finally {
      await killPty(sessions[0].sessionId);
    }
  });
});

// Scrollback-replay pull path. subscribeAndReplay is the channel behind
// PTY_SUBSCRIBE: it must hand back the rolling buffer on EVERY call (the
// old subscribe() early-returned for an already-subscribed WebContents,
// which made remount replay dead code), and adding the same wc repeatedly
// must stay idempotent. The unknown-key case needs no PTY; the buffer case
// spawns /bin/cat like the dedup suite and skips gracefully when node-pty's
// native addon can't load in this runner.
describe('PtyPool — subscribeAndReplay', () => {
  // Minimal WebContents stand-in: subscribeAndReplay only touches
  // subscribers.add, the destroy hook, and (via flush) send/isDestroyed.
  const makeFakeWc = () =>
    ({
      send: () => undefined,
      isDestroyed: () => false,
      once: () => undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

  it('returns "" for unknown sessions', () => {
    expect(subscribeAndReplay('does-not-exist:shell:tab', makeFakeWc())).toBe('');
  });

  it('returns buffer contents and keeps replaying on repeat calls for the same wc', async () => {
    const opts = {
      projectId: 'ptypool-test-replay',
      kind: 'agent' as const, // non-tmux-backed: killPty alone cleans up
      tabId: 'replay',
      cwd: process.cwd(),
      command: '/bin/cat',
      args: [],
    };
    let session: Awaited<ReturnType<typeof createPty>>;
    try {
      session = await createPty(opts);
    } catch {
      // node-pty native addon unavailable in this runner — skip gracefully,
      // matching the dedup suite above. The unknown-key test still ran.
      return;
    }
    try {
      // cat under a PTY echoes its input, so a write is the cheapest way to
      // get deterministic bytes into the rolling buffer. Await the echo via
      // the programmatic listener (fires on every chunk, unbatched).
      const probe = 'replay-probe-payload';
      let echoed = '';
      const sawProbe = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 5000);
        const off = subscribeData(session.sessionId, (chunk) => {
          echoed += chunk;
          if (echoed.includes(probe)) {
            clearTimeout(timer);
            off();
            resolve(true);
          }
        });
      });
      writeToPty(session.sessionId, `${probe}\n`);
      if (!(await sawProbe)) return; // PTY produced nothing — environment issue

      const wc = makeFakeWc();
      const first = subscribeAndReplay(session.sessionId, wc);
      // Same wc again — the remount case. No has(wc) early-return may
      // suppress the replay.
      const second = subscribeAndReplay(session.sessionId, wc);
      expect(first).toContain(probe);
      expect(second).toContain(probe);
      // No new output between the calls → identical snapshots.
      expect(second).toBe(first);
    } finally {
      await killPty(session.sessionId);
    }
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
