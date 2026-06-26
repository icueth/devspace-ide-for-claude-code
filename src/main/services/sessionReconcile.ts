import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

// Electron-touching deps (resolveTmuxBinary → PtyPool → electron) are imported
// lazily inside reconcileOrphanCliSessions so the pure helpers below stay
// unit-testable in a node env.

const pexec = promisify(execFile);

export interface CliTmuxSession {
  name: string; // tmux session name, e.g. devspace-cli-<proj>-<tab>
  key: string; // PtyPool session key, e.g. <proj>:claude-cli:<tab>
  attached: boolean;
}

// devspace-cli-<proj>-<tab>  → <proj>:claude-cli:<tab>
// devspace-cli-<proj>        → <proj>:claude-cli:default
// project ids (hex) and tab ids (base36) never contain '-', so the LAST '-'
// after the prefix splits project from tab unambiguously. Returns null for
// non-cli session names (shells, chat-runs) so the caller skips them.
export function tmuxNameToKey(name: string, sessionPrefix: string): string | null {
  const p = `${sessionPrefix}-cli-`;
  if (!name.startsWith(p)) return null;
  const rest = name.slice(p.length);
  const dash = rest.lastIndexOf('-');
  if (dash < 0) return `${rest}:claude-cli:default`;
  return `${rest.slice(0, dash)}:claude-cli:${rest.slice(dash + 1)}`;
}

// Pure, safety-critical selection: a session is an orphan ONLY when it is not
// currently attached, not backed by an open dock tab (liveKeys), and not a live
// task agent (taskKeys). Anything in doubt is kept. Returns names to kill.
export function selectOrphans(
  sessions: CliTmuxSession[],
  liveKeys: Set<string>,
  taskKeys: Set<string>,
): string[] {
  return sessions
    .filter((s) => !s.attached && !liveKeys.has(s.key) && !taskKeys.has(s.key))
    .map((s) => s.name);
}

// Read the session keys of tasks that are still alive (their agent must survive
// reconcile even when no detail pane is attached — they run eagerly).
async function readLiveTaskKeys(): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const file = path.join(os.homedir(), '.devspace', 'tasks.json');
    const data = JSON.parse(await fs.promises.readFile(file, 'utf8')) as {
      tasks?: Array<{ sessionKey?: string; status?: string }>;
    };
    for (const t of data.tasks ?? []) {
      if (t.sessionKey && t.status !== 'done' && t.status !== 'discarded') {
        out.add(t.sessionKey);
      }
    }
  } catch {
    /* no tasks.json / parse error → no task keys to protect */
  }
  return out;
}

// Boot reconcile: kill claude-cli tmux sessions that no open tab or live task
// is backing (orphans left by past runs / crashes). `liveKeys` is the renderer's
// full set of open-tab session keys. Returns the killed session names.
export async function reconcileOrphanCliSessions(
  liveKeys: Set<string>,
): Promise<string[]> {
  const [{ resolveTmuxBinary }, { getTmuxConfigSync }] = await Promise.all([
    import('@main/services/ClaudeCliLauncher'),
    import('@main/services/TmuxConfigService'),
  ]);

  const tmuxBin = await resolveTmuxBinary();
  if (!tmuxBin) return [];
  const cfg = getTmuxConfigSync();
  const prefix = cfg.sessionPrefix;

  let sessions: CliTmuxSession[];
  try {
    const { stdout } = await pexec(tmuxBin, [
      '-L',
      cfg.socketName,
      'list-sessions',
      '-F',
      '#{session_attached} #{session_name}',
    ]);
    sessions = stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const sp = line.indexOf(' ');
        const name = line.slice(sp + 1);
        return {
          name,
          attached: line.slice(0, sp) !== '0',
          key: tmuxNameToKey(name, prefix),
        };
      })
      .filter((s): s is CliTmuxSession => s.key !== null);
  } catch {
    return []; // no tmux server / no sessions
  }

  const taskKeys = await readLiveTaskKeys();
  const orphans = selectOrphans(sessions, liveKeys, taskKeys);
  for (const name of orphans) {
    await pexec(tmuxBin, ['-L', cfg.socketName, 'kill-session', '-t', name]).catch(
      () => undefined,
    );
  }
  if (orphans.length) {
    console.log(
      `[SessionReconcile] boot reconcile: closed ${orphans.length} orphan cli session(s) (no open tab / task)`,
    );
  }
  return orphans;
}
