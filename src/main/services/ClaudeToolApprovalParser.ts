/**
 * Phase 4a — Claude tool-approval prompt detector.
 *
 * Claude's CLI prints a confirmation prompt before each tool call ("Allow
 * Bash command? (y/N)" etc.). In Terminal mode the user has to physically
 * type `y` / `n` into the PTY, which means they can't approve without
 * focusing the terminal — fatal friction for a chat-style workflow.
 *
 * This module is a pure stateful detector that scans every chunk of PTY
 * stdout and fires once when it sees a fresh approval prompt. The
 * surrounding glue (PtyPool → IPC → renderer banner) reads the result and
 * surfaces an Allow/Deny overlay inside the terminal body. When the user
 * clicks Allow we write `y\r` to the PTY ourselves.
 *
 * Detection is deliberately pattern-based + tolerant. Claude's exact prompt
 * wording varies across CLI versions, so APPROVAL_PATTERNS is exported and
 * tested as the canonical set — extending it is the supported way to teach
 * the detector new variants.
 */

/** Public payload emitted to the renderer. */
export interface ApprovalRequest {
  /** Tool the prompt is gating, when the regex captures it ("Bash", "Edit",
   *  "Write", "Read", "MultiEdit"). null when the prompt's wording doesn't
   *  expose the tool name (e.g. the generic "Allow this tool call?"). */
  toolName: string | null;
  /** The exact substring of PTY output that matched. Carries the original
   *  question + prompt so the renderer can show it verbatim if it wants. */
  raw: string;
  /** ms-epoch when the match fired. Used by the renderer for slide-in
   *  animation timing and by `feed()` for de-duplication. */
  matchedAt: number;
}

/**
 * Patterns we recognise as a pending approval prompt. Order matters only
 * for the toolName capture priority — the first match wins. Adding a new
 * variant: append to the array AND add a test exercise the new wording.
 *
 * Notes on the chosen patterns:
 *  - `(y/N)` / `(y/n)` / `[y/n/a]` are all observed across claude versions.
 *  - Tool names are captured non-greedily so a multi-tool prompt
 *    ("Allow MultiEdit?") still resolves the right name.
 *  - We anchor on the prompt-shape phrase, not the leading "?" or "│", so
 *    box-drawing prefixes (claude-cli uses cyan │ guttering) don't break
 *    detection.
 */
export const APPROVAL_PATTERNS: RegExp[] = [
  // Generic "Allow this tool call? (y/N)" — no toolName captured.
  /Allow this tool call\?\s*\(y\/N\)/i,
  // "Allow Bash command? (y/N)" / "Allow Edit operation? (y/N)" etc.
  // Captures the tool name in group 1.
  /Allow\s+(Bash|Edit|Write|Read|MultiEdit|Grep|Glob|NotebookEdit|WebFetch|WebSearch|Task)\s+(?:command|tool|operation|call)?\??\s*\(y\/N\)/i,
  // "Approve this action? [y/n/a]" — alternate phrasing seen on some
  // builds, includes the "always" affordance natively.
  /Approve this action\?\s*\[y\/n\/a\]/i,
  // "? Allow Bash? (y/n)" — interactive picker layout with leading "?".
  /\?\s+Allow\s+(\S+?)\?\s*\(y\/n\)/i,
  // "Do you want to allow Bash?" — verbose phrasing observed on 2.1.x.
  /Do you want to allow\s+(Bash|Edit|Write|Read|MultiEdit)\??/i,
];

/** ms-window where the SAME raw match is treated as a redraw rather than a
 *  new prompt. Claude redraws its TUI on resize and keystrokes, which would
 *  otherwise re-fire the detector hundreds of times per second. */
const DEDUPE_WINDOW_MS = 500;

/** Rolling buffer cap. 1024 B is plenty for any single approval prompt
 *  (claude rarely emits more than ~400 B per prompt block) and small
 *  enough that the regex sweep stays microsecond-scale. */
const BUFFER_CAP = 1024;

