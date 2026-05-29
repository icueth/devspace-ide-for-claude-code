import { BrowserWindow, ipcMain } from 'electron';

import {
  addMarketplace,
  getMarketplaceStatus,
  installPlugin,
  listPlugins,
  togglePlugin,
  uninstallPlugin,
} from '@main/services/RufloPluginsService';
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

  // Phase 2 — plugin management. All handlers return tagged result objects;
  // throw only on truly exceptional conditions (e.g. validation) so the
  // renderer can render row-level errors inline without an error boundary.
  ipcMain.handle(IPC.RUFLO_PLUGINS_LIST, async () => {
    try {
      return await listPlugins();
    } catch (err) {
      logger.error(`listPlugins failed: ${(err as Error).message}`);
      return [];
    }
  });

  ipcMain.handle(IPC.RUFLO_PLUGINS_INSTALL, async (_e, name: unknown) => {
    if (typeof name !== 'string' || !name) {
      throw new Error('plugin name must be a non-empty string');
    }
    return installPlugin(name);
  });

  ipcMain.handle(IPC.RUFLO_PLUGINS_UNINSTALL, async (_e, id: unknown) => {
    if (typeof id !== 'string' || !id) {
      throw new Error('plugin id must be a non-empty string');
    }
    return uninstallPlugin(id);
  });

  ipcMain.handle(IPC.RUFLO_PLUGINS_TOGGLE, async (_e, payload: unknown) => {
    if (
      !payload ||
      typeof payload !== 'object' ||
      typeof (payload as { id?: unknown }).id !== 'string' ||
      typeof (payload as { enable?: unknown }).enable !== 'boolean'
    ) {
      throw new Error('toggle payload must be { id: string, enable: boolean }');
    }
    const { id, enable } = payload as { id: string; enable: boolean };
    return togglePlugin(id, enable);
  });

  ipcMain.handle(IPC.RUFLO_MARKETPLACE_STATUS, async () => {
    try {
      return await getMarketplaceStatus();
    } catch (err) {
      logger.error(`marketplaceStatus failed: ${(err as Error).message}`);
      // Fail open so the UI doesn't push an Add button that won't help.
      return { added: true };
    }
  });

  ipcMain.handle(IPC.RUFLO_MARKETPLACE_ADD, async () => {
    return addMarketplace();
  });
}
