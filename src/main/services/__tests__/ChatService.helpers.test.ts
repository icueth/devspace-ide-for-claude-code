import { describe, expect, it } from 'vitest';

import {
  fenceUntrusted,
  sanitizePathForFrontmatter,
} from '@main/services/ChatService';

// v0.25 SEC regression: pinned shape of devlog-body untrusted-data
// fencing and frontmatter path scrubbing. Both feed model/user prose
// into on-disk markdown that the renderer reads back; if either drift
// regresses, prompt-injected content or comma-bearing paths could
// corrupt the devlog beyond visual noise.

describe('fenceUntrusted', () => {
  it('wraps prose in a triple-backtick text fence', () => {
    expect(fenceUntrusted('hello world')).toBe('```text\nhello world\n```');
  });

  it('returns empty for empty input', () => {
    expect(fenceUntrusted('')).toBe('');
  });

  it('neutralizes embedded fence-breakout sequences', () => {
    const evil = 'safe\n```\n# Injected heading\n[bad](javascript:alert(1))\n```';
    const out = fenceUntrusted(evil);
    // Outer fence starts and ends.
    expect(out.startsWith('```text\n')).toBe(true);
    expect(out.endsWith('\n```')).toBe(true);
    // No inner triple-backtick survives — they were spaced.
    expect(out.slice(8, -4)).not.toMatch(/```/);
  });
});

describe('sanitizePathForFrontmatter', () => {
  it('passes normal POSIX paths through', () => {
    expect(sanitizePathForFrontmatter('src/main/foo.ts')).toBe('src/main/foo.ts');
    expect(sanitizePathForFrontmatter('a/b/c-d_e.ts')).toBe('a/b/c-d_e.ts');
  });

  it('drops paths containing characters that corrupt list serialization', () => {
    expect(sanitizePathForFrontmatter('src/foo,bar.ts')).toBe('');
    expect(sanitizePathForFrontmatter('src/[brackets].ts')).toBe('');
    expect(sanitizePathForFrontmatter('src/"quoted".ts')).toBe('');
    expect(sanitizePathForFrontmatter("src/'single'.ts")).toBe('');
    expect(sanitizePathForFrontmatter('src/with\nnewline.ts')).toBe('');
  });

  it('returns empty for empty input', () => {
    expect(sanitizePathForFrontmatter('')).toBe('');
  });
});
