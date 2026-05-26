import { describe, expect, it } from 'vitest';

import {
  buildClaudeArgs,
  isClaudeSessionLost,
} from '@main/services/ChatService';

// v0.32 regression: native claude session reuse. These pin the exact
// flag emission (seed vs resume) and the session-lost detection that
// drives the re-seed fallback. The spawn/prompt path itself can't be
// unit-tested without a live claude binary, but the arg builder and the
// error classifier are the load-bearing pure pieces — if either drifts,
// threads silently fall back to quadratic full-replay (lost flag) or
// brick on a vanished session (broken detector).

const baseline = [
  '--print',
  '--permission-mode',
  'bypassPermissions',
  '--output-format',
  'stream-json',
  '--verbose',
];

describe('buildClaudeArgs', () => {
  it('emits the unchanged 6-flag baseline with no session', () => {
    expect(buildClaudeArgs({})).toEqual(baseline);
  });

  it('seed mode appends --session-id <id> right after the baseline', () => {
    const args = buildClaudeArgs({}, { mode: 'seed', id: 'abc-123' });
    expect(args).toEqual([...baseline, '--session-id', 'abc-123']);
  });

  it('resume mode appends --resume <id> right after the baseline', () => {
    const args = buildClaudeArgs({}, { mode: 'resume', id: 'abc-123' });
    expect(args).toEqual([...baseline, '--resume', 'abc-123']);
  });

  it('session flags precede optional knobs + extraArgs', () => {
    const args = buildClaudeArgs(
      {
        model: 'opus',
        systemPromptAppend: 'be terse',
        allowedTools: ['Read', 'Edit'],
        extraArgs: ['--foo'],
      },
      { mode: 'resume', id: 'sid' },
    );
    // --resume sits immediately after --verbose, before --model.
    const verboseIdx = args.indexOf('--verbose');
    expect(args[verboseIdx + 1]).toBe('--resume');
    expect(args[verboseIdx + 2]).toBe('sid');
    expect(args[verboseIdx + 3]).toBe('--model');
    // append + tools + extraArgs still flow through verbatim.
    expect(args).toContain('--append-system-prompt');
    expect(args).toContain('--allowed-tools');
    expect(args[args.length - 1]).toBe('--foo');
  });
});

describe('isClaudeSessionLost', () => {
  it('matches claude stderr for a missing session (case-insensitive)', () => {
    expect(
      isClaudeSessionLost(
        'No conversation found with session ID: 7bdd1db7-7d4d-42d2',
      ),
    ).toBe(true);
    expect(
      isClaudeSessionLost('no conversation found with session id: x'),
    ).toBe(true);
  });

  it('does NOT match unrelated errors (those stay terminal)', () => {
    expect(isClaudeSessionLost('claude exited 1')).toBe(false);
    expect(isClaudeSessionLost('stream idle timeout (10 min)')).toBe(false);
    expect(isClaudeSessionLost('rate limit exceeded')).toBe(false);
  });

  it('handles null / undefined / empty without throwing', () => {
    expect(isClaudeSessionLost(null)).toBe(false);
    expect(isClaudeSessionLost(undefined)).toBe(false);
    expect(isClaudeSessionLost('')).toBe(false);
  });
});
