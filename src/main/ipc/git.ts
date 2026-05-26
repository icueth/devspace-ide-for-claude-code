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
import { assertInWorkspace } from '@main/utils/pathScope';
import { IPC } from '@shared/ipc-channels';

export function registerGitIpc(): void {
  ipcMain.handle(IPC.GIT_STATUS, async (_e, cwd: string) => {
    await assertInWorkspace(cwd);
    return getStatus(cwd);
  });

  ipcMain.handle(IPC.GIT_DIFF, async (_e, cwd: string, file: string) => {
    await assertInWorkspace(cwd);
    return getFileDiff(cwd, file);
  });

  ipcMain.handle(IPC.GIT_STAGE, async (_e, cwd: string, paths: string[]) => {
    await assertInWorkspace(cwd);
    return stageFiles(cwd, paths);
  });

  ipcMain.handle(IPC.GIT_UNSTAGE, async (_e, cwd: string, paths: string[]) => {
    await assertInWorkspace(cwd);
    return unstageFiles(cwd, paths);
  });

  ipcMain.handle(IPC.GIT_DISCARD, async (_e, cwd: string, paths: string[]) => {
    await assertInWorkspace(cwd);
    return discardFiles(cwd, paths);
  });

  ipcMain.handle(
    IPC.GIT_COMMIT,
    async (_e, cwd: string, message: string, opts?: { amend?: boolean }) => {
      await assertInWorkspace(cwd);
      return commitChanges(cwd, message, opts);
    },
  );

  ipcMain.handle(IPC.GIT_BRANCHES, async (_e, cwd: string) => {
    await assertInWorkspace(cwd);
    return listBranches(cwd);
  });

  ipcMain.handle(IPC.GIT_CHECKOUT, async (_e, cwd: string, name: string) => {
    await assertInWorkspace(cwd);
    return checkoutBranch(cwd, name);
  });

  ipcMain.handle(
    IPC.GIT_CREATE_BRANCH,
    async (_e, cwd: string, name: string, from?: string) => {
      await assertInWorkspace(cwd);
      return createBranch(cwd, name, from);
    },
  );

  ipcMain.handle(IPC.GIT_LOG, async (_e, cwd: string, limit?: number) => {
    await assertInWorkspace(cwd);
    return gitLog(cwd, limit);
  });

  ipcMain.handle(IPC.GIT_FETCH, async (_e, cwd: string) => {
    await assertInWorkspace(cwd);
    return gitFetch(cwd);
  });

  ipcMain.handle(IPC.GIT_PUSH, async (_e, cwd: string) => {
    await assertInWorkspace(cwd);
    return gitPush(cwd);
  });

  ipcMain.handle(IPC.GIT_PULL, async (_e, cwd: string) => {
    await assertInWorkspace(cwd);
    return gitPull(cwd);
  });
}
