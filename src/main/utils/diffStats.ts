// diffStats — pure helpers for deriving Cursor-style +N / -N additions
// and deletions from a Claude `tool_use` block. Stays in main/utils
// because the JSONL parser in ChatLineHandler is the only consumer in
// the main process; the renderer just reads the computed value off the
// persisted toolCall entry. Never throws — malformed input returns null
// so the chat stream keeps flowing even when claude emits a weird tool
// shape we don't recognize.

import * as path from 'node:path';

export interface DiffStats {
  additions: number;
  deletions: number;
  path: string;
}

// Tools that mutate files on disk. Anything outside this set returns
// null from computeToolDiffStats — Read/Grep/Bash/etc. don't get chips.
const FILE_MUTATING_TOOLS = new Set([
  'Edit',
  'Write',
  'NotebookEdit',
  'MultiEdit',
]);

// v0.16.0 review-fix M3: cap per-string scan to bound CPU + memory when a
// hostile / buggy LLM emits a multi-megabyte tool_use input. countLines
// is O(n) over the string, and computeToolDiffStats runs on every
// tool_use that flows through ChatLineHandler — a 1GB string would
// freeze the main process. 1 MB is comfortably larger than any
// legitimate edit (the largest source files in this repo are ~80KB).
const MAX_STRING_BYTES = 1_000_000;

// Tools recognized by Claude Code's NotebookEdit. Unknown modes are
// warned-and-treated-as-replace so we don't silently mis-classify a
// future mode addition.
const KNOWN_NOTEBOOK_EDIT_MODES = new Set(['', 'insert', 'replace', 'delete']);

/**
 * Count newline-terminated lines.
 *   ""        → 0
 *   "a"       → 1
 *   "a\nb"    → 2
 *   "a\n"     → 1   (trailing newline doesn't add a phantom blank line)
 *   "a\nb\n"  → 2
 *
 * The rule matches `wc -l + 1 unless the file is empty or ends in \n`
 * which is what users intuitively expect from a +N / -N chip.
 */
export function countLines(s: string): number {
  if (s.length === 0) return 0;
  // v0.16.0 review-fix M3: bound CPU on pathological inputs. Cap is far
  // above any legitimate file edit, so this only fires on malformed /
  // hostile JSONL where the right behavior is "show no chip" anyway.
  if (s.length > MAX_STRING_BYTES) return -1;
  // Strip exactly one trailing \n so "a\n" and "a" both count as 1.
  const trimmed = s.endsWith('\n') ? s.slice(0, -1) : s;
  if (trimmed.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed.charCodeAt(i) === 10) count++;
  }
  return count;
}

/**
 * Return a project-relative path when filePath lives inside projectPath,
 * otherwise the absolute path. Posix-only — devspace is macOS-only and
 * the JSONL paths from claude are always posix. Never throws.
 */
export function maybeRelativize(filePath: string, projectPath?: string): string {
  if (!filePath) return filePath;
  if (!projectPath) return filePath;
  try {
    const absFile = path.resolve(filePath);
    const absProject = path.resolve(projectPath);
    const rel = path.relative(absProject, absFile);
    // `..` prefix means the file is outside the project root — fall
    // back to absolute so the user still sees where the edit landed.
    if (rel === '' || rel.startsWith('..')) return absFile;
    return rel;
  } catch {
    return filePath;
  }
}

interface EditLike {
  old_string?: unknown;
  new_string?: unknown;
}

function statsFromEdit(edit: EditLike): { additions: number; deletions: number } | null {
  const oldStr = typeof edit.old_string === 'string' ? edit.old_string : '';
  const newStr = typeof edit.new_string === 'string' ? edit.new_string : '';
  const additions = countLines(newStr);
  const deletions = countLines(oldStr);
  // countLines returns -1 on over-cap inputs — propagate as a null sentinel
  // so callers know to drop the chip rather than render garbage numbers.
  if (additions < 0 || deletions < 0) return null;
  return { additions, deletions };
}

