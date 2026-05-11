import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WebContents } from 'electron';

import { listAgents } from '@main/services/AgentsService';
import { resolveClaudeBinary } from '@main/services/ClaudeCliLauncher';
import { getTeam } from '@main/services/TeamsService';
import { resolveInteractiveShellEnv } from '@main/utils/shellEnv';
import { createLogger } from '@shared/logger';
import type {
  AgentDef,
  ChatConfig,
  ChatEvent,
  ChatMessage,
  ChatSendRequest,
  ChatThread,
  TeamDef,
  TeamStep,
} from '@shared/types';

const logger = createLogger('Chat');

// One persisted JSON file per thread. Lives alongside codeflow + augment
// in .devspace/ so codeflow's `.claude/` doesn't accidentally swallow chat
// state (Claude's harness blocks writes there).
function threadsDir(projectPath: string): string {
  return path.join(projectPath, '.devspace', 'chat');
}

function threadFile(projectPath: string, threadId: string): string {
  return path.join(threadsDir(projectPath), `${threadId}.json`);
}

// Project-level default chat config — applied to every new thread unless
// the thread itself sets a config override. One file per project so
// switching workspaces gives a clean slate without leaking the wrong
// model / system prompt across projects.
function chatConfigFile(projectPath: string): string {
  return path.join(projectPath, '.devspace', 'chat-config.json');
}

interface ProjectState {
  projectPath: string;
  threads: Map<string, ChatThread>; // by threadId
  // The live child process for any in-flight turn. One at a time per
  // project — same model as Claude Code CLI; queuing is the user's
  // problem if they want multiple turns at once.
  activeChild: ChildProcess | null;
  activeThreadId: string | null;
  subscribers: Set<WebContents>;
  // Promise that resolves once the initial disk → memory hydration
  // finishes. listThreads() awaits this so the renderer never receives
  // an empty list while threads are still being read from disk — the
  // previous setImmediate yield wasn't enough for an async chain
  // (readdir + readFile per thread file) and caused the panel to
  // auto-create a "New chat" while existing threads were still loading.
  hydrationPromise: Promise<void>;
}

const states = new Map<string, ProjectState>();

function getState(projectPath: string): ProjectState {
  const key = path.resolve(projectPath);
  let state = states.get(key);
  if (!state) {
    state = {
      projectPath: key,
      threads: new Map(),
      activeChild: null,
      activeThreadId: null,
      subscribers: new Set(),
      hydrationPromise: Promise.resolve(),
    };
    states.set(key, state);
    state.hydrationPromise = hydrateFromDisk(state).catch((err) => {
      logger.warn(`hydrate failed for ${key}: ${(err as Error).message}`);
    });
  }
  return state;
}

async function hydrateFromDisk(state: ProjectState): Promise<void> {
  const dir = threadsDir(state.projectPath);
  let files: fs.Dirent[];
  try {
    files = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const f of files) {
    if (!f.isFile() || !f.name.endsWith('.json')) continue;
    try {
      const raw = await fs.promises.readFile(path.join(dir, f.name), 'utf8');
      const thread = JSON.parse(raw) as ChatThread;
      if (thread.id && Array.isArray(thread.messages)) {
        state.threads.set(thread.id, thread);
      }
    } catch {
      /* skip corrupt thread */
    }
  }
}

async function persistThread(
  projectPath: string,
  thread: ChatThread,
): Promise<void> {
  const file = threadFile(projectPath, thread.id);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify(thread, null, 2));
}

// Resolve the config that should govern a turn. Precedence:
//   turn (request.config) → thread (thread.config) → project default
// Fields are merged shallowly — each field falls through independently
// so a turn can override just the model without losing the thread's
// allow-list, etc.
function mergeConfig(...layers: Array<ChatConfig | undefined>): ChatConfig {
  const out: ChatConfig = {};
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.model !== undefined) out.model = layer.model;
    if (layer.systemPromptAppend !== undefined)
      out.systemPromptAppend = layer.systemPromptAppend;
    if (layer.allowedTools !== undefined) out.allowedTools = layer.allowedTools;
    if (layer.disallowedTools !== undefined)
      out.disallowedTools = layer.disallowedTools;
    if (layer.extraArgs !== undefined) out.extraArgs = layer.extraArgs;
  }
  return out;
}

