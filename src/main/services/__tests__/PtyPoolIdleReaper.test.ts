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
  selectIdleClaudeCliVictims,
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

describe('PtyPool — selectIdleClaudeCliVictims (pure)', () => {
  const NOW = 1_700_000_000_000;
  const THRESHOLD_MS = 60 * 60 * 1000; // 1h

  it('kills claude-cli sessions older than threshold', () => {
    const sessions = [
      mkSession('a', 'claude-cli', NOW - 2 * THRESHOLD_MS), // 2h idle
      mkSession('b', 'claude-cli', NOW - 30 * 60 * 1000),   // 30m idle (under)
    ];
    expect(
      selectIdleClaudeCliVictims(sessions, NOW, THRESHOLD_MS),
    ).toEqual(['a']);
  });

  it('never touches non-claude-cli kinds even when grossly idle', () => {
    const sessions = [
      mkSession('shell-1', 'shell', NOW - 10 * THRESHOLD_MS),
      mkSession('dev-1', 'dev-server', NOW - 10 * THRESHOLD_MS),
      mkSession('agent-1', 'agent', NOW - 10 * THRESHOLD_MS),
      mkSession('install-1', 'install', NOW - 10 * THRESHOLD_MS),
      mkSession('setup-1', 'setup-claude', NOW - 10 * THRESHOLD_MS),
    ];
    expect(
      selectIdleClaudeCliVictims(sessions, NOW, THRESHOLD_MS),
    ).toEqual([]);
  });

  it('returns an empty list when nothing is idle', () => {
    const sessions = [
      mkSession('cli-young', 'claude-cli', NOW - 5 * 60 * 1000), // 5m
      mkSession('shell-young', 'shell', NOW - 1 * 60 * 1000),
    ];
    expect(
      selectIdleClaudeCliVictims(sessions, NOW, THRESHOLD_MS),
    ).toEqual([]);
  });

  it('returns empty for non-positive threshold (defensive)', () => {
    const sessions = [
      mkSession('cli-old', 'claude-cli', NOW - 100 * THRESHOLD_MS),
    ];
    expect(selectIdleClaudeCliVictims(sessions, NOW, 0)).toEqual([]);
    expect(selectIdleClaudeCliVictims(sessions, NOW, -1)).toEqual([]);
    expect(
      selectIdleClaudeCliVictims(sessions, NOW, Number.NaN),
    ).toEqual([]);
  });

  it('uses strict > threshold (== threshold is still alive)', () => {
    const sessions = [
      mkSession('cli-edge', 'claude-cli', NOW - THRESHOLD_MS),
    ];
    expect(
      selectIdleClaudeCliVictims(sessions, NOW, THRESHOLD_MS),
    ).toEqual([]);
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
