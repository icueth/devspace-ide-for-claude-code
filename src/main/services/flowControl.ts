// chat→flow bridge. The mirror of taskControl, on its own socket: the bundled
// stdio MCP server (resources/task-mcp/server.mjs) relays the lead agent's
// run_flow / flow_status / send_flow / stop_flow tool calls here, and this
// module drives FlowService. Chat is the ONLY way to start a run — the canvas
// designs and monitors, it has no Run button.
//
// Electron-free on purpose so routeFlowControl stays unit-testable with a
// mocked service (no sockets, no PTYs, no fs).

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import type { FlowService } from '@main/services/FlowService';
import { assertInWorkspace } from '@main/utils/pathScope';
import type { FlowGraph, FlowRun } from '@shared/flowTypes';

export function flowControlSocketPath(): string {
  return path.join(os.homedir(), '.devspace', 'flow-control.sock');
}

// The subset of FlowService the router drives.
type RouterSvc = Pick<
  FlowService,
  'list' | 'runs' | 'runFlow' | 'stopRun' | 'sendToNode' | 'getRun'
>;

export interface FlowControlReq {
  op?: string;
  repo?: unknown;
  flow?: unknown;
  task?: unknown;
  runId?: unknown;
  node?: unknown;
  text?: unknown;
}

export interface FlowControlRes {
  ok: boolean;
  error?: string;
  flows?: unknown;
  runs?: unknown;
  run?: unknown;
  runId?: string;
}

// Ops that change a run and should trigger a FLOW_CHANGED broadcast. `run` is
// absent: FlowService already pushes every transition through onRunChanged.
const BROADCAST_OPS = new Set(['stop']);

// Per-node output tail in `status` — enough for the lead agent to see what a
// node produced without dragging a 20k-char transcript through the tool reply.
const TAIL = 2_000;

function slimFlow(f: FlowGraph): unknown {
  return {
    id: f.id,
    name: f.name,
    description: f.description,
    nodes: f.nodes.map((n) => ({ id: n.id, role: n.role, cli: n.cliId, mode: n.mode })),
    edges: f.edges,
  };
}

function slimRun(r: FlowRun): unknown {
  return {
    runId: r.id,
    flow: r.flowName,
    status: r.status,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    error: r.error,
    nodes: r.nodes.map((n) => ({ node: n.nodeId, status: n.status })),
  };
}

function fullRun(r: FlowRun): unknown {
  return {
    runId: r.id,
    flow: r.flowName,
    status: r.status,
    task: r.task,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    error: r.error,
    nodes: r.nodes.map((n) => ({
      node: n.nodeId,
      status: n.status,
      error: n.error,
      output: n.output ? n.output.slice(-TAIL) : undefined,
    })),
  };
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Pure request router — one JSON request → one JSON reply. Every repo-bearing
 * op passes assertInWorkspace first: `repo` arrives from an MCP client we do
 * not control, so it is never trusted as a path.
 */
export async function routeFlowControl(
  svc: RouterSvc,
  req: FlowControlReq,
): Promise<FlowControlRes> {
  switch (req?.op) {
    case 'list': {
      const repo = str(req.repo);
      if (!repo) return { ok: false, error: 'repo required' };
      const dir = await assertInWorkspace(repo);
      return { ok: true, flows: (await svc.list(dir)).map(slimFlow) };
    }

    case 'runs': {
      const repo = str(req.repo);
      if (!repo) return { ok: false, error: 'repo required' };
      const dir = await assertInWorkspace(repo);
      return { ok: true, runs: (await svc.runs(dir)).map(slimRun) };
    }

    case 'run': {
      const repo = str(req.repo);
      const flow = str(req.flow);
      const task = str(req.task);
      if (!repo) return { ok: false, error: 'repo required' };
      if (!flow) return { ok: false, error: 'flow required' };
      if (!task) return { ok: false, error: 'task required' };
      const dir = await assertInWorkspace(repo);
      const res = await svc.runFlow(dir, flow, task);
      return res.ok ? { ok: true, runId: res.runId } : { ok: false, error: res.error };
    }

    case 'status': {
      const runId = str(req.runId);
      if (!runId) return { ok: false, error: 'runId required' };
      const run = svc.getRun(runId);
      // Only live runs are held in memory; a finished run is on disk under the
      // project, which `runs {repo}` lists.
      if (!run) return { ok: false, error: `run not found or already finished: ${runId}` };
      return { ok: true, run: fullRun(run) };
    }

    case 'send': {
      const runId = str(req.runId);
      const node = str(req.node);
      const text = typeof req.text === 'string' ? req.text : '';
      if (!runId) return { ok: false, error: 'runId required' };
      if (!node) return { ok: false, error: 'node required' };
      if (!text.trim()) return { ok: false, error: 'text required' };
      return svc.sendToNode(runId, node, text);
    }

    case 'stop': {
      const runId = str(req.runId);
      if (!runId) return { ok: false, error: 'runId required' };
      return svc.stopRun(runId);
    }

    default:
      return { ok: false, error: `unknown op: ${String(req?.op)}` };
  }
}

/**
 * Bind the unix socket and relay newline-delimited JSON to routeFlowControl.
 * Same wire shape as taskControl (one JSON line in, one JSON line out).
 */
export function startFlowControlSocket(
  svc: RouterSvc,
  onMutate: () => void,
): void {
  const sockPath = flowControlSocketPath();
  try {
    fs.mkdirSync(path.dirname(sockPath), { recursive: true });
    fs.rmSync(sockPath, { force: true }); // clear a stale socket left by a crash
  } catch {
    /* best-effort — listen() below surfaces a real bind failure */
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
          let res: FlowControlRes;
          let op: unknown;
          try {
            const req = JSON.parse(line) as FlowControlReq;
            op = req?.op;
            res = await routeFlowControl(svc, req);
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
    console.error('[flows] control socket error:', (e as Error).message);
  });
  server.listen(sockPath);
  server.unref(); // never keep the process alive at shutdown
}
