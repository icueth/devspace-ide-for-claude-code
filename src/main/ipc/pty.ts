import { ipcMain } from 'electron';

import { launchClaudeCli, launchShell } from '@main/services/ClaudeCliLauncher';
import {
  createPty,
  killPty,
  resizePty,
  subscribe,
  writeToPty,
} from '@main/services/PtyPool';
import { IPC } from '@shared/ipc-channels';
import { createLogger } from '@shared/logger';
import type { PtyCreateOptions, PtySession } from '@shared/types';

const logger = createLogger('IPC:pty');

export function registerPtyIpc(): void {
  ipcMain.handle(
    IPC.PTY_CREATE,
    async (event, opts: PtyCreateOptions): Promise<PtySession> => {
      if (!opts || !opts.projectId || !opts.cwd) {
        throw new Error('PTY_CREATE requires projectId + cwd');
      }

      let session: PtySession;
      if (opts.kind === 'claude-cli') {
        session = await launchClaudeCli({
          projectId: opts.projectId,
          tabId: opts.tabId,
          cwd: opts.cwd,
          cols: opts.cols,
          rows: opts.rows,
        });
      } else if (opts.kind === 'shell') {
        session = await launchShell({
          projectId: opts.projectId,
          cwd: opts.cwd,
          cols: opts.cols,
          rows: opts.rows,
        });
      } else {
        session = await createPty(opts);
      }

      subscribe(session.sessionId, event.sender);
      return session;
    },
  );

  ipcMain.handle(IPC.PTY_WRITE, async (_e, sessionId: string, data: string) => {
    if (typeof data !== 'string') throw new Error('PTY_WRITE expects string data');
    writeToPty(sessionId, data);
  });

  ipcMain.handle(
    IPC.PTY_RESIZE,
    async (_e, sessionId: string, cols: number, rows: number) => {
      resizePty(sessionId, cols, rows);
    },
  );

  ipcMain.handle(IPC.PTY_KILL, async (_e, sessionId: string) => {
    logger.info(`kill requested for ${sessionId}`);
    killPty(sessionId);
  });
}
