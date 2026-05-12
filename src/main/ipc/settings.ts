import { ipcMain } from 'electron';

import {
  listSettings,
  readSettingsFile,
  writeSettingsFile,
} from '@main/services/SettingsService';
import { listWorkspaces } from '@main/services/WorkspaceService';
import { assertAllowedSettingsPath } from '@main/utils/pathScope';
import { IPC } from '@shared/ipc-channels';

async function activeProjectPath(): Promise<string | null> {
  const { active } = await listWorkspaces();
  return active?.path ?? null;
}

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
    const safe = assertAllowedSettingsPath(filePath, await activeProjectPath());
    return readSettingsFile(safe);
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
      const safe = assertAllowedSettingsPath(filePath, await activeProjectPath());
      await writeSettingsFile(safe, content);
    },
  );
}