// Translate a resolved ChatConfig into the args array passed to spawn().
// Order: required baseline first (--print + permission + format), then
// optional knobs, then extraArgs verbatim at the end. Empty / undefined
// fields are skipped so claude uses its own defaults.
function buildClaudeArgs(cfg: ChatConfig): string[] {
  const args = [
    '--print',
    '--permission-mode',
    'bypassPermissions',
    '--output-format',
    'stream-json',
    '--verbose',
  ];
  if (cfg.model?.trim()) {
    args.push('--model', cfg.model.trim());
  }
  if (cfg.systemPromptAppend?.trim()) {
    args.push('--append-system-prompt', cfg.systemPromptAppend);
  }
  if (cfg.allowedTools && cfg.allowedTools.length > 0) {
    args.push('--allowed-tools', cfg.allowedTools.join(','));
  }
  if (cfg.disallowedTools && cfg.disallowedTools.length > 0) {
    args.push('--disallowed-tools', cfg.disallowedTools.join(','));
  }
  if (cfg.extraArgs && cfg.extraArgs.length > 0) {
    args.push(...cfg.extraArgs);
  }
  return args;
}

// ─── public API ─────────────────────────────────────────────────────────────

// Read the project-level chat config. Missing file = empty config (claude
// uses its own defaults for everything). Corrupt JSON = also empty
// config; logged but not surfaced (the user can re-save from the drawer
// to overwrite garbage).
export async function getProjectConfig(projectPath: string): Promise<ChatConfig> {
  const file = chatConfigFile(projectPath);
  try {
    const raw = await fs.promises.readFile(file, 'utf8');
    return JSON.parse(raw) as ChatConfig;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn(
        `failed to read chat-config for ${projectPath}: ${(err as Error).message}`,
      );
    }
    return {};
  }
}

export async function setProjectConfig(
  projectPath: string,
  cfg: ChatConfig,
): Promise<ChatConfig> {
  const file = chatConfigFile(projectPath);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify(cfg, null, 2));
  return cfg;
}

export async function updateThreadConfig(
  projectPath: string,
  threadId: string,
  cfg: ChatConfig | null,
): Promise<ChatThread> {
  const s = getState(projectPath);
  await s.hydrationPromise;
  const thread = s.threads.get(threadId);
  if (!thread) throw new Error(`thread not found: ${threadId}`);
  if (cfg === null) {
    delete thread.config;
  } else {
    thread.config = cfg;
  }
  thread.updatedAt = Date.now();
  await persistThread(s.projectPath, thread);
  return thread;
}

export function subscribe(projectPath: string, wc: WebContents): void {
  const s = getState(projectPath);
  s.subscribers.add(wc);
  wc.once('destroyed', () => s.subscribers.delete(wc));
}

