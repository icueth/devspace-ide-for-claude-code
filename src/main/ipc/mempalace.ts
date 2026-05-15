import { ipcMain } from 'electron';

import {
  getStatus,
  install,
  openVault,
  subscribeMempalace,
  uninstall,
} from '@main/services/MemPalaceService';
import { IPC } from '@shared/ipc-channels';
import { createLogger } from '@shared/logger';
import type {
  MemPalaceInstallInput,
  MemPalaceUninstallInput,
} from '@shared/mempalace';

const logger = createLogger('IPC:mempalace');

export function registerMempalaceIpc(): void {
  ipcMain.handle(IPC.MEMPALACE_GET_STATUS, async (event) => {
    // Subscribe the requesting webContents so install/uninstall progress
    // events are routed back to this window. The service de-dupes via Set
    // and prunes on 'destroyed'.
    subscribeMempalace(event.sender);
    return getStatus();
  });

  ipcMain.handle(
    IPC.MEMPALACE_INSTALL,
    async (event, input: MemPalaceInstallInput | undefined) => {
      subscribeMempalace(event.sender);
      try {
        return await install(input ?? {});
      } catch (err) {
        logger.error('install failed:', (err as Error).message);
        throw err;
      }
    },
  );

  ipcMain.handle(
    IPC.MEMPALACE_UNINSTALL,
    async (event, input: MemPalaceUninstallInput | undefined) => {
      subscribeMempalace(event.sender);
      try {
        return await uninstall(input ?? {});
      } catch (err) {
        logger.error('uninstall failed:', (err as Error).message);
        throw err;
      }
    },
  );

  ipcMain.handle(IPC.MEMPALACE_OPEN_VAULT, async () => {
    await openVault();
  });
}
