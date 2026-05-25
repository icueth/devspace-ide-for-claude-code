import { describe, expect, it } from 'vitest';

import {
  composeSections,
  filterCommands,
  filterFiles,
  filterRecents,
  flattenSections,
  parseSpotlightQuery,
  scoreCommandMatch,
  scoreFileMatch,
  type RecentItem,
  type SpotlightCommand,
} from '../spotlightProviders';

import { __test as recentTest } from '@renderer/state/spotlightRecent';

const noop = () => {};

const mkCmd = (id: string, title: string, keywords = '', group = 'Editor'): SpotlightCommand => ({
  id,
  title,
  keywords,
  group,
  run: noop,
});

describe('parseSpotlightQuery', () => {
  it('returns mixed mode for empty input', () => {
    expect(parseSpotlightQuery('')).toEqual({ mode: 'mixed', term: '' });
  });

  it('routes > prefix to commands and strips it', () => {
    expect(parseSpotlightQuery('>wrap')).toEqual({ mode: 'commands', term: 'wrap' });
  });

  it('routes / prefix to settings', () => {
    expect(parseSpotlightQuery('/agents')).toEqual({ mode: 'settings', term: 'agents' });
  });

  it('routes @ prefix to symbols', () => {
    expect(parseSpotlightQuery('@runOpen')).toEqual({ mode: 'symbols', term: 'runOpen' });
  });

  it('routes # prefix to notes', () => {
    expect(parseSpotlightQuery('#perf')).toEqual({ mode: 'notes', term: 'perf' });
  });

  it('plain text defaults to mixed', () => {
    expect(parseSpotlightQuery('chat')).toEqual({ mode: 'mixed', term: 'chat' });
  });

  it('trims residual whitespace in the term', () => {
    expect(parseSpotlightQuery('>  wrap   ')).toEqual({ mode: 'commands', term: 'wrap' });
  });

  it('handles null/undefined gracefully via empty string', () => {
    expect(parseSpotlightQuery(undefined as unknown as string)).toEqual({ mode: 'mixed', term: '' });
  });
});

describe('scoreFileMatch', () => {
  it('returns >0 for empty query (everything matches)', () => {
    expect(scoreFileMatch('a/b.ts', 'b.ts', '')).toBe(1);
  });

  it('exact-name match scores highest (1000)', () => {
    expect(scoreFileMatch('src/foo.ts', 'foo.ts', 'foo.ts')).toBe(1000);
  });

  it('prefix beats substring', () => {
    const prefix = scoreFileMatch('src/cha.ts', 'cha.ts', 'cha');
    const sub = scoreFileMatch('src/xxxchaxxx.ts', 'xxxchaxxx.ts', 'cha');
    expect(prefix).toBeGreaterThan(sub);
  });

  it('substring beats path-substring', () => {
    const nameSub = scoreFileMatch('a/foochat.ts', 'foochat.ts', 'chat');
    const pathSub = scoreFileMatch('src/chat/utils.ts', 'utils.ts', 'chat');
    expect(nameSub).toBeGreaterThan(pathSub);
  });

  it('fuzzy fallback matches when chars appear in order', () => {
    expect(scoreFileMatch('src/abc.ts', 'abc.ts', 'sac')).toBeGreaterThan(0);
  });

  it('returns 0 when no match path exists', () => {
    expect(scoreFileMatch('src/foo.ts', 'foo.ts', 'zzz')).toBe(0);
  });
});

describe('scoreCommandMatch', () => {
  it('exact title scores 1000', () => {
    expect(scoreCommandMatch('toggle wrap', '', 'toggle wrap')).toBe(1000);
  });

  it('title prefix beats title substring', () => {
    expect(scoreCommandMatch('toggle wrap', '', 'tog')).toBeGreaterThan(
      scoreCommandMatch('untoggle wrap', 'tog wrap', 'tog'),
    );
  });

  it('matches via keywords if title misses', () => {
    expect(scoreCommandMatch('Word Wrap', 'soft hard line', 'soft')).toBeGreaterThan(0);
  });

  it('returns 0 when neither title nor keywords match', () => {
    expect(scoreCommandMatch('Open settings', 'pref config', 'xyzzy')).toBe(0);
  });
});

