// StyleAdapterService — top-level dispatcher for source-aware write-back
// of design edits. Phase 0.8 ships ONE working adapter (Tailwind); the
// other kinds defined in DesignAdapterDetectResult resolve to a stub
// that returns `error: 'adapter not implemented in 0.8'` per edit so
// the UI can present a useful error.
//
// The dispatcher's two responsibilities:
//
//   1. detectAdapter(input)
//      Scan the project for evidence of which style stack(s) are in use
//      and pick the preferred adapter. Detection is intentionally fast
//      (a few stat + readFile calls); the renderer calls this on tab
//      activation to label the "Apply" button.
//
//   2. writeBack(input)
//      Validate the input, then dispatch each edit to the matching
//      adapter. We aggregate the per-edit results into a
//      DesignWriteBackResult.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createLogger } from '@shared/logger';
import type {
  DesignAdapterDetectInput,
  DesignAdapterDetectResult,
  DesignWriteBackApplied,
  DesignWriteBackEdit,
  DesignWriteBackInput,
  DesignWriteBackResult,
  StyleAdapterKind,
} from '@shared/design';

import { applyEdit as applyTailwindEdit } from './TailwindAdapter';

const logger = createLogger('StyleAdapterService');

// ─── input validation ─────────────────────────────────────────────────────

