// DevSpace task + flow MCP server (bundled, zero-dependency). Spawned over stdio
// by the main-chat claude CLI; relays orchestration to DevSpace's unix control
// sockets so the agent can (a) create / monitor / drive / integrate
// worktree-isolated tasks and (b) run / monitor / steer / stop Agent Flows — a
// user-designed graph of real CLI agents. Newline-delimited JSON-RPC 2.0 (the
// MCP stdio transport).
//
// Two sockets, one server: tasks and flows are separate subsystems in the main
// process, each owning its own socket.
//
// Runs under plain node OR electron-as-node (ELECTRON_RUN_AS_NODE=1) so no
// external node install is required. Env:
//   DEVSPACE_TASK_SOCK     task control socket (default ~/.devspace/task-control.sock)
//   DEVSPACE_FLOW_SOCK     flow control socket (default ~/.devspace/flow-control.sock)
//   DEVSPACE_PROJECT_PATH  default repo when `repo` is omitted
//   DEVSPACE_CLI_TAB_ID    the dock tab of the claude that spawned us (we
//                          inherit its env) — sent with each flow op so DevSpace
//                          can resolve the flow the user pinned to THIS session.
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const SOCK =
  process.env.DEVSPACE_TASK_SOCK ||
  path.join(os.homedir(), '.devspace', 'task-control.sock');
const FLOW_SOCK =
  process.env.DEVSPACE_FLOW_SOCK ||
  path.join(os.homedir(), '.devspace', 'flow-control.sock');
const DEFAULT_REPO = process.env.DEVSPACE_PROJECT_PATH || '';
// Empty when this claude wasn't launched from a dock tab (a flow node's own
// agent, a bare CLI) — then nothing is pinned and `flow` stays mandatory.
const TAB = process.env.DEVSPACE_CLI_TAB_ID || '';

const idSchema = {
  type: 'object',
  properties: { id: { type: 'string', description: 'Task id (from list_tasks).' } },
  required: ['id'],
};

const TOOLS = [
  {
    name: 'create_task',
    description:
      'Create a DevSpace worktree-isolated task: forks a git worktree + branch and launches a background agent in it. Pass `prompt` with the full brief/context so the agent starts working immediately. Use to delegate a self-contained unit of work.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title (also names the branch).' },
        prompt: {
          type: 'string',
          description:
            "The agent's initial brief — what to do, plus any context/spec/file pointers it needs. Without it the agent starts idle.",
        },
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

  // ── Agent Flows ───────────────────────────────────────────────────────────
  // A flow is a graph the USER designed on the DevSpace canvas: each node is a
  // real CLI agent with a role (researcher → coder → tester → reviewer), each
  // edge hands the upstream node's output to the next node's brief. You are the
  // only way to start one — the canvas has no Run button.
  //
  // ROUTING — how to decide, every turn:
  //   • Normal conversation, a question, a quick edit, a one-off command?
  //     Just answer / do it yourself. Do NOT run a flow.
  //   • Multi-step procedural work the user wants carried out end-to-end
  //     (build this feature, investigate + fix + test this bug, review and
  //     harden this module)? Call list_flows, see whether a flow's description
  //     matches the shape of the work, and if one does, run_flow it with a
  //     well-formed `task`.
  //   • The user may PIN a flow to this session (right-click the dock tab → Use
  //     flow); list_flows marks it [pinned]. That is a standing instruction —
  //     prefer it for procedural work, and just omit `flow` to run it.
  //   • No flow fits? Say so and do the work yourself (or use create_task).
  // Never invent a flow name — only run what list_flows returned.
  {
    name: 'list_flows',
    description:
      "List the Agent Flows the user has designed for this project: id, name, description, and the node graph (role + CLI + mode per node). Each flow's description says what kind of work it is for — read it to decide whether the user's request matches. The reply marks the flow pinned to this session — prefer it for procedural work unless the task clearly doesn't fit. Call this BEFORE run_flow, never guess a flow name. If MORE THAN ONE flow plausibly fits (or none clearly does), ask the user which to use — list the candidates with one-line reasons — instead of picking silently. If the user names a flow themselves, use that one.",
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Absolute project path. Defaults to the current project.',
        },
      },
    },
  },
  {
    name: 'run_flow',
    description:
      "Start a run of a user-designed flow. Use when the user asks for multi-step procedural work that matches a flow's description (from list_flows) — the flow's agents then do the work, not you. `task` is the kickoff brief handed to every entry node: write it as a complete, self-contained statement of the goal (what to build/fix, which files or areas, what 'done' looks like, any constraints from the conversation) — the flow's agents cannot see this chat. Returns a runId; monitor it with flow_status.",
    inputSchema: {
      type: 'object',
      properties: {
        flow: {
          type: 'string',
          description:
            'Flow name or id (from list_flows). OMIT it to use the flow the user pinned to this session (right-click the dock tab → Use flow).',
        },
        task: {
          type: 'string',
          description:
            "The kickoff brief for the flow's agents — full goal + context + constraints. They see only this, not the conversation.",
        },
        repo: {
          type: 'string',
          description: 'Absolute project path. Defaults to the current project.',
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'flow_status',
    description:
      "Progress of a live run: each node's status (queued / running / done / failed / skipped) and a tail of its output. Poll this to monitor a flow you started, and report progress back to the user in your own words. A finished run is no longer live — use list_flow_runs for its final state.",
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string', description: 'Run id (from run_flow).' } },
      required: ['runId'],
    },
  },
  {
    name: 'send_flow',
    description:
      "Type an instruction into one running node's live agent session — relay a user message, answer a question the agent is stuck on, or steer it. Only works for interactive nodes (headless nodes have no session). Use the node id shown by flow_status.",
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Run id.' },
        node: { type: 'string', description: 'Node id (from flow_status).' },
        text: { type: 'string', description: 'The instruction to send to that agent.' },
      },
      required: ['runId', 'node', 'text'],
    },
  },
  {
    name: 'stop_flow',
    description:
      'Stop a running flow: kills its in-flight agents and marks the run stopped. Use when the user asks to stop/cancel/abort it.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string', description: 'Run id.' } },
      required: ['runId'],
    },
  },
  {
    name: 'list_flow_runs',
    description:
      'Recent flow runs for this project (live and finished) with per-node status. Use to answer "how did that run end?" or to find the runId of a run already in progress.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Absolute project path. Defaults to the current project.',
        },
      },
    },
  },
];

