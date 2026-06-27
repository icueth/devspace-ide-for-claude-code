import { ipcMain } from 'electron';

import { runClaudeSetup } from '@main/services/ClaudeSetupRunner';
import { subscribe as subscribePty } from '@main/services/PtyPool';
import {
  getStatus,
  installAllMissing,
  installEverything,
  installTool,
  openSettingsDir,
  subscribeSetup,
  uninstallRtkHookPublic,
} from '@main/services/SetupService';
import { IPC } from '@shared/ipc-channels';
import { createLogger } from '@shared/logger';
import type { SetupClaudeRunResult, SetupToolId } from '@shared/setup';

const logger = createLogger('IPC:setup');

export function registerSetupIpc(): void {
  ipcMain.handle(IPC.SETUP_GET_STATUS, async (event) => {
    subscribeSetup(event.sender);
    return getStatus();
  });

  ipcMain.handle(IPC.SETUP_INSTALL_TOOL, async (event, toolId: SetupToolId) => {
    subscribeSetup(event.sender);
    try {
      return await installTool(toolId);
    } catch (err) {
      logger.error(`installTool(${toolId}) failed:`, (err as Error).message);
      throw err;
    }
  });

  ipcMain.handle(IPC.SETUP_INSTALL_ALL, async (event) => {
    subscribeSetup(event.sender);
    try {
      return await installAllMissing();
    } catch (err) {
      logger.error('installAllMissing failed:', (err as Error).message);
      throw err;
    }
  });

  ipcMain.handle(IPC.SETUP_INSTALL_EVERYTHING, async (event) => {
    subscribeSetup(event.sender);
    try {
      return await installEverything();
    } catch (err) {
      logger.error('installEverything failed:', (err as Error).message);
      throw err;
    }
  });

  ipcMain.handle(IPC.SETUP_UNINSTALL_RTK_HOOK, async (event) => {
    subscribeSetup(event.sender);
    try {
      return await uninstallRtkHookPublic();
    } catch (err) {
      logger.error('uninstallRtkHook failed:', (err as Error).message);
      throw err;
    }
  });

  ipcMain.handle(IPC.SETUP_OPEN_CLAUDE_DIR, async () => {
    await openSettingsDir();
  });

  ipcMain.handle(
    IPC.SETUP_RUN_CLAUDE,
    async (
      event,
      opts: { cols?: number; rows?: number } = {},
    ): Promise<SetupClaudeRunResult> => {
      try {
        const result = await runClaudeSetup({
          cols: opts.cols,
          rows: opts.rows,
        });
        if (!result.ok || !result.session) {
          return { ok: false, error: result.error };
        }
        // Subscribe the renderer's webContents so it receives pty:data /
        // pty:exit events for the spawned setup session.
        subscribePty(result.session.sessionId, event.sender);
        return { ok: true, sessionId: result.session.sessionId };
      } catch (err) {
        logger.error('runClaudeSetup failed:', (err as Error).message);
        return { ok: false, error: (err as Error).message };
      }
    },
  );
}
