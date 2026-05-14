// gitFolderAggregate — turns a flat list of git file changes into a
// per-folder rollup so the sidebar can show "this folder has changes"
// dots/counts without expanding the tree. Pure function, deterministic,
// works on any abs path strings.

import type { GitChangeType, GitFileChange } from '@shared/types';

export interface FolderChangeStats {
  added: number;
  modified: number;
  deleted: number;
  conflict: number;
  // Total = added + modified + deleted + conflict + untracked + renamed.
  // Used for the count badge so a folder with 12 modified + 3 added shows
  // "15" rather than two separate numbers.
  total: number;
  // Dominant kind for the colored dot. Priority: conflict > deleted >
  // modified > added > renamed > untracked. Matches the file-level color
  // convention so a folder dot always looks like the "worst" change inside.
  dominant: GitChangeType;
}

const PRIORITY: GitChangeType[] = [
  'conflict',
  'deleted',
  'modified',
  'added',
  'renamed',
  'untracked',
];

function pickDominant(current: GitChangeType, next: GitChangeType): GitChangeType {
  return PRIORITY.indexOf(next) < PRIORITY.indexOf(current) ? next : current;
}

export function aggregateFolderChanges(
  files: readonly GitFileChange[],
  rootPath: string,
): Map<string, FolderChangeStats> {
  const out = new Map<string, FolderChangeStats>();
  if (files.length === 0 || !rootPath) return out;

  const normalizedRoot = rootPath.endsWith('/') ? rootPath.slice(0, -1) : rootPath;
  const rootPrefix = `${normalizedRoot}/`;

  for (const f of files) {
    // Skip files outside this workspace — defensive, simple-git can return
    // submodule paths that escape the root in edge cases.
    if (!f.absolutePath.startsWith(rootPrefix)) continue;

    // Walk every ancestor folder up to (and including) the workspace root,
    // bumping its counters. A file `foo/bar/baz.ts` contributes to
    // `foo/bar` and `foo` and the root, so any of those folders shows the
    // badge no matter how deep the user has collapsed the tree.
    let cursor = f.absolutePath;
    while (true) {
      const idx = cursor.lastIndexOf('/');
      if (idx <= 0) break;
      cursor = cursor.slice(0, idx);
      if (cursor.length < normalizedRoot.length) break;
      bump(out, cursor, f.type);
      if (cursor === normalizedRoot) break;
    }
  }

  return out;
}

function bump(
  map: Map<string, FolderChangeStats>,
  folder: string,
  type: GitChangeType,
): void {
  const cur = map.get(folder);
  if (!cur) {
    map.set(folder, {
      added: type === 'added' || type === 'untracked' ? 1 : 0,
      modified: type === 'modified' || type === 'renamed' ? 1 : 0,
      deleted: type === 'deleted' ? 1 : 0,
      conflict: type === 'conflict' ? 1 : 0,
      total: 1,
      dominant: type,
    });
    return;
  }
  cur.total += 1;
  if (type === 'added' || type === 'untracked') cur.added += 1;
  else if (type === 'modified' || type === 'renamed') cur.modified += 1;
  else if (type === 'deleted') cur.deleted += 1;
  else if (type === 'conflict') cur.conflict += 1;
  cur.dominant = pickDominant(cur.dominant, type);
}
