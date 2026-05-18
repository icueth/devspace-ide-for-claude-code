// v0.15: Renderer-side bridge from the Design pane back to the Main chat.
// The user right-clicks a screen header (or version) in DesignView and
// picks "Discuss in main chat". DesignView formats a prefill string,
// publishes it on this bridge, and ChatPanel — already mounted in App —
// listens, opens itself if collapsed, and drops the text into the input
// box for the user to review before sending.
//
// We use a tiny pub/sub instead of an IPC round trip because no backend
// state changes; this is purely renderer UI choreography. The chat panel
// already has an input ref; the listener calls setInput + focuses.

export interface ChatPrefillEvent {
  // The project the prefill targets. ChatPanel ignores events for other
  // projects (each panel instance is per-project).
  projectPath: string;
  // The composed text to drop into the chat input. May contain newlines.
  // Ignored when `attachPath` is set — the panel uses its own
  // `insertAttachment` helper to format `@<rel> ` against its project root.
  text: string;
  // Optional preferred thread to switch to. When unset, ChatPanel uses
  // the currently-active thread. When set but the thread no longer exists
  // (e.g. user deleted it), the panel falls back to the active thread.
  threadId?: string;
  // When true, the panel auto-creates a new thread before pre-filling.
  // Default: false (use the active thread).
  newThread?: boolean;
  // When set, the listener APPENDS `@<rel> ` to the current input instead
  // of replacing it. Used by FileTree right-click "Add to Chat" and drag-
  // and-drop — the user may already be composing a question.
  attachPath?: string;
}

type Listener = (event: ChatPrefillEvent) => void;

const listeners = new Set<Listener>();

// Buffer for events emitted before the target ChatPanel has subscribed.
// Right-clicking a file in the sidebar and picking "Add to Chat" can fire
// emit *before* React has rendered ChatPanel for a newly-docked project
// — the panel mounts a microtask later. Without this buffer the event
// would simply drop on the floor (the symptom users hit in 0.24.2).
//
// Keyed by projectPath; capped per-project; entries expire after 3s so
// stale events from a tab the user closed don't replay later.
interface PendingEntry {
  event: ChatPrefillEvent;
  ts: number;
}
const pending = new Map<string, PendingEntry[]>();
const PENDING_TTL_MS = 3000;
const PENDING_CAP = 5;

function purgePending(projectPath: string, now: number): PendingEntry[] {
  const list = pending.get(projectPath);
  if (!list || list.length === 0) return [];
  const fresh = list.filter((e) => now - e.ts <= PENDING_TTL_MS);
  if (fresh.length === 0) pending.delete(projectPath);
  else pending.set(projectPath, fresh);
  return fresh;
}

export function onChatPrefill(listener: Listener): () => void {
  listeners.add(listener);
  // Drain any pending events the listener might be the intended target
  // for — the listener filters by projectPath itself, so just replay
  // everything fresh in the buffer.
  const now = Date.now();
  for (const projectPath of Array.from(pending.keys())) {
    const fresh = purgePending(projectPath, now);
    for (const entry of fresh) {
      try {
        listener(entry.event);
      } catch (err) {
        console.error('[chatBridge] listener threw on replay', err);
      }
    }
    pending.delete(projectPath); // events delivered once, drop the buffer
  }
  return () => {
    listeners.delete(listener);
  };
}

export function emitChatPrefill(event: ChatPrefillEvent): void {
  // Iterate a snapshot so handlers can safely unsubscribe during dispatch.
  const snapshot = Array.from(listeners);
  let delivered = false;
  for (const fn of snapshot) {
    try {
      const result = fn(event);
      // Listeners filter by projectPath internally and return implicitly;
      // we can't tell from here whether a given listener actually matched.
      // Treat *any* listener call as a delivery attempt — if no listener
      // exists at all (snapshot empty), buffer instead.
      delivered = true;
      void result;
    } catch (err) {
      console.error('[chatBridge] listener threw', err);
    }
  }
  // Buffer when there are no listeners at all — the most common cause of
  // "Add to Chat does nothing" on a project that hasn't been docked yet.
  if (!delivered) {
    const now = Date.now();
    const list = purgePending(event.projectPath, now);
    list.push({ event, ts: now });
    if (list.length > PENDING_CAP) list.splice(0, list.length - PENDING_CAP);
    pending.set(event.projectPath, list);
  }
}

// Test-only — clears the buffer between tests so leakage doesn't cause
// false positives.
export function __resetChatBridgeForTests(): void {
  listeners.clear();
  pending.clear();
}

// Format a chat prefill from a DesignScreen reference. Pure helper so it
// can be unit-tested without mounting the React tree. Excerpt is capped
// at 8KB so we never blow up the chat input. The HTML excerpt is fenced
// in a markdown code block so claude renders it as code, not as DOM.
export interface BuildChatPrefillInput {
  screenName: string;
  pageName?: string;
  relPath: string;            // e.g. ".devspace/design/screens/<id>/index.html"
  versionNumber: number;      // 1-based index for human display
  brief: string;
  htmlExcerpt?: string;       // already capped to ≤8KB by caller
}

const MAX_BRIEF = 1200;
const MAX_EXCERPT = 8 * 1024;

export function buildChatPrefill(input: BuildChatPrefillInput): string {
  const lines: string[] = [];
  const titleBits = [`screen "${input.screenName}"`];
  if (input.pageName && input.pageName !== input.screenName) {
    titleBits.push(`(${input.pageName} page)`);
  }
  lines.push(`I'm working on ${titleBits.join(' ')} in design.`);
  lines.push(``);
  lines.push(`File: \`${input.relPath}\` (v${input.versionNumber})`);
  lines.push(``);
  if (input.brief) {
    const brief = input.brief.length > MAX_BRIEF
      ? input.brief.slice(0, MAX_BRIEF) + '…'
      : input.brief;
    lines.push(`Brief: ${brief}`);
    lines.push(``);
  }
  if (input.htmlExcerpt) {
    const excerpt = input.htmlExcerpt.length > MAX_EXCERPT
      ? input.htmlExcerpt.slice(0, MAX_EXCERPT) + '\n…(truncated)'
      : input.htmlExcerpt;
    // CommonMark allows fences of any backtick length ≥3. To prevent the
    // excerpt from breaking out of its own fence (e.g. a tutorial screen
    // showing markdown samples, or a hostile assistant message containing
    // ```), pick a fence one longer than the longest backtick run inside.
    const longestRun = Math.max(0, ...Array.from(excerpt.matchAll(/`+/g)).map((m) => m[0].length));
    const fence = '`'.repeat(Math.max(3, longestRun + 1));
    lines.push(`${fence}html`);
    lines.push(excerpt);
    lines.push(fence);
    lines.push(``);
  }
  lines.push(`Help me with: `);
  return lines.join('\n');
}
