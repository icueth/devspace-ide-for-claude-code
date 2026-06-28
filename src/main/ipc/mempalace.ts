import { ipcMain } from 'electron';

import {
  getCliMempalaceWiring,
  syncAllCliMempalace,
} from '@main/services/cliMcpSetup';
import {
  getPalaceSyncStatus,
  pullPalace,
  pushPalace,
} from '@main/services/palaceSync';
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

  // Per-CLI MemPalace wiring roll-up + one-click "connect all" (pre-wires the
  // global-config CLIs without needing to open each tab).
  ipcMain.handle(IPC.MEMPALACE_CLI_WIRING, async () => getCliMempalaceWiring());
  ipcMain.handle(IPC.MEMPALACE_CLI_SYNC, async () => syncAllCliMempalace());

  // Git-backed vault sync across machines (pull before use / push after use).
  ipcMain.handle(IPC.MEMPALACE_SYNC_STATUS, async () => getPalaceSyncStatus());
  ipcMain.handle(IPC.MEMPALACE_SYNC_PULL, async () => pullPalace());
  ipcMain.handle(IPC.MEMPALACE_SYNC_PUSH, async () => pushPalace());

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
