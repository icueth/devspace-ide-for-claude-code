import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Exercises the bundled stdio MCP server end-to-end (real child process +
// real unix socket), so the JSON-RPC protocol and the control-socket relay are
// verified without needing a live claude CLI.
const SCRIPT = path.resolve(process.cwd(), 'resources/task-mcp/server.mjs');

let sockPath: string;
let socketServer: net.Server;
let received: Array<Record<string, unknown>>;

beforeEach(async () => {
  received = [];
  sockPath = path.join(
    os.tmpdir(),
    `tc-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
  );
  socketServer = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (d) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl));
      received.push(req);
      let reply: Record<string, unknown>;
      if (req.op === 'create') {
        reply = {
          ok: true,
          task: { id: 't1', title: req.title, status: 'running', branch: 'devspace/task/x' },
        };
      } else if (req.op === 'list') {
        reply = { ok: true, tasks: [{ id: 't1', title: 'X', status: 'running', branch: 'b' }] };
      } else if (req.op === 'changes') {
        reply = { ok: true, diff: '--- a\n+++ b\n+line' };
      } else {
        reply = { ok: true }; // merge / discard / send / get
      }
      conn.write(`${JSON.stringify(reply)}\n`);
    });
  });
  await new Promise<void>((r) => socketServer.listen(sockPath, r));
});

afterEach(() => {
  socketServer.close();
  try {
    fs.rmSync(sockPath, { force: true });
  } catch {
    /* ignore */
  }
});

function rpc(requests: object[]): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: {
        ...process.env,
        DEVSPACE_TASK_SOCK: sockPath,
        DEVSPACE_PROJECT_PATH: '/fake/repo',
      },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const out: Array<Record<string, unknown>> = [];
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) out.push(JSON.parse(line));
      }
    });
    child.on('error', reject);
    for (const r of requests) child.stdin.write(`${JSON.stringify(r)}\n`);
    setTimeout(() => {
      child.kill();
      resolve(out);
    }, 900);
  });
}

describe('task MCP server (stdio)', () => {
  // One bundled server, two subsystems: the task tools relay to the task socket,
  // the flow tools to the flow socket (DEVSPACE_FLOW_SOCK).
  it('handshakes and lists the task + flow tools', async () => {
    const out = await rpc([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]);
    const init = out.find((m) => m.id === 1) as { result: { serverInfo: { name: string } } };
    expect(init.result.serverInfo.name).toBe('devspace-tasks');
    const tools = out.find((m) => m.id === 2) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(tools.result.tools.map((t) => t.name).sort()).toEqual([
      'create_task',
      'discard_task',
      'flow_status',
      'list_flow_runs',
      'list_flows',
      'list_tasks',
      'merge_task',
      'run_flow',
      'send_flow',
      'send_task',
      'stop_flow',
      'task_changes',
    ]);
  });

  it('create_task relays to the control socket using the default repo', async () => {
    const out = await rpc([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'create_task', arguments: { title: 'Do X' } },
      },
    ]);
    expect(received.find((r) => r.op === 'create')).toMatchObject({
      op: 'create',
      title: 'Do X',
      repo: '/fake/repo',
    });
    const call = out.find((m) => m.id === 3) as {
      result: { content: Array<{ text: string }> };
    };
    expect(call.result.content[0].text).toMatch(/Task t1 — running/);
  });

  it('merge_task relays an op:merge for the given id', async () => {
    const out = await rpc([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'merge_task', arguments: { id: 't1' } },
      },
    ]);
    expect(received.find((r) => r.op === 'merge')).toMatchObject({ op: 'merge', id: 't1' });
    const call = out.find((m) => m.id === 4) as {
      result: { content: Array<{ text: string }> };
    };
    expect(call.result.content[0].text).toMatch(/Merged/);
  });
});

// The flow tools are the chat agent's only way to start an Agent Flow, and they
// must reach the FLOW socket — a misrouted run_flow would hit the task socket
// (an unknown op) and the user's flow would silently never start.
describe('flow MCP tools (stdio → flow socket)', () => {
  let flowSock: string;
  let flowServer: net.Server;
  let flowReceived: Array<Record<string, unknown>>;

  beforeEach(async () => {
    flowReceived = [];
    flowSock = path.join(
      os.tmpdir(),
      `fc-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
    );
    flowServer = net.createServer((conn) => {
      let buf = '';
      conn.on('data', (d) => {
        buf += d.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        const req = JSON.parse(buf.slice(0, nl));
        flowReceived.push(req);
        const reply =
          req.op === 'run'
            ? { ok: true, runId: 'r1' }
            : req.op === 'list'
              ? { ok: true, flows: [{ id: 'f1', name: 'feature-pipeline' }] }
              : { ok: true };
        conn.write(`${JSON.stringify(reply)}\n`);
      });
    });
    await new Promise<void>((r) => flowServer.listen(flowSock, r));
  });

  afterEach(() => {
    flowServer.close();
    try {
      fs.rmSync(flowSock, { force: true });
    } catch {
      /* ignore */
    }
  });

  function flowRpc(
    requests: object[],
    env: Record<string, string> = {},
  ): Promise<Array<Record<string, unknown>>> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [SCRIPT], {
        env: {
          ...process.env,
          DEVSPACE_TASK_SOCK: sockPath,
          DEVSPACE_FLOW_SOCK: flowSock,
          DEVSPACE_PROJECT_PATH: '/fake/repo',
          ...env,
        },
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      const out: Array<Record<string, unknown>> = [];
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d.toString('utf8');
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) out.push(JSON.parse(line));
        }
      });
      child.on('error', reject);
      for (const r of requests) child.stdin.write(`${JSON.stringify(r)}\n`);
      setTimeout(() => {
        child.kill();
        resolve(out);
      }, 900);
    });
  }

  it('run_flow relays op:run to the flow socket (never the task socket)', async () => {
    const out = await flowRpc([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'run_flow',
          arguments: { flow: 'feature-pipeline', task: 'add dark mode' },
        },
      },
    ]);
    expect(flowReceived.find((r) => r.op === 'run')).toMatchObject({
      op: 'run',
      flow: 'feature-pipeline',
      task: 'add dark mode',
      repo: '/fake/repo', // defaults to the current project
    });
    expect(received).toEqual([]); // the task socket saw nothing
    const call = out.find((m) => m.id === 2) as {
      result: { content: Array<{ text: string }> };
    };
    // The reply must hand the lead agent the runId AND tell it to monitor.
    expect(call.result.content[0].text).toMatch(/runId r1/);
    expect(call.result.content[0].text).toMatch(/flow_status/);
  });

  // Phase 3: the server inherits DEVSPACE_CLI_TAB_ID from the dock tab's claude
  // that spawned it. Without `tab` on the wire, DevSpace cannot tell WHICH
  // session is calling, and every pinned-flow run would fall back to an error.
  it('relays its dock tab id with the flow ops', async () => {
    await flowRpc(
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'list_flows', arguments: {} },
        },
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          // No `flow`: the pinned one is resolved by DevSpace from `tab`.
          params: { name: 'run_flow', arguments: { task: 'add dark mode' } },
        },
      ],
      { DEVSPACE_CLI_TAB_ID: 'tab-7' },
    );
    expect(flowReceived.find((r) => r.op === 'list')).toMatchObject({ tab: 'tab-7' });
    expect(flowReceived.find((r) => r.op === 'run')).toMatchObject({
      op: 'run',
      task: 'add dark mode',
      tab: 'tab-7',
      repo: '/fake/repo',
    });
  });

  it('run_flow no longer requires `flow` (a pinned session omits it)', async () => {
    const out = await flowRpc([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]);
    const tools = out.find((m) => m.id === 2) as {
      result: { tools: Array<{ name: string; inputSchema: { required?: string[] } }> };
    };
    const runFlow = tools.result.tools.find((t) => t.name === 'run_flow')!;
    expect(runFlow.inputSchema.required).toEqual(['task']);
  });

  it('marks the pinned flow in the list_flows reply text', async () => {
    // The pin only helps if the agent SEES it — a `pinned:true` buried in the
    // node graph JSON is not a routing signal, the digest line is. Own socket
    // (not a rebind of flowSock) so this reply shape can't race the shared one.
    const pinnedSock = path.join(
      os.tmpdir(),
      `fp-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
    );
    const pinnedServer = net.createServer((conn) => {
      conn.on('data', () => {
        conn.write(
          `${JSON.stringify({
            ok: true,
            flows: [
              { id: 'f1', name: 'feature-pipeline', description: 'features', pinned: true },
              { id: 'f2', name: 'bugfix', description: 'bugs' },
            ],
          })}\n`,
        );
      });
    });
    await new Promise<void>((r) => pinnedServer.listen(pinnedSock, r));

    try {
      const out = await flowRpc(
        [
          { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
          {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'list_flows', arguments: {} },
          },
        ],
        { DEVSPACE_FLOW_SOCK: pinnedSock },
      );
      const call = out.find((m) => m.id === 2) as {
        result: { content: Array<{ text: string }> };
      };
      expect(call.result.content[0].text).toMatch(/feature-pipeline \[pinned\]/);
      expect(call.result.content[0].text).not.toMatch(/bugfix \[pinned\]/);
    } finally {
      pinnedServer.close();
      try {
        fs.rmSync(pinnedSock, { force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('list_flows / stop_flow relay their ops to the flow socket', async () => {
    await flowRpc([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'list_flows', arguments: {} },
      },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'stop_flow', arguments: { runId: 'r1' } },
      },
    ]);
    expect(flowReceived.map((r) => r.op).sort()).toEqual(['list', 'stop']);
    expect(flowReceived.find((r) => r.op === 'stop')).toMatchObject({ runId: 'r1' });
    expect(received).toEqual([]);
  });
});
