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
  text: string;
  // Optional preferred thread to switch to. When unset, ChatPanel uses
  // the currently-active thread. When set but the thread no longer exists
  // (e.g. user deleted it), the panel falls back to the active thread.
  threadId?: string;
  // When true, the panel auto-creates a new thread before pre-filling.
  // Default: false (use the active thread).
  newThread?: boolean;
}

type Listener = (event: ChatPrefillEvent) => void;

const listeners = new Set<Listener>();

export function onChatPrefill(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitChatPrefill(event: ChatPrefillEvent): void {
  // Iterate a snapshot so handlers can safely unsubscribe during dispatch.
  const snapshot = Array.from(listeners);
  for (const fn of snapshot) {
    try {
      fn(event);
    } catch (err) {
      console.error('[chatBridge] listener threw', err);
    }
  }
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
