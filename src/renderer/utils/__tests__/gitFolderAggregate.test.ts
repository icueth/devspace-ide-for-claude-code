import { describe, expect, it } from 'vitest';

import { aggregateFolderChanges } from '@renderer/utils/gitFolderAggregate';
import type { GitFileChange } from '@shared/types';

const ROOT = '/repo';

function file(rel: string, type: GitFileChange['type']): GitFileChange {
  return {
    path: rel,
    absolutePath: `${ROOT}/${rel}`,
    type,
    staged: false,
  };
}

describe('aggregateFolderChanges', () => {
  it('rolls counts up through every ancestor folder', () => {
    const map = aggregateFolderChanges(
      [file('src/components/Button.tsx', 'modified')],
      ROOT,
    );
    expect(map.get('/repo/src/components')?.total).toBe(1);
    expect(map.get('/repo/src')?.total).toBe(1);
    expect(map.get('/repo')?.total).toBe(1);
  });

  it('picks the dominant change kind by priority', () => {
    // conflict beats deleted beats modified beats added.
    const map = aggregateFolderChanges(
      [
        file('a/x.ts', 'modified'),
        file('a/y.ts', 'added'),
        file('a/z.ts', 'conflict'),
      ],
      ROOT,
    );
    expect(map.get('/repo/a')?.dominant).toBe('conflict');
  });

  it('treats untracked as added in the badge category', () => {
    const map = aggregateFolderChanges([file('a/new.ts', 'untracked')], ROOT);
    expect(map.get('/repo/a')?.added).toBe(1);
  });

  it('ignores files outside the workspace root', () => {
    const map = aggregateFolderChanges(
      [
        { path: '../sibling/x.ts', absolutePath: '/sibling/x.ts', type: 'modified', staged: false },
        file('src/a.ts', 'modified'),
      ],
      ROOT,
    );
    expect(map.has('/sibling')).toBe(false);
    expect(map.get('/repo/src')?.total).toBe(1);
  });

  it('handles root path with trailing slash', () => {
    const map = aggregateFolderChanges([file('src/a.ts', 'modified')], `${ROOT}/`);
    expect(map.get('/repo/src')?.total).toBe(1);
  });

  it('returns empty map when there are no files', () => {
    const map = aggregateFolderChanges([], ROOT);
    expect(map.size).toBe(0);
  });

  it('does not double-count a file under its own folder', () => {
    // A file in a/b/c.ts counts once each at a/b, a, and /repo — not
    // twice at any level.
    const map = aggregateFolderChanges(
      [file('a/b/c.ts', 'modified'), file('a/b/d.ts', 'modified')],
      ROOT,
    );
    expect(map.get('/repo/a/b')?.total).toBe(2);
    expect(map.get('/repo/a')?.total).toBe(2);
    expect(map.get('/repo')?.total).toBe(2);
  });
});
