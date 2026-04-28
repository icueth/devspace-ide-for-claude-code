import { spawn } from 'node:child_process';

import { ipcMain } from 'electron';

import {
  resolveTmuxBinary,
  tmuxSocketArgs,
} from '@main/services/ClaudeCliLauncher';
import {
  loadTmuxConfig,
  renderTmuxConfSnippet,
  saveTmuxConfig,
} from '@main/services/TmuxConfigService';
import { resolveInteractiveShellEnv } from '@main/utils/shellEnv';
import { IPC } from '@shared/ipc-channels';
import { createLogger } from '@shared/logger';
import type { TmuxConfig, TmuxPane, TmuxSession } from '@shared/types';

const logger = createLogger('IPC:tmux');

// Run a tmux command on DevSpace's dedicated socket. Always prefixes `-L
// <socketName>` so we never touch the user's default tmux server.
async function runTmux(args: string[]): Promise<string> {
  const env = await resolveInteractiveShellEnv();
  const bin = (await resolveTmuxBinary()) ?? 'tmux';
  const fullArgs = [...tmuxSocketArgs(), ...args];
  return new Promise((resolve, reject) => {
    const child = spawn(bin, fullArgs, { env });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        // "no server running" is expected when no tmux session exists yet.
        if (err.includes('no server running') || err.includes('no current client')) {
          resolve('');
          return;
        }
        reject(new Error(`tmux ${args.join(' ')} exit ${code}: ${err}`));
        return;
      }
      resolve(out);
    });
  });
}

const LIST_FMT =
  '#{pane_id}\t#{pane_index}\t#{pane_title}\t#{pane_current_command}\t#{pane_pid}\t#{pane_activity}\t#{pane_current_path}';

function parsePanes(raw: string): TmuxPane[] {
  const panes: TmuxPane[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const [paneId, paneIndex, title, command, pid, activity, cwd] = parts;
    panes.push({
      paneId,
      paneIndex: Number(paneIndex) || 0,
      title: title.trim(),
      command: command.trim(),
      pid: Number(pid) || 0,
      activity: Number(activity) || 0,
      cwd: cwd.trim(),
    });
  }
  return panes;
}