/**
 * Compute diff stats for a single tool_use call. Returns null when the
 * tool isn't a recognized file mutator or when the input shape doesn't
 * carry enough information to produce meaningful numbers.
 *
 * For Write: counts content as additions only — we don't have the prior
 *   file contents at this layer, so faking deletions would mislead.
 * For Edit:  countLines(new_string) additions, countLines(old_string) deletions.
 * For MultiEdit: sum across edits[].
 * For NotebookEdit: insert/replace use new_source as additions, delete_cell
 *   uses old_source (if claude included it) as deletions. Otherwise nulls.
 */
export function computeToolDiffStats(
  toolName: string,
  input: Record<string, unknown>,
  projectPath?: string,
): DiffStats | null {
  try {
    if (!FILE_MUTATING_TOOLS.has(toolName)) return null;
    if (!input || typeof input !== 'object') return null;

    if (toolName === 'Edit') {
      const fp = typeof input.file_path === 'string' ? input.file_path : '';
      if (!fp) return null;
      const stats = statsFromEdit(input as EditLike);
      if (!stats) return null;
      return {
        additions: stats.additions,
        deletions: stats.deletions,
        path: maybeRelativize(fp, projectPath),
      };
    }

    if (toolName === 'MultiEdit') {
      const fp = typeof input.file_path === 'string' ? input.file_path : '';
      if (!fp) return null;
      const edits = Array.isArray(input.edits) ? (input.edits as unknown[]) : [];
      let additions = 0;
      let deletions = 0;
      for (const e of edits) {
        if (e && typeof e === 'object') {
          const s = statsFromEdit(e as EditLike);
          // If any single edit is over-cap, drop the whole chip — sum
          // would be misleading.
          if (!s) return null;
          additions += s.additions;
          deletions += s.deletions;
        }
      }
      return {
        additions,
        deletions,
        path: maybeRelativize(fp, projectPath),
      };
    }

    if (toolName === 'Write') {
      const fp = typeof input.file_path === 'string' ? input.file_path : '';
      if (!fp) return null;
      const content = typeof input.content === 'string' ? input.content : '';
      const additions = countLines(content);
      // No prior content available here — deletions stay 0 rather than
      // guessing. Renderer will skip the chip when both are 0.
      if (additions <= 0) return null;
      return {
        additions,
        deletions: 0,
        path: maybeRelativize(fp, projectPath),
      };
    }

    if (toolName === 'NotebookEdit') {
      const fp = typeof input.notebook_path === 'string' ? input.notebook_path : '';
      if (!fp) return null;
      const editMode = typeof input.edit_mode === 'string' ? input.edit_mode : '';
      // v0.16.0 review-fix: warn on unrecognized modes so a future
      // Anthropic API addition doesn't silently mis-classify.
      if (!KNOWN_NOTEBOOK_EDIT_MODES.has(editMode)) {
        // eslint-disable-next-line no-console
        console.warn('[diffStats] unknown NotebookEdit edit_mode', { editMode });
      }
      const newSource = typeof input.new_source === 'string' ? input.new_source : '';
      const oldSource = typeof input.old_source === 'string' ? input.old_source : '';

      if (editMode === 'delete') {
        const deletions = countLines(oldSource);
        if (deletions <= 0) return null;
        return {
          additions: 0,
          deletions,
          path: maybeRelativize(fp, projectPath),
        };
      }

      // insert or replace (default — also covers unknown modes treated
      // conservatively as a replace).
      const additions = countLines(newSource);
      const deletions = countLines(oldSource);
      if (additions <= 0 && deletions <= 0) return null;
      return {
        additions: Math.max(0, additions),
        deletions: Math.max(0, deletions),
        path: maybeRelativize(fp, projectPath),
      };
    }

    return null;
  } catch (err) {
    // Never throw — malformed input shouldn't break the chat stream.
    // eslint-disable-next-line no-console
    console.warn('[diffStats] failed to compute stats', err);
    return null;
  }
}