/**
 * Stateful detector. One instance per PTY session — held inside PtyPool's
 * PoolEntry so its lifecycle matches the underlying claude process.
 *
 * Usage from PtyPool.proc.onData:
 *   const hit = entry.approvals.feed(chunk);
 *   if (hit) broadcast(hit);
 *
 * Usage from PtyPool.writeToPty (any user-originated input clears the
 * "waiting for response" state so a follow-up prompt re-fires):
 *   entry.approvals.reset();
 */
export class ApprovalDetector {
  private buffer = '';
  private lastFiredRaw: string | null = null;
  private lastFiredAt = 0;
  private waitingForResponse = false;

  /** Feed a PTY output chunk. Returns the matching ApprovalRequest if this
   *  chunk completes (or contains) a fresh approval prompt, otherwise null.
   *  Idempotent within DEDUPE_WINDOW_MS for the same raw match. */
  feed(chunk: string): ApprovalRequest | null {
    if (!chunk) return null;

    // Append + cap. We keep the LAST 1024 bytes so a prompt that arrives
    // split across two chunks ("…Allow Ba" / "sh? (y/N)") still matches.
    this.buffer = (this.buffer + chunk).slice(-BUFFER_CAP);

    // If we've already fired for an outstanding prompt, the next chunk
    // tells us whether claude has moved on. Two signals clear the wait:
    //   1. Output that does NOT contain any approval pattern → claude
    //      printed its tool result or asked something different.
    //   2. The dedupe window has lapsed → treat the next match as fresh.
    // We compute the match first either way, then decide.
    const match = this.findMatch(this.buffer);
    if (!match) {
      if (this.waitingForResponse) {
        // Claude moved past the prompt without us echoing it back —
        // clear so a follow-up tool prompt will fire.
        this.waitingForResponse = false;
        this.lastFiredRaw = null;
      }
      return null;
    }

    const now = Date.now();
    if (
      this.waitingForResponse &&
      this.lastFiredRaw === match.raw &&
      now - this.lastFiredAt < DEDUPE_WINDOW_MS
    ) {
      // Same prompt redraw within the dedupe window — swallow.
      return null;
    }

    // Either a brand-new prompt, a new prompt that happens to share text
    // with a stale one, or the dedupe window expired. Fire.
    this.lastFiredRaw = match.raw;
    this.lastFiredAt = now;
    this.waitingForResponse = true;

    return {
      toolName: match.toolName,
      raw: match.raw,
      matchedAt: now,
    };
  }

  /** Clear ALL detector state. Called when the user types into the PTY
   *  (because they may be responding to the prompt themselves) or when the
   *  underlying claude process restarts. */
  reset(): void {
    this.buffer = '';
    this.lastFiredRaw = null;
    this.lastFiredAt = 0;
    this.waitingForResponse = false;
  }

  /** Internal: walk the patterns and return the first match. Exported via
   *  a method (not a free fn) so tests can subclass / spy if needed. */
  private findMatch(
    haystack: string,
  ): { raw: string; toolName: string | null } | null {
    for (const re of APPROVAL_PATTERNS) {
      const m = re.exec(haystack);
      if (!m) continue;
      const captured = m[1];
      const toolName =
        typeof captured === 'string' && captured.length > 0
          ? normalizeToolName(captured)
          : null;
      return { raw: m[0], toolName };
    }
    return null;
  }
}

/** Map captured strings to canonical tool names. We accept lowercase /
 *  weird-case inputs from regex captures and emit the canonical Claude
 *  tool name so the UI can render an icon without a second normalization
 *  pass. Unrecognized captures pass through verbatim. */
function normalizeToolName(raw: string): string {
  const lower = raw.trim().toLowerCase();
  switch (lower) {
    case 'bash':
      return 'Bash';
    case 'edit':
      return 'Edit';
    case 'write':
      return 'Write';
    case 'read':
      return 'Read';
    case 'multiedit':
      return 'MultiEdit';
    case 'grep':
      return 'Grep';
    case 'glob':
      return 'Glob';
    case 'notebookedit':
      return 'NotebookEdit';
    case 'webfetch':
      return 'WebFetch';
    case 'websearch':
      return 'WebSearch';
    case 'task':
      return 'Task';
    default:
      return raw.trim();
  }
}
