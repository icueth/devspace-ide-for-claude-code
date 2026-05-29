import { describe, expect, it } from 'vitest';

import {
  meetsClaudeVersion,
  parseClaudeVersion,
} from '@main/cli/adapters/claude';

// v0.37: parseClaudeVersion + meetsClaudeVersion pin the gate used by the
// renderer to disable /effort, /goal, /reload-skills, Ultra-Review, and
// the background-run launcher when the installed claude is too old.

describe('parseClaudeVersion', () => {
  it('parses the canonical "2.1.154 (Claude Code)" output', () => {
    expect(parseClaudeVersion('2.1.154 (Claude Code)')).toEqual({
      major: 2,
      minor: 1,
      patch: 154,
    });
  });

  it('parses "claude 2.1.154"', () => {
    expect(parseClaudeVersion('claude 2.1.154')).toEqual({
      major: 2,
      minor: 1,
      patch: 154,
    });
  });

  it('parses a leading-v form', () => {
    expect(parseClaudeVersion('v2.1.154')).toEqual({
      major: 2,
      minor: 1,
      patch: 154,
    });
  });

  it('defaults minor + patch to 0 when only the major is present', () => {
    expect(parseClaudeVersion('3')).toEqual({ major: 3, minor: 0, patch: 0 });
  });

  it('defaults patch to 0 when only major.minor present', () => {
    expect(parseClaudeVersion('3.4')).toEqual({ major: 3, minor: 4, patch: 0 });
  });

  it('returns null for empty / non-numeric strings', () => {
    expect(parseClaudeVersion('')).toBeNull();
    expect(parseClaudeVersion('not a version')).toBeNull();
  });
});

describe('meetsClaudeVersion', () => {
  const MIN = { major: 2, minor: 1, patch: 154 };

  it('returns false when actual is null (unknown version)', () => {
    expect(meetsClaudeVersion(null, MIN)).toBe(false);
  });

  it('returns true when actual is exactly equal', () => {
    expect(meetsClaudeVersion({ major: 2, minor: 1, patch: 154 }, MIN)).toBe(
      true,
    );
  });

  it('returns true for a higher patch', () => {
    expect(meetsClaudeVersion({ major: 2, minor: 1, patch: 200 }, MIN)).toBe(
      true,
    );
  });

  it('returns true for a higher minor regardless of patch', () => {
    expect(meetsClaudeVersion({ major: 2, minor: 2, patch: 0 }, MIN)).toBe(true);
  });

  it('returns true for a higher major regardless of minor/patch', () => {
    expect(meetsClaudeVersion({ major: 3, minor: 0, patch: 0 }, MIN)).toBe(true);
  });

  it('returns false for a lower patch', () => {
    expect(meetsClaudeVersion({ major: 2, minor: 1, patch: 153 }, MIN)).toBe(
      false,
    );
  });

  it('returns false for a lower minor even when patch is higher', () => {
    expect(meetsClaudeVersion({ major: 2, minor: 0, patch: 999 }, MIN)).toBe(
      false,
    );
  });

  it('returns false for a lower major even when minor/patch are higher', () => {
    expect(meetsClaudeVersion({ major: 1, minor: 9, patch: 999 }, MIN)).toBe(
      false,
    );
  });
});
