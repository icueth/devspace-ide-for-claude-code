// DesignGenerator — thin wrapper around TmuxChatRunner specialized for
// one-shot HTML generation runs. Composes the prompt from the design
// skill + design system + user brief, resolves the local `claude`
// binary, spawns it through the same tmux machinery the chat panel uses
// so the run survives an app restart, and extracts the HTML from the
// returned text.
//
// The runner writes claude's plain-text output into `out.jsonl` (the
// file is named for the chat case — we treat it as a raw text stream
// because we pass `--output-format text`). When the run completes we
// read it back, strip the surrounding preamble/postamble, and return
// the HTML string so DesignService can write it to disk + archive the
// previous version.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { resolveClaudeBinary } from '@main/services/ClaudeCliLauncher';
import {
  type BuildPromptThemeTokens,
  buildDesignPrompt,
} from '@main/services/DesignPromptBuilder';
import {
  type ChatRunHandle,
  newRunId,
  startChatRun,
} from '@main/services/TmuxChatRunner';
import { resolveInteractiveShellEnv } from '@main/utils/shellEnv';
import { createLogger } from '@shared/logger';
import type {
  DesignMessage,
  DesignMessageSegment,
  DesignSkill,
  DesignSystem,
  ProjectDesignProfile,
} from '@shared/design';

const logger = createLogger('DesignGenerator');

export interface GenerateActiveRunInfo {
  runId: string;
  sessionName: string;
  runDir: string;
  startedAt: number;
}

export interface GenerateDesignOptions {
  projectPath: string;
  screenId: string;
  skill: DesignSkill;
  designSystem?: DesignSystem;
  brief: string;
  onProgress?: (message: string) => void;
  onActiveRun?: (info: GenerateActiveRunInfo) => void | Promise<void>;
  // v0.10: when set, supersedes `brief` for prompt assembly. The builder
  // renders the transcript as `## Conversation` and uses the LAST user
  // turn as the active request. `brief` is still passed for back-compat
  // and ignored when messages is non-empty.
  messages?: DesignMessage[];
  // v0.10: pre-rendered project context (framework/styling/TS/pm).
  // Injected under `## Project Context` before the brief/conversation.
  projectProfile?: ProjectDesignProfile | null;
  // v0.14: optional page-name hint. Threaded through to the prompt
  // builder so Claude knows which page of a larger app this design
  // represents (e.g. "Design the Checkout page for this project's app.").
  pageName?: string;
  // v0.14: optional theme lock pre-computed by DesignService from the
  // prior version's HTML. When provided, the prompt builder injects a
  // "## Theme constraints (keep from previous version)" section that
  // pins colors / fonts so iterative regenerations don't drift.
  reuseThemeTokens?: BuildPromptThemeTokens;
}

export interface GenerateDesignResult {
  html: string | null;
  // v0.14: structured assistant content split from the raw response.
  // The first prose segment (if any) explains the design; the html
  // segment carries byte-length + preview; the trailing prose segment
  // (if any) suggests next iterations. Empty array on extraction
  // failure — DesignService still emits message_finalized with this
  // shape so renderers can fall back to `content`.
  segments: DesignMessageSegment[];
  cancelled: boolean;
  error: string | null;
  runId: string;
}

export interface GenerateDesignHandle {
  kill: () => Promise<void>;
  completion: Promise<GenerateDesignResult>;
}

