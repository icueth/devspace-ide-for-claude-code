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
  launchSession: (
    sessionKey: string,
    cwd: string,
    agent: string,
    initialPrompt?: string,
  ) => Promise<void>;
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

  // Release the OS resources a task holds — agent session, worktree, branch,
  // and its pathScope allowlist entry — WITHOUT touching the task record.
  async function cleanupResources(t: Task): Promise<void> {
    await deps.killSession(t.sessionKey).catch(() => undefined);
    await removeWorktree(t.sourceRepoPath, t.worktreePath, t.branch).catch(
      () => undefined,
    );
    removeWorktreeScope(t.worktreePath);
  }

  // Free resources AND drop the record from the list (the discard path).
  async function remove(t: Task): Promise<void> {
    await cleanupResources(t);
    tasks = tasks.filter((x) => x.id !== t.id);
    await persist();
  }

  return {
    deps, // exposed for IPC wiring + tests

    async init(): Promise<void> {
      tasks = (await loadTasks(tasksFile)).tasks;
      let dirty = false;
      tasks = tasks.map((t) => {
        // Finished tasks (merged/discarded) intentionally have no worktree —
        // they're kept only as a historical record, so never flag them error.
        if (t.status === 'done' || t.status === 'discarded') return t;
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
      /** Optional brief sent to the agent as its first message. */
      prompt?: string;
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
        await deps.launchSession(
          task.sessionKey,
          worktreePath,
          opts.agent,
          opts.prompt,
        );
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
      // Merge landed: free the worktree/session/branch but KEEP the task as a
      // 'done' record so the user can see what was integrated (cleared later
      // via dismiss). Previously this removed the task outright, which made a
      // successful merge look like the task had vanished.
      await cleanupResources(t);
      set(id, { status: 'done' });
      // Durably flush the terminal state before returning. set() persists
      // fire-and-forget; if the app exited right after merge the 'done' status
      // could be lost and boot reconcile would then mis-flag it as 'error'
      // (its worktree is intentionally gone).
      await persist();
    },

    async discard(id: string): Promise<void> {
      const t = get(id);
      if (!t) return;
      await remove(t);
    },

    // Drop a finished (done/discarded/error) task from the list. Resources are
    // already released by merge/discard, so this is pure record removal.
    async dismiss(id: string): Promise<void> {
      if (!get(id)) return;
      tasks = tasks.filter((x) => x.id !== id);
      await persist();
    },

    // Proactive "changes ready" transition, driven by the IPC idle poller
    // (registerTasksIpc → startReviewPoller). That poller reads PtyPool's
    // read-only activity snapshot — never the PTY stream — so it can't disturb
    // the idle-tab reaper. Guarded to the real running → awaiting-review edge:
    // an undefined return means "no change", which is how the poller knows not
    // to re-fire its one-shot notification.
    markAwaitingReview(id: string): Task | undefined {
      const t = get(id);
      if (!t || t.status !== 'running') return undefined;
      return set(id, { status: 'awaiting-review' });
    },

    // Reverse edge: the agent emitted output again (e.g. a follow-up prompt),
    // so the task is no longer parked for review. Keeps the sidebar bucket
    // honest. Only acts on the awaiting-review → running edge.
    markRunning(id: string): Task | undefined {
      const t = get(id);
      if (!t || t.status !== 'awaiting-review') return undefined;
      return set(id, { status: 'running' });
    },
  };
}

export type TaskService = ReturnType<typeof createTaskService>;
