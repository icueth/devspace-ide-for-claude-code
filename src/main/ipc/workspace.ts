import { dialog, ipcMain } from 'electron';

import { closeWatchersForRoot } from '@main/services/FileWatcherService';
import { shutdownProject as shutdownDevServerProject } from '@main/services/DevServerService';
import { killProjectSessions } from '@main/services/PtyPool';
import { disposeProject as disposeChatProject } from '@main/services/ChatTranscript';
import { disposeProject as disposeCodeflowProject } from '@main/services/CodeflowService';
import { disposeProject as disposeCodeflowGraphProject } from '@main/services/CodeflowGraphLive';
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
        // shutdownProject (not stopDevServer) so an in-flight `pnpm install`
        // PTY is killed too, not just the dev-server.
        await shutdownDevServerProject(projectPath).catch(() => undefined);
      } catch (err) {
        logger.warn(`shutdownProject failed: ${(err as Error).message}`);
      }
      try {
        await killProjectSessions(projectId);
      } catch (err) {
        logger.warn(`killProjectSessions failed: ${(err as Error).message}`);
      }
      try {
        closeWatchersForRoot(projectPath);
      } catch (err) {
        logger.warn(`closeWatchersForRoot failed: ${(err as Error).message}`);
      }
      // Evict per-project in-memory service state (kills active chat/design
      // runs + codeflow child, drops loaded threads/screens). Without this the
      // state Maps grow unbounded across a session and runs keep streaming
      // into a closed project. Re-opening re-hydrates from disk.
      try {
        await disposeChatProject(projectPath);
      } catch (err) {
        logger.warn(`disposeChatProject failed: ${(err as Error).message}`);
      }
      try {
        disposeCodeflowProject(projectPath);
      } catch (err) {
        logger.warn(`disposeCodeflowProject failed: ${(err as Error).message}`);
      }
      try {
        disposeCodeflowGraphProject(projectPath);
      } catch (err) {
        logger.warn(`disposeCodeflowGraphProject failed: ${(err as Error).message}`);
      }
      logger.info(`closed workspace ${projectId} (${projectPath})`);
    },
  );
}
