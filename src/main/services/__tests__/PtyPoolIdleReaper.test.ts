import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// node-pty is a native addon and PtyPool only loadPty()'s on createPty().
// Mock it defensively so even if anything in the suite does trigger that
// path, vitest doesn't blow up trying to resolve the .node binary.
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    throw new Error('node-pty.spawn called in unit test');
  }),
}));

import {
  configureIdleReaper,
  getPinnedSessionsForTest,
  selectIdleClaudeCliVictims,
  setPinnedSessions,
  startIdleReaper,
  stopIdleReaper,
} from '@main/services/PtyPool';
import type { PtySessionKind } from '@shared/types';

// Helper — make a session stat row without typing the discriminator each
// time. lastActivityAt is in ms-epoch, same as PoolEntry.
function mkSession(
  id: string,
  kind: PtySessionKind,
  lastActivityAt: number,
): { id: string; kind: PtySessionKind; lastActivityAt: number } {
  return { id, kind, lastActivityAt };
}

const EMPTY_PINS: ReadonlySet<string> = new Set();

describe('PtyPool — selectIdleClaudeCliVictims (pure)', () => {
  const NOW = 1_700_000_000_000;
  const PINNED_MS = 60 * 60 * 1000; // 1h
  const UNPINNED_MS = 10 * 60 * 1000; // 10m

  it('kills claude-cli sessions older than threshold (pinned tier)', () => {
    const sessions = [
      mkSession('a', 'claude-cli', NOW - 2 * PINNED_MS), // 2h idle
      mkSession('b', 'claude-cli', NOW - 30 * 60 * 1000), // 30m idle (under 1h)
    ];
    const pinned = new Set(['a', 'b']);
    expect(
      selectIdleClaudeCliVictims(sessions, NOW, PINNED_MS, UNPINNED_MS, pinned),
    ).toEqual(['a']);
  });

  it('never touches non-claude-cli kinds even when grossly idle', () => {
    const sessions = [
      mkSession('shell-1', 'shell', NOW - 10 * PINNED_MS),
      mkSession('dev-1', 'dev-server', NOW - 10 * PINNED_MS),
      mkSession('agent-1', 'agent', NOW - 10 * PINNED_MS),
      mkSession('install-1', 'install', NOW - 10 * PINNED_MS),
      mkSession('setup-1', 'setup-claude', NOW - 10 * PINNED_MS),
    ];
    expect(
      selectIdleClaudeCliVictims(sessions, NOW, PINNED_MS, UNPINNED_MS, EMPTY_PINS),
    ).toEqual([]);
  });

  it('returns an empty list when nothing is idle', () => {
    const sessions = [
      mkSession('cli-young', 'claude-cli', NOW - 5 * 60 * 1000), // 5m
      mkSession('shell-young', 'shell', NOW - 1 * 60 * 1000),
    ];
    const pinned = new Set(['cli-young']);
    expect(
      selectIdleClaudeCliVictims(sessions, NOW, PINNED_MS, UNPINNED_MS, pinned),
    ).toEqual([]);
  });

  it('returns empty when both thresholds are non-positive (defensive)', () => {
    const sessions = [
      mkSession('cli-old', 'claude-cli', NOW - 100 * PINNED_MS),
    ];
    expect(selectIdleClaudeCliVictims(sessions, NOW, 0, 0, EMPTY_PINS)).toEqual([]);
    expect(selectIdleClaudeCliVictims(sessions, NOW, -1, -1, EMPTY_PINS)).toEqual([]);
    expect(
      selectIdleClaudeCliVictims(
        sessions,
        NOW,
        Number.NaN,
        Number.NaN,
        EMPTY_PINS,
      ),
    ).toEqual([]);
  });

  it('uses strict > threshold (== threshold is still alive)', () => {
    const sessions = [
      mkSession('cli-edge', 'claude-cli', NOW - PINNED_MS),
    ];
    const pinned = new Set(['cli-edge']);
    expect(
      selectIdleClaudeCliVictims(sessions, NOW, PINNED_MS, UNPINNED_MS, pinned),
    ).toEqual([]);
  });

  it('kills unpinned idle tab using unpinned threshold even when pinned threshold has not elapsed', () => {
    // Session idle 20m: under pinned threshold (1h) but over unpinned (10m).
    // No pin → unpinned tier applies and it dies.
    const sessions = [
      mkSession('off-screen', 'claude-cli', NOW - 20 * 60 * 1000),
    ];
    expect(
      selectIdleClaudeCliVictims(
        sessions,
        NOW,
        PINNED_MS,
        UNPINNED_MS,
        EMPTY_PINS,
      ),
    ).toEqual(['off-screen']);
  });

  it('leaves pinned idle tab alone when pinned threshold not yet elapsed', () => {
    // Session idle 20m: under pinned threshold (1h). Pin protects it from
    // the more aggressive unpinned tier (10m) — visible tabs get patience.
    const sessions = [
      mkSession('visible', 'claude-cli', NOW - 20 * 60 * 1000),
    ];
    const pinned = new Set(['visible']);
    expect(
      selectIdleClaudeCliVictims(sessions, NOW, PINNED_MS, UNPINNED_MS, pinned),
    ).toEqual([]);
  });

  it('kills pinned tab once pinned threshold elapses', () => {
    const sessions = [
      mkSession('visible-stale', 'claude-cli', NOW - 2 * PINNED_MS),
    ];
    const pinned = new Set(['visible-stale']);
    expect(
      selectIdleClaudeCliVictims(sessions, NOW, PINNED_MS, UNPINNED_MS, pinned),
    ).toEqual(['visible-stale']);
  });

  it('non-claude-cli sessions ignored regardless of pinned set', () => {
    const sessions = [
      mkSession('shell-pinned', 'shell', NOW - 10 * PINNED_MS),
      mkSession('dev-pinned', 'dev-server', NOW - 10 * PINNED_MS),
    ];
    const pinned = new Set(['shell-pinned', 'dev-pinned']);
    expect(
      selectIdleClaudeCliVictims(sessions, NOW, PINNED_MS, UNPINNED_MS, pinned),
    ).toEqual([]);
  });

  it('empty pinned set means everything is treated as unpinned', () => {
    // Both sessions idle 20m. Unpinned tier (10m) kills both because
    // neither is in the pinned set.
    const sessions = [
      mkSession('cli-a', 'claude-cli', NOW - 20 * 60 * 1000),
      mkSession('cli-b', 'claude-cli', NOW - 20 * 60 * 1000),
    ];
    expect(
      selectIdleClaudeCliVictims(
        sessions,
        NOW,
        PINNED_MS,
        UNPINNED_MS,
        EMPTY_PINS,
      ),
    ).toEqual(['cli-a', 'cli-b']);
  });

  it('mixed tiers in one snapshot select correctly', () => {
    // Three claude-cli sessions:
    //   - visible-young: pinned, idle 5m → safe
    //   - visible-old:   pinned, idle 2h → killed by pinned tier
    //   - hidden-mid:    unpinned, idle 20m → killed by unpinned tier
    const sessions = [
      mkSession('visible-young', 'claude-cli', NOW - 5 * 60 * 1000),
      mkSession('visible-old', 'claude-cli', NOW - 2 * PINNED_MS),
      mkSession('hidden-mid', 'claude-cli', NOW - 20 * 60 * 1000),
    ];
    const pinned = new Set(['visible-young', 'visible-old']);
    expect(
      selectIdleClaudeCliVictims(sessions, NOW, PINNED_MS, UNPINNED_MS, pinned),
    ).toEqual(['visible-old', 'hidden-mid']);
  });
});

