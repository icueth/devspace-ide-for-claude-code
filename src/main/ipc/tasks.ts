import { execFile } from 'node:child_process';
import * as os from 'node:os';
import { promisify } from 'node:util';

import { BrowserWindow, ipcMain, Notification } from 'electron';

import { getSessionStats, writeToPty } from '@main/services/PtyPool';
import {
  createTaskService,
  type TaskService,
} from '@main/services/TaskService';
import {
  killWorktreeSession,
  launchClaudeInWorktree,
} from '@main/services/TaskService.session';
import {
  startTaskControlSocket,
  type TaskControlDeps,
} from '@main/services/taskControl';
import { assertInWorkspace } from '@main/utils/pathScope';
import { IPC } from '@shared/ipc-channels';
import type { Task } from '@shared/types';

const pexec = promisify(execFile);

// Worktree diff vs base branch, capped so a huge diff can't blow the IPC
// payload / MCP tool reply. Shared by the TASK_DIFF handler and the chat→task
// `task_changes` op.
async function computeTaskDiff(t: Task): Promise<string> {
  try {
    const { stdout } = await pexec(
      'git',
      ['-C', t.worktreePath, 'diff', t.baseBranch],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    return stdout.length > 200_000
      ? `${stdout.slice(0, 200_000)}\n… (diff truncated)`
      : stdout;
  } catch (e) {
    return `# failed to compute diff: ${(e as Error).message}`;
  }
}

export function registerTasksIpc(): void {
  const svc = createTaskService({
    homeDir: os.homedir(),
    now: () => Date.now(),
    idgen: () => Math.random().toString(36).slice(2, 8),
    launchSession: (key, cwd) => launchClaudeInWorktree(key, cwd),
    killSession: (key) => killWorktreeSession(key),
  });
  void svc.init();

  // Broadcast the current task list to every renderer window on any change.
  const push = (): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send(IPC.TASK_CHANGED, svc.list());
    }
  };

  ipcMain.handle(IPC.TASK_LIST, () => svc.list());

  ipcMain.handle(
    IPC.TASK_CREATE,
    async (
      _e,
      opts: { title: string; sourceRepoPath: string; agent: string },
    ) => {
      // Defense-in-depth: the source repo must live inside an open workspace —
      // never let the renderer fork a worktree from an arbitrary path.
      await assertInWorkspace(opts.sourceRepoPath);
      const t = await svc.create(opts);
      push();
      return t;
    },
  );

  ipcMain.handle(IPC.TASK_MERGE, async (_e, id: string) => {
    await svc.merge(id);
    push();
  });

  ipcMain.handle(IPC.TASK_DISCARD, async (_e, id: string) => {
    await svc.discard(id);
    push();
  });

  ipcMain.handle(IPC.TASK_DISMISS, async (_e, id: string) => {
    await svc.dismiss(id);
    push();
  });

  ipcMain.handle(IPC.TASK_DIFF_STAT, async (_e, id: string) => {
    const t = svc.list().find((x) => x.id === id);
    if (!t) return { files: 0, additions: 0, deletions: 0 };
    try {
      // Working tree (committed + uncommitted) vs base, summarized. --shortstat
      // prints "N files changed, A insertions(+), D deletions(-)" — any clause
      // may be absent (a pure-additions diff has no deletions line), so parse
      // each independently rather than with one combined regex.
      const { stdout } = await pexec('git', [
        '-C',
        t.worktreePath,
        'diff',
        '--shortstat',
        t.baseBranch,
      ]);
      const num = (re: RegExp): number => Number(re.exec(stdout)?.[1] ?? 0);
      return {
        files: num(/(\d+) files? changed/),
        additions: num(/(\d+) insertions?\(\+\)/),
        deletions: num(/(\d+) deletions?\(-\)/),
      };
    } catch {
      return { files: 0, additions: 0, deletions: 0 };
    }
  });

  ipcMain.handle(IPC.TASK_DIFF, async (_e, id: string) => {
    const t = svc.list().find((x) => x.id === id);
    return t ? computeTaskDiff(t) : '';
  });

  ipcMain.handle(IPC.TASK_CREATE_PR, async (_e, id: string) => {
    const t = svc.list().find((x) => x.id === id);
    if (!t) return { ok: false, error: 'task not found' };
    try {
      await pexec('git', [
        '-C',
        t.worktreePath,
        'push',
        '-u',
        'origin',
        t.branch,
      ]);
      const { stdout } = await pexec(
        'gh',
        ['pr', 'create', '--fill', '--head', t.branch],
        { cwd: t.worktreePath },
      );
      push();
      return { ok: true, url: stdout.trim() };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  // Kick off the background "changes ready" watcher (see startReviewPoller).
  startReviewPoller(svc, push);

  // chat→task bridge: a unix socket the bundled stdio MCP server relays through
  // so the main-chat agent can create / monitor / drive / merge tasks by tool
  // call (see taskControl). Side-effects (PTY write, git diff) injected here.
  const taskControlDeps: TaskControlDeps = {
    sendToSession: (key, text) =>
      writeToPty(key, /[\r\n]$/.test(text) ? text : `${text}\r`),
    diffOf: (t) => computeTaskDiff(t),
  };
  startTaskControlSocket(svc, push, taskControlDeps);
}

// ── awaiting-review auto-detection ───────────────────────────────────────────
// A `running` task flips to `awaiting-review` when its agent session has gone
// quiet (no PTY output) for REVIEW_IDLE_MS AND its worktree shows a non-empty,
// *stable* diff. We poll PtyPool's read-only activity snapshot (getSessionStats)
// on a timer — deliberately NOT subscribing to the PTY stream — so this can
// never disturb the idle-tab reaper. A spinner tick / prompt redraw refreshes
// lastActivityAt, so "quiet" reliably means the agent is parked at a prompt;
// requiring the diff to be unchanged across two idle ticks guards the one
// remaining case (a long, silent tool run mid-turn).
const REVIEW_IDLE_MS = 20_000;
const REVIEW_POLL_MS = 6_000;

function startReviewPoller(svc: TaskService, push: () => void): void {
  const lastSig = new Map<string, string>();

  const shortstat = async (t: Task): Promise<string> => {
    try {
      const { stdout } = await pexec('git', [
        '-C',
        t.worktreePath,
        'diff',
        '--shortstat',
        t.baseBranch,
      ]);
      return stdout.trim();
    } catch {
      return '';
    }
  };

  const timer = setInterval(() => {
    void (async () => {
      const stats = getSessionStats();
      const now = Date.now();
      const activityOf = (key: string): number | undefined =>
        stats.find((s) => s.id === key)?.lastActivityAt;

      for (const t of svc.list()) {
        const act = activityOf(t.sessionKey);

        if (t.status === 'awaiting-review') {
          // Agent produced output again → back to running.
          if (act !== undefined && now - act < REVIEW_IDLE_MS) {
            if (svc.markRunning(t.id)) push();
          }
          continue;
        }
        if (t.status !== 'running') continue;
        // Still generating (or no live session yet) — leave it alone.
        if (act === undefined || now - act < REVIEW_IDLE_MS) continue;

        const sig = await shortstat(t);
        const prev = lastSig.get(t.id);
        lastSig.set(t.id, sig);
        const hasDiff = /\d+ files? changed/.test(sig);
        // Two consecutive idle ticks with an unchanged diff before we call it
        // "ready" — a single quiet sample could be a silent mid-turn tool run.
        if (hasDiff && prev === sig) {
          const moved = svc.markAwaitingReview(t.id);
          if (moved) {
            push();
            notifyReviewReady(moved.title);
          }
        }
      }
    })();
  }, REVIEW_POLL_MS);
  // Never let the watcher keep the process alive at shutdown.
  timer.unref?.();
}

function notifyReviewReady(title: string): void {
  try {
    if (Notification.isSupported()) {
      new Notification({ title: 'Task ready for review', body: title }).show();
    }
  } catch {
    /* notifications unavailable (headless / no perms) — best-effort */
  }
}
