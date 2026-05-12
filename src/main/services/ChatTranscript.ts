// ChatTranscript — disk persistence, per-project state container, and
// thread CRUD for chat. Owns the in-memory `states` Map that everything
// else in the chat subsystem reads / mutates, and is the single place
// that writes thread JSON to .devspace/chat/<id>.json.
//
// Split out of ChatService so the orchestration layer (spawning claude,
// finalize logic, resume-on-boot) can stay focused on turn execution
// without also juggling the storage layer. ChatService re-exports the
// thread CRUD functions so the IPC layer's imports don't change.

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WebContents } from 'electron';

import { type ChatRunHandle } from '@main/services/TmuxChatRunner';
import { createLogger } from '@shared/logger';
import type { ChatConfig, ChatEvent, ChatThread } from '@shared/types';

const logger = createLogger('ChatTranscript');

// One persisted JSON file per thread. Lives alongside codeflow + augment
// in .devspace/ so codeflow's `.claude/` doesn't accidentally swallow chat
// state (Claude's harness blocks writes there).
export function threadsDir(projectPath: string): string {
  return path.join(projectPath, '.devspace', 'chat');
}

export function threadFile(projectPath: string, threadId: string): string {
  return path.join(threadsDir(projectPath), `${threadId}.json`);
}

export interface ProjectState {
  projectPath: string;
  threads: Map<string, ChatThread>; // by threadId
  // Live tmux-backed run handle for any in-flight turn. One at a time
  // per project — same model as Claude Code CLI; queuing is the user's
  // problem if they want multiple turns at once. The handle is what
  // cancelActive() reaches for to kill-session the tmux backend.
  activeRunHandle: ChatRunHandle | null;
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

// Hook invoked once per project, after hydrateFromDisk completes inside
// getState(). ChatService registers resumeActiveRuns here so it doesn't
// need to import private state. Optional — leaving it null disables the
// resume-on-first-access behavior (useful in tests).
let postHydrateHook: ((state: ProjectState) => Promise<void>) | null = null;

export function registerPostHydrate(
  hook: (state: ProjectState) => Promise<void>,
): void {
  postHydrateHook = hook;
}

export function getState(projectPath: string): ProjectState {
  const key = path.resolve(projectPath);
  let state = states.get(key);
  if (!state) {
    state = {
      projectPath: key,
      threads: new Map(),
      activeRunHandle: null,
      activeThreadId: null,
      subscribers: new Set(),
      hydrationPromise: Promise.resolve(),
    };
    states.set(key, state);
    state.hydrationPromise = hydrateFromDisk(state)
      .then(async () => {
        if (postHydrateHook) await postHydrateHook(state!);
      })
      .catch((err) => {
        logger.warn(`hydrate failed for ${key}: ${(err as Error).message}`);
      });
  }
  return state;
}

// Look up an existing state without creating one. Used by cancelActive
// — there's nothing to cancel if no IPC has touched the project yet.
export function lookupState(projectPath: string): ProjectState | undefined {
  return states.get(path.resolve(projectPath));
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

export async function persistThread(
  projectPath: string,
  thread: ChatThread,
): Promise<void> {
  const file = threadFile(projectPath, thread.id);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify(thread, null, 2));
}

export function broadcast(
  state: ProjectState,
  threadId: string,
  event: ChatEvent,
): void {
  for (const wc of state.subscribers) {
    if (!wc.isDestroyed()) {
      wc.send('chat:event', { projectPath: state.projectPath, threadId, event });
    }
  }
}

// ─── thread CRUD (IPC surface) ──────────────────────────────────────────────

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
