import { dialog, ipcMain } from 'electron';

import {
  addWorkspace,
  listWorkspaces,
  setActiveWorkspace,
} from '@main/services/WorkspaceService';
import { scanWorkspace } from '@main/services/ProjectScanner';
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
      return ws;
    } catch (err) {
      logger.error('addWorkspace failed:', (err as Error).message);
      throw err;
    }
  });

  ipcMain.handle(IPC.WORKSPACE_OPEN, async (_e, absPath: string) => {
    return addWorkspace(absPath);
  });

  ipcMain.handle(IPC.WORKSPACE_SCAN, async (_e, workspaceId: string, workspacePath: string) => {
    return scanWorkspace(workspacePath, workspaceId);
  });

  ipcMain.handle(IPC.WORKSPACE_SET_ACTIVE, async (_e, id: string) => {
    return setActiveWorkspace(id);
  });
}
