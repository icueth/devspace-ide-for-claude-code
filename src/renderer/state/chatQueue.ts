import { create } from 'zustand';

// v0.16.0 — Chat message queue.
//
// Users want to keep typing while the assistant is mid-reply. Pre-0.16
// the send button disabled during streaming and the user had to wait.
// Now: anything typed while `isStreaming === true` lands in this queue,
// renders as editable / deletable pills below the textarea, and
// auto-fires (in order) the moment the current turn finishes.
//
// In-memory ONLY — no persist middleware. Rationale:
//   • The queue describes intent the user expressed seconds ago. Persisting
//     it across app restart risks a stale message firing into an evolved
//     thread the user has since forgotten about.
//   • Keyed per `${projectId}::${threadId}` so switching threads mid-stream
//     preserves the queue without bleeding into a different thread.
//
// The store is intentionally dumb: it does NOT know about streaming state,
// `api.chat.send`, or when to drain. The ChatPanel owns the auto-send loop
// and subscribes to `isStreaming` transitions. This keeps the store
// testable in isolation (no IPC mocks needed).

export interface QueuedMessage {
  id: string;
  text: string;
  createdAt: number;
  // Optional attachments preserved when queued via drag-drop / Add to Chat.
  // Currently unused by the renderer (the textarea inlines `@<path>`
  // tokens into `text` directly) but reserved so callers that want to
  // round-trip structured attachments don't have to re-encode them as
  // strings.
  attachments?: string[];
}

interface ChatQueueState {
  // Key shape: `${projectId}::${threadId}` — match the format used by
  // ChatPanel callers. Two colons (`::`) avoids collision with paths that
  // contain a single colon (Windows-style "C:" drives are theoretical
  // here since the app is mac-only, but we double-up for safety regardless).
  queues: Record<string, QueuedMessage[]>;
  // Paused queues — set when the most recent auto-sent turn errored.
  // While true, the auto-send loop will NOT drain the next message.
  // User has to explicitly Resume or Discard. Keyed identically to queues.
  paused: Record<string, boolean>;

  /** Enqueue a message at the tail; returns the generated id. */
  enqueue(
    key: string,
    msg: Omit<QueuedMessage, 'id' | 'createdAt'>,
  ): string;
  /** Drop the matching message by id. No-op if not found. */
  remove(key: string, id: string): void;
  /** Replace the `text` of a queued message. No-op if not found. */
  update(key: string, id: string, text: string): void;
  /** Move item between indices. Bounds-checked; no-op if out of range. */
  reorder(key: string, fromIdx: number, toIdx: number): void;
  /** Pop the head and return it. Returns undefined when the queue is empty. */
  shift(key: string): QueuedMessage | undefined;
  /**
   * Push a popped message back at the HEAD of the queue. Used when an
   * auto-drain fails and we want to preserve user intent (combined with
   * `setPaused(key, true)` so the loop stops until the user resumes).
   * Preserves the original `id` + `createdAt` so the UI doesn't jitter.
   */
  unshift(key: string, msg: QueuedMessage): void;
  /** Read-only snapshot of the queue for a given key. */
  list(key: string): QueuedMessage[];
  /** Drop everything queued under `key`. */
  clear(key: string): void;
  /** Set or clear the paused flag for a given key. */
  setPaused(key: string, paused: boolean): void;
  /** Whether the queue for the given key is currently paused. */
  isPaused(key: string): boolean;
  /**
   * Drop every queue whose key starts with `${projectId}::`. Used when
   * the user closes a project so per-thread queues for that project don't
   * leak across sessions.
   */
  clearProject(projectId: string): void;
}

// Build the storage key. Exported so callers don't have to remember the
// `::` separator — keeps the format change isolated to one place.
export function queueKey(projectId: string, threadId: string): string {
  return `${projectId}::${threadId}`;
}

