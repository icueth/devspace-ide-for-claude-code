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
import { buildDesignPrompt } from '@main/services/DesignPromptBuilder';
import {
  type ChatRunHandle,
  newRunId,
  startChatRun,
} from '@main/services/TmuxChatRunner';
import { resolveInteractiveShellEnv } from '@main/utils/shellEnv';
import { createLogger } from '@shared/logger';
import type {
  DesignMessage,
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
}

export interface GenerateDesignResult {
  html: string | null;
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
  // S1+S2 hardening (v0.13): design generations should not be able to
  // touch the host filesystem outside the project, hit the network, or
  // run shell commands — the brief is untrusted user input that can ask
  // Claude to do unsafe things. The lockdown is layered:
  //
  //   1. --permission-mode plan  — Claude's "planning" mode is read-only
  //      by spec; it cannot invoke Edit/Write/Bash/WebFetch regardless
  //      of the user's ~/.claude/settings.json allowlist. Belt.
  //   2. --allowed-tools Glob,Grep  — explicit allowlist of the inspection
  //      tools we actually want (project tree walks). Read is intentionally
  //      OMITTED because `--add-dir` does NOT scope the Read tool to a
  //      subtree — it would still resolve absolute paths like
  //      `/Users/<u>/.aws/credentials`. Suspenders.
  //   3. --disallowed-tools …  — defense-in-depth explicit denial for
  //      every write-class and exfil-class tool, so even if a future
  //      Claude CLI release changes the meaning of `plan` mode the
  //      hardening doesn't silently weaken. Backup suspenders.
  //
  // If we ever need to write back to source code we'll route through
  // StyleAdapterService, not through Claude. So Write/Edit stay denied.
  const args = [
    '--print',
    '--output-format',
    'text',
    '--permission-mode',
    'plan',
    '--allowed-tools',
    'Glob,Grep',
    '--disallowed-tools',
    'Bash,WebFetch,WebSearch,Edit,Write,NotebookEdit,Task,Read',
  ];

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
      return { html: null, cancelled: true, error: null, runId };
    }
    if (result.error) {
      return { html: null, cancelled: false, error: result.error, runId };
    }
    // Read whatever claude wrote into the run's `out.jsonl` (named that
    // way by the chat runner — for design we treat it as raw text).
    let raw: string;
    try {
      raw = await fs.promises.readFile(path.join(handle.runDir, 'out.jsonl'), 'utf8');
    } catch (err) {
      return {
        html: null,
        cancelled: false,
        error: `failed to read claude output: ${(err as Error).message}`,
        runId,
      };
    }
    const html = extractHtml(raw);
    if (!html) {
      logger.warn(
        `no HTML extracted from design run ${runId} (output length ${raw.length})`,
      );
      return {
        html: null,
        cancelled: false,
        error: 'claude did not return HTML — try refining your brief',
        runId,
      };
    }
    return { html, cancelled: false, error: null, runId };
  })();

  return {
    kill: () => handle.kill(),
    completion,
  };
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

// Tolerant HTML extractor — claude often wraps its output in ```html
// fences, prefaces with a sentence ("Here's the page:"), or appends
// closing thoughts. We accept any of those.
//
// S3 hardening (v0.13): the v0.10 implementation took `firstDoctype …
// lastClose`, which merged two HTML documents if Claude emitted an
// example doctype inside a fenced code block AND the real one in
// prose — bad for both UX (broken page) and security (the merged
// document might mix two scripts that weren't reviewed together). The
// new version:
//   1. Prefer fenced ```html blocks. When SEVERAL are present, prefer
//      a fence that has BOTH a doctype/<html> opener AND a `</html>`
//      closer (a complete document); among complete fences, prefer the
//      LAST one — Claude's final answer is typically the bottom-most.
//      Falls back to the longest fence body when none look complete.
//   2. Outside of fences, take the FIRST doctype/html opener and the
//      FIRST `</html>` AFTER it (not the last) so two documents don't
//      get merged.
//   3. If no opener is found, return null instead of guessing.
export function extractHtml(raw: string): string | null {
  if (!raw) return null;

  // 1. Scan for fenced html blocks. Prefer a complete one (has both an
  //    `<!doctype`/`<html` and a `</html>`); among completes, take the
  //    last (typically the "final answer"). If none are complete, pick
  //    the longest body — that's almost certainly the real page.
  const fenceRe = /```(?:html|HTML)?\s*\r?\n([\s\S]*?)\r?\n```/g;
  let lastCompleteFence = '';
  let longestFence = '';
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(raw)) !== null) {
    const body = m[1] ?? '';
    const lower = body.toLowerCase();
    const hasOpen =
      lower.includes('<!doctype html') || lower.includes('<html');
    const hasClose = lower.includes('</html>');
    if (hasOpen && hasClose) lastCompleteFence = body;
    if (body.length > longestFence.length) longestFence = body;
  }

  const candidate = lastCompleteFence || longestFence || raw;
  const lower = candidate.toLowerCase();
  let start = lower.indexOf('<!doctype html');
  if (start < 0) start = lower.indexOf('<html');
  if (start < 0) return null;

  const endTag = '</html>';
  // Use FIRST close AFTER start, not last — avoids merging two docs.
  const endIdx = lower.indexOf(endTag, start);
  if (endIdx < 0) {
    // Tolerate truncated output — return what we have starting at the
    // doctype/html opener. Better to surface a partial page than fail
    // outright; the user can regenerate if it's broken.
    return candidate.slice(start).trim();
  }
  return candidate.slice(start, endIdx + endTag.length).trim();
}
