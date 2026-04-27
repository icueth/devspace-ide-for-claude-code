import { ipcMain } from 'electron';

import {
  checkoutBranch,
  commitChanges,
  createBranch,
  discardFiles,
  getFileDiff,
  getStatus,
  gitFetch,
  gitLog,
  gitPull,
  gitPush,
  listBranches,
  stageFiles,
  unstageFiles,
} from '@main/services/GitStatusService';
import { IPC } from '@shared/ipc-channels';

export function registerGitIpc(): void {
  ipcMain.handle(IPC.GIT_STATUS, async (_e, cwd: string) => getStatus(cwd));

  ipcMain.handle(IPC.GIT_DIFF, async (_e, cwd: string, file: string) =>
    getFileDiff(cwd, file),
  );

  ipcMain.handle(IPC.GIT_STAGE, async (_e, cwd: string, paths: string[]) =>
    stageFiles(cwd, paths),
  );

  ipcMain.handle(IPC.GIT_UNSTAGE, async (_e, cwd: string, paths: string[]) =>
    unstageFiles(cwd, paths),
  );

  ipcMain.handle(IPC.GIT_DISCARD, async (_e, cwd: string, paths: string[]) =>
    discardFiles(cwd, paths),
  );

  ipcMain.handle(
    IPC.GIT_COMMIT,
    async (_e, cwd: string, message: string, opts?: { amend?: boolean }) =>
      commitChanges(cwd, message, opts),
  );

  ipcMain.handle(IPC.GIT_BRANCHES, async (_e, cwd: string) => listBranches(cwd));

  ipcMain.handle(IPC.GIT_CHECKOUT, async (_e, cwd: string, name: string) =>
    checkoutBranch(cwd, name),
  );

  ipcMain.handle(
    IPC.GIT_CREATE_BRANCH,
    async (_e, cwd: string, name: string, from?: string) =>
      createBranch(cwd, name, from),
  );

  ipcMain.handle(IPC.GIT_LOG, async (_e, cwd: string, limit?: number) =>
    gitLog(cwd, limit),
  );

  ipcMain.handle(IPC.GIT_FETCH, async (_e, cwd: string) => gitFetch(cwd));

  ipcMain.handle(IPC.GIT_PUSH, async (_e, cwd: string) => gitPush(cwd));

  ipcMain.handle(IPC.GIT_PULL, async (_e, cwd: string) => gitPull(cwd));
}
