// DevSpace task MCP server (bundled, zero-dependency). Spawned over stdio by
// the main-chat claude CLI; relays task orchestration to DevSpace's task-control
// unix socket so the agent can create / monitor / drive / integrate
// worktree-isolated tasks by tool call. Newline-delimited JSON-RPC 2.0 (the MCP
// stdio transport).
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

const idSchema = {
  type: 'object',
  properties: { id: { type: 'string', description: 'Task id (from list_tasks).' } },
  required: ['id'],
};

const TOOLS = [
  {
    name: 'create_task',
    description:
      'Create a DevSpace worktree-isolated task: forks a git worktree + branch and launches a background agent in it. Use to delegate a self-contained unit of work.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title (also names the branch).' },
        repo: {
          type: 'string',
          description: 'Absolute path of the source git repo. Defaults to the current project.',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_tasks',
    description:
      'List current DevSpace tasks with id, title, status, and branch. Use to monitor progress (status running → awaiting-review when an agent is idle with changes).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'task_changes',
    description:
      "Get a task's full unified diff (worktree vs its base branch) so you can review the agent's work before merging.",
    inputSchema: idSchema,
  },
  {
    name: 'send_task',
    description:
      "Send a follow-up instruction to a task's running agent (typed into its session). Use to course-correct or ask for more work.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task id.' },
        text: { type: 'string', description: 'The instruction to send to the agent.' },
      },
      required: ['id', 'text'],
    },
  },
  {
    name: 'merge_task',
    description:
      "Merge a task's branch into its base branch and clean up the worktree (the task becomes Done). Review with task_changes first.",
    inputSchema: idSchema,
  },
  {
    name: 'discard_task',
    description: 'Discard a task: remove its worktree + branch without merging.',
    inputSchema: idSchema,
  },
];

// tool name → control-socket request payload.
const TOOL_OP = {
  create_task: (a) => ({ op: 'create', title: a.title, repo: a.repo || DEFAULT_REPO }),
  list_tasks: () => ({ op: 'list' }),
  task_changes: (a) => ({ op: 'changes', id: a.id }),
  send_task: (a) => ({ op: 'send', id: a.id, text: a.text }),
  merge_task: (a) => ({ op: 'merge', id: a.id }),
  discard_task: (a) => ({ op: 'discard', id: a.id }),
};

function resultText(name, res) {
  if (!res.ok) return `Error: ${res.error}`;
  if (res.task) return `Task ${res.task.id} — ${res.task.status} on ${res.task.branch}`;
  if (res.diff !== undefined) return res.diff || '(no changes vs base branch)';
  if (res.tasks) return JSON.stringify(res.tasks, null, 2);
  if (name === 'send_task') return 'Instruction sent to the task agent.';
  if (name === 'merge_task') return 'Merged into the base branch; task is now Done.';
  if (name === 'discard_task') return 'Task discarded.';
  return 'OK';
}

// One request to the control socket → one JSON reply. Best-effort: a missing
// socket means DevSpace isn't running, surfaced as a tool error.
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
    setTimeout(() => finish({ ok: false, error: 'task socket timeout' }), 8000);
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
        serverInfo: { name: 'devspace-tasks', version: '1.1.0' },
      });
    case 'notifications/initialized':
      return; // notification — no reply
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params?.name;
      const build = TOOL_OP[name];
      if (!build) return fail(id, -32602, `unknown tool: ${name}`);
      const res = await callControl(build(params?.arguments || {}));
      return ok(id, {
        content: [{ type: 'text', text: resultText(name, res) }],
        isError: !res.ok,
      });
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
