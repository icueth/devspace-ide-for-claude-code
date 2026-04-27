import { app, ipcMain } from 'electron';
import * as os from 'node:os';

import { IPC } from '@shared/ipc-channels';

export function registerAppIpc(): void {
  ipcMain.handle(IPC.APP_GET_VERSION, () => app.getVersion());
  ipcMain.handle(IPC.APP_GET_HOME, () => os.homedir());
}
