// CLI runtime detection + per-provider profile CRUD IPC. Probes installed CLI
// runtimes (claude, opencode) via the adapter registry, and manages CliProfiles
// (custom OpenAI-compatible providers) for non-claude CLIs like OpenCode.
//
// Keys never cross to the renderer — list/save return sanitized profiles
// (see CliProfileService.sanitize); save takes the raw key (blank keeps it).

import { ipcMain } from 'electron';

import { detectAll } from '@main/cli/registry';
import {
  deleteCliProfile,
  listCliProfiles,
  saveCliProfile,
} from '@main/services/CliProfileService';
import { IPC } from '@shared/ipc-channels';
import type { CliId } from '@shared/types';

export function registerCliIpc(): void {
  ipcMain.handle(IPC.CLI_DETECT, () => detectAll());

  ipcMain.handle(IPC.CLI_PROFILE_LIST, (_e, cliId?: CliId) =>
    listCliProfiles(cliId),
  );

  ipcMain.handle(
    IPC.CLI_PROFILE_SAVE,
    (
      _e,
      input: {
        id?: string;
        name: string;
        cliId: Exclude<CliId, 'claude'>;
        baseURL: string;
        apiKey: string;
        model: string;
      },
    ) => saveCliProfile(input),
  );

  ipcMain.handle(IPC.CLI_PROFILE_DELETE, (_e, id: string) =>
    deleteCliProfile(id),
  );
}
