import { ipcMain } from 'electron';

import { mempalaceData } from '@main/services/MemPalaceDataService';
import { IPC } from '@shared/ipc-channels';
import type {
  MemPalaceListDrawersInput,
  MemPalaceListTriplesInput,
} from '@shared/mempalaceData';

/**
 * Wires the renderer-side {@link window.devspace.mempalaceData} namespace.
 * All handlers are pure reads — they cannot mutate the vault. Errors are
 * surfaced as rejected promises so the dashboard can show "vault
 * unavailable" with a reason instead of throwing in render.
 */
export function registerMempalaceDataIpc(): void {
  ipcMain.handle(IPC.MEMPALACE_DATA_GET_OVERVIEW, () => mempalaceData.getOverview());
  ipcMain.handle(IPC.MEMPALACE_DATA_LIST_WINGS, () => mempalaceData.listWings());
  ipcMain.handle(IPC.MEMPALACE_DATA_LIST_ROOMS, (_e, wing: string) =>
    mempalaceData.listRoomsForWing(wing),
  );
  ipcMain.handle(
    IPC.MEMPALACE_DATA_LIST_DRAWERS,
    (_e, input: MemPalaceListDrawersInput | undefined) => mempalaceData.listDrawers(input ?? {}),
  );
  ipcMain.handle(
    IPC.MEMPALACE_DATA_LIST_TRIPLES,
    (_e, input: MemPalaceListTriplesInput | undefined) => mempalaceData.listTriples(input ?? {}),
  );
  ipcMain.handle(IPC.MEMPALACE_DATA_INVALIDATE, () => {
    mempalaceData.invalidate();
  });
}
