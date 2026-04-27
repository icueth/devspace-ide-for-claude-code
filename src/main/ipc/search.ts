import { ipcMain } from 'electron';

import { grepProject } from '@main/services/SearchService';
import { IPC } from '@shared/ipc-channels';
import type { SearchOptions } from '@shared/types';

export function registerSearchIpc(): void {
  ipcMain.handle(
    IPC.SEARCH_GREP,
    async (_e, cwd: string, query: string, opts?: SearchOptions) =>
      grepProject(cwd, query, opts ?? {}),
  );
}
