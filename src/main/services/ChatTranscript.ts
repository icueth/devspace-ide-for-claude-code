// ChatTranscript — disk persistence, per-project state container, and
// thread CRUD for chat. Owns the in-memory `states` Map that everything
// else in the chat subsystem reads / mutates, and is the single place
// that writes thread JSON to .devspace/chat/<id>.json.

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WebContents } from 'electron';

import { type ChatRunHandle } from '@main/services/TmuxChatRunner';
import { createLogger } from '@shared/logger';
import type { ChatConfig, ChatEvent, ChatThread } from '@shared/types';

const logger = createLogger('ChatTranscript');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s);
}

export function threadsDir(projectPath: string): string {
  return path.join(projectPath, '.devspace', 'chat');
}

export function threadFile(projectPath: string, threadId: string): string {
  return path.join(threadsDir(projectPath), `${threadId}.json`);
}

export interface ProjectState {
  projectPath: string;
  threads: Map<string, ChatThread>;
  activeRunHandle: ChatRunHandle | null;
  activeThreadId: string | null;
  subscribers: Set<WebContents>;
  hydrationPromise: Promise<void>;
}

const states = new Map<string, ProjectState>();

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

export function lookupState(projectPath: string): ProjectState | undefined {
  return states.get(path.resolve(projectPath));
}

const MAX_SEGMENTS_PER_MESSAGE = 5000;
const MAX_TEXT_SEGMENT_CHARS = 500_000;

function isValidSegment(s: unknown): boolean {
  if (!s || typeof s !== 'object') return false;
  const x = s as Record<string, unknown>;
  if (typeof x.id !== 'string') return false;
  if (x.kind === 'text') {
    return typeof x.text === 'string' && x.text.length <= MAX_TEXT_SEGMENT_CHARS;
  }
  if (x.kind === 'tool_group') {
    return (
      Array.isArray(x.toolUseIds) &&
      x.toolUseIds.every((id) => typeof id === 'string') &&
      x.toolUseIds.length <= 1000
    );
  }
  return false;
}

/**
 * Reject a run handle that escapes the threads directory. Hostile chat
 * JSON could otherwise set activeRun.runDir to anywhere on disk; downstream
 * tmux runner concatenates with runRoot to build write paths.
 */
function isRunDirSafe(runDir: unknown, projectPath: string): boolean {
  if (typeof runDir !== 'string') return false;
  const resolved = path.resolve(runDir);
  const root = threadsDir(projectPath) + path.sep;
  return resolved === threadsDir(projectPath) || resolved.startsWith(root);
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
    // Filename must be <uuid>.json — anything else is hostile or stale.
    const stem = f.name.slice(0, -'.json'.length);
    if (!isUuid(stem)) continue;
    const filePath = path.join(dir, f.name);
    try {
      const lst = await fs.promises.lstat(filePath);
      if (!lst.isFile()) continue;
      const raw = await fs.promises.readFile(filePath, 'utf8');
      const thread = JSON.parse(raw) as ChatThread;
      if (!isUuid(thread.id) || thread.id !== stem) {
        // ID mismatch with filename = tampered or migrated badly; quarantine.
        await quarantine(filePath, 'id-mismatch');
        continue;
      }
      if (!Array.isArray(thread.messages)) {
        await quarantine(filePath, 'invalid-shape');
        continue;
      }
      // Strip unsafe run handles before they reach orchestration code.
      for (const m of thread.messages) {
        const ar = (m as { activeRun?: { runDir?: unknown } }).activeRun;
        if (ar?.runDir && !isRunDirSafe(ar.runDir, state.projectPath)) {
          delete (m as { activeRun?: unknown }).activeRun;
        }
        if (Array.isArray(m.segments)) {
          m.segments = m.segments
            .filter(isValidSegment)
            .slice(0, MAX_SEGMENTS_PER_MESSAGE);
        }
        if (m.teamRun && Array.isArray(m.teamRun.steps)) {
          for (const step of m.teamRun.steps) {
            if (Array.isArray(step.segments)) {
              step.segments = step.segments
                .filter(isValidSegment)
                .slice(0, MAX_SEGMENTS_PER_MESSAGE);
            }
          }
        }
      }
      state.threads.set(thread.id, thread);
    } catch (err) {
      // Rename instead of dropping silently — the user can recover, and
      // we get telemetry the next time they ask "where did my chat go".
      logger.warn(`thread parse failed for ${f.name}: ${(err as Error).message}`);
      await quarantine(filePath, 'parse-error').catch(() => {});
    }
  }
}

async function quarantine(filePath: string, reason: string): Promise<void> {
  const dest = `${filePath}.corrupt-${reason}-${Date.now()}`;
  try {
    await fs.promises.rename(filePath, dest);
    logger.warn(`quarantined corrupt thread: ${dest}`);
  } catch (err) {
    logger.warn(`quarantine rename failed for ${filePath}: ${(err as Error).message}`);
  }
}

export async function persistThread(
  projectPath: string,
  thread: ChatThread,
): Promise<void> {
  if (!isUuid(thread.id)) {
    throw new Error(`persistThread: invalid threadId: ${thread.id}`);
  }
  const file = threadFile(projectPath, thread.id);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(thread, null, 2));
    await fs.promises.rename(tmp, file);
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw err;
  }
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

// Single-shot destroy hooks per WebContents — prevent N-time listener
// accumulation when the renderer re-subscribes after HMR / project switch.
const wcDestroyHooks = new WeakSet<WebContents>();

export function subscribe(projectPath: string, wc: WebContents): void {
  const s = getState(projectPath);
  if (s.subscribers.has(wc)) return;
  s.subscribers.add(wc);
  if (wcDestroyHooks.has(wc)) return;
  wcDestroyHooks.add(wc);
  wc.once('destroyed', () => {
    const snapshot = Array.from(states.values());
    for (const st of snapshot) st.subscribers.delete(wc);
  });
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
  await s.hydrationPromise;
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
  if (!isUuid(threadId)) {
    throw new Error(`deleteThread: invalid threadId: ${threadId}`);
  }
  const s = getState(projectPath);
  await s.hydrationPromise;
  // Kill any in-flight run for this thread first — otherwise the tail
  // loop keeps streaming events into nowhere and may crash line handlers.
  if (s.activeThreadId === threadId && s.activeRunHandle) {
    try {
      await s.activeRunHandle.kill();
    } catch (err) {
      logger.warn(`kill on delete failed: ${(err as Error).message}`);
    }
    s.activeRunHandle = null;
    s.activeThreadId = null;
  }
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
  if (!isUuid(threadId)) {
    throw new Error(`updateThreadConfig: invalid threadId: ${threadId}`);
  }
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
