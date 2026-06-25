import * as fs from 'node:fs';
import * as path from 'node:path';

import { addWorktreeScope, removeWorktreeScope } from '@main/utils/pathScope';
import type { Task } from '@shared/types';

import { loadTasks, saveTasks } from './taskStore';
import {
  addWorktree,
  currentBranch,
  mergeBranch,
  removeWorktree,
} from './taskWorktree';

export interface TaskServiceDeps {
  homeDir: string;
  now: () => number;
  idgen: () => string;
  // Reuse the existing PTY/tmux launch path with cwd = worktree. The session
  // key MUST be the one ClaudeCliPane(projectId=id, tabId='agent') composes so
  // the detail pane attaches rather than spawning a second session.
  launchSession: (sessionKey: string, cwd: string, agent: string) => Promise<void>;
  killSession: (sessionKey: string) => Promise<void>;
}

function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'task'
  );
}

export function createTaskService(deps: TaskServiceDeps) {
  const tasksFile = path.join(deps.homeDir, '.devspace', 'tasks.json');
  const worktreesDir = path.join(deps.homeDir, '.devspace', 'worktrees');
  let tasks: Task[] = [];

  async function persist(): Promise<void> {
    await saveTasks(tasksFile, { tasks });
  }

  const get = (id: string): Task | undefined => tasks.find((t) => t.id === id);

  function set(id: string, patch: Partial<Task>): Task {
    tasks = tasks.map((t) => (t.id === id ? { ...t, ...patch } : t));
    // Best-effort, fire-and-forget: a failed metadata write must never crash a
    // status update (the next mutation re-persists). .catch keeps it from
    // surfacing as an unhandled rejection.
    void persist().catch(() => undefined);
    return get(id)!;
  }

  async function teardown(t: Task): Promise<void> {
    await deps.killSession(t.sessionKey).catch(() => undefined);
    await removeWorktree(t.sourceRepoPath, t.worktreePath, t.branch).catch(
      () => undefined,
    );
    removeWorktreeScope(t.worktreePath);
    tasks = tasks.filter((x) => x.id !== t.id);
    await persist();
  }

  return {
    deps, // exposed for IPC wiring + tests

    async init(): Promise<void> {
      tasks = (await loadTasks(tasksFile)).tasks;
      let dirty = false;
      tasks = tasks.map((t) => {
        if (!fs.existsSync(t.worktreePath)) {
          dirty = true;
          return { ...t, status: 'error', error: 'worktree missing' };
        }
        addWorktreeScope(t.worktreePath);
        return t;
      });
      if (dirty) await persist();
    },

    list(): Task[] {
      return tasks;
    },

    async create(opts: {
      title: string;
      sourceRepoPath: string;
      agent: string;
    }): Promise<Task> {
      const id = deps.idgen();
      const branch = `devspace/task/${slug(opts.title)}-${id}`;
      const worktreePath = path.join(worktreesDir, id);
      const baseBranch = await currentBranch(opts.sourceRepoPath);
      const task: Task = {
        id,
        title: opts.title,
        sourceRepoPath: opts.sourceRepoPath,
        baseBranch,
        branch,
        worktreePath,
        agent: opts.agent,
        status: 'setting-up',
        sessionKey: `${id}:claude-cli:agent`,
        createdAt: deps.now(),
      };
      tasks = [...tasks, task];
      await persist();
      try {
        await addWorktree(opts.sourceRepoPath, worktreePath, branch);
        addWorktreeScope(worktreePath);
        await deps.launchSession(task.sessionKey, worktreePath, opts.agent);
        return set(id, { status: 'running' });
      } catch (e) {
        return set(id, { status: 'error', error: (e as Error).message });
      }
    },

    async merge(id: string): Promise<void> {
      const t = get(id);
      if (!t) return;
      set(id, { status: 'integrating' });
      await mergeBranch(t.sourceRepoPath, t.branch);
      await teardown(t);
    },

    async discard(id: string): Promise<void> {
      const t = get(id);
      if (!t) return;
      await teardown(t);
    },

    markAwaitingReview(id: string): Task | undefined {
      if (!get(id)) return undefined;
      return set(id, { status: 'awaiting-review' });
    },
  };
}

export type TaskService = ReturnType<typeof createTaskService>;
