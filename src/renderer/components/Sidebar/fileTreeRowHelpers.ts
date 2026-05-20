// Pure, React-free helpers for the file tree rows. Kept in their own module
// so they can be unit-tested under Vitest's node environment without pulling
// in React / Radix / lucide (which the .tsx row component imports).

import type { GitChangeType } from '@shared/types';
import type { FolderChangeStats } from '@renderer/utils/gitFolderAggregate';

export const GIT_CLASS: Record<GitChangeType, string> = {
  modified: 'text-semantic-warning',
  added: 'text-semantic-success',
  deleted: 'text-semantic-error line-through',
  renamed: 'text-semantic-info',
  untracked: 'text-semantic-success/60',
  conflict: 'text-semantic-error',
};

export const GIT_BADGE: Record<GitChangeType, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflict: '!',
};

/** Human-readable summary for a folder's change-count badge tooltip. */
export function folderChangeTitle(stat: FolderChangeStats): string {
  const parts: string[] = [];
  if (stat.modified) parts.push(`${stat.modified} modified`);
  if (stat.added) parts.push(`${stat.added} added`);
  if (stat.deleted) parts.push(`${stat.deleted} deleted`);
  if (stat.conflict) parts.push(`${stat.conflict} conflict`);
  return parts.length ? parts.join(', ') : `${stat.total} change${stat.total === 1 ? '' : 's'}`;
}

/** Structural equality for the folder-stat badge so React.memo treats two
 *  freshly-aggregated-but-identical stats as equal and skips re-render. */
export function folderStatEqual(
  a: FolderChangeStats | undefined,
  b: FolderChangeStats | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.total === b.total &&
    a.added === b.added &&
    a.modified === b.modified &&
    a.deleted === b.deleted &&
    a.conflict === b.conflict &&
    a.dominant === b.dominant
  );
}
