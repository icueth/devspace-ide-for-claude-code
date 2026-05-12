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
import type { DesignSkill, DesignSystem } from '@shared/design';

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
  const args = ['--print', '--output-format', 'text'];

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
// closing thoughts. We accept any of those by finding the first
// `<!DOCTYPE html>` (or bare `<html`) marker and the matching closing
// `</html>` tag.
export function extractHtml(raw: string): string | null {
  if (!raw) return null;

  // Strip code fences first, including the optional language tag.
  let text = raw;
  const fenceMatch = /```(?:html|HTML)?\s*\r?\n([\s\S]*?)\r?\n```/.exec(text);
  if (fenceMatch && fenceMatch[1]) {
    text = fenceMatch[1];
  }

  const lower = text.toLowerCase();
  let start = lower.indexOf('<!doctype html');
  if (start < 0) start = lower.indexOf('<html');
  if (start < 0) return null;

  const endTag = '</html>';
  const endIdx = lower.lastIndexOf(endTag);
  if (endIdx < 0 || endIdx < start) {
    // Tolerate truncated output — return what we have starting at the
    // doctype/html opener. Better to surface a partial page than fail
    // outright; the user can regenerate if it's broken.
    return text.slice(start).trim();
  }
  return text.slice(start, endIdx + endTag.length).trim();
}
