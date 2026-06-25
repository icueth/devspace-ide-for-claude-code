// DevSpace task MCP server (bundled, zero-dependency). Spawned over stdio by
// the main-chat claude CLI; relays create_task / list_tasks to DevSpace's
// task-control unix socket so the agent can fork worktree-isolated tasks by
// tool call. Newline-delimited JSON-RPC 2.0 (the MCP stdio transport).
//
// Runs under plain node OR electron-as-node (ELECTRON_RUN_AS_NODE=1) so no
// external node install is required. Env:
//   DEVSPACE_TASK_SOCK     path to the control socket (default ~/.devspace/...)
//   DEVSPACE_PROJECT_PATH  default repo for create_task when `repo` is omitted
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const SOCK =
  process.env.DEVSPACE_TASK_SOCK ||
  path.join(os.homedir(), '.devspace', 'task-control.sock');
const DEFAULT_REPO = process.env.DEVSPACE_PROJECT_PATH || '';

const TOOLS = [
  {
    name: 'create_task',
    description:
      'Create a DevSpace worktree-isolated task: forks a git worktree + branch from the repo and launches a background agent in it. Use to delegate a self-contained unit of work.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Short task title (also used to name the branch).',
        },
        repo: {
          type: 'string',
          description:
            'Absolute path of the source git repo. Defaults to the current project.',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_tasks',
    description: 'List current DevSpace tasks with id, title, status, and branch.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// One request to the control socket → one JSON reply. Best-effort: a missing
// socket means DevSpace isn't running, which we surface as a tool error.
function callControl(payload) {
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const finish = (res) => {
      if (done) return;
      done = true;
      try {
        conn.destroy();
      } catch {
        /* ignore */
      }
      resolve(res);
    };
    const conn = net.createConnection(SOCK);
    conn.on('connect', () => conn.write(`${JSON.stringify(payload)}\n`));
    conn.on('data', (d) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        try {
          finish(JSON.parse(buf.slice(0, nl)));
        } catch {
          finish({ ok: false, error: 'bad reply from DevSpace' });
        }
      }
    });
    conn.on('error', () =>
      finish({ ok: false, error: 'DevSpace is not running (task socket unavailable)' }),
    );
    setTimeout(() => finish({ ok: false, error: 'task socket timeout' }), 5000);
  });
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}
function ok(id, res) {
  send({ jsonrpc: '2.0', id, result: res });
}
function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'devspace-tasks', version: '1.0.0' },
      });
    case 'notifications/initialized':
      return; // notification — no reply
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments || {};
      let res;
      if (name === 'create_task') {
        res = await callControl({
          op: 'create',
          title: args.title,
          repo: args.repo || DEFAULT_REPO,
        });
      } else if (name === 'list_tasks') {
        res = await callControl({ op: 'list' });
      } else {
        return fail(id, -32602, `unknown tool: ${name}`);
      }
      const text = !res.ok
        ? `Error: ${res.error}`
        : res.task
          ? `Created task ${res.task.id} (${res.task.status}) on branch ${res.task.branch}`
          : JSON.stringify(res.tasks ?? [], null, 2);
      return ok(id, { content: [{ type: 'text', text }], isError: !res.ok });
    }
    default:
      if (id !== undefined) return fail(id, -32601, `method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try {
    msg = JSON.parse(s);
  } catch {
    return; // ignore non-JSON noise
  }
  Promise.resolve(handle(msg)).catch((e) => {
    if (msg && msg.id !== undefined) fail(msg.id, -32603, String(e?.message || e));
  });
});
