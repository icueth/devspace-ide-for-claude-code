import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WebContents } from 'electron';

import { resolveClaudeBinary } from '@main/services/ClaudeCliLauncher';
import { resolveInteractiveShellEnv } from '@main/utils/shellEnv';
import { createLogger } from '@shared/logger';
import type {
  ChatEvent,
  ChatMessage,
  ChatSendRequest,
  ChatThread,
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

interface ProjectState {
  projectPath: string;
  threads: Map<string, ChatThread>; // by threadId
  // The live child process for any in-flight turn. One at a time per
  // project — same model as Claude Code CLI; queuing is the user's
  // problem if they want multiple turns at once.
  activeChild: ChildProcess | null;
  activeThreadId: string | null;
  subscribers: Set<WebContents>;
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
    };
    states.set(key, state);
    void hydrateFromDisk(state).catch((err) =>
      logger.warn(`hydrate failed for ${key}: ${(err as Error).message}`),
    );
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

// ─── public API ─────────────────────────────────────────────────────────────

export function subscribe(projectPath: string, wc: WebContents): void {
  const s = getState(projectPath);
  s.subscribers.add(wc);
  wc.once('destroyed', () => s.subscribers.delete(wc));
}

export async function listThreads(projectPath: string): Promise<ChatThread[]> {
  const s = getState(projectPath);
  // Wait for hydration to complete on first call — otherwise the renderer's
  // initial mount sees an empty list even when threads exist on disk.
  await new Promise<void>((resolve) => setImmediate(resolve));
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

  // Kick off the spawn but don't await it — caller wants the message id
  // synchronously so it can render the streaming placeholder.
  void runClaudeTurn(s, thread, assistantMsg).catch((err) => {
    logger.error(`chat turn failed: ${(err as Error).message}`);
  });

  return { messageId: assistantMsg.id };
}

async function runClaudeTurn(
  state: ProjectState,
  thread: ChatThread,
  assistant: ChatMessage,
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
  const args = [
    '--print',
    '--permission-mode',
    'bypassPermissions', // chat UI can't render TTY approvals
    '--output-format',
    'stream-json',
    '--verbose',
  ];

  logger.info(
    `spawn claude (chat) thread=${thread.id.slice(0, 8)} cwd=${state.projectPath}`,
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
