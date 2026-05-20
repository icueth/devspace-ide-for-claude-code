// Pure, React-free helpers for the file tree rows. Kept in their own module
// so they can be unit-tested under Vitest's node environment without pulling
// in React / Radix / lucide (which the .tsx row component imports).

import type { DirEntry, GitChangeType } from '@shared/types';
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

/** A folder shows an inline "Loading…" row while it is expanded but its
 *  children haven't arrived yet (first expand or a forced refresh) and no error
 *  occurred. Without it, an expanded folder renders empty during readdir latency
 *  and looks frozen — only the tree ROOT had a loading line before. */
export function shouldShowLoadingRow(
  isDirectory: boolean,
  expanded: boolean,
  hasEntries: boolean,
  hasError: boolean,
): boolean {
  return isDirectory && expanded && !hasEntries && !hasError;
}

/** The subset of row props that the React.memo comparator inspects. */
export interface RowComparableProps {
  entry: DirEntry;
  depth: number;
  expanded: boolean;
  hasEntries: boolean;
  loading: boolean;
  loadError: string | undefined;
  gitType: GitChangeType | undefined;
  /** Flips on any git-snapshot change. */
  gitToken: object;
  /** Flips on any file-tree state change (expand / collapse / load). */
  structureToken: object;
  folderStat: FolderChangeStats | undefined;
  isActiveFile: boolean;
  isIgnored: boolean;
  childEntries: DirEntry[];
}

/**
 * React.memo equality for a file-tree row.
 *
 * Folder rows re-render on ANY git change (re-derive children's gitType) AND on
 * ANY tree-structure change. The structure check is critical: expanding a NESTED
 * folder mutates tree state but leaves every ANCESTOR row's props unchanged, so
 * without it the memoized ancestors never re-render and the newly-loaded
 * children don't mount until an unrelated git tick happens to cascade through —
 * which reads as a multi-second "stuck" expand (regression after rows were
 * memoized). Leaf (file) rows ignore both tokens — their own gitType prop is the
 * precise signal — so a git tick or a sibling folder expanding still only
 * re-renders rows that actually changed.
 */
export function areRowPropsEqual(
  prev: RowComparableProps,
  next: RowComparableProps,
): boolean {
  if (
    next.entry.isDirectory &&
    (prev.gitToken !== next.gitToken ||
      prev.structureToken !== next.structureToken)
  ) {
    return false;
  }
  return (
    prev.entry === next.entry &&
    prev.depth === next.depth &&
    prev.expanded === next.expanded &&
    prev.hasEntries === next.hasEntries &&
    prev.loading === next.loading &&
    prev.loadError === next.loadError &&
    prev.gitType === next.gitType &&
    prev.isActiveFile === next.isActiveFile &&
    prev.isIgnored === next.isIgnored &&
    prev.childEntries === next.childEntries &&
    folderStatEqual(prev.folderStat, next.folderStat)
  );
}
