import { BrowserWindow, ipcMain } from 'electron';

import {
  getProjectStatus,
  initProject,
  subscribeInitProgress,
} from '@main/services/RufloService';
import { IPC } from '@shared/ipc-channels';
import { createLogger } from '@shared/logger';
import type { RufloInitProgressEvent } from '@shared/ruflo';

const logger = createLogger('IPC:ruflo');

function validatePath(p: unknown): p is string {
  return typeof p === 'string' && p.length > 0;
}

export function registerRufloIpc(): void {
  ipcMain.handle(IPC.RUFLO_PROJECT_STATUS, async (_e, projectPath: unknown) => {
    if (!validatePath(projectPath)) {
      throw new Error('projectPath must be a non-empty string');
    }
    return getProjectStatus(projectPath);
  });

  ipcMain.handle(IPC.RUFLO_PROJECT_INIT, async (_e, projectPath: unknown) => {
    if (!validatePath(projectPath)) {
      throw new Error('projectPath must be a non-empty string');
    }
    try {
      return await initProject(projectPath);
    } catch (err) {
      logger.error(`initProject failed: ${(err as Error).message}`);
      throw err;
    }
  });

  // Fan progress events out to every renderer window. Subscribing here (once
  // at registration time) is simpler than per-renderer bookkeeping and
  // matches how PTY_AUTO_CLOSED is broadcast from main/index.ts.
  subscribeInitProgress((ev: RufloInitProgressEvent) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send(IPC.RUFLO_PROJECT_INIT_PROGRESS, ev);
    }
  });
}
