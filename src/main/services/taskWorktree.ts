import simpleGit from 'simple-git';

import { assertGitRef } from '@main/utils/pathScope';

// Thin, testable wrappers around `git worktree`/merge for the task lifecycle.
// Branch names are validated with assertGitRef to block flag/`..` injection.

export async function currentBranch(repoPath: string): Promise<string> {
  return (await simpleGit(repoPath).revparse(['--abbrev-ref', 'HEAD'])).trim();
}

export async function addWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  assertGitRef(branch);
  await simpleGit(repoPath).raw(['worktree', 'add', worktreePath, '-b', branch]);
}

export async function mergeBranch(
  repoPath: string,
  branch: string,
): Promise<void> {
  assertGitRef(branch);
  await simpleGit(repoPath).raw(['merge', '--no-edit', branch]);
}

export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  assertGitRef(branch);
  const git = simpleGit(repoPath);
  await git.raw(['worktree', 'remove', '--force', worktreePath]);
  await git.raw(['branch', '-D', branch]).catch(() => undefined);
}

export async function listWorktrees(repoPath: string): Promise<string[]> {
  const out = await simpleGit(repoPath).raw(['worktree', 'list', '--porcelain']);
  return out
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim());
}
