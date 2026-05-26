// ChatTranscript — disk persistence, per-project state container, and
// thread CRUD for chat. Owns the in-memory `states` Map that everything
// else in the chat subsystem reads / mutates, and is the single place
// that writes thread JSON to .devspace/chat/<id>.json.

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WebContents } from 'electron';

import { type ChatRunHandle } from '@main/services/TmuxChatRunner';
import { type LlmRunHandle } from '@main/services/LlmChatRunner';
import { createLogger } from '@shared/logger';
import type {
  ChatConfig,
  ChatEvent,
  ChatThread,
  ChatThreadMeta,
} from '@shared/types';

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
  // v0.30.3: per-thread active-run lock. Previously single handles +
  // activeThreadId enforced project-wide single-concurrency, which broke
  // the realistic flow of "Claude thread A is streaming, switch to LLM
  // thread B, send a message there" (error: "a chat turn is already
  // running for this project"). Map keyed by threadId lets distinct
  // threads run in parallel; double-send to the same thread is still
  // rejected at the sendMessage gate. Kind-separated so LLM/OpenCode
  // handles never get mistaken for tmux handles in finalize paths.
  activeRunsByThread: Map<string, ChatRunHandle>;
  activeLlmRunsByThread: Map<string, LlmRunHandle>;
  // v0.35.2: the active-run Maps above are only populated AFTER the spawn
  // resolves (an await). `startingThreads` is claimed SYNCHRONOUSLY in
  // sendMessage before any await, so the per-thread lock holds across the
  // whole dispatch→spawn window — closing a double-send race that pushed
  // two interleaved runs onto one thread. `cancelDuringStart` records a
  // cancel/delete that arrived during that window; the run honors it right
  // after the spawn (kill + finalize-cancelled / skip-persist-if-deleted)
  // instead of silently losing the cancel.
  startingThreads: Set<string>;
  cancelDuringStart: Set<string>;
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
      activeRunsByThread: new Map(),
      activeLlmRunsByThread: new Map(),
      startingThreads: new Set(),
      cancelDuringStart: new Set(),
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

/**
 * Tear down a project's in-memory chat state on workspace close/eviction.
 * Kills any in-flight run (so its tmux tail loop + broadcasts actually stop)
 * and drops the loaded-thread Map so it stops accumulating across a session
 * where the user cycles through many projects. Re-opening re-hydrates from
 * disk, so nothing is lost.
 */
