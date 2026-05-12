import simpleGit, { type SimpleGit } from 'simple-git';

import { assertGitRef, assertRelativePath } from '@main/utils/pathScope';
import { createLogger } from '@shared/logger';
import * as path from 'node:path';

const logger = createLogger('GitStatusService');

export type GitChangeType = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict';

export interface GitFileChange {
  path: string;
  absolutePath: string;
  type: GitChangeType;
  staged: boolean;
}

export interface GitSnapshot {
  branch: string | null;
  ahead: number;
  behind: number;
  files: GitFileChange[];
  isRepo: boolean;
  ignoredPaths: string[];
}

function normalizeStatus(s: string): GitChangeType {
  const t = s.trim();
  if (t.includes('U') || t === 'AA' || t === 'DD') return 'conflict';
  if (t.startsWith('R')) return 'renamed';
  if (t === '??' || t === '?') return 'untracked';
  if (t.includes('D')) return 'deleted';
  if (t.includes('A')) return 'added';
  if (t.includes('M')) return 'modified';
  return 'modified';
}

function getGit(cwd: string): SimpleGit {
  // GIT_OPTIONAL_LOCKS=0 avoids racing with foreground operations on the
  // `.git/index.lock`. Only keep the env vars simple-git actually needs so
  // inherited settings like GIT_EDITOR can't trip its safety checks.
  return simpleGit(cwd).env({
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    LANG: process.env.LANG ?? 'C',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  });
}

export async function getStatus(cwd: string): Promise<GitSnapshot> {
  const git = getGit(cwd);
  try {
    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
      return {
        branch: null,
        ahead: 0,
        behind: 0,
        files: [],
        isRepo: false,
        ignoredPaths: [],
      };
    }

    const [status, ignoredRaw] = await Promise.all([
      git.status(),
      // --directory rolls up entirely-ignored folders so the result stays
      // small even when a project has node_modules with thousands of files.
      // Errors are swallowed because some old git versions or non-trivial
      // exclude configurations can fail this command without breaking the
      // overall status snapshot.
      git
        .raw([
          'ls-files',
          '--others',
          '--ignored',
          '--exclude-standard',
          '--directory',
        ])
        .catch(() => ''),
    ]);

    const files: GitFileChange[] = status.files.map((f) => ({
      path: f.path,
      absolutePath: path.join(cwd, f.path),
      type: normalizeStatus(`${f.index}${f.working_dir}`),
      staged: f.index !== ' ' && f.index !== '?',
    }));

    const ignoredPaths = ignoredRaw
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    return {
      branch: status.current ?? null,
      ahead: status.ahead,
      behind: status.behind,
      files,
      isRepo: true,
      ignoredPaths,
    };
  } catch (err) {
    logger.warn(`status failed for ${cwd}:`, (err as Error).message);
    return {
      branch: null,
      ahead: 0,
      behind: 0,
      files: [],
      isRepo: false,
      ignoredPaths: [],
    };
  }
}

export async function getFileDiff(
  cwd: string,
  relativePath: string,
): Promise<{ oldContent: string; newContent: string }> {
  assertRelativePath(relativePath);
  const git = getGit(cwd);
  let oldContent = '';
  try {
    // Use `-- <path>` separator so git treats the arg as a pathspec, never a flag.
    oldContent = await git.show(['HEAD', '--', relativePath]).catch(async () => {
      // Older git versions don't accept the separator on `show`; fall back
      // to the legacy form, knowing the path was already validated.
      return git.show([`HEAD:${relativePath}`]);
    });
  } catch {
    oldContent = '';
  }

  let newContent = '';
  try {
    const fs = await import('node:fs/promises');
    newContent = await fs.readFile(path.join(cwd, relativePath), 'utf8');
  } catch {
    newContent = '';
  }

  return { oldContent, newContent };
}

export async function stageFiles(cwd: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  paths.forEach(assertRelativePath);
  await getGit(cwd).raw(['add', '--', ...paths]);
}

export async function unstageFiles(cwd: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  paths.forEach(assertRelativePath);
  try {
    await getGit(cwd).reset(['HEAD', '--', ...paths]);
  } catch {
    await getGit(cwd).raw(['rm', '--cached', '--', ...paths]).catch(() => undefined);
  }
}

export async function discardFiles(cwd: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  paths.forEach(assertRelativePath);
  const git = getGit(cwd);
  for (const p of paths) {
    try {
      await git.checkout(['--', p]);
    } catch {
      const fs = await import('node:fs/promises');
      await fs.rm(path.join(cwd, p), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export async function commitChanges(
  cwd: string,
  message: string,
  opts: { amend?: boolean } = {},
): Promise<string> {
  const git = getGit(cwd);
  const flags: string[] = [];
  if (opts.amend) flags.push('--amend');
  const result = await git.commit(message, undefined, { ...Object.fromEntries(flags.map((f) => [f, null])) });
  return result.commit;
}

export async function listBranches(cwd: string): Promise<{
  current: string | null;
  branches: Array<{
    name: string;
    current: boolean;
    remote: boolean;
    commit?: string;
    subject?: string;
    upstream?: string;
  }>;
}> {
  const git = getGit(cwd);
  try {
    const res = await git.branch(['-a', '-v']);
    const current = res.current || null;
    const branches = Object.values(res.branches).map((b) => {
      // remotes/origin/foo — normalise
      const isRemote = b.name.startsWith('remotes/');
      const name = isRemote ? b.name.slice('remotes/'.length) : b.name;
      return {
        name,
        current: b.current,
        remote: isRemote,
        commit: b.commit,
        subject: b.label,
      };
    });
    return { current, branches };
  } catch (err) {
    logger.warn(`listBranches failed: ${(err as Error).message}`);
    return { current: null, branches: [] };
  }
}

export async function checkoutBranch(cwd: string, name: string): Promise<void> {
  assertGitRef(name);
  // `--` separator forces git to treat the next arg as a ref, never a flag,
  // even if a future migration flips the arg into a path slot accidentally.
  await getGit(cwd).raw(['checkout', name]);
}

export async function createBranch(
  cwd: string,
  name: string,
  from?: string,
): Promise<void> {
  assertGitRef(name);
  if (from) assertGitRef(from);
  const args = ['checkout', '-b', name];
  if (from) args.push(from);
  await getGit(cwd).raw(args);
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: number;
  subject: string;
  refs: string[];
}

export async function gitLog(cwd: string, limit = 50): Promise<GitLogEntry[]> {
  const git = getGit(cwd);
  try {
    const res = await git.log({ maxCount: limit });
    return res.all.map((c) => {
      const t = new Date(c.date).getTime();
      return ({
        hash: c.hash,
        shortHash: c.hash.slice(0, 7),
        author: c.author_name,
        email: c.author_email,
        // Guard against malformed dates from simple-git → renderer crashes
        // when sorting/formatting NaN dates.
        date: Number.isFinite(t) ? t : 0,
        subject: c.message,
      refs: c.refs
        ? c.refs
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
      });
    });
  } catch (err) {
    logger.warn(`log failed for ${cwd}:`, (err as Error).message);
    return [];
  }
}

export async function gitFetch(cwd: string): Promise<void> {
  await getGit(cwd).fetch();
}

export async function gitPush(cwd: string): Promise<void> {
  await getGit(cwd).push();
}

export async function gitPull(cwd: string): Promise<void> {
  // `--rebase=false` avoids surprising the user when their local config
  // defaults to rebase — we just want fast-forward-or-merge semantics.
  await getGit(cwd).pull(undefined, undefined, { '--rebase': 'false' });
}
