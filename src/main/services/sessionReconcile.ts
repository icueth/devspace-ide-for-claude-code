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

// devspace-{cli|oc|cx|gm|ag}-<proj>-<tab> → the matching PtyPool key.
// A project id is 12 hex chars and never contains '-', so the FIRST '-' after
// the prefix splits project from tab unambiguously — and unlike splitting on
// the LAST '-', it survives a tab id that itself contains dashes. Agent Flow
// tabs are exactly that (`flow-<runId>-<nodeId>`): splitting on the last dash
// would derive `…-flow-<runId>:claude-cli:<nodeId>`, which matches no protected
// key, and boot reconcile would kill a live flow agent. Returns null for
// non-cli session names (shells, chat-runs) so the caller skips them.
export function tmuxNameToKey(name: string, sessionPrefix: string): string | null {
  const kinds = {
    cli: 'claude-cli',
    oc: 'opencode-cli',
    cx: 'codex-cli',
    gm: 'gemini-cli',
    ag: 'antigravity-cli',
  } as const;
  const match = Object.entries(kinds).find(([prefix]) =>
    name.startsWith(`${sessionPrefix}-${prefix}-`),
  );
  if (!match) return null;
  const [tmuxPrefix, kind] = match;
  const rest = name.slice(`${sessionPrefix}-${tmuxPrefix}-`.length);
  const dash = rest.indexOf('-');
  if (dash < 0) return `${rest}:${kind}:default`;
  return `${rest.slice(0, dash)}:${kind}:${rest.slice(dash + 1)}`;
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
  const [{ resolveTmuxBinary }, { getTmuxConfigSync }, { getActiveFlowSessionKeys }] =
    await Promise.all([
      import('@main/services/ClaudeCliLauncher'),
      import('@main/services/TmuxConfigService'),
      import('@main/services/FlowService'),
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

  // Protected beyond open tabs: live task agents AND live Agent Flow nodes.
  // Both run eagerly with no pane attached, so to the sweep they look exactly
  // like an orphan — killing one would take out a working agent mid-run.
  const taskKeys = await readLiveTaskKeys();
  for (const key of getActiveFlowSessionKeys()) taskKeys.add(key);
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