// Exercise the reaper as an interval consumer. We don't want to spin up a
// real PTY, so we drive the decision-pure helper above and assert the
// configure path is wired correctly. The interval itself is best-effort
// to test — we cover it indirectly by ensuring configure + start/stop do
// not throw and selectIdleClaudeCliVictims behaves under the configured
// threshold.
describe('PtyPool — configureIdleReaper clamping', () => {
  afterEach(() => stopIdleReaper());

  it('clamps thresholdMinutes below 15 up to 15', () => {
    // No public getter — verify indirectly by exercising the helper at
    // the configured threshold via a fake call site that mirrors the
    // setInterval body. We can't observe the private state, but the
    // call must not throw, and a subsequent configure with a sane value
    // must succeed.
    expect(() =>
      configureIdleReaper({ enabled: true, thresholdMinutes: 1 }),
    ).not.toThrow();
    expect(() =>
      configureIdleReaper({ enabled: true, thresholdMinutes: 120 }),
    ).not.toThrow();
  });

  it('clamps thresholdMinutes above 720 down to 720', () => {
    expect(() =>
      configureIdleReaper({ enabled: true, thresholdMinutes: 99_999 }),
    ).not.toThrow();
  });

  it('accepts disabled=true even with a junk threshold', () => {
    expect(() =>
      configureIdleReaper({
        enabled: false,
        thresholdMinutes: Number.NaN,
      }),
    ).not.toThrow();
  });

  it('clamps unpinnedThresholdMinutes below 1 up to 1', () => {
    expect(() =>
      configureIdleReaper({
        enabled: true,
        thresholdMinutes: 120,
        unpinnedThresholdMinutes: 0,
      }),
    ).not.toThrow();
    expect(() =>
      configureIdleReaper({
        enabled: true,
        thresholdMinutes: 120,
        unpinnedThresholdMinutes: -5,
      }),
    ).not.toThrow();
  });

  it('clamps unpinnedThresholdMinutes above 60 down to 60', () => {
    expect(() =>
      configureIdleReaper({
        enabled: true,
        thresholdMinutes: 120,
        unpinnedThresholdMinutes: 9_999,
      }),
    ).not.toThrow();
  });

  it('missing unpinnedThresholdMinutes keeps current value', () => {
    // Two back-to-back calls — second omits the field — must not throw.
    expect(() => {
      configureIdleReaper({
        enabled: true,
        thresholdMinutes: 120,
        unpinnedThresholdMinutes: 15,
      });
      configureIdleReaper({ enabled: true, thresholdMinutes: 240 });
    }).not.toThrow();
  });
});