export async function listThreads(projectPath: string): Promise<ChatThread[]> {
  const s = getState(projectPath);
  await s.hydrationPromise;
  return [...s.threads.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function createThread(
  projectPath: string,
  title?: string,
): Promise<ChatThread> {
  const s = getState(projectPath);
  const thread: ChatThread = {
    id: randomUUID(),
    projectId: path.basename(s.projectPath),
    title: title?.trim() || 'New chat',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  };
  s.threads.set(thread.id, thread);
  await persistThread(s.projectPath, thread);
  return thread;
}

export async function deleteThread(
  projectPath: string,
  threadId: string,
): Promise<void> {
  const s = getState(projectPath);
  s.threads.delete(threadId);
  try {
    await fs.promises.unlink(threadFile(s.projectPath, threadId));
  } catch {
    /* already gone */
  }
}

export function cancelActive(projectPath: string): void {
  const s = states.get(path.resolve(projectPath));
  if (!s || !s.activeChild) return;
  try {
    s.activeChild.kill('SIGTERM');
  } catch {
    /* ignore */
  }
}

// ─── turn execution ─────────────────────────────────────────────────────────

function broadcast(state: ProjectState, threadId: string, event: ChatEvent): void {
  for (const wc of state.subscribers) {
    if (!wc.isDestroyed()) {
      wc.send('chat:event', { projectPath: state.projectPath, threadId, event });
    }
  }
}

/**
 * Send a user message, spawn claude-headless with the full history as
 * stdin, parse its stream-json output into normalized ChatEvent objects,
 * and stream them to every subscribed WebContents. Persists the final
 * message pair to disk when the turn completes.
 *
 * One concurrent turn per project. Calls during an active turn return the
 * existing in-progress assistant message id without spawning a duplicate.
 */
export async function sendMessage(req: ChatSendRequest): Promise<{ messageId: string }> {
  const s = getState(req.projectId);
  const thread = s.threads.get(req.threadId);
  if (!thread) throw new Error(`thread not found: ${req.threadId}`);
  if (s.activeChild) {
    throw new Error('a chat turn is already running for this project');
  }

  const userMsg: ChatMessage = {
    id: randomUUID(),
    role: 'user',
    content: req.text,
    toolCalls: [],
    createdAt: Date.now(),
    status: 'done',
  };
  thread.messages.push(userMsg);

  // Give the thread a sensible title once it has its first user message.
  if (thread.title === 'New chat' && thread.messages.length === 1) {
    thread.title = req.text.split('\n')[0]!.slice(0, 60) || 'New chat';
  }

  const assistantMsg: ChatMessage = {
    id: randomUUID(),
    role: 'assistant',
    content: '',
    toolCalls: [],
    createdAt: Date.now(),
    status: 'streaming',
  };
  thread.messages.push(assistantMsg);
  thread.updatedAt = Date.now();
  await persistThread(s.projectPath, thread);

  // Resolve effective config for this turn before we lose the request
  // reference. Highest precedence: turn override (req.config) → thread
  // override (thread.config) → project default on disk.
  const projectDefault = await getProjectConfig(s.projectPath);
  const effective = mergeConfig(projectDefault, thread.config, req.config);

  // Resolve team (if any) and branch on its mode. Orchestrator just
  // appends a system prompt and runs the normal turn. Sequential takes
  // a different codepath that chains N spawns. Parallel isn't
  // implemented yet — falls back to solo with a status note so the
  // user knows their team setting was ignored.
  const team = req.teamId ? await getTeam(s.projectPath, req.teamId) : null;

  if (team && team.mode === 'sequential') {
    void runTeamSequentialTurn(s, thread, assistantMsg, effective, team).catch(
      (err) => logger.error(`team-sequential failed: ${(err as Error).message}`),
    );
    return { messageId: assistantMsg.id };
  }

  let cfg = effective;
  if (team && team.mode === 'orchestrator') {
    const orchestratorAppend = await buildOrchestratorPromptAppend(
      s.projectPath,
      team,
    );
    cfg = mergeConfig(effective, {
      systemPromptAppend:
        (effective.systemPromptAppend ?? '') +
        (effective.systemPromptAppend ? '\n\n' : '') +
        orchestratorAppend,
    });
  }

  // Kick off the spawn but don't await it — caller wants the message id
  // synchronously so it can render the streaming placeholder.
  void runClaudeTurn(s, thread, assistantMsg, cfg).catch((err) => {
    logger.error(`chat turn failed: ${(err as Error).message}`);
  });

  return { messageId: assistantMsg.id };
}

/**
 * Build the system-prompt addition for orchestrator mode. Resolves each
 * team member's agent file (description + tools) and gives claude an
 * explicit roster + nudge to use the Task tool. The user's original
 * prompt is unchanged — claude just becomes more dispatch-happy.
 */
async function buildOrchestratorPromptAppend(
  projectPath: string,
  team: TeamDef,
): Promise<string> {
  const all = await listAgents(projectPath);
  const validMembers = team.members
    .map((m) => {
      const agent = all.find((a) => a.slug === m.agentSlug);
      return agent ? { member: m, agent } : null;
    })
    .filter((x): x is { member: typeof team.members[number]; agent: AgentDef } => x !== null);

  const lines: string[] = [];
  lines.push(`You are orchestrating a team called "${team.name}" for this task.`);
  lines.push('');
  lines.push(
    `**Recommended baseline (${validMembers.length} agent${validMembers.length === 1 ? '' : 's'} the user pre-selected):**`,
  );
  for (const { agent } of validMembers) {
    const desc = agent.description.trim().split('\n')[0]!.slice(0, 200);
    lines.push(`  - \`${agent.slug}\` — ${desc}`);
  }
  lines.push('');
  lines.push('## How to run this team');
  lines.push(
    '1. **Start from the baseline.** Always dispatch to each of the user-selected agents above (one Task call each) — they were chosen on purpose.',
  );
  lines.push(
    '2. **Expand only if clearly useful.** If the task has a sub-angle the baseline doesn\'t cover (e.g. user said "review for security AND perf" but the team only has a security agent), you MAY add 1–2 more sub-agents from the agents you know about. Keep additions to a minimum.',
  );
  lines.push(
    '3. **Announce expansions explicitly.** If you add an agent not in the baseline, open your reply with a short note like: "I added `perf-engineer` because the task asked about perf, which the team\'s 2 agents don\'t cover." This lets the user update their team config if they want this addition to stick.',
  );
  lines.push(
    '4. **Parallel when independent**, sequential when there\'s a real dependency. Synthesize the agents\' results into one response — cite who produced what when it matters.',
  );
  return lines.join('\n');
}

async function runClaudeTurn(
  state: ProjectState,
  thread: ChatThread,
  assistant: ChatMessage,
  config: ChatConfig,
): Promise<void> {
  const claudeBin = await resolveClaudeBinary();
  if (!claudeBin) {
    assistant.status = 'error';
    assistant.error = "claude binary not found on PATH";
    broadcast(state, thread.id, {
      kind: 'error',
      message: assistant.error,
      ts: Date.now(),
    });
    broadcast(state, thread.id, { kind: 'done', ts: Date.now() });
    await persistThread(state.projectPath, thread);
    return;
  }

  // Build the prompt as the full conversation history (system + user/asst
  // turns) so claude has context for the latest user message. claude
  // --print processes a single prompt at a time, so we serialize the
  // entire history into one stdin payload. This costs more tokens than a
  // proper session but works without claude session state.
  const history = thread.messages
    .slice(0, -1) // exclude the current streaming assistant
    .map((m) => {
      if (m.role === 'user') return `User: ${m.content}`;
      return `Assistant: ${m.content || '(thinking)'}`;
    })
    .join('\n\n');

  const lastUser = thread.messages
    .slice()
    .reverse()
    .find((m) => m.role === 'user');
  const prompt = history
    ? `${history}\n\n(Continue the conversation above. Reply only with the new assistant turn.)`
    : (lastUser?.content ?? '');

  const env = await resolveInteractiveShellEnv();
  const args = buildClaudeArgs(config);

  logger.info(
    `spawn claude (chat) thread=${thread.id.slice(0, 8)} cwd=${state.projectPath} model=${config.model ?? 'default'} tools=${config.allowedTools?.length ?? 'all'}`,
  );
  const child = spawn(claudeBin, args, {
    cwd: state.projectPath,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  state.activeChild = child;
  state.activeThreadId = thread.id;
  child.stdin?.write(prompt);
  child.stdin?.end();

  broadcast(state, thread.id, {
    kind: 'status',
    message: 'running',
    ts: Date.now(),
  });

  let lineBuf = '';
  let stderrBuf = '';

  const handleLine = (raw: string) => {
    let evt: unknown;
    try {
      evt = JSON.parse(raw);
    } catch {
      return;
    }
    const e = evt as {
      type?: string;
      subtype?: string;
      message?: {
        content?: Array<
          | { type: 'text'; text?: string }
          | { type: 'thinking'; thinking?: string }
          | {
              type: 'tool_use';
              id?: string;
              name?: string;
              input?: Record<string, unknown>;
            }
          | {
              type: 'tool_result';
              tool_use_id?: string;
              content?: string | { type?: string; text?: string }[];
              is_error?: boolean;
            }
        >;
      };
      result?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    if (e.type === 'assistant' && e.message?.content) {
      for (const block of e.message.content) {
        if (block.type === 'text' && block.text) {
          assistant.content += block.text;
          broadcast(state, thread.id, {
            kind: 'text_delta',
            text: block.text,
            ts: Date.now(),
          });
        } else if (block.type === 'thinking' && block.thinking) {
          assistant.thinking = (assistant.thinking ?? '') + block.thinking;
          broadcast(state, thread.id, {
            kind: 'thinking_delta',
            text: block.thinking,
            ts: Date.now(),
          });
        } else if (block.type === 'tool_use') {
          const id = block.id ?? randomUUID();
          assistant.toolCalls.push({
            id,
            name: block.name ?? 'tool',
            input: block.input ?? {},
          });
          broadcast(state, thread.id, {
            kind: 'tool_use',
            toolUseId: id,
            toolName: block.name,
            toolInput: block.input,
            ts: Date.now(),
          });
        }
      }
    } else if (e.type === 'user' && e.message?.content) {
      // user-role events in claude's stream-json carry tool_result blocks
      // matched back to their tool_use by tool_use_id.
      for (const block of e.message.content) {
        if (block.type === 'tool_result') {
          const text =
            typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .map((c) => (typeof c === 'object' && c?.type === 'text' ? c.text ?? '' : ''))
                    .join('')
                : '';
          const tu = assistant.toolCalls.find(
            (c) => c.id === block.tool_use_id,
          );
          if (tu) {
            tu.result = text;
            tu.isError = !!block.is_error;
          }
          broadcast(state, thread.id, {
            kind: 'tool_result',
            toolUseId: block.tool_use_id,
            toolResult: text,
            toolIsError: !!block.is_error,
            ts: Date.now(),
          });
        }
      }
    } else if (e.type === 'result') {
      if (e.usage) {
        assistant.usage = {
          input: e.usage.input_tokens ?? 0,
          output: e.usage.output_tokens ?? 0,
        };
        broadcast(state, thread.id, {
          kind: 'usage',
          inputTokens: e.usage.input_tokens,
          outputTokens: e.usage.output_tokens,
          ts: Date.now(),
        });
      }
    }
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    lineBuf += chunk.toString('utf8');
    let nl: number;
    while ((nl = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, nl).trim();
      lineBuf = lineBuf.slice(nl + 1);
      if (line) handleLine(line);
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
  });

  child.on('error', (err) => {
    state.activeChild = null;
    assistant.status = 'error';
    assistant.error = err.message;
    broadcast(state, thread.id, {
      kind: 'error',
      message: err.message,
      ts: Date.now(),
    });
    broadcast(state, thread.id, { kind: 'done', ts: Date.now() });
    void persistThread(state.projectPath, thread);
  });
  child.on('exit', (code, signal) => {
    if (lineBuf.trim()) handleLine(lineBuf.trim());
    state.activeChild = null;
    state.activeThreadId = null;

    if (signal === 'SIGTERM' || signal === 'SIGKILL') {
      assistant.status = 'cancelled';
    } else if (code !== 0) {
      assistant.status = 'error';
      assistant.error =
        stderrBuf.trim().slice(-500) || `claude exited ${code}`;
      broadcast(state, thread.id, {
        kind: 'error',
        message: assistant.error,
        ts: Date.now(),
      });
    } else {
      assistant.status = 'done';
    }
    thread.updatedAt = Date.now();
    broadcast(state, thread.id, { kind: 'done', ts: Date.now() });
    void persistThread(state.projectPath, thread);
  });
}

// ─── team execution (sequential) ────────────────────────────────────────────

/**
 * Sequential pipeline: spawn each team member in order, piping the
 * previous step's output as context for the next. Each step gets the
 * agent's own system prompt (frontmatter description + body) and tool
 * allow-list. Failures or cancellations short-circuit the chain — later
 * steps stay queued so the renderer can show them as untouched.
 */
async function runTeamSequentialTurn(
  state: ProjectState,
  thread: ChatThread,
  assistant: ChatMessage,
  baseConfig: ChatConfig,
  team: TeamDef,
): Promise<void> {
  const claudeBin = await resolveClaudeBinary();
  if (!claudeBin) {
    assistant.status = 'error';
    assistant.error = 'claude binary not found on PATH';
    broadcast(state, thread.id, {
      kind: 'error',
      message: assistant.error,
      ts: Date.now(),
    });
    broadcast(state, thread.id, { kind: 'done', ts: Date.now() });
    await persistThread(state.projectPath, thread);
    return;
  }

  const allAgents = await listAgents(state.projectPath);
  const resolveAgent = (slug: string): AgentDef | null =>
    allAgents.find((a) => a.slug === slug) ?? null;

  // Pre-build steps so the renderer shows the full pipeline upfront
  // (queued items + a running indicator). Each step's agentName is
  // frozen here — if the user renames an agent mid-run, the run still
  // reads correctly.
  assistant.teamRun = {
    teamId: team.id,
    teamName: team.name,
    mode: 'sequential',
    steps: team.members.map((m): TeamStep => {
      const a = resolveAgent(m.agentSlug);
      return {
        agentSlug: m.agentSlug,
        agentName: a?.name ?? m.agentSlug,
        status: 'queued',
        content: '',
        toolCalls: [],
      };
    }),
  };
  await persistThread(state.projectPath, thread);

  broadcast(state, thread.id, {
    kind: 'status',
    message: `team-sequential: ${team.members.length} step(s)`,
    ts: Date.now(),
  });

  const userText =
    [...thread.messages]
      .reverse()
      .find((m) => m.role === 'user')?.content ?? '';

  const env = await resolveInteractiveShellEnv();

  for (let i = 0; i < team.members.length; i++) {
    const member = team.members[i]!;
    const step = assistant.teamRun.steps[i]!;
    const agent = resolveAgent(member.agentSlug);

    if (!agent) {
      step.status = 'error';
      step.error = `agent not found: ${member.agentSlug}`;
      broadcast(state, thread.id, {
        kind: 'team_step_end',
        stepIndex: i,
        stepAgent: member.agentSlug,
        message: step.error,
        ts: Date.now(),
      });
      // Mark following steps cancelled so the UI doesn't spin forever.
      for (let j = i + 1; j < assistant.teamRun.steps.length; j++) {
        assistant.teamRun.steps[j]!.status = 'cancelled';
      }
      break;
    }

    step.status = 'running';
    step.startedAt = Date.now();
    broadcast(state, thread.id, {
      kind: 'team_step_start',
      stepIndex: i,
      stepAgent: agent.slug,
      ts: Date.now(),
    });

    // Build the prompt for this step. We include the original user task,
    // a brief team roadmap so the agent knows where it sits in the
    // pipeline, and the verbatim output of prior steps. Then the
    // agent's own role description nudges its behavior.
    const prompt = buildSequentialStepPrompt(
      userText,
      team,
      assistant.teamRun.steps,
      i,
      agent,
    );

    // Each step uses the BASE config (project default / thread override)
    // as a floor, then layers the agent's own model + tools on top. The
    // agent's body is appended as a system-prompt addition so its
    // persona kicks in.
    const stepCfg: ChatConfig = mergeConfig(baseConfig, {
      model: member.modelOverride ?? agent.model ?? baseConfig.model,
      allowedTools: agent.tools ?? baseConfig.allowedTools,
      systemPromptAppend:
        (baseConfig.systemPromptAppend ?? '') +
        (baseConfig.systemPromptAppend ? '\n\n' : '') +
        `You are the "${agent.name}" agent. ${agent.description}\n\n${agent.body.trim()}`,
    });

    const stepArgs = buildClaudeArgs(stepCfg);

    logger.info(
      `spawn claude (team-seq step ${i + 1}/${team.members.length}) agent=${agent.slug} thread=${thread.id.slice(0, 8)}`,
    );

    const result = await runStreamingSpawn({
      state,
      thread,
      claudeBin,
      args: stepArgs,
      env,
      prompt,
      stepIndex: i,
      stepTarget: step,
    });

    step.finishedAt = Date.now();
    if (result.cancelled) {
      step.status = 'cancelled';
      // User stopped — leave remaining steps queued / cancelled but
      // don't continue the pipeline.
      for (let j = i + 1; j < assistant.teamRun.steps.length; j++) {
        assistant.teamRun.steps[j]!.status = 'cancelled';
      }
      assistant.status = 'cancelled';
      broadcast(state, thread.id, {
        kind: 'team_step_end',
        stepIndex: i,
        ts: Date.now(),
      });
      break;
    } else if (result.error) {
      step.status = 'error';
      step.error = result.error;
      broadcast(state, thread.id, {
        kind: 'team_step_end',
        stepIndex: i,
        message: result.error,
        ts: Date.now(),
      });
      assistant.status = 'error';
      assistant.error = `step ${i + 1} (${agent.slug}) failed: ${result.error}`;
      for (let j = i + 1; j < assistant.teamRun.steps.length; j++) {
        assistant.teamRun.steps[j]!.status = 'cancelled';
      }
      break;
    } else {
      step.status = 'done';
      broadcast(state, thread.id, {
        kind: 'team_step_end',
        stepIndex: i,
        ts: Date.now(),
      });
    }
    await persistThread(state.projectPath, thread);
  }

  if (assistant.status === 'streaming') {
    assistant.status = 'done';
  }
  thread.updatedAt = Date.now();
  broadcast(state, thread.id, { kind: 'done', ts: Date.now() });
  await persistThread(state.projectPath, thread);
}

function buildSequentialStepPrompt(
  userText: string,
  team: TeamDef,
  steps: TeamStep[],
  currentIndex: number,
  agent: AgentDef,
): string {
  const lines: string[] = [];
  lines.push(`You are part of the "${team.name}" team working on a user task.`);
  lines.push('');
  lines.push(`The user's request:`);
  lines.push(userText);
  lines.push('');
  lines.push(`Team pipeline (${steps.length} steps, executed in order):`);
  for (let i = 0; i < steps.length; i++) {
    const marker = i === currentIndex ? '→' : i < currentIndex ? '✓' : '·';
    lines.push(`  ${marker} step ${i + 1}: ${steps[i]!.agentName}`);
  }
  lines.push('');
  if (currentIndex > 0) {
    lines.push('Previous step outputs:');
    for (let i = 0; i < currentIndex; i++) {
      const s = steps[i]!;
      lines.push('');
      lines.push(`### Step ${i + 1} (${s.agentName}) said:`);
      lines.push(s.content || '(no text output — see tool calls)');
    }
    lines.push('');
  }
  lines.push(
    `You are step ${currentIndex + 1}: ${agent.name}. Focus on YOUR role. Output only your contribution — the next step will see this verbatim.`,
  );
  return lines.join('\n');
}

interface StreamingSpawnArgs {
  state: ProjectState;
  thread: ChatThread;
  claudeBin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  prompt: string;
  // When set, parsed events are routed into the team step at this index
  // and rebroadcast with the stepIndex field set. When unset, this is a
  // solo turn (not used today — runClaudeTurn handles its own parsing).
  stepIndex?: number;
  stepTarget: TeamStep;
}

interface StreamingSpawnResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  cancelled: boolean;
  error: string | null;
}

/**
 * Spawn one claude --print invocation, parse its stream-json output, and
 * mirror events into a team step. Returns a promise that resolves when
 * the child exits so the caller can await it in the sequential loop.
 * Each call wires state.activeChild so cancelActive() reaches the right
 * process even mid-pipeline.
 */
function runStreamingSpawn(
  opts: StreamingSpawnArgs,
): Promise<StreamingSpawnResult> {
  const { state, thread, claudeBin, args, env, prompt, stepIndex, stepTarget } =
    opts;
  return new Promise<StreamingSpawnResult>((resolve) => {
    const child = spawn(claudeBin, args, {
      cwd: state.projectPath,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    state.activeChild = child;
    state.activeThreadId = thread.id;
    child.stdin?.write(prompt);
    child.stdin?.end();

    let lineBuf = '';
    let stderrBuf = '';

    const handleLine = (raw: string) => {
      let evt: unknown;
      try {
        evt = JSON.parse(raw);
      } catch {
        return;
      }
      const e = evt as {
        type?: string;
        message?: {
          content?: Array<
            | { type: 'text'; text?: string }
            | { type: 'thinking'; thinking?: string }
            | {
                type: 'tool_use';
                id?: string;
                name?: string;
                input?: Record<string, unknown>;
              }
            | {
                type: 'tool_result';
                tool_use_id?: string;
                content?: string | { type?: string; text?: string }[];
                is_error?: boolean;
              }
          >;
        };
        usage?: { input_tokens?: number; output_tokens?: number };
      };

      if (e.type === 'assistant' && e.message?.content) {
        for (const block of e.message.content) {
          if (block.type === 'text' && block.text) {
            stepTarget.content += block.text;
            broadcast(state, thread.id, {
              kind: 'text_delta',
              text: block.text,
              stepIndex,
              ts: Date.now(),
            });
          } else if (block.type === 'thinking' && block.thinking) {
            stepTarget.thinking = (stepTarget.thinking ?? '') + block.thinking;
            broadcast(state, thread.id, {
              kind: 'thinking_delta',
              text: block.thinking,
              stepIndex,
              ts: Date.now(),
            });
          } else if (block.type === 'tool_use') {
            const id = block.id ?? randomUUID();
            stepTarget.toolCalls.push({
              id,
              name: block.name ?? 'tool',
              input: block.input ?? {},
            });
            broadcast(state, thread.id, {
              kind: 'tool_use',
              toolUseId: id,
              toolName: block.name,
              toolInput: block.input,
              stepIndex,
              ts: Date.now(),
            });
          }
        }
      } else if (e.type === 'user' && e.message?.content) {
        for (const block of e.message.content) {
          if (block.type === 'tool_result') {
            const text =
              typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? block.content
                      .map((c) =>
                        typeof c === 'object' && c?.type === 'text'
                          ? (c.text ?? '')
                          : '',
                      )
                      .join('')
                  : '';
            const tu = stepTarget.toolCalls.find(
              (c) => c.id === block.tool_use_id,
            );
            if (tu) {
              tu.result = text;
              tu.isError = !!block.is_error;
            }
            broadcast(state, thread.id, {
              kind: 'tool_result',
              toolUseId: block.tool_use_id,
              toolResult: text,
              toolIsError: !!block.is_error,
              stepIndex,
              ts: Date.now(),
            });
          }
        }
      } else if (e.type === 'result' && e.usage) {
        stepTarget.usage = {
          input: e.usage.input_tokens ?? 0,
          output: e.usage.output_tokens ?? 0,
        };
        broadcast(state, thread.id, {
          kind: 'usage',
          inputTokens: e.usage.input_tokens,
          outputTokens: e.usage.output_tokens,
          stepIndex,
          ts: Date.now(),
        });
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      lineBuf += chunk.toString('utf8');
      let nl: number;
      while ((nl = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (line) handleLine(line);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      state.activeChild = null;
      resolve({
        exitCode: null,
        signal: null,
        cancelled: false,
        error: err.message,
      });
    });
    child.on('exit', (code, signal) => {
      if (lineBuf.trim()) handleLine(lineBuf.trim());
      state.activeChild = null;
      state.activeThreadId = null;
      const cancelled = signal === 'SIGTERM' || signal === 'SIGKILL';
      let error: string | null = null;
      if (!cancelled && code !== 0) {
        error = stderrBuf.trim().slice(-500) || `claude exited ${code}`;
      }
      resolve({ exitCode: code, signal, cancelled, error });
    });
  });
}
