import { dialog, ipcMain } from 'electron';

import { closeWatchersForRoot } from '@main/services/FileWatcherService';
import { stopDevServer } from '@main/services/DevServerService';
import { killProjectSessions } from '@main/services/PtyPool';
import {
  addWorkspace,
  listWorkspaces,
  setActiveWorkspace,
} from '@main/services/WorkspaceService';
import { scanWorkspace } from '@main/services/ProjectScanner';
import { invalidateWorkspaceRootsCache } from '@main/utils/pathScope';
import { IPC } from '@shared/ipc-channels';
import { createLogger } from '@shared/logger';

const logger = createLogger('IPC:workspace');

export function registerWorkspaceIpc(): void {
  ipcMain.handle(IPC.WORKSPACE_LIST, async () => listWorkspaces());

  ipcMain.handle(IPC.WORKSPACE_PICK, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Pick workspace folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    try {
      const ws = await addWorkspace(result.filePaths[0]);
      invalidateWorkspaceRootsCache();
      return ws;
    } catch (err) {
      logger.error('addWorkspace failed:', (err as Error).message);
      throw err;
    }
  });

  ipcMain.handle(IPC.WORKSPACE_OPEN, async (_e, absPath: string) => {
    const ws = await addWorkspace(absPath);
    invalidateWorkspaceRootsCache();
    return ws;
  });

  ipcMain.handle(IPC.WORKSPACE_SCAN, async (_e, workspaceId: string, workspacePath: string) => {
    return scanWorkspace(workspacePath, workspaceId);
  });

  ipcMain.handle(IPC.WORKSPACE_SET_ACTIVE, async (_e, id: string) => {
    return setActiveWorkspace(id);
  });

  // Tear down ephemeral resources belonging to a workspace: PTYs (claude /
  // shell / dev-server), file watchers, and dev-server lifecycle. Does NOT
  // remove the workspace from history — that's a separate user gesture.
  ipcMain.handle(
    IPC.WORKSPACE_CLOSE,
    async (_e, projectId: string, projectPath: string) => {
      if (typeof projectId !== 'string' || typeof projectPath !== 'string') {
        throw new Error('WORKSPACE_CLOSE requires projectId and projectPath');
      }
      try {
        await stopDevServer(projectPath).catch(() => undefined);
      } catch (err) {
        logger.warn(`stopDevServer failed: ${(err as Error).message}`);
      }
      try {
        killProjectSessions(projectId);
      } catch (err) {
        logger.warn(`killProjectSessions failed: ${(err as Error).message}`);
      }
      try {
        closeWatchersForRoot(projectPath);
      } catch (err) {
        logger.warn(`closeWatchersForRoot failed: ${(err as Error).message}`);
      }
      logger.info(`closed workspace ${projectId} (${projectPath})`);
    },
  );
}
