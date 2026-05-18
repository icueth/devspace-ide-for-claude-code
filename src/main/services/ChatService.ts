// ChatService — orchestration layer for chat turns. Owns the
// claude-binary spawn lifecycle (solo + team-sequential), the
// configuration merge logic, and the resume-on-boot handler that
// re-attaches to tmux runs left in flight by a prior app session.
//
// Storage / state / thread CRUD lives in ChatTranscript.
// JSONL parsing + line mutation lives in ChatLineHandler.
// Tmux process management lives in TmuxChatRunner.
//
// IPC surface (registerChatIpc) imports its 9 handler functions from
// here, so this module re-exports thread CRUD from ChatTranscript to
// keep the import path stable across the refactor.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { listAgents } from '@main/services/AgentsService';
import { resolveClaudeBinary } from '@main/services/ClaudeCliLauncher';
import {
  makeSoloLineHandler,
  makeStepLineHandler,
} from '@main/services/ChatLineHandler';
import {
  type ProjectState,
  broadcast,
  deleteThread as transcriptDeleteThread,
  getState,
  lookupState,
  persistThread,
  registerPostHydrate,
} from '@main/services/ChatTranscript';
import {
  buildInjectPreamble as buildDevlogPreamble,
  createEntry as createDevlogEntry,
  getSettings as getDevlogSettings,
} from '@main/services/DevlogService';
import {
  getSettings as getForgeSettings,
  proposeFromChat as forgeProposeFromChat,
  recordSignal as recordForgeSignal,
} from '@main/services/ForgeService';
import {
  buildInjectPreamble,
  summarizeThread as memorySummarizeThread,
} from '@main/services/MemoryService';
import { getTeam } from '@main/services/TeamsService';
import {
  type ChatRunHandle,
  attachToRun,
  newRunId,
  startChatRun,
} from '@main/services/TmuxChatRunner';
import { resolveInteractiveShellEnv } from '@main/utils/shellEnv';
import { createLogger } from '@shared/logger';
import type {
  AgentDef,
  ChatConfig,
  ChatMessage,
  ChatSendRequest,
  ChatThread,
  TeamDef,
  TeamStep,
} from '@shared/types';

const logger = createLogger('Chat');

// Re-export thread CRUD / config-IPC surface from the storage layer so
// the IPC registration file (main/ipc/chat.ts) imports stay stable.
// Note: `deleteThread` is intentionally NOT re-exported as-is — we wrap
// it below so the memory subsystem gets a chance to summarize the
// thread before its JSON file is unlinked.
export {
  createThread,
  listThreads,
  subscribe,
  updateThreadConfig,
} from '@main/services/ChatTranscript';

/**
 * Delete a chat thread, but first ask MemoryService to persist a
 * thread summary so the Dashboard's "Threads" view keeps content
 * even after the raw JSON is gone. The summarize call is
 * fire-and-forget at the failure level — if it throws we log and
 * continue with the delete (losing the thread is worse than losing
 * its summary).
 */
export async function deleteThread(
  projectPath: string,
  threadId: string,
): Promise<void> {
  try {
    await memorySummarizeThread({ projectPath, threadId });
  } catch (err) {
    logger.warn(
      `memory.summarizeThread failed for ${threadId.slice(0, 8)}: ${(err as Error).message}`,
    );
  }
  await transcriptDeleteThread(projectPath, threadId);
}