// Public entry point. Returns a handle whose `completion` promise
// resolves with the extracted HTML (or an error). The caller wires the
// handle into DesignService's active-run map so cancel can find it.
export async function generateDesign(
  opts: GenerateDesignOptions,
): Promise<GenerateDesignHandle> {
  const claudeBin = await resolveClaudeBinary();
  if (!claudeBin) {
    throw new Error(
      "`claude` binary not found on PATH. Install Claude Code CLI first.",
    );
  }

  const prompt = await buildPrompt(opts);
  const runId = newRunId();
  const runRoot = path.join(opts.projectPath, '.devspace', 'design');
  const env = await resolveInteractiveShellEnv();

  // Plain text output — simpler than stream-json for a single HTML blob.
  // The run's `out.jsonl` will just be the raw text in this case (the
  // chat parser only kicks in when it sees JSONL lines).
  //
  // S1+S2 hardening (v0.13, revised v0.13.1): design generations must not
  // touch the host filesystem outside the project, hit the network, or
  // run shell commands. The brief is untrusted user input. Lockdown is:
  //
  //   1. --disallowed-tools …  — explicit denylist for every write-class
  //      and exfil-class tool. This is the real security boundary in
  //      `--print` mode: tools listed here cannot be invoked regardless
  //      of the user's ~/.claude/settings.json allowlist.
  //   2. --allowed-tools Glob,Grep  — explicit allowlist of the inspection
  //      tools the generator is allowed to use. Read is intentionally
  //      OMITTED — Claude has no need to read source files (we already
  //      inject project context via ProjectProfileBuilder), and `Read`
  //      would resolve absolute paths like `/Users/<u>/.aws/credentials`
  //      that `--add-dir` does not scope.
  //
  // PRIOR BUG (v0.13.0): we also passed `--permission-mode plan`. plan is
  // Claude Code's interactive "research" mode — Claude must call the
  // `ExitPlanMode` tool before producing real output. In `--print` mode
  // there is no UI to confirm the plan, so Claude emitted the plan text
  // itself (not the HTML page). That manifested as "claude did not return
  // HTML" + no streaming visible. Lesson: plan mode is interactive-only;
  // for one-shot `--print` runs, `--disallowed-tools` alone is the right
  // security primitive. If a future hardening pass wants tighter scope,
  // use `--add-dir <project>` (already implied by cwd) + extend the
  // disallow list, not `--permission-mode plan`.
  const args = buildClaudeArgs();

  let handle: ChatRunHandle;
  try {
    handle = await startChatRun({
      projectId: path.basename(path.resolve(opts.projectPath)),
      // ChatRunner namespaces run dirs by threadId — reuse the screenId
      // here so each design has its own runs/ subtree, mirroring the
      // chat layout (runs/<thread>/<runId>).
      threadId: opts.screenId,
      runId,
      cwd: opts.projectPath,
      claudeBin,
      args,
      env,
      prompt,
      onLine: (line) => {
        // For text output mode claude doesn't emit JSONL — every line is
        // raw text. Forward as a progress event so the UI can show a
        // live preview of what's being generated.
        opts.onProgress?.(line);
      },
      runRoot,
    });
  } catch (err) {
    throw new Error(`failed to spawn claude: ${(err as Error).message}`);
  }

  // Notify the caller about the active run AFTER startChatRun resolves
  // — at this point the tmux session is live and the runDir is on disk.
  await opts.onActiveRun?.({
    runId,
    sessionName: handle.sessionName,
    runDir: handle.runDir,
    startedAt: Date.now(),
  });

  const completion = (async (): Promise<GenerateDesignResult> => {
    const result = await handle.promise;
    if (result.cancelled) {
      return { html: null, segments: [], cancelled: true, error: null, runId };
    }
    if (result.error) {
      return { html: null, segments: [], cancelled: false, error: result.error, runId };
    }
    // Read whatever claude wrote into the run's `out.jsonl` (named that
    // way by the chat runner — for design we treat it as raw text).
    let raw: string;
    try {
      raw = await fs.promises.readFile(path.join(handle.runDir, 'out.jsonl'), 'utf8');
    } catch (err) {
      return {
        html: null,
        segments: [],
        cancelled: false,
        error: `failed to read claude output: ${(err as Error).message}`,
        runId,
      };
    }
    const { html, segments } = extractGeneratedSegments(raw);
    if (!html) {
      logger.warn(
        `no HTML extracted from design run ${runId} (output length ${raw.length})`,
      );
      return {
        html: null,
        // Even on failure we hand back a prose segment so the renderer
        // can show the user what Claude actually said (helps debug the
        // "no HTML" path — e.g. a refusal or a clarifying question).
        segments,
        cancelled: false,
        error: 'claude did not return HTML — try refining your brief',
        runId,
      };
    }
    return { html, segments, cancelled: false, error: null, runId };
  })();

  return {
    kill: () => handle.kill(),
    completion,
  };
}

