import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import type { TaskService } from '@main/services/TaskService';
import { assertInWorkspace } from '@main/utils/pathScope';

// chat→task bridge (beta.21). A bundled stdio MCP server — spawned by the
// main-chat claude CLI — relays create/list requests to this unix socket, so
// the agent can fork worktree-isolated tasks by tool call. The socket lives in
// the same process as TaskService; the MCP server is a thin relay. This module
// is electron-free on purpose so the request router stays unit-testable.

export function taskControlSocketPath(): string {
  return path.join(os.homedir(), '.devspace', 'task-control.sock');
}

// Upper bound on live tasks an agent may create through the bridge — a backstop
// against a runaway loop spawning worktrees without limit.
const MAX_ACTIVE_TASKS = 20;

type ControlReq = { op?: string; title?: unknown; repo?: unknown };
type ControlRes = {
  ok: boolean;
  error?: string;
  task?: unknown;
  tasks?: unknown;
};

// Pure request router — one JSON request → one JSON reply. Exported for tests.
export async function routeTaskControl(
  svc: Pick<TaskService, 'list' | 'create'>,
  req: ControlReq,
): Promise<ControlRes> {
  if (req?.op === 'list') {
    return {
      ok: true,
      tasks: svc.list().map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        branch: t.branch,
      })),
    };
  }
  if (req?.op === 'create') {
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
    // Defense-in-depth: only ever fork from a repo inside an open workspace —
    // the relay must not let the agent worktree an arbitrary path.
    await assertInWorkspace(repo);
    const t = await svc.create({ title, sourceRepoPath: repo, agent: 'claude' });
    return {
      ok: true,
      task: { id: t.id, title: t.title, status: t.status, branch: t.branch },
    };
  }
  return { ok: false, error: `unknown op: ${String(req?.op)}` };
}

// Bind the unix socket and relay newline-delimited JSON to routeTaskControl.
// `onCreated` lets the caller broadcast TASK_CHANGED after a successful create.
export function startTaskControlSocket(
  svc: TaskService,
  onCreated: () => void,
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
            res = await routeTaskControl(svc, req);
          } catch (e) {
            res = { ok: false, error: (e as Error).message };
          }
          if (res.ok && op === 'create') onCreated();
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