function assertAbsoluteSafePath(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${fieldName} is required`);
  }
  if (!path.isAbsolute(value)) {
    throw new Error(`${fieldName} must be absolute`);
  }
  if (value.split(/[\\/]/).some((seg) => seg === '..')) {
    throw new Error(`${fieldName} must not contain ..`);
  }
  return path.resolve(value);
}

// ─── adapter detection ─────────────────────────────────────────────────────

interface ParsedPackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

async function readPackageJson(projectPath: string): Promise<ParsedPackageJson | null> {
  try {
    const raw = await fs.readFile(path.join(projectPath, 'package.json'), 'utf8');
    return JSON.parse(raw) as ParsedPackageJson;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn(`failed to read package.json: ${(err as Error).message}`);
    }
    return null;
  }
}

async function hasFile(projectPath: string, candidates: string[]): Promise<string | null> {
  for (const file of candidates) {
    try {
      await fs.access(path.join(projectPath, file));
      return file;
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

/**
 * Walk a directory (depth-limited) and return whether at least one file
 * matching `predicate` exists. We cap the walk at MAX_ENTRIES so a giant
 * monorepo can't stall detection.
 */
async function existsMatching(
  root: string,
  predicate: (relPath: string) => boolean,
  maxEntries = 20_000,
): Promise<string | null> {
  let count = 0;
  const queue: string[] = [root];
  while (queue.length > 0 && count < maxEntries) {
    const dir = queue.shift()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      // Skip common heavy / generated directories so the scan is fast.
      // These DON'T count toward the cap — we're not scanning them.
      if (e.isDirectory()) {
        if (
          e.name === 'node_modules' ||
          e.name === '.git' ||
          e.name === 'dist' ||
          e.name === 'build' ||
          e.name === '.next' ||
          e.name === '.turbo' ||
          e.name === '.cache' ||
          e.name === 'coverage' ||
          e.name === '.devspace'
        ) {
          continue;
        }
        queue.push(abs);
      } else if (e.isFile()) {
        // Only count entries we actually inspect (the skip-list above is
        // free). Without this, the cap fires on entries we never scan,
        // truncating detection in monorepos with lots of skipped dirs.
        count++;
        if (count >= maxEntries) break;
        const rel = path.relative(root, abs);
        if (predicate(rel)) return rel;
      }
    }
  }
  return null;
}

// Per-file async lock — two concurrent writeBack calls to the same file
// would otherwise both read-splice-rename based on the same snapshot,
// silently losing the loser's changes. Serialize them at the file level
// so each edit applies to the current on-disk content.
const fileLocks = new Map<string, Promise<unknown>>();
async function withFileLock<T>(
  absPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = fileLocks.get(absPath) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  fileLocks.set(
    absPath,
    next.finally(() => {
      // Drop the entry only if it still points at our promise — a later
      // call may have already chained another step.
      if (fileLocks.get(absPath) === next) fileLocks.delete(absPath);
    }),
  );
  return next as Promise<T>;
}

export async function detectAdapter(
  input: DesignAdapterDetectInput,
): Promise<DesignAdapterDetectResult> {
  const projectPath = assertAbsoluteSafePath(input.projectPath, 'projectPath');
  const evidence: string[] = [];
  const available = new Set<StyleAdapterKind>();
  let preferred: StyleAdapterKind = 'unknown';

  // 1. Tailwind: package.json + tailwind.config.{js,ts,mjs,cjs}.
  const pkg = await readPackageJson(projectPath);
  const allDeps: Record<string, string> = {
    ...(pkg?.dependencies ?? {}),
    ...(pkg?.devDependencies ?? {}),
    ...(pkg?.peerDependencies ?? {}),
  };

  const tailwindCfg = await hasFile(projectPath, [
    'tailwind.config.ts',
    'tailwind.config.js',
    'tailwind.config.mjs',
    'tailwind.config.cjs',
  ]);
  if ('tailwindcss' in allDeps) {
    evidence.push('tailwindcss in dependencies');
    available.add('tailwind');
    if (tailwindCfg) {
      evidence.push(tailwindCfg);
      preferred = 'tailwind';
    } else if (preferred === 'unknown') {
      preferred = 'tailwind';
    }
  } else if (tailwindCfg) {
    evidence.push(`${tailwindCfg} (without tailwindcss dep)`);
    available.add('tailwind');
    if (preferred === 'unknown') preferred = 'tailwind';
  }

  // 2. styled-components / Emotion.
  if ('styled-components' in allDeps) {
    evidence.push('styled-components in dependencies');
    available.add('styled-components');
    if (preferred === 'unknown') preferred = 'styled-components';
  }
  if ('@emotion/styled' in allDeps || '@emotion/react' in allDeps) {
    evidence.push('@emotion/* in dependencies');
    available.add('styled-components');
    if (preferred === 'unknown') preferred = 'styled-components';
  }

  // 3. CSS Modules + vanilla CSS — scan `src/` for matching files. If
  // `src/` doesn't exist we scan from project root, but with the same
  // skip list and entry cap so detection stays bounded.
  const srcPath = path.join(projectPath, 'src');
  let scanRoot = srcPath;
  try {
    await fs.access(srcPath);
  } catch {
    scanRoot = projectPath;
  }

  const cssModuleEvidence = await existsMatching(
    scanRoot,
    (rel) => /\.module\.(css|scss|sass|less)$/i.test(rel),
  );
  if (cssModuleEvidence) {
    evidence.push(`CSS module: ${cssModuleEvidence}`);
    available.add('css-modules');
    if (preferred === 'unknown') preferred = 'css-modules';
  }

  const vanillaCssEvidence = await existsMatching(
    scanRoot,
    (rel) => /\.(css|scss|sass|less)$/i.test(rel) && !/\.module\.(css|scss|sass|less)$/i.test(rel),
  );
  if (vanillaCssEvidence) {
    evidence.push(`stylesheet: ${vanillaCssEvidence}`);
    available.add('vanilla-css');
    if (preferred === 'unknown') preferred = 'vanilla-css';
  }

  // Fallback: always offer "unknown" so the UI can render an
  // explanatory empty-state rather than failing.
  if (available.size === 0) {
    available.add('unknown');
    preferred = 'unknown';
    evidence.push('no style stack detected');
  }

  return {
    preferred,
    available: [...available].sort(),
    evidence,
  };
}

// ─── per-edit dispatch ─────────────────────────────────────────────────────

function notImplementedApplied(
  edit: DesignWriteBackEdit,
  adapter: StyleAdapterKind,
): DesignWriteBackApplied {
  return {
    sourceRef: edit.source?.ref ?? '',
    adapter,
    filePath: '',
    summary: '',
    error: 'adapter not implemented in 0.8',
  };
}

function pickAdapterForEdit(
  edit: DesignWriteBackEdit,
  preferred: StyleAdapterKind,
): StyleAdapterKind {
  // Future hook: the bridge populates `styledComponent` / `cssModuleClasses`
  // hints on the source so we can pick per-edit. For 0.8 we honour those
  // hints by returning the relevant adapter kind — the dispatcher will
  // then return the not-implemented stub for those kinds (which is the
  // correct behaviour: failure with a clear error message vs. silently
  // doing the wrong thing through the Tailwind adapter).
  if (edit.source?.styledComponent) return 'styled-components';
  if (edit.source?.cssModuleClasses && edit.source.cssModuleClasses.length > 0) {
    return 'css-modules';
  }
  return preferred;
}

export async function writeBack(
  input: DesignWriteBackInput,
): Promise<DesignWriteBackResult> {
  // Pre-validate the input. Any failure here returns a top-level error
  // with an empty `applied[]` — the renderer surfaces this in the toast.
  if (!input || typeof input !== 'object') {
    return { ok: false, applied: [], errorMessage: 'invalid write-back input' };
  }
  let projectPath: string;
  try {
    projectPath = assertAbsoluteSafePath(input.projectPath, 'projectPath');
  } catch (err) {
    return { ok: false, applied: [], errorMessage: (err as Error).message };
  }

  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    return { ok: false, applied: [], errorMessage: 'edits[] is empty' };
  }
  // Soft per-batch cap. A genuine UI invocation never sends more than a
  // handful of edits at once; anything larger likely indicates a bug or
  // an unbounded loop in the renderer.
  if (input.edits.length > 200) {
    return { ok: false, applied: [], errorMessage: 'too many edits in one batch' };
  }

  const dryRun = !!input.dryRun;
  const preferred = input.preferredAdapter ?? 'tailwind';

  const applied: DesignWriteBackApplied[] = [];
  for (const edit of input.edits) {
    const adapter = pickAdapterForEdit(edit, preferred);
    if (adapter === 'tailwind') {
      // Serialize writes per source file so two concurrent writeBacks
      // touching the same file can't interleave a read-splice-rename
      // race and silently drop one user's edit.
      // The lock key is the raw source.ref's file portion; the adapter
      // realpaths it later, but the unresolved path is fine as a lock
      // discriminator (collisions across realpath aliasing are
      // acceptable — they just over-serialize, never under-serialize).
      const rawRef = edit?.source?.ref ?? '';
      const lockKey = rawRef.split(':')[0] || '<no-ref>';
      // eslint-disable-next-line no-await-in-loop -- serial by design within a batch
      const result = await withFileLock(lockKey, () =>
        applyTailwindEdit(projectPath, edit, dryRun),
      );
      applied.push(result);
      continue;
    }
    // All other adapters are stubbed for 0.8 — return a clear,
    // actionable error per edit so the UI can dispatch to a "Phase 0.9"
    // help message.
    applied.push(notImplementedApplied(edit, adapter));
  }

  const anyError = applied.some((a) => a.error);
  return {
    ok: !anyError,
    applied,
    errorMessage: anyError ? 'one or more edits failed' : undefined,
  };
}
