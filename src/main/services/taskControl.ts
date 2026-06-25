import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import type { TaskService } from '@main/services/TaskService';
import { assertInWorkspace } from '@main/utils/pathScope';
import type { Task } from '@shared/types';

// chat→task bridge (beta.21–23). A bundled stdio MCP server — spawned by the
// main-chat claude CLI — relays orchestration ops to this unix socket so the
// agent can create / monitor / drive / integrate worktree-isolated tasks by tool
// call. The socket lives in the same process as TaskService; the MCP server is a
// thin relay. This module is electron-free so the request router stays
// unit-testable; PtyPool / git side-effects are injected as deps.

export function taskControlSocketPath(): string {
  return path.join(os.homedir(), '.devspace', 'task-control.sock');
}

// Upper bound on live tasks an agent may create through the bridge — a backstop
// against a runaway loop spawning worktrees without limit.
const MAX_ACTIVE_TASKS = 20;

// The subset of TaskService the router drives.
type RouterSvc = Pick<TaskService, 'list' | 'create' | 'merge' | 'discard'>;

// Side-effects injected by the IPC layer (kept out so the router is testable).
export interface TaskControlDeps {
  // Type text into a task agent's live PTY (a follow-up instruction).
  sendToSession: (sessionKey: string, text: string) => void;
  // Compute the task's worktree diff vs its base branch (capped upstream).
  diffOf: (task: Task) => Promise<string>;
}

type ControlReq = {
  op?: string;
  id?: unknown;
  title?: unknown;
  repo?: unknown;
  text?: unknown;
  prompt?: unknown;
};
type ControlRes = {
  ok: boolean;
  error?: string;
  task?: unknown;
  tasks?: unknown;
  diff?: string;
};

// Ops that mutate the task list and should trigger a TASK_CHANGED broadcast.
const BROADCAST_OPS = new Set(['create', 'merge', 'discard']);

function slim(t: Task) {
  return { id: t.id, title: t.title, status: t.status, branch: t.branch };
}

// Pure request router — one JSON request → one JSON reply. Exported for tests.
export async function routeTaskControl(
  svc: RouterSvc,
  deps: TaskControlDeps,
  req: ControlReq,
): Promise<ControlRes> {
  const findTask = (): Task | undefined =>
    typeof req.id === 'string' ? svc.list().find((t) => t.id === req.id) : undefined;

  switch (req?.op) {
    case 'list':
      return { ok: true, tasks: svc.list().map(slim) };

    case 'get': {
      const t = findTask();
      return t ? { ok: true, task: slim(t) } : { ok: false, error: 'task not found' };
    }

    case 'create': {
      const title = typeof req.title === 'string' ? req.title.trim() : '';
      const repo = typeof req.repo === 'string' ? req.repo : '';
      if (!title) return { ok: false, error: 'title required' };
      if (!repo) return { ok: false, error: 'repo required' };
      const active = svc
        .list()
        .filter((t) => t.status !== 'done' && t.status !== 'discarded').length;
      if (active >= MAX_ACTIVE_TASKS) {
        return { ok: false, error: `task limit reached (${MAX_ACTIVE_TASKS} active)` };
      }
      const prompt = typeof req.prompt === 'string' ? req.prompt : undefined;
      // Defense-in-depth: only ever fork from a repo inside an open workspace.
      await assertInWorkspace(repo);
      const t = await svc.create({
        title,
        sourceRepoPath: repo,
        agent: 'claude',
        prompt,
      });
      return { ok: true, task: slim(t) };
    }

    case 'changes': {
      const t = findTask();
      if (!t) return { ok: false, error: 'task not found' };
      return { ok: true, diff: await deps.diffOf(t) };
    }

    case 'send': {
      const t = findTask();
      if (!t) return { ok: false, error: 'task not found' };
      const text = typeof req.text === 'string' ? req.text : '';
      if (!text.trim()) return { ok: false, error: 'text required' };
      deps.sendToSession(t.sessionKey, text);
      return { ok: true };
    }

    case 'merge': {
      const t = findTask();
      if (!t) return { ok: false, error: 'task not found' };
      await svc.merge(t.id);
      return { ok: true };
    }

    case 'discard': {
      const t = findTask();
      if (!t) return { ok: false, error: 'task not found' };
      await svc.discard(t.id);
      return { ok: true };
    }

    default:
      return { ok: false, error: `unknown op: ${String(req?.op)}` };
  }
}

// Bind the unix socket and relay newline-delimited JSON to routeTaskControl.
// `onMutate` broadcasts TASK_CHANGED after a create/merge/discard.
export function startTaskControlSocket(
  svc: TaskService,
  onMutate: () => void,
  deps: TaskControlDeps,
): void {
  const sockPath = taskControlSocketPath();
  try {
    fs.mkdirSync(path.dirname(sockPath), { recursive: true });
    fs.rmSync(sockPath, { force: true }); // clear a stale socket left by a crash
  } catch {
    /* best-effort — listen() below will surface a real bind failure */
  }

  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        void (async () => {
          let res: ControlRes;
          let op: unknown;
          try {
            const req = JSON.parse(line) as ControlReq;
            op = req?.op;
            res = await routeTaskControl(svc, deps, req);
          } catch (e) {
            res = { ok: false, error: (e as Error).message };
          }
          if (res.ok && typeof op === 'string' && BROADCAST_OPS.has(op)) onMutate();
          if (!conn.destroyed) conn.write(`${JSON.stringify(res)}\n`);
        })();
      }
    });
    conn.on('error', () => undefined);
  });

  server.on('error', (e) => {
    console.error('[tasks] control socket error:', (e as Error).message);
  });
  server.listen(sockPath);
  // Never keep the process alive at shutdown on account of the socket.
  server.unref();
}
