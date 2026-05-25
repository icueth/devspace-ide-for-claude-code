import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __resetChatBridgeForTests,
  emitChatPrefill,
  onChatPrefill,
  type ChatPrefillEvent,
} from '@renderer/lib/chatBridge';

// ─── emitChatPrefill / onChatPrefill ────────────────────────────────────────

// Track unsubscribers so we can guarantee cleanup between tests — the
// listener Set is module-level state shared across the file.
const cleanupFns: Array<() => void> = [];
afterEach(() => {
  while (cleanupFns.length > 0) cleanupFns.pop()?.();
  __resetChatBridgeForTests();
});

function subscribe(fn: (e: ChatPrefillEvent) => void): void {
  cleanupFns.push(onChatPrefill(fn));
}

describe('emitChatPrefill / onChatPrefill', () => {
  it('listeners receive emitted events', () => {
    const got: ChatPrefillEvent[] = [];
    subscribe((e) => got.push(e));

    const evt: ChatPrefillEvent = {
      projectPath: '/p',
      text: 'hello',
    };
    emitChatPrefill(evt);

    expect(got).toHaveLength(1);
    expect(got[0]).toEqual(evt);
  });

  it('unsubscribe stops further events', () => {
    const got: ChatPrefillEvent[] = [];
    const off = onChatPrefill((e) => got.push(e));

    emitChatPrefill({ projectPath: '/p', text: 'first' });
    off();
    emitChatPrefill({ projectPath: '/p', text: 'second' });

    expect(got).toHaveLength(1);
    expect(got[0]!.text).toBe('first');
  });

  it("listener throwing doesn't break other listeners", () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const survivor = vi.fn();
      subscribe(() => {
        throw new Error('boom');
      });
      subscribe(survivor);
      // Even though the first listener throws, the second one MUST still
      // receive the event.
      emitChatPrefill({ projectPath: '/p', text: 'still goes' });
      expect(survivor).toHaveBeenCalledTimes(1);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('multiple listeners all receive the same event', () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribe(a);
    subscribe(b);
    emitChatPrefill({ projectPath: '/p', text: 'broadcast' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('attach mode carries absolute path through the bridge', () => {
    // Regression for v0.15.1: FileTree right-click "Add to Chat" and the
    // textarea drop handler both rely on `attachPath` reaching the
    // listener intact so it can compute @<rel> against project root.
    const got: ChatPrefillEvent[] = [];
    subscribe((e) => got.push(e));

    emitChatPrefill({
      projectPath: '/proj',
      text: '',
      attachPath: '/proj/src/index.ts',
    });

    expect(got).toHaveLength(1);
    expect(got[0]!.attachPath).toBe('/proj/src/index.ts');
  });

  // v0.24.3 regression: "Add to Chat" silently dropped events when the
  // target ChatPanel hadn't mounted yet (dockProject schedules the panel
  // for the *next* render). The buffer replays fresh events on the
  // first subscribe so the workflow doesn't depend on render timing.
  it('buffers events emitted before any listener subscribes', () => {
    emitChatPrefill({
      projectPath: '/proj',
      text: '',
      attachPath: '/proj/src/foo.ts',
    });
    const got: ChatPrefillEvent[] = [];
    subscribe((e) => got.push(e));
    expect(got).toHaveLength(1);
    expect(got[0]!.attachPath).toBe('/proj/src/foo.ts');
  });

  it('only replays buffered events once even with multiple subscribers', () => {
    emitChatPrefill({ projectPath: '/proj', text: 'queued' });
    const a: ChatPrefillEvent[] = [];
    const b: ChatPrefillEvent[] = [];
    subscribe((e) => a.push(e));
    subscribe((e) => b.push(e));
    // The buffer is drained by the first subscriber; the second one only
    // gets future events.
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });
});
