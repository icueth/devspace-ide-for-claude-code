// v0.37: background-claude IPC. Wraps BackgroundClaudeRunner with input
// validation + a non-blocking surface so the renderer can fire spawns and
// poll logs without freezing on a long-running child.

import { ipcMain } from 'electron';

import {
  killBackgroundRun,
  listBackgroundRuns,
  readBackgroundRunLog,
  startBackgroundRun,
} from '@main/services/BackgroundClaudeRunner';
import { IPC } from '@shared/ipc-channels';

export function registerBgClaudeIpc(): void {
  ipcMain.handle(IPC.BG_CLAUDE_START, async (_e, command: unknown) => {
    if (typeof command !== 'string') {
      throw new Error('bg-claude:start: command must be a string');
    }
    return startBackgroundRun(command);
  });

  ipcMain.handle(IPC.BG_CLAUDE_LIST, () => listBackgroundRuns());

  ipcMain.handle(
    IPC.BG_CLAUDE_READ_LOG,
    async (_e, runId: unknown, offset: unknown) => {
      if (typeof runId !== 'string' || !runId.trim()) {
        throw new Error('bg-claude:read-log: runId is required');
      }
      const off =
        typeof offset === 'number' && Number.isFinite(offset) && offset >= 0
          ? Math.floor(offset)
          : 0;
      return readBackgroundRunLog(runId, off);
    },
  );

  ipcMain.handle(IPC.BG_CLAUDE_KILL, (_e, runId: unknown) => {
    if (typeof runId !== 'string' || !runId.trim()) {
      throw new Error('bg-claude:kill: runId is required');
    }
    return killBackgroundRun(runId);
  });
}