export function registerTmuxIpc(): void {
  // Eager-load the config cache so the first launcher call doesn't pay the I/O
  // cost. Failure here is non-fatal — defaults take over.
  void loadTmuxConfig();

  ipcMain.handle(
    IPC.TMUX_LIST_PANES,
    async (_e, sessionName?: string): Promise<TmuxPane[]> => {
      const args = sessionName
        ? ['list-panes', '-s', '-t', sessionName, '-F', LIST_FMT]
        : ['list-panes', '-a', '-F', LIST_FMT];
      logger.info(`list-panes: session="${sessionName ?? '<all>'}" args=${args.join(' ')}`);
      try {
        const raw = await runTmux(args);
        const parsed = parsePanes(raw);
        logger.info(`list-panes → ${parsed.length} panes`);
        return parsed;
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes("can't find session") || msg.includes('no session')) {
          return [];
        }
        logger.warn('list-panes failed:', msg);
        return [];
      }
    },
  );

  ipcMain.handle(
    IPC.TMUX_CAPTURE_PANE,
    async (_e, paneId: string, lines = 3): Promise<string> => {
      try {
        const raw = await runTmux(['capture-pane', '-p', '-t', paneId, '-S', `-${lines}`]);
        return raw.trimEnd();
      } catch (err) {
        logger.warn(`capture-pane ${paneId} failed:`, (err as Error).message);
        return '';
      }
    },
  );

  ipcMain.handle(IPC.TMUX_SELECT_PANE, async (_e, paneId: string): Promise<boolean> => {
    try {
      await runTmux(['select-pane', '-t', paneId]);
      return true;
    } catch (err) {
      logger.warn(`select-pane ${paneId} failed:`, (err as Error).message);
      return false;
    }
  });

  ipcMain.handle(
    IPC.TMUX_SEND_KEYS,
    async (_e, paneId: string, text: string, submit = true): Promise<boolean> => {
      try {
        const args = ['send-keys', '-t', paneId, text];
        if (submit) args.push('Enter');
        await runTmux(args);
        return true;
      } catch (err) {
        logger.warn(`send-keys ${paneId} failed:`, (err as Error).message);
        return false;
      }
    },
  );

  ipcMain.handle(IPC.TMUX_LIST_SESSIONS, async (): Promise<TmuxSession[]> => {
    const fmt =
      '#{session_name}\t#{session_id}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{session_activity}';
    try {
      const raw = await runTmux(['list-sessions', '-F', fmt]);
      return await parseSessions(raw);
    } catch (err) {
      logger.warn('list-sessions failed:', (err as Error).message);
      return [];
    }
  });

  ipcMain.handle(IPC.TMUX_KILL_SESSION, async (_e, name: string): Promise<boolean> => {
    if (!name) return false;
    try {
      await runTmux(['kill-session', '-t', name]);
      logger.info(`killed session ${name}`);
      return true;
    } catch (err) {
      logger.warn(`kill-session ${name} failed:`, (err as Error).message);
      return false;
    }
  });

  ipcMain.handle(
    IPC.TMUX_RENAME_SESSION,
    async (_e, oldName: string, newName: string): Promise<boolean> => {
      if (!oldName || !newName) return false;
      try {
        await runTmux(['rename-session', '-t', oldName, newName]);
        logger.info(`renamed session ${oldName} → ${newName}`);
        return true;
      } catch (err) {
        logger.warn(`rename-session ${oldName} failed:`, (err as Error).message);
        return false;
      }
    },
  );

  ipcMain.handle(IPC.TMUX_KILL_SERVER, async (): Promise<boolean> => {
    try {
      await runTmux(['kill-server']);
      logger.info('killed tmux server');
      return true;
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('no server running')) return true;
      logger.warn('kill-server failed:', msg);
      return false;
    }
  });

  ipcMain.handle(IPC.TMUX_GET_CONFIG, async (): Promise<TmuxConfig> => {
    return loadTmuxConfig();
  });

  ipcMain.handle(
    IPC.TMUX_SET_CONFIG,
    async (_e, next: TmuxConfig): Promise<TmuxConfig> => {
      return saveTmuxConfig(next);
    },
  );

  ipcMain.handle(IPC.TMUX_RENDER_CONF, async (_e, cfg: TmuxConfig): Promise<string> => {
    return renderTmuxConfSnippet(cfg);
  });

  ipcMain.handle(
    IPC.TMUX_RESOLVE_BINARY,
    async (): Promise<{ path: string | null; configured: string | null }> => {
      const cfg = await loadTmuxConfig();
      const resolved = await resolveTmuxBinary();
      return { path: resolved, configured: cfg.binaryPath };
    },
  );
}

function classifySession(
  name: string,
  sessionPrefix: string,
): {
  kind: TmuxSession['kind'];
  projectId: string | null;
  tabId: string | null;
} {
  // Build dynamic patterns honoring the configured prefix (default 'devspace').
  const escaped = sessionPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const claude = new RegExp(`^${escaped}-cli-([^-\\s]+)(?:-(.+))?$`).exec(name);
  if (claude) {
    return {
      kind: 'claude-cli',
      projectId: claude[1] ?? null,
      tabId: claude[2] ?? 'default',
    };
  }
  const shell = new RegExp(`^${escaped}-shell-([^-\\s]+)(?:-(.+))?$`).exec(name);
  if (shell) {
    return {
      kind: 'shell',
      projectId: shell[1] ?? null,
      tabId: shell[2] ?? 'default',
    };
  }
  return { kind: 'other', projectId: null, tabId: null };
}

async function parseSessions(raw: string): Promise<TmuxSession[]> {
  const cfg = await loadTmuxConfig();
  const sessions: TmuxSession[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 6) continue;
    const [name, id, windows, attached, created, activity] = parts;
    const cls = classifySession(name, cfg.sessionPrefix);
    sessions.push({
      name,
      id,
      windows: Number(windows) || 0,
      attached: Number(attached) > 0,
      created: Number(created) || 0,
      activity: Number(activity) || 0,
      kind: cls.kind,
      projectId: cls.projectId,
      tabId: cls.tabId,
    });
  }
  return sessions;
}