// Pure args builder — exported so DesignGenerator.test.ts can pin this
// shape down. The plan-mode regression (v0.13.0 → v0.13.1) was invisible
// to extractHtml tests; pinning the CLI args here is the cheapest way to
// keep "no `--permission-mode plan` in --print" enforced.
export function buildClaudeArgs(): string[] {
  return [
    '--print',
    '--output-format',
    'text',
    '--allowed-tools',
    'Glob,Grep',
    '--disallowed-tools',
    'Bash,WebFetch,WebSearch,Edit,Write,NotebookEdit,Task,Read',
  ];
}

// ─── prompt assembly ────────────────────────────────────────────────────────

// Reads SKILL.md and DESIGN.md bodies from disk, then delegates pure
// composition to DesignPromptBuilder. We split the I/O from the
// composition so the builder stays trivially unit-testable.
async function buildPrompt(opts: GenerateDesignOptions): Promise<string> {
  const skillBody = await safeReadFile(opts.skill.path);
  const designSystemBody = opts.designSystem
    ? await safeReadFile(opts.designSystem.path)
    : undefined;

  return buildDesignPrompt({
    skill: opts.skill,
    designSystem: opts.designSystem,
    brief: opts.brief,
    skillBody,
    designSystemBody,
    messages: opts.messages,
    projectProfile: opts.projectProfile ?? null,
    pageName: opts.pageName,
    reuseThemeTokens: opts.reuseThemeTokens,
  });
}

async function safeReadFile(file: string): Promise<string> {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch (err) {
    logger.warn(`failed to read ${file}: ${(err as Error).message}`);
    return '';
  }
}

// ─── HTML extraction ────────────────────────────────────────────────────────

// Tolerant tri-split extractor — claude's v0.14 output contract asks
// for [prose intro] + [```html fence``` ] + [prose outro]. We slice on
// the LAST complete html fence (preserving the v0.13 selection logic:
// prefer complete fences over incomplete ones, latest fence over
// earlier examples) and return the three slices as segments so the
// chat surface can render prose as bubbles and the HTML as a compact
// card.
//
// Selection logic (carried over from the v0.13 extractor for the
// regression invariants the tests pin):
//   1. Prefer fenced ```html blocks. When SEVERAL are present, prefer
//      a fence that has BOTH a doctype/<html> opener AND a `</html>`
//      closer (a complete document); among complete fences, prefer the
//      LAST one — Claude's final answer is typically the bottom-most.
//      Falls back to the longest fence body when none look complete.
//   2. Outside of fences, take the FIRST doctype/html opener and the
//      FIRST `</html>` AFTER it (not the last) so two documents don't
//      get merged.
//   3. If no opener is found, return { html: null, segments: [prose
//      with raw response] } so the user still sees what Claude said.
//
// `extractHtml` is kept as a thin wrapper over `extractGeneratedSegments`
// so legacy callers + regression tests keep working unchanged.

// Preview cap for the html segment. The UI shows this in a "Generated
// index.html — N KB" card so the user can decide whether to expand the
// full document; 200 chars is enough for the opening tags + title.
const HTML_PREVIEW_LEN = 200;

