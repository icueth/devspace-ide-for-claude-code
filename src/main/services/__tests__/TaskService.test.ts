import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTaskService } from '../TaskService';

let repo: string;
let home: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'devspace-repo-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspace-home-'));
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
  fs.rmSync(home, { recursive: true, force: true });
});

function makeService() {
  return createTaskService({
    homeDir: home,
    now: () => 1000,
    idgen: () => 'abc',
    launchSession: vi.fn(async () => undefined),
    killSession: vi.fn(async () => undefined),
  });
}

describe('TaskService', () => {
  it('create builds a worktree+branch, persists, and launches a session', async () => {
    const svc = makeService();
    const task = await svc.create({
      title: 'Fix bug',
      sourceRepoPath: repo,
      agent: 'claude',
    });
    expect(task.branch).toBe('devspace/task/fix-bug-abc');
    expect(task.baseBranch).toBe('main');
    expect(task.sessionKey).toBe('abc:claude-cli:agent');
    expect(fs.existsSync(task.worktreePath)).toBe(true);
    expect(svc.list()).toHaveLength(1);
    expect(svc.deps.launchSession).toHaveBeenCalledWith(
      task.sessionKey,
      task.worktreePath,
      'claude',
    );
  });

  it('discard removes the worktree, kills the session, and drops the task', async () => {
    const svc = makeService();
    const task = await svc.create({ title: 'X', sourceRepoPath: repo, agent: 'claude' });
    await svc.discard(task.id);
    expect(fs.existsSync(task.worktreePath)).toBe(false);
    expect(svc.deps.killSession).toHaveBeenCalledWith(task.sessionKey);
    expect(svc.list()).toHaveLength(0);
  });

  it('merge integrates the branch and removes the worktree', async () => {
    const svc = makeService();
    const task = await svc.create({ title: 'Y', sourceRepoPath: repo, agent: 'claude' });
    fs.writeFileSync(path.join(task.worktreePath, 'b.txt'), 'two\n');
    execSync('git add -A && git commit -qm work', {
      cwd: task.worktreePath,
      stdio: 'ignore',
    });
    await svc.merge(task.id);
    expect(fs.existsSync(path.join(repo, 'b.txt'))).toBe(true);
    expect(svc.list()).toHaveLength(0);
  });

  it('init marks tasks whose worktree vanished as error', async () => {
    const svc = makeService();
    const t = await svc.create({ title: 'Z', sourceRepoPath: repo, agent: 'claude' });
    fs.rmSync(t.worktreePath, { recursive: true, force: true });
    const svc2 = makeService(); // fresh instance, same home → reloads tasks.json
    await svc2.init();
    expect(svc2.list().find((x) => x.id === t.id)?.status).toBe('error');
  });
});
