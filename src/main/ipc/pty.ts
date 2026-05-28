import { ipcMain } from 'electron';

import { launchClaudeCli, launchShell } from '@main/services/ClaudeCliLauncher';
import {
  createPty,
  killPty,
  resizePty,
  setPinnedSessions,
  subscribe,
  writeToPty,
} from '@main/services/PtyPool';
import { assertInWorkspace } from '@main/utils/pathScope';
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

      // Confine the spawned shell/CLI to an open workspace — the renderer
      // supplies cwd and it must never point a PTY at an arbitrary directory.
      await assertInWorkspace(opts.cwd);

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
    await killPty(sessionId);
  });

  // v0.36.1: renderer pushes the set of pinned claude-cli session ids on
  // every change to its columns layout. Fire-and-forget (ipcMain.on, not
  // .handle) — no response is needed and we don't want a slow reaper tick
  // to block the renderer's next push.
  ipcMain.on(IPC.PTY_SET_PINNED, (_e, payload: unknown) => {
    if (!payload || typeof payload !== 'object') {
      setPinnedSessions([]);
      return;
    }
    const ids = (payload as { ids?: unknown }).ids;
    if (!Array.isArray(ids)) {
      setPinnedSessions([]);
      return;
    }
    setPinnedSessions(ids.filter((x): x is string => typeof x === 'string'));
  });
}