// Project-level default chat config — applied to every new thread unless
// the thread itself sets a config override. One file per project so
// switching workspaces gives a clean slate without leaking the wrong
// model / system prompt across projects.
function chatConfigFile(projectPath: string): string {
  return path.join(projectPath, '.devspace', 'chat-config.json');
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

// ─── public API: config IO ──────────────────────────────────────────────────

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

export async function cancelActive(projectPath: string): Promise<void> {
  const s = lookupState(projectPath);
  if (!s || !s.activeRunHandle) return;
  // Await tmux kill-session so any failure (session already gone, tmux
  // binary missing) surfaces to the IPC caller and the renderer can
  // show an error toast. The tail loop still notices the session
  // disappear and resolves with cancelled=true, which fires the same
  // finalize path as a normal exit.
  try {
    await s.activeRunHandle.kill();
  } catch (err) {
    logger.warn(`cancel kill failed: ${(err as Error).message}`);
    throw err;
  }
}

// ─── turn execution ─────────────────────────────────────────────────────────

/**
 * Send a user message, spawn claude-headless with the full history as
 * stdin, parse its stream-json output into normalized ChatEvent objects,
 * and stream them to every subscribed WebContents. Persists the final
 * message pair to disk when the turn completes.
 *
 * One concurrent turn per project. Calls during an active turn throw so
 * the caller can show a "stop the current run first" notice.
 */
export async function sendMessage(req: ChatSendRequest): Promise<{ messageId: string }> {
  const s = getState(req.projectId);
  await s.hydrationPromise; // wait for resume-on-boot before checking active state
  const thread = s.threads.get(req.threadId);
  if (!thread) throw new Error(`thread not found: ${req.threadId}`);
  if (s.activeRunHandle) {
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
  // v0.24: implicit Forge signal detection. Inspect the user text
  // against the IMMEDIATELY-PREVIOUS assistant turn — if we detect a
  // thanks/correction/abandoned cue, emit a forge_signal event so the
  // ForgeService can bump the per-skill counters for every key in
  // prev.loadedSkillKeys. Fire-and-forget — chat must never block on
  // this. See detectForgeSignal() at the bottom of this module.
  try {
    const prev = lastAssistantMessage(thread);
    if (prev) {
      const detected = detectForgeSignal(req.text, userMsg.createdAt, prev.createdAt);
      if (detected) {
        // Settings gate is async — broadcast / record only after the
        // settings check resolves so a disabled toggle doesn't leak
        // events. Fire-and-forget so the chat path isn't blocked.
        const detectedKind = detected;
        const prevId = prev.id;
        const keys = prev.loadedSkillKeys ?? [];
        void forgeSignalAllowed(detectedKind).then((ok) => {
          if (!ok) return;
          broadcast(s, thread.id, {
            kind: 'forge_signal',
            forgeSignal: detectedKind,
            prevAssistantId: prevId,
            ts: Date.now(),
          });
          for (const key of keys) {
            recordForgeSignal({
              projectPath: s.projectPath,
              key,
              messageId: prevId,
              signal: detectedKind,
            }).catch((err) => {
              logger.warn(`forge recordSignal failed: ${(err as Error).message}`);
            });
          }
        });
      }
    }
  } catch (err) {
    logger.warn(`forge signal detection threw: ${(err as Error).message}`);
  }
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
  let effective = mergeConfig(projectDefault, thread.config, req.config);

  // Memory injection: ONCE per thread, on whichever turn happens first
  // after the thread is created — not "first turn after resume". A
  // persisted `thread.memoryInjected` flag avoids count-based heuristics
  // that mis-fire on hydrated/retried threads. Capped server-side by
  // MemorySettings.maxInjectLines. Best-effort: empty preamble or
  // failure = pass-through. SEC: the preamble is fenced as untrusted
  // reference data by buildInjectPreamble — Claude won't treat memory
  // content as system-prompt instructions.
  if (!thread.memoryInjected) {
    try {
      const memoryPre = await buildInjectPreamble(s.projectPath);
      // Devlog preamble lives in its own fence so Claude can pattern-
      // match the source — never throws (DevlogService swallows at the
      // boundary). Both blocks get prepended to systemPromptAppend in
      // sequence so the prior config / orchestrator prompt still flows
      // after them.
      const devlogPre = await buildDevlogPreamble(s.projectPath).catch(
        (err) => {
          logger.warn(`devlog inject failed: ${(err as Error).message}`);
          return '';
        },
      );
      const prior = effective.systemPromptAppend ?? '';
      const blocks: string[] = [];
      if (memoryPre) blocks.push(`## Project memory\n\n${memoryPre}`);
      if (devlogPre) blocks.push(devlogPre);
      if (prior) blocks.push(prior);
      if (blocks.length > 0) {
        effective = mergeConfig(effective, {
          systemPromptAppend: blocks.join('\n\n---\n\n').trimEnd(),
        });
      }
      thread.memoryInjected = true;
      await persistThread(s.projectPath, thread);
    } catch (err) {
      logger.warn(`memory inject failed: ${(err as Error).message}`);
    }
  }

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

// Truncate the agent's output (the `text` field of the tool_result)
// before persisting it to the devlog. 4KB is enough to give the user
// a glance-able summary in the dashboard without bloating per-thread
// auto-capture into a runaway disk-write.
const MAX_AGENT_OUTPUT_BYTES = 4 * 1024;

function truncateAgentOutput(raw: string): string {
  if (!raw) return '';
  const buf = Buffer.from(raw, 'utf8');
  if (buf.byteLength <= MAX_AGENT_OUTPUT_BYTES) return raw;
  const trimmed = buf.slice(0, MAX_AGENT_OUTPUT_BYTES).toString('utf8');
  return `${trimmed}\n\n_(truncated to ${MAX_AGENT_OUTPUT_BYTES}B)_`;
}

// Auto-capture a completed Task() dispatch into the per-project
// devlog. Gated on DevlogSettings.autoCaptureAgents — when off, this
// is a no-op. Never throws (wrapped at the call site too); a devlog
// write failure must never break chat finalize.
async function captureTaskToDevlog(
  projectPath: string,
  ev: {
    toolUseId: string;
    subagentType: string;
    description: string;
    durationMs: number;
    isError: boolean;
    output: string;
    threadId: string;
  },
): Promise<void> {
  try {
    const settings = await getDevlogSettings(projectPath);
    if (!settings.enabled || !settings.autoCaptureAgents) return;
    const title = ev.description
      ? `${ev.subagentType}: ${ev.description}`
      : ev.subagentType;
    const body =
      (ev.description ? `**${ev.description}**\n\n` : '') +
      truncateAgentOutput(ev.output);
    await createDevlogEntry({
      projectPath,
      type: 'agent',
      title,
      body,
      subagentType: ev.subagentType,
      durationMs: ev.durationMs,
      verdict: ev.isError ? 'failed' : 'success',
      threadId: ev.threadId,
      toolUseId: ev.toolUseId,
    });
  } catch (err) {
    logger.warn(`devlog auto-capture failed: ${(err as Error).message}`);
  }
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

  // Forward ref: line handler needs handle.kill but handle isn't built
  // until startChatRun returns. The closure binds late, so by the time
  // an AskUserQuestion tool_use arrives via onLine the handle is set.
  let runHandleRef: ChatRunHandle | null = null;
  const handleLine = makeSoloLineHandler(
    state,
    thread,
    assistant,
    () => {
      logger.info(
        `AskUserQuestion in thread=${thread.id.slice(0, 8)} — early-finalizing run`,
      );
      runHandleRef?.kill().catch((err) => {
        logger.warn(`kill on AskUserQuestion failed: ${(err as Error).message}`);
      });
    },
    (ev) => {
      // Devlog auto-capture for Task() dispatches. Fire-and-forget; the
      // chat finalize path must never wait on (or break from) this.
      void captureTaskToDevlog(state.projectPath, ev).catch((err) => {
        logger.warn(`devlog capture failed: ${(err as Error).message}`);
      });
    },
  );

  logger.info(
    `spawn claude (chat) thread=${thread.id.slice(0, 8)} cwd=${state.projectPath} model=${config.model ?? 'default'} tools=${config.allowedTools?.length ?? 'all'}`,
  );

  const runId = newRunId();
  let handle: ChatRunHandle;
  try {
    handle = await startChatRun({
      projectId: state.projectPath,
      threadId: thread.id,
      runId,
      cwd: state.projectPath,
      claudeBin,
      args,
      env: { ...process.env, ...env },
      prompt,
      runRoot: path.join(state.projectPath, '.devspace', 'chat'),
      onLine: handleLine,
    });
    runHandleRef = handle;
  } catch (err) {
    assistant.status = 'error';
    assistant.error = (err as Error).message;
    broadcast(state, thread.id, {
      kind: 'error',
      message: assistant.error,
      ts: Date.now(),
    });
    broadcast(state, thread.id, { kind: 'done', ts: Date.now() });
    await persistThread(state.projectPath, thread);
    return;
  }

  state.activeRunHandle = handle;
  state.activeThreadId = thread.id;
  thread.activeRun = {
    runId,
    sessionName: handle.sessionName,
    runDir: handle.runDir,
    startedAt: Date.now(),
    assistantMessageId: assistant.id,
    kind: 'solo',
  };
  await persistThread(state.projectPath, thread);

  broadcast(state, thread.id, {
    kind: 'status',
    message: handle.detached ? 'running (tmux)' : 'running',
    ts: Date.now(),
  });

  await finalizeSoloRun(state, thread, assistant, handle);
}

// Wait for the run to terminate, then update the assistant message +
// thread state. Hoisted out of runClaudeTurn so resumeActiveRuns() can
// drive the same finalize path when reattaching to an in-flight run.
async function finalizeSoloRun(
  state: ProjectState,
  thread: ChatThread,
  assistant: ChatMessage,
  handle: ChatRunHandle,
): Promise<void> {
  const result = await handle.promise;

  // Only clear active state if WE are still the owner — defensive
  // against a race where the user already started another run.
  if (state.activeRunHandle === handle) {
    state.activeRunHandle = null;
    state.activeThreadId = null;
  }
  delete thread.activeRun;

  if (assistant.awaitingUserAnswer) {
    // Claude called AskUserQuestion and we killed the run early. Treat
    // the turn as a clean completion — user's next message resumes the
    // conversation with full history including the question + answer.
    assistant.status = 'done';
  } else if (result.cancelled) {
    assistant.status = 'cancelled';
  } else if (result.error) {
    assistant.status = 'error';
    assistant.error = result.error;
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
  await persistThread(state.projectPath, thread);

  // v0.24: forge auto-suggestion. Scan the last ~200 turns of this thread
  // for repeated patterns (questions, file pairs, boilerplate blocks) and
  // surface as suggestions in the project's forge inbox. Fire-and-forget —
  // chat must never block on it. The service self-gates on autoSuggest
  // setting; on 'off' it returns early.
  void forgeProposeFromChat({
    projectPath: state.projectPath,
    threadId: thread.id,
    messages: thread.messages.slice(-200).map((m) => ({
      role: m.role,
      content: m.content,
      ts: m.createdAt,
      filesTouched: m.toolCalls
        ?.flatMap((tc) =>
          tc.diffStats?.path ? [tc.diffStats.path] : [],
        ),
    })),
  }).catch((err) => {
    logger.warn(`forge proposeFromChat failed: ${(err as Error).message}`);
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

  const shellEnv = await resolveInteractiveShellEnv();
  const env: NodeJS.ProcessEnv = { ...process.env, ...shellEnv };

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
      assistant,
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
  assistant: ChatMessage;
  claudeBin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  prompt: string;
  stepIndex: number;
  stepTarget: TeamStep;
}

interface StreamingSpawnResult {
  exitCode: number | null;
  cancelled: boolean;
  error: string | null;
}

/**
 * Spawn one claude --print invocation INSIDE a detached tmux session,
 * parse its stream-json output via tail, and mirror events into a team
 * step. Resolves when the run terminates so the sequential loop can
 * await it. Persists activeRun on the thread so a mid-pipeline restart
 * can resume this exact step on next app boot.
 */
async function runStreamingSpawn(
  opts: StreamingSpawnArgs,
): Promise<StreamingSpawnResult> {
  const {
    state,
    thread,
    assistant,
    claudeBin,
    args,
    env,
    prompt,
    stepIndex,
    stepTarget,
  } = opts;

  const handleLine = makeStepLineHandler(state, thread, stepTarget, stepIndex);
  const runId = newRunId();

  let handle: ChatRunHandle;
  try {
    handle = await startChatRun({
      projectId: state.projectPath,
      threadId: thread.id,
      runId,
      cwd: state.projectPath,
      claudeBin,
      args,
      env,
      prompt,
      runRoot: path.join(state.projectPath, '.devspace', 'chat'),
      onLine: handleLine,
    });
  } catch (err) {
    return {
      exitCode: null,
      cancelled: false,
      error: (err as Error).message,
    };
  }

  state.activeRunHandle = handle;
  state.activeThreadId = thread.id;
  thread.activeRun = {
    runId,
    sessionName: handle.sessionName,
    runDir: handle.runDir,
    startedAt: Date.now(),
    assistantMessageId: assistant.id,
    kind: 'team-step',
    stepIndex,
  };
  await persistThread(state.projectPath, thread);

  const result = await handle.promise;

  if (state.activeRunHandle === handle) {
    state.activeRunHandle = null;
    state.activeThreadId = null;
  }
  delete thread.activeRun;

  return {
    exitCode: result.exitCode,
    cancelled: result.cancelled,
    error: result.error,
  };
}

// ─── resume on boot ─────────────────────────────────────────────────────────

// Walk every hydrated thread looking for activeRun records, then re-
// attach a watcher to each one's runDir. The tmux session may have:
//   1. finished cleanly while the app was closed — done file present,
//      we finalize from the saved exit code without spawning anything
//   2. still be running — we resume tailing out.jsonl from offset 0 so
//      the renderer sees everything that's been streamed so far, then
//      keep streaming new events as claude writes them
//   3. been killed (no tmux session, no done file) — finalize as
//      cancelled
//
// Only solo runs get full pipeline continuation on resume. Team-step
// runs resume the in-flight step but the pipeline does NOT continue
// past it (the remaining steps get marked cancelled). Re-running the
// whole turn is the user's job — keeping this simple sidesteps the
// "did the base config change?" problem.
async function resumeActiveRuns(state: ProjectState): Promise<void> {
  for (const thread of state.threads.values()) {
    if (!thread.activeRun) continue;
    // Defensive: a malformed thread JSON could leave assistantMessageId
    // pointing at a non-existent message. Just clear and move on.
    const run = thread.activeRun;
    const assistant = thread.messages.find((m) => m.id === run.assistantMessageId);
    if (!assistant) {
      logger.warn(
        `thread ${thread.id.slice(0, 8)} has activeRun pointing at missing message — clearing`,
      );
      delete thread.activeRun;
      await persistThread(state.projectPath, thread);
      continue;
    }

    if (state.activeRunHandle) {
      logger.warn(
        `thread ${thread.id.slice(0, 8)} resume skipped — another run already active`,
      );
      continue;
    }

    logger.info(
      `resuming chat run thread=${thread.id.slice(0, 8)} runId=${run.runId} kind=${run.kind}`,
    );

    if (run.kind === 'solo') {
      const handleLine = makeSoloLineHandler(state, thread, assistant);
      const handle = await attachToRun({
        sessionName: run.sessionName,
        runDir: run.runDir,
        onLine: handleLine,
      });
      state.activeRunHandle = handle;
      state.activeThreadId = thread.id;
      broadcast(state, thread.id, {
        kind: 'status',
        message: 'resumed (tmux)',
        ts: Date.now(),
      });
      void finalizeSoloRun(state, thread, assistant, handle);
    } else if (run.kind === 'team-step') {
      const stepIndex = run.stepIndex ?? -1;
      const step = assistant.teamRun?.steps[stepIndex];
      if (!step) {
        logger.warn(
          `thread ${thread.id.slice(0, 8)} team-step resume: step ${stepIndex} missing`,
        );
        delete thread.activeRun;
        await persistThread(state.projectPath, thread);
        continue;
      }
      const handleLine = makeStepLineHandler(state, thread, step, stepIndex);
      const handle = await attachToRun({
        sessionName: run.sessionName,
        runDir: run.runDir,
        onLine: handleLine,
      });
      state.activeRunHandle = handle;
      state.activeThreadId = thread.id;
      broadcast(state, thread.id, {
        kind: 'status',
        message: `resumed step ${stepIndex + 1} (tmux)`,
        ts: Date.now(),
      });
      void finalizeResumedTeamStep(state, thread, assistant, step, stepIndex, handle);
    }
  }
}

// Mirror of finalizeSoloRun for resumed team steps. We DON'T continue
// the pipeline past this step — the user gets the in-flight step's
// output and any later steps stay 'cancelled'. Resending picks up from
// scratch with fresh team config + base config.
async function finalizeResumedTeamStep(
  state: ProjectState,
  thread: ChatThread,
  assistant: ChatMessage,
  step: TeamStep,
  stepIndex: number,
  handle: ChatRunHandle,
): Promise<void> {
  const result = await handle.promise;

  if (state.activeRunHandle === handle) {
    state.activeRunHandle = null;
    state.activeThreadId = null;
  }
  delete thread.activeRun;

  step.finishedAt = Date.now();
  if (result.cancelled) {
    step.status = 'cancelled';
    assistant.status = 'cancelled';
  } else if (result.error) {
    step.status = 'error';
    step.error = result.error;
    assistant.status = 'error';
    assistant.error = `step ${stepIndex + 1} (${step.agentSlug}) failed: ${result.error}`;
  } else {
    step.status = 'done';
    // Don't auto-continue: mark every later step cancelled so the UI
    // doesn't spin forever and the user knows the run didn't proceed.
    if (assistant.teamRun) {
      for (let j = stepIndex + 1; j < assistant.teamRun.steps.length; j++) {
        const later = assistant.teamRun.steps[j]!;
        if (later.status === 'queued' || later.status === 'running') {
          later.status = 'cancelled';
        }
      }
    }
    if (assistant.status === 'streaming') assistant.status = 'cancelled';
  }
  broadcast(state, thread.id, {
    kind: 'team_step_end',
    stepIndex,
    message: result.error ?? undefined,
    ts: Date.now(),
  });
  thread.updatedAt = Date.now();
  broadcast(state, thread.id, { kind: 'done', ts: Date.now() });
  await persistThread(state.projectPath, thread);
}

// Wire resume-on-hydrate into the transcript layer. This runs once per
// project, the first time anything touches getState() — typically the
// renderer's listThreads IPC on chat panel mount. Tying it to module
// load (instead of e.g. main.ts boot) keeps the dependency wiring local.
registerPostHydrate(resumeActiveRuns);

// ─── Forge signal detection ────────────────────────────────────────────────
//
// v0.24: when a new user message arrives, scan the text for cues that
// implicitly rate the prior assistant turn. Three signals:
//
//   - thanks      → matches /(thank|thanks|perfect|exactly|ตรง|ใช่|ขอบคุณ|👍)/i
//   - correction  → matches /(ไม่ใช่|ผิด|stop|don't|wrong|no that|that's wrong)/i
//   - abandoned   → user message arrives ≥5 minutes after the prev
//                    assistant turn (topic-shift detection deferred to
//                    v0.25; the gap heuristic is the v0.24 baseline)
//
// Settings gating lives in ForgeSettings — when disabled we silently
// return null so no signal is emitted.

const THANKS_RE = /(thank|thanks|perfect|exactly|ตรง|ใช่|ขอบคุณ|👍)/i;
// Tightened in CR-6 review: anchor to sentence-start signals so benign
// phrases like "don't forget to commit" / "stop the dev server" / "the
// wrong file is on prod" don't poison stats. Required form: phrase begins
// at the start of the message (or just after newline).
const CORRECTION_RE =
  /(^|\n)\s*(ไม่ใช่|ผิด|stop\b|don'?t (do|use|add|change)|that'?s wrong|no that|wrong[, ]|no[, ])/i;
const ABANDONED_GAP_MS = 5 * 60 * 1000;
// Cap on how long an "abandoned" claim can be inferred from a clock gap:
// if the user-message timestamp is more than this far behind wall-clock
// (e.g. laptop slept overnight then resumed), suppress the abandoned
// signal — we can't tell stale-thread-resumption from genuine give-up.
const ABANDONED_FRESHNESS_MS = 60 * 1000;

// Cached forge settings — refreshed on a short TTL so we don't read
// disk every user turn. We don't have a per-project cache here because
// the chat path doesn't know the projectPath until sendMessage runs; the
// service caches per-project itself, this TTL just smooths the
// chat-side fanout.
let cachedForgeSettings: import('@shared/types').ForgeSettings | null = null;
let cachedForgeSettingsExpiry = 0;
const FORGE_SETTINGS_TTL_MS = 30_000;

async function loadForgeSettingsCached(): Promise<
  import('@shared/types').ForgeSettings | null
> {
  const now = Date.now();
  if (cachedForgeSettings && now < cachedForgeSettingsExpiry) {
    return cachedForgeSettings;
  }
  try {
    const s = await getForgeSettings();
    cachedForgeSettings = s;
    cachedForgeSettingsExpiry = now + FORGE_SETTINGS_TTL_MS;
    return s;
  } catch (err) {
    logger.warn(`load forge settings failed: ${(err as Error).message}`);
    return null;
  }
}

// Pure helper — exported for tests. Returns the detected signal kind
// or null. Settings gating happens in the caller (sendMessage) before
// emitting the event — keeping detection pure lets the unit test pin
// regex behavior without spinning up the whole service.
export function detectForgeSignal(
  userText: string,
  userTs: number,
  prevAssistantTs: number,
  now: number = Date.now(),
): 'thanks' | 'correction' | 'abandoned' | null {
  if (typeof userText !== 'string' || userText.length === 0) return null;
  // Strip fenced code blocks before regex match so "stop the dev server"
  // inside a paste doesn't trigger a correction.
  const stripped = userText.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  // Correction wins over thanks if both match — a "no thanks, that's
  // wrong" message is clearly a correction.
  if (CORRECTION_RE.test(stripped)) return 'correction';
  if (THANKS_RE.test(stripped)) return 'thanks';
  // Abandoned gap detection — only fires when the user message is FRESH
  // (composed within the last minute of wall-clock). Avoids classifying a
  // post-suspend wake-up message as an abandonment of yesterday's chat.
  if (
    userTs - prevAssistantTs >= ABANDONED_GAP_MS &&
    now - userTs <= ABANDONED_FRESHNESS_MS
  ) {
    return 'abandoned';
  }
  return null;
}

// Use loadForgeSettingsCached at the boundary in sendMessage. We don't
// gate it inside detectForgeSignal to keep the helper pure for tests.
// Wire it up here as a wrapper used only by sendMessage — but we want
// to keep the change minimal, so the recordForgeSignal call sites in
// sendMessage already swallow errors. Gate via settings before
// recording. Returns true when the kind is allowed by current settings.
async function forgeSignalAllowed(
  kind: 'thanks' | 'correction' | 'abandoned',
): Promise<boolean> {
  const s = await loadForgeSettingsCached();
  if (!s || !s.enabled) return false;
  if (kind === 'thanks') return s.implicitThanks;
  if (kind === 'correction') return s.implicitCorrection;
  if (kind === 'abandoned') return s.implicitAbandoned;
  return false;
}

// Reach the last assistant message in a thread — small helper used by
// the signal detection path. Exported for tests.
export function lastAssistantMessage(thread: ChatThread): ChatMessage | null {
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const m = thread.messages[i]!;
    if (m.role === 'assistant') return m;
  }
  return null;
}

// Re-export so the IPC handler can be tested without importing service
// internals.
export { forgeSignalAllowed };

