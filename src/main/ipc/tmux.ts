import { spawn } from 'node:child_process';

import { ipcMain } from 'electron';

import { resolveInteractiveShellEnv } from '@main/utils/shellEnv';
import { IPC } from '@shared/ipc-channels';
import { createLogger } from '@shared/logger';
import type { TmuxPane } from '@shared/types';

const logger = createLogger('IPC:tmux');

// Run a tmux command and collect stdout. Uses the default tmux server
// (whatever socket Claude CLI's spawned tmux uses, which is typically the
// user's default) — we don't try to be clever about sockets. If no tmux
// server is running the command exits with non-zero and we return empty.
async function runTmux(args: string[]): Promise<string> {
  const env = await resolveInteractiveShellEnv();
  return new Promise((resolve, reject) => {
    const child = spawn('tmux', args, { env });
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

// Format string mirrors the fields we need on TmuxPane. Using tab as the
// delimiter is safe because none of the fields can contain tabs.
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
  ipcMain.handle(
    IPC.TMUX_LIST_PANES,
    async (_e, sessionName?: string): Promise<TmuxPane[]> => {
      // Scope to the given session (`-t <name>`) when provided; otherwise
      // fall back to `-a` so the rail works even if we can't guess the
      // session name for some reason.
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
        // `session not found` is expected before Claude CLI spawns a team.
        const msg = (err as Error).message;
        if (msg.includes("can't find session") || msg.includes('no session')) {
          return [];
        }
        logger.warn('list-panes failed:', msg);
        return [];
      }
    },
  );

  // Capture the last N lines of a specific pane (default 3). Pattern used for
  // the preview strip in the Agents rail. Empty string if pane gone.
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

  // Select a pane from outside the tmux client. The CLI pane rendering inside
  // devspace doesn't own the tmux attach — those panes run as children of the
  // Claude CLI process — so we have to speak to the tmux server over its
  // socket, not pipe the command through our xterm PTY (which would just type
  // it as text into the Claude prompt).
  ipcMain.handle(IPC.TMUX_SELECT_PANE, async (_e, paneId: string): Promise<boolean> => {
    try {
      await runTmux(['select-pane', '-t', paneId]);
      return true;
    } catch (err) {
      logger.warn(`select-pane ${paneId} failed:`, (err as Error).message);
      return false;
    }
  });

  // Type a message into a pane followed by Enter — lets the user dispatch to
  // any agent without stealing focus first.
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
}
