import { ipcMain } from 'electron';

import {
  listSettings,
  readSettingsFile,
  writeSettingsFile,
} from '@main/services/SettingsService';
import { IPC } from '@shared/ipc-channels';

export function registerSettingsIpc(): void {
  ipcMain.handle(IPC.SETTINGS_LIST, async (_e, projectPath: string | null) => {
    const p = typeof projectPath === 'string' && projectPath.length > 0
      ? projectPath
      : null;
    return listSettings(p);
  });

  ipcMain.handle(IPC.SETTINGS_READ, async (_e, filePath: string) => {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new Error('SETTINGS_READ requires a file path');
    }
    return readSettingsFile(filePath);
  });

  ipcMain.handle(
    IPC.SETTINGS_WRITE,
    async (_e, filePath: string, content: string) => {
      if (typeof filePath !== 'string' || filePath.length === 0) {
        throw new Error('SETTINGS_WRITE requires a file path');
      }
      if (typeof content !== 'string') {
        throw new Error('SETTINGS_WRITE requires string content');
      }
      await writeSettingsFile(filePath, content);
    },
  );
}