// Cheap, collision-resistant id. Stronger than `Date.now()` (two enqueues
// in the same tick would collide) but cheaper than pulling in a uuid dep.
// Format: `${timestampBase36}-${random6}`.
function makeId(): string {
  // crypto.randomUUID is available in modern Electron renderers; fall back
  // to Math.random for environments (vitest node env) that haven't polyfilled.
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through to fallback */
  }
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

export const useChatQueueStore = create<ChatQueueState>((set, get) => ({
  queues: {},
  paused: {},

  enqueue(key, msg) {
    const id = makeId();
    const queued: QueuedMessage = {
      id,
      text: msg.text,
      createdAt: Date.now(),
      ...(msg.attachments ? { attachments: msg.attachments } : {}),
    };
    set((state) => {
      const prev = state.queues[key] ?? [];
      return { queues: { ...state.queues, [key]: [...prev, queued] } };
    });
    return id;
  },

  remove(key, id) {
    set((state) => {
      const prev = state.queues[key];
      if (!prev) return state;
      const next = prev.filter((q) => q.id !== id);
      if (next.length === prev.length) return state;
      const queues = { ...state.queues };
      if (next.length === 0) {
        delete queues[key];
      } else {
        queues[key] = next;
      }
      return { queues };
    });
  },

  update(key, id, text) {
    set((state) => {
      const prev = state.queues[key];
      if (!prev) return state;
      let changed = false;
      const next = prev.map((q) => {
        if (q.id !== id) return q;
        if (q.text === text) return q;
        changed = true;
        return { ...q, text };
      });
      if (!changed) return state;
      return { queues: { ...state.queues, [key]: next } };
    });
  },

  reorder(key, fromIdx, toIdx) {
    set((state) => {
      const prev = state.queues[key];
      if (!prev) return state;
      if (fromIdx === toIdx) return state;
      if (fromIdx < 0 || fromIdx >= prev.length) return state;
      if (toIdx < 0 || toIdx >= prev.length) return state;
      const next = prev.slice();
      const [moved] = next.splice(fromIdx, 1);
      if (!moved) return state;
      next.splice(toIdx, 0, moved);
      return { queues: { ...state.queues, [key]: next } };
    });
  },

  shift(key) {
    const prev = get().queues[key];
    if (!prev || prev.length === 0) return undefined;
    const [head, ...rest] = prev;
    set((state) => {
      const queues = { ...state.queues };
      if (rest.length === 0) {
        delete queues[key];
      } else {
        queues[key] = rest;
      }
      return { queues };
    });
    return head;
  },

  unshift(key, msg) {
    set((state) => {
      const prev = state.queues[key] ?? [];
      return { queues: { ...state.queues, [key]: [msg, ...prev] } };
    });
  },

  list(key) {
    return get().queues[key] ?? [];
  },

  clear(key) {
    set((state) => {
      const hadQueue = key in state.queues;
      const hadPause = key in state.paused;
      if (!hadQueue && !hadPause) return state;
      const queues = { ...state.queues };
      const paused = { ...state.paused };
      delete queues[key];
      delete paused[key];
      return { queues, paused };
    });
  },

  setPaused(key, isPaused) {
    set((state) => {
      const current = state.paused[key] ?? false;
      if (current === isPaused) return state;
      const paused = { ...state.paused };
      if (isPaused) {
        paused[key] = true;
      } else {
        delete paused[key];
      }
      return { paused };
    });
  },

  isPaused(key) {
    return get().paused[key] ?? false;
  },

  clearProject(projectId) {
    set((state) => {
      const prefix = `${projectId}::`;
      const queues: Record<string, QueuedMessage[]> = {};
      const paused: Record<string, boolean> = {};
      let changed = false;
      for (const [k, v] of Object.entries(state.queues)) {
        if (k.startsWith(prefix)) {
          changed = true;
          continue;
        }
        queues[k] = v;
      }
      for (const [k, v] of Object.entries(state.paused)) {
        if (k.startsWith(prefix)) {
          changed = true;
          continue;
        }
        paused[k] = v;
      }
      if (!changed) return state;
      return { queues, paused };
    });
  },
}));
