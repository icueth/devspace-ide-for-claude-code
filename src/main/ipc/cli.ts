// CLI runtime detection IPC. Probes the installed CLI runtimes (currently
// just `claude`) via the adapter registry so the renderer can version-gate
// features behind the detected claude-code version.
//
// The old cli:profiles:* CRUD (alternative CLI runtimes like OpenCode) was
// removed when Chat mode went away — Terminal mode runs `claude` directly,
// so there is no longer a per-thread CLI runtime to configure.

import { ipcMain } from 'electron';

import { detectAll } from '@main/cli/registry';
import { IPC } from '@shared/ipc-channels';

export function registerCliIpc(): void {
  ipcMain.handle(IPC.CLI_DETECT, () => detectAll());
}