export async function disposeProject(projectPath: string): Promise<void> {
  const key = path.resolve(projectPath);
  const state = states.get(key);
  if (!state) return;
  states.delete(key);
  state.subscribers.clear();
  // Drain every in-flight handle. Best-effort — the project is going
  // away regardless, so we ignore individual kill failures.
  const claudeHandles = Array.from(state.activeRunsByThread.values());
  state.activeRunsByThread.clear();
  for (const h of claudeHandles) {
    try {
      await h.kill();
    } catch {
      /* best-effort */
    }
  }
  const llmHandles = Array.from(state.activeLlmRunsByThread.values());
  state.activeLlmRunsByThread.clear();
  for (const h of llmHandles) {
    try {
      await h.kill();
    } catch {
      /* best-effort */
    }
  }
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
      // v0.30 SEC-HIGH-4: validate cliId/cliProfileId pair on hydration so
      // a hand-edited thread JSON can't smuggle a hostile runtime id into
      // dispatch (e.g. routing to a future adapter before it has its own
      // guards) or correlate the thread to a different profile's apiKey.
      // Strip both fields if either is invalid or unpaired. Also enforce
      // mutual exclusion with llmProfileId — IPC rejects this at create
      // time, but pre-existing tampered JSONs would otherwise persist.
      const ALLOWED_PERSISTED_CLI_IDS = new Set(['opencode']);
      const tAsRec = thread as {
        cliId?: unknown;
        cliProfileId?: unknown;
        llmProfileId?: unknown;
      };
      if (tAsRec.cliId !== undefined) {
        const cidOk =
          typeof tAsRec.cliId === 'string' &&
          ALLOWED_PERSISTED_CLI_IDS.has(tAsRec.cliId);
        const pidOk = isUuid(tAsRec.cliProfileId);
        if (!cidOk || !pidOk) {
          delete tAsRec.cliId;
          delete tAsRec.cliProfileId;
        }
      } else if (tAsRec.cliProfileId !== undefined) {
        // cliProfileId without cliId — unpaired, drop it.
        delete tAsRec.cliProfileId;
      }
      if (
        typeof tAsRec.llmProfileId === 'string' &&
        tAsRec.llmProfileId.trim() &&
        tAsRec.cliProfileId !== undefined
      ) {
        // Mutual exclusion violated — llmProfileId wins (matches dispatch
        // order in ChatService.sendMessage).
        delete tAsRec.cliId;
        delete tAsRec.cliProfileId;
      }
      // Strip an unsafe top-level run handle. `thread.activeRun` is the
      // canonical field resume-on-boot consumes (and getThread now ships to
      // the renderer), so a hostile chat JSON pointing runDir outside the
      // threads dir must be neutralized here — symmetric with the per-message
      // guard below.
      const tar = (thread as { activeRun?: { runDir?: unknown } }).activeRun;
      if (tar?.runDir && !isRunDirSafe(tar.runDir, state.projectPath)) {
        delete (thread as { activeRun?: unknown }).activeRun;
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
  // v0.29: orphaned-streaming sweep. The Claude path resumes via
  // `thread.activeRun` (tmux session re-attach), but the LLM path uses
  // streaming HTTP — there's no equivalent to resume. If the app
  // crashed / was force-quit mid-LLM-stream, the persisted assistant
  // message is stuck at `status: 'streaming'` with no `activeRun`, and
  // the renderer locks the composer into "running" mode forever waiting
  // for a `done` event that will never arrive. Flip those to 'error'
  // here so the renderer surfaces them as an interrupted turn the user
  // can retry. The same logic applies to a hypothetical Claude orphan
  // without activeRun, so we don't condition on `llmProfileId`.
  let mutatedAny = false;
  for (const thread of state.threads.values()) {
    if (thread.activeRun) continue;     // tmux resume will handle it
    let mutated = false;
    for (const m of thread.messages) {
      if (m.role === 'assistant' && m.status === 'streaming') {
        m.status = 'error';
        (m as { error?: string }).error = 'interrupted';
        mutated = true;
      }
    }
    if (mutated) {
      try {
        await persistThread(state.projectPath, thread);
        mutatedAny = true;
      } catch (err) {
        logger.warn(
          `orphan sweep persist failed for ${thread.id.slice(0, 8)}: ${(err as Error).message}`,
        );
      }
    }
  }
  if (mutatedAny) {
    logger.info(
      `swept orphaned 'streaming' messages on hydrate for ${state.projectPath}`,
    );
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
  // v0.35.2: never resurrect a deleted thread. A run finalizer holds the
  // thread object by reference; if the user deleted the thread mid-stream
  // (deleteThread removed it from state + unlinked the file), the
  // finalizer's persist would re-create the JSON → a zombie thread that
  // reappears on next-boot hydrate. If the thread is gone from its live
  // state, this write is a no-op. (When no state exists yet — e.g. an
  // isolated unit test — we fall through and write as before.)
  const liveState = states.get(path.resolve(projectPath));
  if (liveState && !liveState.threads.has(thread.id)) {
    return;
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

/**
 * Does this thread have a persisted in-flight run? The canonical record
 * is `thread.activeRun` (set by ChatService while a tmux run is live), but
 * older / partially-migrated thread JSON could also carry an `activeRun`
 * on a message — so we check both. Used to drive the list's "running"
 * affordance without shipping the messages themselves.
 */
function threadHasActiveRun(t: ChatThread): boolean {
  if (t.activeRun) return true;
  return t.messages.some(
    (m) => !!(m as { activeRun?: unknown }).activeRun,
  );
}

/**
 * v0.27: return lightweight metadata for every thread instead of the full
 * `ChatThread[]`. Opening a project no longer ships every thread's entire
 * transcript over IPC + holds it all in renderer memory — the renderer
 * fetches the full thread lazily via `getThread` when the user opens it.
 *
 * `messageCount` and `hasActiveRun` are derived from the in-memory thread
 * so the list UI can show "running" affordances + message counts without
 * the messages themselves. `config` is carried so the settings badge can
 * render without a per-thread round-trip. Sort matches the old behavior
 * (updatedAt desc).
 */
export async function listThreads(
  projectPath: string,
): Promise<ChatThreadMeta[]> {
  const s = getState(projectPath);
  await s.hydrationPromise;
  return [...s.threads.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(
      (t): ChatThreadMeta => ({
        id: t.id,
        projectId: t.projectId,
        title: t.title,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        messageCount: t.messages.length,
        hasActiveRun: threadHasActiveRun(t),
        ...(t.config ? { config: t.config } : {}),
        ...(t.llmProfileId ? { llmProfileId: t.llmProfileId } : {}),
        // v0.30: mirror the CLI runtime lock so the thread list can
        // paint an "OpenCode" badge without re-fetching the full
        // thread JSON. cliId is undefined for the default Claude
        // path; cliProfileId is only meaningful when cliId is set.
        ...(t.cliId ? { cliId: t.cliId } : {}),
        ...(t.cliProfileId ? { cliProfileId: t.cliProfileId } : {}),
      }),
    );
}

/**
 * Fetch the FULL hydrated thread (with `messages`) for the renderer's
 * lazy-load. Mirrors the security pattern of deleteThread /
 * updateThreadConfig — a non-UUID threadId is hostile (path-traversal
 * vector if it ever reached the disk layer) so we throw rather than try
 * to look it up. Returns null when the id is well-formed but unknown.
 */
export async function getThread(
  projectPath: string,
  threadId: string,
): Promise<ChatThread | null> {
  if (!isUuid(threadId)) {
    throw new Error(`getThread: invalid threadId: ${threadId}`);
  }
  const s = getState(projectPath);
  await s.hydrationPromise;
  return s.threads.get(threadId) ?? null;
}

export async function createThread(
  projectPath: string,
  title?: string,
  llmProfileId?: string,
  // v0.30: CLI runtime lock. When set, the IPC layer has already
  // validated the matching CliProfile exists and resolved its cliId
  // (currently always 'opencode'). Mutually exclusive with llmProfileId
  // — IPC must reject if both are non-empty before reaching here.
  cliProfileBinding?: { profileId: string; cliId: 'opencode' },
): Promise<ChatThread> {
  const s = getState(projectPath);
  await s.hydrationPromise;
  const trimmedProfileId =
    typeof llmProfileId === 'string' && llmProfileId.trim()
      ? llmProfileId.trim()
      : undefined;
  const thread: ChatThread = {
    id: randomUUID(),
    projectId: path.basename(s.projectPath),
    title: title?.trim() || 'New chat',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    ...(trimmedProfileId ? { llmProfileId: trimmedProfileId } : {}),
    ...(cliProfileBinding
      ? {
          cliId: cliProfileBinding.cliId,
          cliProfileId: cliProfileBinding.profileId,
        }
      : {}),
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
  // Kill any in-flight run for THIS thread only (per-thread lock in
  // v0.30.3). Concurrent runs on other threads keep streaming unaffected.
  const claudeHandle = s.activeRunsByThread.get(threadId);
  if (claudeHandle) {
    s.activeRunsByThread.delete(threadId);
    try {
      await claudeHandle.kill();
    } catch (err) {
      logger.warn(`kill on delete failed: ${(err as Error).message}`);
    }
  }
  const llmHandle = s.activeLlmRunsByThread.get(threadId);
  if (llmHandle) {
    s.activeLlmRunsByThread.delete(threadId);
    try {
      await llmHandle.kill();
    } catch (err) {
      logger.warn(`kill llm on delete failed: ${(err as Error).message}`);
    }
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
