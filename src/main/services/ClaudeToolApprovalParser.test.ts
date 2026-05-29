import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  APPROVAL_PATTERNS,
  ApprovalDetector,
} from './ClaudeToolApprovalParser';

describe('ClaudeToolApprovalParser', () => {
  let detector: ApprovalDetector;

  beforeEach(() => {
    detector = new ApprovalDetector();
    vi.useFakeTimers();
    // Anchor the fake clock so we can advance it deterministically across
    // the dedupe-window cases below.
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('APPROVAL_PATTERNS', () => {
    it('matches the generic "Allow this tool call?" wording', () => {
      const matched = APPROVAL_PATTERNS.some((re) =>
        re.test('Allow this tool call? (y/N)'),
      );
      expect(matched).toBe(true);
    });

    it('matches the tool-specific "Allow Bash command?" wording', () => {
      const matched = APPROVAL_PATTERNS.some((re) =>
        re.test('Allow Bash command? (y/N)'),
      );
      expect(matched).toBe(true);
    });

    it('does not match arbitrary prose', () => {
      const matched = APPROVAL_PATTERNS.some((re) =>
        re.test('Some unrelated terminal output line.'),
      );
      expect(matched).toBe(false);
    });
  });

  describe('ApprovalDetector.feed', () => {
    it('returns a request when a single chunk contains a match', () => {
      const hit = detector.feed('foo\nAllow Bash command? (y/N) ');
      expect(hit).not.toBeNull();
      expect(hit?.toolName).toBe('Bash');
      expect(hit?.raw).toMatch(/Allow Bash command\? \(y\/N\)/);
      expect(typeof hit?.matchedAt).toBe('number');
    });

    it('returns null when no pattern matches the chunk', () => {
      const hit = detector.feed('just some regular output');
      expect(hit).toBeNull();
    });

    it('dedupes identical raw matches within the 500ms window', () => {
      const first = detector.feed('Allow Edit operation? (y/N)');
      expect(first).not.toBeNull();
      // Advance LESS than the dedupe window — second feed of the same
      // prompt should be swallowed as a redraw.
      vi.advanceTimersByTime(200);
      const second = detector.feed('Allow Edit operation? (y/N)');
      expect(second).toBeNull();
    });

    it('re-fires the same raw match after the dedupe window expires', () => {
      const first = detector.feed('Allow Write operation? (y/N)');
      expect(first).not.toBeNull();
      // Step past 500ms — claude must have moved on AND then redrawn the
      // same prompt for a new tool call. Detector should treat as fresh.
      vi.advanceTimersByTime(600);
      const second = detector.feed('Allow Write operation? (y/N)');
      expect(second).not.toBeNull();
      expect(second?.toolName).toBe('Write');
    });

    it('reset() clears state so the next match fires immediately', () => {
      const first = detector.feed('Allow Bash command? (y/N)');
      expect(first).not.toBeNull();
      detector.reset();
      // Immediately re-feed — no time advance. Without reset() this would
      // be dedup'd; reset wipes the lastFiredRaw + waitingForResponse.
      const second = detector.feed('Allow Bash command? (y/N)');
      expect(second).not.toBeNull();
    });

    it('detects a prompt that arrives split across two feed() calls', () => {
      const a = detector.feed('…some output\nAllow Ba');
      expect(a).toBeNull();
      const b = detector.feed('sh command? (y/N) ');
      expect(b).not.toBeNull();
      expect(b?.toolName).toBe('Bash');
    });

    it('clears waiting state when a non-matching chunk arrives', () => {
      // Establish a waiting state.
      const first = detector.feed('Allow Bash command? (y/N)');
      expect(first).not.toBeNull();
      // Claude moves past (prints tool output). The buffer no longer
      // contains the prompt at the head — but we sliced to 1024 so it
      // may still be in the tail. Push enough non-matching data to
      // overflow the buffer.
      const padding = 'x'.repeat(1100);
      const cleared = detector.feed(`\n${padding}`);
      expect(cleared).toBeNull();
      // Now the SAME prompt should fire again even inside the dedupe
      // window — claude is asking for a NEW tool call.
      const next = detector.feed('Allow Bash command? (y/N)');
      expect(next).not.toBeNull();
    });

    it('recognises the [y/n/a] variant and captures no toolName', () => {
      const hit = detector.feed('Approve this action? [y/n/a]');
      expect(hit).not.toBeNull();
      expect(hit?.toolName).toBeNull();
    });

    it('normalises tool-name capitalisation', () => {
      const hit = detector.feed('? Allow bash? (y/n)');
      expect(hit).not.toBeNull();
      // 4th pattern captures the verbatim word; normalizeToolName uppercases.
      expect(hit?.toolName).toBe('Bash');
    });
  });
});
