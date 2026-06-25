import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  addWorktree,
  currentBranch,
  mergeBranch,
  removeWorktree,
} from '../taskWorktree';

let repo: string;
let wtRoot: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'devspace-repo-'));
  wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devspace-wt-'));
  const run = (c: string) => execSync(c, { cwd: repo, stdio: 'ignore' });
  run('git init -q');
  run('git config user.email t@t.t');
  run('git config user.name t');
  run('git checkout -q -b main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  run('git add -A');
  run('git commit -qm init');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(wtRoot, { recursive: true, force: true });
});

describe('taskWorktree', () => {
  it('currentBranch reads HEAD branch', async () => {
    expect(await currentBranch(repo)).toBe('main');
  });

  it('addWorktree creates an isolated checkout on a new branch', async () => {
    const wt = path.join(wtRoot, 'task-1');
    await addWorktree(repo, wt, 'devspace/task/t1');
    expect(fs.existsSync(path.join(wt, 'a.txt'))).toBe(true);
    expect(await currentBranch(wt)).toBe('devspace/task/t1');
  });

  it('mergeBranch fast-forwards the task branch back into base', async () => {
    const wt = path.join(wtRoot, 'task-2');
    await addWorktree(repo, wt, 'devspace/task/t2');
    fs.writeFileSync(path.join(wt, 'b.txt'), 'two\n');
    execSync('git add -A && git commit -qm work', { cwd: wt, stdio: 'ignore' });
    await mergeBranch(repo, 'devspace/task/t2');
    expect(fs.existsSync(path.join(repo, 'b.txt'))).toBe(true);
  });

  it('removeWorktree deletes the worktree and (force) its branch', async () => {
    const wt = path.join(wtRoot, 'task-3');
    await addWorktree(repo, wt, 'devspace/task/t3');
    await removeWorktree(repo, wt, 'devspace/task/t3');
    expect(fs.existsSync(wt)).toBe(false);
    const branches = execSync('git branch', { cwd: repo }).toString();
    expect(branches).not.toContain('devspace/task/t3');
  });
});