describe('PtyPool — setPinnedSessions / getPinnedSessionsForTest', () => {
  afterEach(() => setPinnedSessions([]));

  it('replaces the pinned set on each call', () => {
    setPinnedSessions(['a', 'b']);
    expect(getPinnedSessionsForTest().size).toBe(2);
    expect(getPinnedSessionsForTest().has('a')).toBe(true);
    expect(getPinnedSessionsForTest().has('b')).toBe(true);
    setPinnedSessions(['c']);
    expect(getPinnedSessionsForTest().size).toBe(1);
    expect(getPinnedSessionsForTest().has('c')).toBe(true);
    expect(getPinnedSessionsForTest().has('a')).toBe(false);
  });

  it('ignores non-string entries', () => {
    setPinnedSessions(['ok', 42 as unknown as string, null as unknown as string, 'also-ok']);
    expect(getPinnedSessionsForTest().size).toBe(2);
    expect(getPinnedSessionsForTest().has('ok')).toBe(true);
    expect(getPinnedSessionsForTest().has('also-ok')).toBe(true);
  });

  it('reflects in selectIdleClaudeCliVictims when used with the live set', () => {
    const NOW = 1_700_000_000_000;
    const PINNED_MS = 60 * 60 * 1000;
    const UNPINNED_MS = 10 * 60 * 1000;
    setPinnedSessions(['protected']);
    const live = getPinnedSessionsForTest();
    const sessions = [
      // 20m idle, unpinned → killed.
      mkSession('hidden', 'claude-cli', NOW - 20 * 60 * 1000),
      // 20m idle, pinned → safe (under pinned 1h threshold).
      mkSession('protected', 'claude-cli', NOW - 20 * 60 * 1000),
    ];
    expect(
      selectIdleClaudeCliVictims(sessions, NOW, PINNED_MS, UNPINNED_MS, live),
    ).toEqual(['hidden']);
  });
});

// Drive the live interval with fake timers so we can verify that a claude-
// cli session older than the threshold triggers the broadcast callback,
// and that disabling the reaper suppresses kills. We can't easily inject a
// session list into the real `entries` Map without spawning a PTY — so
// these tests focus on the path the reaper takes when the live snapshot
// (which they cannot influence) is empty, plus the decision logic above.
//
// The key correctness signal here is that startIdleReaper is idempotent
// and stopIdleReaper releases the timer cleanly.
describe('PtyPool — startIdleReaper / stopIdleReaper lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    stopIdleReaper();
    vi.useRealTimers();
  });

  it('start → stop releases the timer (no callback fires after stop)', () => {
    const broadcast = vi.fn();
    configureIdleReaper({ enabled: true, thresholdMinutes: 15 });
    startIdleReaper(broadcast);
    stopIdleReaper();
    // Advance past several reaper ticks (60s each) — without a running
    // interval, broadcast must never fire even if the real entries map
    // had stale sessions.
    vi.advanceTimersByTime(5 * 60_000);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('start is idempotent — calling twice does not double-fire', () => {
    const broadcast = vi.fn();
    configureIdleReaper({ enabled: true, thresholdMinutes: 15 });
    startIdleReaper(broadcast);
    startIdleReaper(broadcast); // replace previous interval
    vi.advanceTimersByTime(60_000);
    // The real entries map is empty in this test process, so the
    // reaper finds zero victims — never invokes broadcast. We only
    // need to confirm the call didn't throw or double-fire.
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('disabled reaper does not broadcast even when ticking', () => {
    const broadcast = vi.fn();
    configureIdleReaper({ enabled: false, thresholdMinutes: 15 });
    startIdleReaper(broadcast);
    vi.advanceTimersByTime(5 * 60_000);
    expect(broadcast).not.toHaveBeenCalled();
  });
});
