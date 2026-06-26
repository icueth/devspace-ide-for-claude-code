import { ipcMain } from 'electron';

import {
  deleteAuthProfile,
  listAuthProfiles,
  saveAuthProfile,
} from '@main/services/ClaudeAuthService';
import { IPC } from '@shared/ipc-channels';

// Per-session claude auth profiles. Keys never cross to the renderer — list
// returns sanitized profiles (see ClaudeAuthService.sanitize); save takes the
// raw key (blank keeps the stored one).
export function registerClaudeAuthIpc(): void {
  ipcMain.handle(IPC.CLAUDE_AUTH_LIST, () => listAuthProfiles());

  ipcMain.handle(
    IPC.CLAUDE_AUTH_SAVE,
    (
      _e,
      input: {
        id?: string;
        name: string;
        apiKey: string;
        baseUrl?: string;
        authToken?: string;
      },
    ) => saveAuthProfile(input),
  );

  ipcMain.handle(IPC.CLAUDE_AUTH_DELETE, (_e, id: string) =>
    deleteAuthProfile(id),
  );
}
