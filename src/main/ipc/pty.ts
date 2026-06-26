import { BrowserWindow, ipcMain } from 'electron';

import {
  launchClaudeCli,
  launchCodexCli,
  launchGeminiCli,
  launchOpenCodeCli,
  launchShell,
} from '@main/services/ClaudeCliLauncher';
import { reconcileOrphanCliSessions } from '@main/services/sessionReconcile';
import {
  createPty,
  killClaudeCliSessionTree,
  killPty,
  killShellSessionTree,
  resizePty,
  restartClaudeCli,
  setPinnedSessions,
  subscribe,
  subscribeAndReplay,
  writeToPty,
} from '@main/services/PtyPool';
import { ensureTaskMcpRegistered } from '@main/services/taskMcpRegister';
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
          authProfileId: opts.authProfileId,
        });
        // Expose the task-creation MCP tool to this project's chat so the agent
        // can fork tasks by tool call. No-op for task worktrees (recursion
        // guard lives in ensureTaskMcpRegistered). Fire-and-forget — a config
        // write must never delay the pane.
        void ensureTaskMcpRegistered(opts.cwd);
      } else if (opts.kind === 'opencode-cli') {
        session = await launchOpenCodeCli({
          projectId: opts.projectId,
          tabId: opts.tabId,
          cwd: opts.cwd,
          cols: opts.cols,
          rows: opts.rows,
          cliProfileId: opts.cliProfileId,
        });
      } else if (opts.kind === 'codex-cli') {
        session = await launchCodexCli({
          projectId: opts.projectId,
          tabId: opts.tabId,
          cwd: opts.cwd,
          cols: opts.cols,
          rows: opts.rows,
          cliProfileId: opts.cliProfileId,
        });
      } else if (opts.kind === 'gemini-cli') {
        session = await launchGeminiCli({
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

      // Live streaming starts now; scrollback replay does NOT happen here —
      // the renderer pulls it via PTY_SUBSCRIBE after its data listener is
      // armed (a push from this handler would race the listener and drop).
      subscribe(session.sessionId, event.sender);
      return session;
    },
  );

  // Renderer-pulled scrollback replay: atomically (one main-side sync turn)
  // re-adds the sender as a subscriber and returns the rolling buffer, so
  // chunks emitted after the snapshot arrive only as PTY_DATA events.
  ipcMain.handle(
    IPC.PTY_SUBSCRIBE,
    async (event, sessionId: string): Promise<string> => {
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new Error('PTY_SUBSCRIBE requires a non-empty sessionId');
      }
      return subscribeAndReplay(sessionId, event.sender);
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

  // Full session-tree kill (PTY + tmux session). The tmux session name is
  // derived in MAIN from the naming helpers — a renderer-supplied session
  // name would let a compromised renderer kill arbitrary tmux sessions on
  // our socket. Runs even when the pool entry is missing: the PTY may have
  // exited while the detached tmux session (claude + MCP servers) persists.
  ipcMain.handle(
    IPC.PTY_KILL_SESSION,
    async (_e, projectId: string, tabId: string, kind: string) => {
      if (typeof projectId !== 'string' || projectId.length === 0) {
        throw new Error('PTY_KILL_SESSION requires a non-empty projectId');
      }
      if (typeof tabId !== 'string' || tabId.length === 0) {
        throw new Error('PTY_KILL_SESSION requires a non-empty tabId');
      }
      if (kind !== 'claude-cli' && kind !== 'shell') {
        throw new Error(`PTY_KILL_SESSION: unsupported kind "${String(kind)}"`);
      }
      logger.info(`session-tree kill requested for ${projectId}:${kind}:${tabId}`);
      if (kind === 'claude-cli') {
        await killClaudeCliSessionTree(projectId, tabId);
      } else {
        await killShellSessionTree(projectId, tabId);
      }
    },
  );

  // "Reload tab — respawn claude": PTY_KILL only detaches (the remounted
  // pane's `new-session -A` reattaches to the SAME claude), so a real
  // restart needs the session-tree kill before the pane respawns.
  ipcMain.handle(
    IPC.PTY_RESTART_CLAUDE,
    async (_e, projectId: string, tabId: string) => {
      if (typeof projectId !== 'string' || projectId.length === 0) {
        throw new Error('PTY_RESTART_CLAUDE requires a non-empty projectId');
      }
      if (typeof tabId !== 'string' || tabId.length === 0) {
        throw new Error('PTY_RESTART_CLAUDE requires a non-empty tabId');
      }
      logger.info(`restart claude requested for ${projectId}:${tabId}`);
      await restartClaudeCli(projectId, tabId);
    },
  );

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

  // beta.25: the renderer pushes its FULL open-tab session set on boot + on tab
  // changes. The first push (once the renderer has hydrated its tabs) triggers a
  // one-shot boot reconcile that prunes claude-cli tmux sessions no open tab or
  // live task backs — orphans left by past runs / crashes. Keeps RAM bounded
  // without an auto-reaper (which the user keeps off). 4s debounce lets all tab
  // pushes settle first.
  ipcMain.on(IPC.PTY_SET_LIVE, (_e, payload: unknown) => {
    const ids =
      payload && typeof payload === 'object'
        ? (payload as { ids?: unknown }).ids
        : undefined;
    liveSessionKeys = Array.isArray(ids)
      ? new Set(ids.filter((x): x is string => typeof x === 'string'))
      : new Set();
    if (bootReconcileScheduled) return;
    bootReconcileScheduled = true;
    setTimeout(() => {
      void runBootReconcile();
    }, 4000);
  });
}

// Latest full open-tab session set reported by the renderer (boot reconcile
// keeps these + live tasks + currently-attached sessions, prunes the rest).
let liveSessionKeys = new Set<string>();
let bootReconcileScheduled = false;

async function runBootReconcile(): Promise<void> {
  try {
    const killed = await reconcileOrphanCliSessions(liveSessionKeys);
    if (killed.length === 0) return;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.PTY_AUTO_CLOSED, {
          ids: killed,
          thresholdMinutes: 0,
        });
      }
    }
  } catch (err) {
    logger.warn(`boot reconcile failed: ${(err as Error).message}`);
  }
}
