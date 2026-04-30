import { app, ipcMain, shell } from 'electron';
import * as os from 'node:os';

import { checkForUpdate } from '@main/services/UpdateService';
import { IPC } from '@shared/ipc-channels';

export function registerAppIpc(): void {
  ipcMain.handle(IPC.APP_GET_VERSION, () => app.getVersion());
  ipcMain.handle(IPC.APP_GET_HOME, () => os.homedir());
  ipcMain.handle(IPC.APP_CHECK_UPDATE, async (_e, force?: boolean) => {
    return checkForUpdate(!!force);
  });
  ipcMain.handle(IPC.APP_OPEN_EXTERNAL, async (_e, url: string) => {
    // Whitelist scheme — never let arbitrary file:// or javascript: URLs
    // sneak through the bridge. http(s) only is enough for "open the
    // release page" + "download the DMG".
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    } catch {
      return false;
    }
    await shell.openExternal(url);
    return true;
  });
}