export function extractGeneratedSegments(raw: string): {
  html: string | null;
  segments: DesignMessageSegment[];
} {
  if (!raw) {
    return { html: null, segments: [] };
  }

  // 1. Scan for fenced html blocks AND capture their start/end indices
  // so we can slice the surrounding prose. Selection rule mirrors the
  // pre-v0.14 logic so the existing regression tests stay green.
  const fenceRe = /```(?:html|HTML)?\s*\r?\n([\s\S]*?)\r?\n```/g;
  type Fence = { body: string; outerStart: number; outerEnd: number };
  let lastCompleteFence: Fence | null = null;
  let longestFence: Fence | null = null;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(raw)) !== null) {
    const body = m[1] ?? '';
    const fence: Fence = {
      body,
      outerStart: m.index,
      outerEnd: m.index + m[0].length,
    };
    const lower = body.toLowerCase();
    const hasOpen =
      lower.includes('<!doctype html') || lower.includes('<html');
    const hasClose = lower.includes('</html>');
    if (hasOpen && hasClose) lastCompleteFence = fence;
    if (!longestFence || body.length > longestFence.body.length) {
      longestFence = fence;
    }
  }

  const picked = lastCompleteFence ?? longestFence;
  if (picked) {
    const html = extractHtmlFromCandidate(picked.body);
    if (html) {
      return buildSegmentsFromFence(raw, picked.outerStart, picked.outerEnd, html);
    }
    // v0.14 code-review MED-1: fence existed but didn't yield extractable
    // HTML (e.g. fence body has `<html` but no `</html>`). Still try a
    // doctype scan over the RAW response so we recover the HTML — and
    // preserve the prose split from the fence boundaries so Claude's
    // explanation around the fence isn't silently dropped.
    const recovered = extractHtmlFromCandidate(raw);
    if (recovered) {
      return buildSegmentsFromFence(raw, picked.outerStart, picked.outerEnd, recovered);
    }
  }

  // 2. No usable fence — try a fence-less doctype scan over the raw
  // response. The whole raw response acts as the "html segment" source
  // when we find an opener; nothing else can be split as prose because
  // we have no clean delimiter.
  const html = extractHtmlFromCandidate(raw);
  if (html) {
    const segments: DesignMessageSegment[] = [
      htmlSegmentFor(html),
    ];
    return { html, segments };
  }

  // 3. Nothing extractable. Hand back the trimmed raw as a single
  // prose segment so the user still sees Claude's answer (refusal,
  // clarifying question, etc.).
  const trimmed = raw.trim();
  const segments: DesignMessageSegment[] =
    trimmed.length > 0 ? [{ kind: 'prose', text: trimmed }] : [];
  return { html: null, segments };
}

// Build the tri-split segments[] given the raw response, the fence's
// outer byte span, and the already-extracted html string. Empty prose
// halves are skipped so the renderer doesn't see empty bubbles.
function buildSegmentsFromFence(
  raw: string,
  outerStart: number,
  outerEnd: number,
  html: string,
): { html: string; segments: DesignMessageSegment[] } {
  const segments: DesignMessageSegment[] = [];
  const intro = raw.slice(0, outerStart).trim();
  if (intro.length > 0) segments.push({ kind: 'prose', text: intro });
  segments.push(htmlSegmentFor(html));
  const outro = raw.slice(outerEnd).trim();
  if (outro.length > 0) segments.push({ kind: 'prose', text: outro });
  return { html, segments };
}

function htmlSegmentFor(html: string): DesignMessageSegment {
  const bytes = Buffer.byteLength(html, 'utf8');
  const preview =
    html.length > HTML_PREVIEW_LEN ? html.slice(0, HTML_PREVIEW_LEN) : html;
  return { kind: 'html', bytes, preview };
}

// Inner HTML-from-candidate slicer. Returns the trimmed `<!doctype …
// </html>` span (or a truncated `<!doctype …` tail when there's no
// closing tag), or null if no opener is present. Shared by the fenced
// and fence-less paths.
function extractHtmlFromCandidate(candidate: string): string | null {
  if (!candidate) return null;
  const lower = candidate.toLowerCase();
  let start = lower.indexOf('<!doctype html');
  if (start < 0) start = lower.indexOf('<html');
  if (start < 0) return null;
  const endTag = '</html>';
  const endIdx = lower.indexOf(endTag, start);
  if (endIdx < 0) {
    // Tolerate truncated output — return what we have starting at the
    // doctype/html opener. Better to surface a partial page than fail
    // outright; the user can regenerate if it's broken.
    return candidate.slice(start).trim();
  }
  return candidate.slice(start, endIdx + endTag.length).trim();
}

// Thin wrapper over extractGeneratedSegments — preserved for existing
// callers (the legacy single-string consumer) and the regression
// tests that pin the v0.13 extraction shape.
export function extractHtml(raw: string): string | null {
  return extractGeneratedSegments(raw).html;
}
