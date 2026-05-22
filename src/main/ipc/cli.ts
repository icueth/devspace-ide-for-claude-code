// CLI multi-runtime IPC. Wires:
//   - cli:profiles:list   → CliProfilesService.listProfiles
//   - cli:profiles:upsert → CliProfilesService.upsertProfile
//   - cli:profiles:delete → CliProfilesService.deleteProfile
//   - cli:detect          → registry.detectAll()
//
// Renderer payloads are NEVER trusted — we re-validate at the boundary
// even though CliProfilesService already validates. Defense in depth so
// a misbehaving renderer can't spam a malformed object into the service
// (the service would throw, but the IPC layer surface should give a
// clearer diagnostic).

import { ipcMain } from 'electron';

import { detectAll } from '@main/cli/registry';
import {
  deleteProfile,
  listProfiles,
  upsertProfile,
} from '@main/services/CliProfilesService';
import { IPC } from '@shared/ipc-channels';
import type { CliProfile } from '@shared/types';

export function registerCliIpc(): void {
  ipcMain.handle(IPC.CLI_PROFILES_LIST, () => listProfiles());

  ipcMain.handle(
    IPC.CLI_PROFILES_UPSERT,
    (_event, payload: Partial<CliProfile>) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('cli:profiles:upsert: payload must be a JSON object');
      }
      // Hand off to the service for the heavy validation (URL safety,
      // length caps, allowed cli ids). Returning the saved profile
      // round-trips it to the renderer so the form can re-bind to the
      // normalized fields.
      return upsertProfile(payload);
    },
  );

  ipcMain.handle(IPC.CLI_PROFILES_DELETE, (_event, id: string) => {
    if (typeof id !== 'string' || !id.trim()) {
      throw new Error('cli:profiles:delete: id must be a non-empty string');
    }
    return deleteProfile(id);
  });

  ipcMain.handle(IPC.CLI_DETECT, () => detectAll());
}
