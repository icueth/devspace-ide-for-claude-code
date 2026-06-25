import { execFile } from 'node:child_process';
import * as os from 'node:os';
import { promisify } from 'node:util';

import { BrowserWindow, ipcMain } from 'electron';

import { createTaskService } from '@main/services/TaskService';
import {
  killWorktreeSession,
  launchClaudeInWorktree,
} from '@main/services/TaskService.session';
import { assertInWorkspace } from '@main/utils/pathScope';
import { IPC } from '@shared/ipc-channels';

const pexec = promisify(execFile);

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

  ipcMain.handle(IPC.TASK_DIFF_STAT, async (_e, id: string) => {
    const t = svc.list().find((x) => x.id === id);
    if (!t) return { files: 0 };
    try {
      const { stdout } = await pexec('git', [
        '-C',
        t.worktreePath,
        'diff',
        '--shortstat',
        t.baseBranch,
      ]);
      const files = /(\d+) files? changed/.exec(stdout)?.[1];
      return { files: files ? Number(files) : 0 };
    } catch {
      return { files: 0 };
    }
  });

  ipcMain.handle(IPC.TASK_DIFF, async (_e, id: string) => {
    const t = svc.list().find((x) => x.id === id);
    if (!t) return '';
    try {
      // Working tree (committed + uncommitted) vs the base branch. Cap output
      // so a huge diff can't blow the IPC payload / renderer.
      const { stdout } = await pexec(
        'git',
        ['-C', t.worktreePath, 'diff', t.baseBranch],
        { maxBuffer: 4 * 1024 * 1024 },
      );
      return stdout.length > 200_000
        ? stdout.slice(0, 200_000) + '\n… (diff truncated)'
        : stdout;
    } catch (e) {
      return `# failed to compute diff: ${(e as Error).message}`;
    }
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
}
