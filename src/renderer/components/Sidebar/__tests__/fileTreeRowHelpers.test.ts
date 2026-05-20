import { describe, expect, it } from 'vitest';

import type { FolderChangeStats } from '@renderer/utils/gitFolderAggregate';

import {
  folderChangeTitle,
  folderStatEqual,
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
