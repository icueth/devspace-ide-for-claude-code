import { describe, expect, it } from 'vitest';

import {
  filterAtMentionFiles,
  findAtMentionToken,
} from '@renderer/components/Dock/AtMentionPicker';

describe('findAtMentionToken', () => {
  it('detects @ at start of input', () => {
    expect(findAtMentionToken('@foo', 4)).toEqual({ tokenStart: 0, query: 'foo' });
  });

  it('detects @ after whitespace', () => {
    expect(findAtMentionToken('hello @bar', 10)).toEqual({ tokenStart: 6, query: 'bar' });
  });

  it('detects @ after newline', () => {
    expect(findAtMentionToken('line1\n@baz', 10)).toEqual({ tokenStart: 6, query: 'baz' });
  });

  it('returns null when @ is preceded by a non-space char (email-style)', () => {
    expect(findAtMentionToken('user@example', 12)).toBeNull();
  });

  it('returns null when no @ before caret', () => {
    expect(findAtMentionToken('hello world', 11)).toBeNull();
  });

  it('returns null when whitespace appears between @ and caret', () => {
    // `@foo bar` — caret after `bar`, the token closed at the space
    expect(findAtMentionToken('@foo bar', 8)).toBeNull();
  });

  it('returns null on tab inside the token', () => {
    expect(findAtMentionToken('@foo\tbar', 8)).toBeNull();
  });

  it('returns empty query when only `@` was typed', () => {
    expect(findAtMentionToken('@', 1)).toEqual({ tokenStart: 0, query: '' });
  });

  it('handles caret in the middle of a longer message', () => {
    // user typed "see @comp" with caret right after "comp"
    expect(findAtMentionToken('see @comp later', 9)).toEqual({
      tokenStart: 4,
      query: 'comp',
    });
  });

  it('rejects runaway queries beyond 200 chars', () => {
    const huge = '@' + 'x'.repeat(201);
    expect(findAtMentionToken(huge, huge.length)).toBeNull();
  });

  it('returns null for out-of-bounds caret', () => {
    expect(findAtMentionToken('@foo', -1)).toBeNull();
    expect(findAtMentionToken('@foo', 99)).toBeNull();
  });
});

describe('filterAtMentionFiles', () => {
  const files = [
    'src/main/index.ts',
    'src/main/services/ChatService.ts',
    'src/renderer/components/Dock/ChatPanel.tsx',
    'src/renderer/components/Dock/SlashPalette.tsx',
    'README.md',
    'package.json',
  ];

  it('returns first 50 entries when query is empty', () => {
    expect(filterAtMentionFiles(files, '').length).toBe(files.length);
  });

  it('prefers basename matches over directory matches', () => {
    const out = filterAtMentionFiles(files, 'chat');
    // ChatPanel.tsx and ChatService.ts should come before any dir-only hits
    expect(out[0]?.endsWith('ChatService.ts') || out[0]?.endsWith('ChatPanel.tsx')).toBe(true);
  });

  it('prefers earlier matches within the basename', () => {
    const set = ['src/foo-bar.ts', 'src/bar-foo.ts'];
    const out = filterAtMentionFiles(set, 'bar');
    expect(out[0]).toBe('src/bar-foo.ts');
  });

  it('is case-insensitive', () => {
    const out = filterAtMentionFiles(files, 'README');
    expect(out[0]).toBe('README.md');
    const out2 = filterAtMentionFiles(files, 'readme');
    expect(out2[0]).toBe('README.md');
  });

  it('caps result at 50 entries', () => {
    const big = Array.from({ length: 80 }, (_, i) => `src/file-${i}.ts`);
    expect(filterAtMentionFiles(big, 'file').length).toBe(50);
  });

  it('breaks score ties by shorter path', () => {
    const set = [
      'aa/bb/cc/dd/match.ts',
      'match.ts',
    ];
    const out = filterAtMentionFiles(set, 'match');
    expect(out[0]).toBe('match.ts');
  });

  it('returns empty array when nothing matches', () => {
    expect(filterAtMentionFiles(files, 'zzzz')).toEqual([]);
  });
});