describe('filterFiles', () => {
  const files = ['src/ChatPanel.tsx', 'src/services/ChatService.ts', 'src/utils/diff.ts'];

  it('returns all files for empty query, capped at limit', () => {
    expect(filterFiles(files, '', 2).length).toBe(2);
  });

  it('orders by score descending', () => {
    const r = filterFiles(files, 'chat', 10);
    expect(r[0]!.fileName).toBe('ChatPanel.tsx'); // exact-ish prefix wins
  });

  it('filters out non-matching files', () => {
    const r = filterFiles(files, 'zzz', 10);
    expect(r.length).toBe(0);
  });

  it('handles a negative limit by returning 0 items', () => {
    expect(filterFiles(files, '', -1).length).toBe(0);
  });
});

describe('filterCommands', () => {
  const cmds = [
    mkCmd('toggle.wrap', 'Toggle word wrap', 'soft hard'),
    mkCmd('open.settings', 'Open settings', 'preferences'),
    mkCmd('design.open', 'Open design studio', 'mockup ui'),
  ];

  it('matches by title', () => {
    const r = filterCommands(cmds, 'wrap', 10);
    expect(r[0]?.command.id).toBe('toggle.wrap');
  });

  it('matches by keywords when title misses', () => {
    const r = filterCommands(cmds, 'preferences', 10);
    expect(r[0]?.command.id).toBe('open.settings');
  });

  it('returns empty for no-match query', () => {
    expect(filterCommands(cmds, 'xyzzy', 10).length).toBe(0);
  });
});

describe('filterRecents', () => {
  const files = ['src/foo.ts', 'src/bar.ts'];
  const cmds: SpotlightCommand[] = [mkCmd('toggle.wrap', 'Toggle word wrap')];

  it('drops stale file entries whose path no longer exists', () => {
    const recents: RecentItem[] = [
      { kind: 'file', relPath: 'src/deleted.ts', at: 100 },
      { kind: 'file', relPath: 'src/foo.ts', at: 90 },
    ];
    const r = filterRecents(recents, files, cmds, '', 10);
    expect(r.length).toBe(1);
    expect(r[0]?.kind === 'file' && r[0].relPath).toBe('src/foo.ts');
  });

  it('drops command entries whose id is no longer registered', () => {
    const recents: RecentItem[] = [
      { kind: 'command', commandId: 'gone.command', at: 100 },
      { kind: 'command', commandId: 'toggle.wrap', at: 90 },
    ];
    const r = filterRecents(recents, files, cmds, '', 10);
    expect(r.length).toBe(1);
  });

  it('preserves chronological order (already-sorted input stays sorted)', () => {
    const recents: RecentItem[] = [
      { kind: 'file', relPath: 'src/foo.ts', at: 200 },
      { kind: 'file', relPath: 'src/bar.ts', at: 100 },
    ];
    const r = filterRecents(recents, files, cmds, '', 10);
    expect(r[0]?.kind === 'file' && r[0].relPath).toBe('src/foo.ts');
    expect(r[1]?.kind === 'file' && r[1].relPath).toBe('src/bar.ts');
  });

  it('filters by query term', () => {
    const recents: RecentItem[] = [
      { kind: 'file', relPath: 'src/foo.ts', at: 200 },
      { kind: 'file', relPath: 'src/bar.ts', at: 100 },
    ];
    const r = filterRecents(recents, files, cmds, 'foo', 10);
    expect(r.length).toBe(1);
  });

  it('respects limit', () => {
    const recents: RecentItem[] = [
      { kind: 'file', relPath: 'src/foo.ts', at: 200 },
      { kind: 'file', relPath: 'src/bar.ts', at: 100 },
    ];
    expect(filterRecents(recents, files, cmds, '', 1).length).toBe(1);
  });
});

