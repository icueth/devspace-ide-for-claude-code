import { describe, expect, it } from 'vitest';

import type { FolderChangeStats } from '@renderer/utils/gitFolderAggregate';
import type { DirEntry } from '@shared/types';

import {
  areRowPropsEqual,
  folderChangeTitle,
  folderStatEqual,
  shouldShowLoadingRow,
  type RowComparableProps,
} from '../fileTreeRowHelpers';

function stat(partial: Partial<FolderChangeStats>): FolderChangeStats {
  return {
    added: 0,
    modified: 0,
    deleted: 0,
    conflict: 0,
    total: 0,
    dominant: 'modified',
    ...partial,
  };
}

describe('folderChangeTitle', () => {
  it('lists each non-zero category in canonical order', () => {
    expect(
      folderChangeTitle(stat({ modified: 2, added: 1, deleted: 3, conflict: 1, total: 7 })),
    ).toBe('2 modified, 1 added, 3 deleted, 1 conflict');
  });

  it('omits zero categories', () => {
    expect(folderChangeTitle(stat({ modified: 5, total: 5 }))).toBe('5 modified');
  });

  it('falls back to total count when no category counters are set', () => {
    // e.g. untracked/renamed roll into total but not into the four named
    // counters, so the title should report the plural total.
    expect(folderChangeTitle(stat({ total: 4 }))).toBe('4 changes');
  });

  it('uses the singular form for a single total change', () => {
    expect(folderChangeTitle(stat({ total: 1 }))).toBe('1 change');
  });
});

describe('folderStatEqual', () => {
  it('treats the same reference as equal', () => {
    const s = stat({ total: 3, modified: 3 });
    expect(folderStatEqual(s, s)).toBe(true);
  });

  it('treats two structurally identical stats as equal', () => {
    expect(
      folderStatEqual(
        stat({ total: 3, modified: 2, added: 1, dominant: 'modified' }),
        stat({ total: 3, modified: 2, added: 1, dominant: 'modified' }),
      ),
    ).toBe(true);
  });

  it('detects a changed count', () => {
    expect(
      folderStatEqual(stat({ total: 3, modified: 3 }), stat({ total: 4, modified: 4 })),
    ).toBe(false);
  });

  it('detects a changed dominant kind even when counts match', () => {
    expect(
      folderStatEqual(
        stat({ total: 2, modified: 1, added: 1, dominant: 'modified' }),
        stat({ total: 2, modified: 1, added: 1, dominant: 'added' }),
      ),
    ).toBe(false);
  });

  it('handles undefined on either side', () => {
    expect(folderStatEqual(undefined, undefined)).toBe(true);
    expect(folderStatEqual(stat({ total: 1 }), undefined)).toBe(false);
    expect(folderStatEqual(undefined, stat({ total: 1 }))).toBe(false);
  });
});

describe('shouldShowLoadingRow', () => {
  it('shows while an expanded folder has no entries yet and no error', () => {
    expect(shouldShowLoadingRow(true, true, false, false)).toBe(true);
  });

  it('hides once entries have arrived', () => {
    expect(shouldShowLoadingRow(true, true, true, false)).toBe(false);
  });

  it('hides on error (the error row takes over)', () => {
    expect(shouldShowLoadingRow(true, true, false, true)).toBe(false);
  });

  it('never shows for collapsed folders or files', () => {
    expect(shouldShowLoadingRow(true, false, false, false)).toBe(false);
    expect(shouldShowLoadingRow(false, true, false, false)).toBe(false);
  });
});

describe('areRowPropsEqual', () => {
  const dir: DirEntry = { name: 'src', path: '/p/src', isDirectory: true };
  const file: DirEntry = { name: 'a.ts', path: '/p/a.ts', isDirectory: false };
  const GIT = {};
  const STRUCT = {};
  const ACTIVE = {};
  // Stable reference — matches real usage (the parent hands the SAME filtered
  // array per node). A fresh [] per call would defeat the identity check and
  // mask what each assertion is actually testing.
  const CHILDREN: DirEntry[] = [];

  function props(over: Partial<RowComparableProps> = {}): RowComparableProps {
    return {
      entry: dir,
      depth: 1,
      expanded: false,
      hasEntries: false,
      loading: false,
      loadError: undefined,
      gitType: undefined,
      gitToken: GIT,
      structureToken: STRUCT,
      activeFileToken: ACTIVE,
      folderStat: undefined,
      isActiveFile: false,
      isIgnored: false,
      childEntries: CHILDREN,
      ...over,
    };
  }

  it('skips re-render when nothing changed', () => {
    expect(areRowPropsEqual(props(), props())).toBe(true);
  });

  // Regression: nested folder expand mutates tree state (new structureToken)
  // without touching ancestor props. Before the structure check, ancestors
  // skipped re-render and children never mounted until a git tick.
  it('FORCES a folder re-render when only the structureToken flips', () => {
    expect(areRowPropsEqual(props(), props({ structureToken: {} }))).toBe(false);
  });

  it('still forces a folder re-render when only the gitToken flips', () => {
    expect(areRowPropsEqual(props(), props({ gitToken: {} }))).toBe(false);
  });

  // Regression: switching the active editor tab mutates neither tree nor git
  // state, so without the active-file token the memoized ancestor chain bails
  // and nested leaves never receive the updated isActiveFile — highlight stays
  // on the old file until an unrelated git tick flips gitToken.
  it('FORCES a folder re-render when only the activeFileToken flips', () => {
    expect(areRowPropsEqual(props(), props({ activeFileToken: {} }))).toBe(false);
  });

  it('does NOT re-render a leaf file when only a token flips (perf preserved)', () => {
    const base = props({ entry: file });
    expect(areRowPropsEqual(base, props({ entry: file, structureToken: {} }))).toBe(true);
    expect(areRowPropsEqual(base, props({ entry: file, gitToken: {} }))).toBe(true);
    // The active-file token is no different: a leaf ignores it and relies on
    // its own isActiveFile flag, so an active-tab switch that doesn't touch
    // THIS file leaves it untouched.
    expect(areRowPropsEqual(base, props({ entry: file, activeFileToken: {} }))).toBe(true);
  });

  // The leaf whose active-state actually changed must re-render — its own
  // isActiveFile flag is the precise signal the comparator inspects directly,
  // independent of the token.
  it('re-renders a leaf file when its own isActiveFile flag flips', () => {
    const base = props({ entry: file, isActiveFile: false });
    expect(
      areRowPropsEqual(base, props({ entry: file, isActiveFile: true })),
    ).toBe(false);
    // And it re-renders even if the token did NOT flip — proving the leaf
    // doesn't depend on the token to catch its own active-state change.
    expect(
      areRowPropsEqual(
        base,
        props({ entry: file, isActiveFile: true, activeFileToken: ACTIVE }),
      ),
    ).toBe(false);
  });

  it('re-renders any row when its own loading flag changes', () => {
    const a = props({ entry: file });
    expect(areRowPropsEqual(a, props({ entry: file, loading: true }))).toBe(false);
  });
});