// tool name → control-socket request payload. `sock` picks which subsystem's
// socket the request goes to (tasks vs flows).
const TOOL_OP = {
  create_task: (a) => ({
    op: 'create',
    title: a.title,
    repo: a.repo || DEFAULT_REPO,
    prompt: a.prompt,
  }),
  list_tasks: () => ({ op: 'list' }),
  task_changes: (a) => ({ op: 'changes', id: a.id }),
  send_task: (a) => ({ op: 'send', id: a.id, text: a.text }),
  merge_task: (a) => ({ op: 'merge', id: a.id }),
  discard_task: (a) => ({ op: 'discard', id: a.id }),

  // `tab` rides along so DevSpace can resolve THIS session's pinned flow — to
  // mark it in the list, and to default to it when run_flow omits `flow`.
  list_flows: (a) => ({ op: 'list', repo: a.repo || DEFAULT_REPO, tab: TAB }),
  run_flow: (a) => ({
    op: 'run',
    repo: a.repo || DEFAULT_REPO,
    flow: a.flow,
    task: a.task,
    tab: TAB,
  }),
  flow_status: (a) => ({ op: 'status', runId: a.runId }),
  send_flow: (a) => ({ op: 'send', runId: a.runId, node: a.node, text: a.text }),
  stop_flow: (a) => ({ op: 'stop', runId: a.runId }),
  list_flow_runs: (a) => ({ op: 'runs', repo: a.repo || DEFAULT_REPO }),
};

// Tools whose op is routed to the flow socket rather than the task socket.
const FLOW_TOOLS = new Set([
  'list_flows',
  'run_flow',
  'flow_status',
  'send_flow',
  'stop_flow',
  'list_flow_runs',
]);

function resultText(name, res) {
  if (!res.ok) return `Error: ${res.error}`;
  if (res.task) return `Task ${res.task.id} — ${res.task.status} on ${res.task.branch}`;
  if (res.diff !== undefined) return res.diff || '(no changes vs base branch)';
  if (res.tasks) return JSON.stringify(res.tasks, null, 2);
  if (res.flows) {
    if (!Array.isArray(res.flows) || res.flows.length === 0) {
      return '(no flows designed yet)';
    }
    // A digest line per flow ahead of the raw graph: the routing decision is
    // made on name + description + [pinned], and burying those in 200 lines of
    // node JSON is how a lead agent ends up ignoring the pin.
    const digest = res.flows
      .map(
        (f) =>
          `• ${f.name}${f.pinned ? ' [pinned]' : ''} — ${f.description || '(no description)'}`,
      )
      .join('\n');
    return `${digest}\n\n${JSON.stringify(res.flows, null, 2)}`;
  }
  if (res.runs) return JSON.stringify(res.runs, null, 2);
  if (res.run) return JSON.stringify(res.run, null, 2);
  if (res.runId) {
    return `Flow started — runId ${res.runId}. Monitor it with flow_status; report progress to the user.`;
  }
  if (name === 'send_task') return 'Instruction sent to the task agent.';
  if (name === 'merge_task') return 'Merged into the base branch; task is now Done.';
  if (name === 'discard_task') return 'Task discarded.';
  if (name === 'send_flow') return 'Instruction sent to the flow node agent.';
  if (name === 'stop_flow') return 'Flow run stopped.';
  return 'OK';
}

// One request to a control socket → one JSON reply. Best-effort: a missing
// socket means DevSpace isn't running, surfaced as a tool error. `sock` selects
// the subsystem (task-control vs flow-control) — the wire shape is identical.
function callControl(payload, sock = SOCK) {
  const what = sock === FLOW_SOCK ? 'flow' : 'task';
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
    const conn = net.createConnection(sock);
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
      finish({
        ok: false,
        error: `DevSpace is not running (${what} socket unavailable)`,
      }),
    );
    setTimeout(() => finish({ ok: false, error: `${what} socket timeout` }), 8000);
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
        serverInfo: { name: 'devspace-tasks', version: '1.3.0' },
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
      const res = await callControl(
        build(params?.arguments || {}),
        FLOW_TOOLS.has(name) ? FLOW_SOCK : SOCK,
      );
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
