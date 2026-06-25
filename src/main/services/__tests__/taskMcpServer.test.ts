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
let received: Array<{ op?: string; title?: string; repo?: string }>;

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
      const reply =
        req.op === 'create'
          ? {
              ok: true,
              task: {
                id: 't1',
                title: req.title,
                status: 'running',
                branch: 'devspace/task/x',
              },
            }
          : { ok: true, tasks: [{ id: 't1', title: 'X', status: 'running', branch: 'b' }] };
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
  it('handshakes and lists both tools', async () => {
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
      'list_tasks',
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
    expect(call.result.content[0].text).toMatch(/Created task t1/);
  });
});