describe('composeSections', () => {
  const files = ['src/ChatPanel.tsx', 'src/ChatService.ts'];
  const commands: SpotlightCommand[] = [
    mkCmd('toggle.wrap', 'Toggle word wrap', 'wrap'),
    mkCmd('settings.account', 'Open account settings', 'account', 'Settings'),
    mkCmd('settings.agents', 'Open agents settings', 'agents', 'Settings'),
  ];

  it('mixed mode composes Recent + Files + Commands sections', () => {
    const recents: RecentItem[] = [{ kind: 'file', relPath: 'src/ChatPanel.tsx', at: 100 }];
    const sections = composeSections({
      parsed: { mode: 'mixed', term: 'chat' },
      files,
      commands,
      recents,
    });
    const labels = sections.map((s) => s.label);
    expect(labels).toEqual(['Recent', 'Files']);
  });

  it('commands mode returns only commands section', () => {
    const sections = composeSections({
      parsed: { mode: 'commands', term: 'wrap' },
      files,
      commands,
      recents: [],
    });
    expect(sections.length).toBe(1);
    expect(sections[0]?.label).toBe('Commands');
  });

  it('settings mode only includes commands in group="Settings"', () => {
    const sections = composeSections({
      parsed: { mode: 'settings', term: 'agents' },
      files,
      commands,
      recents: [],
    });
    expect(sections.length).toBe(1);
    expect(sections[0]?.items.length).toBe(1);
    expect(
      sections[0]?.items[0]?.source === 'command' && sections[0]?.items[0]?.command.id,
    ).toBe('settings.agents');
  });

  it('notes mode returns empty (Phase C)', () => {
    const sections = composeSections({
      parsed: { mode: 'notes', term: 'perf' },
      files,
      commands,
      recents: [],
    });
    expect(sections).toEqual([]);
  });

  it('symbols mode falls back to file search with explanatory label', () => {
    const sections = composeSections({
      parsed: { mode: 'symbols', term: 'chat' },
      files,
      commands,
      recents: [],
    });
    expect(sections[0]?.label).toContain('symbol indexing coming');
  });

  it('skips empty sections so headers do not appear with zero items', () => {
    const sections = composeSections({
      parsed: { mode: 'mixed', term: 'xyzzy' },
      files,
      commands,
      recents: [],
    });
    expect(sections).toEqual([]);
  });
});

describe('flattenSections', () => {
  it('produces a single positional list in section order', () => {
    const flat = flattenSections([
      { label: 'A', items: [{ source: 'file', relPath: '1', fileName: '1', score: 1 }] },
      { label: 'B', items: [{ source: 'file', relPath: '2', fileName: '2', score: 1 }] },
    ]);
    expect(flat.length).toBe(2);
    expect(flat[0]?.source === 'file' && flat[0].relPath).toBe('1');
  });
});

describe('spotlightRecent bumpToFront helper', () => {
  it('moves an existing file to the front + dedupes', () => {
    const prev: RecentItem[] = [
      { kind: 'file', relPath: 'a', at: 1 },
      { kind: 'file', relPath: 'b', at: 2 },
    ];
    const next = recentTest.bumpToFront(prev, { kind: 'file', relPath: 'a', at: 3 });
    expect(next.length).toBe(2);
    expect(next[0]?.kind === 'file' && next[0].relPath).toBe('a');
    expect(next[0]?.kind === 'file' && next[0].at).toBe(3);
  });

  it('caps at PER_WORKSPACE_CAP when adding a brand-new item', () => {
    const prev: RecentItem[] = Array.from({ length: recentTest.PER_WORKSPACE_CAP }, (_, i) => ({
      kind: 'file' as const,
      relPath: `f${i}`,
      at: i,
    }));
    const next = recentTest.bumpToFront(prev, { kind: 'file', relPath: 'NEW', at: 999 });
    expect(next.length).toBe(recentTest.PER_WORKSPACE_CAP);
    expect(next[0]?.kind === 'file' && next[0].relPath).toBe('NEW');
  });

  it('does not collide file recent with command recent that share a name', () => {
    const prev: RecentItem[] = [{ kind: 'file', relPath: 'wrap', at: 1 }];
    const next = recentTest.bumpToFront(prev, { kind: 'command', commandId: 'wrap', at: 2 });
    expect(next.length).toBe(2);
  });
});
