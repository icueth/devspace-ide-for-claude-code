// VanillaCssAdapter — applies one DesignWriteBackEdit to a project that
// uses plain CSS (`.btn { background: red }`) rather than Tailwind utility
// classes. The general strategy:
//
//   1. The Phase C bridge populates `edit.source.className` with the
//      element's className string AND `edit.source.ref` with the JSX
//      file:line:col anchor.
//   2. For each className token, walk the project's CSS files looking for
//      a plain class selector (`.btn`, `.card-primary`, etc.) whose rule
//      body we can edit. First match wins, deterministic by file walk
//      order, then position in file.
//   3. Inside the matched rule body, find an existing declaration of the
//      property (preferring longhand over shorthand) and replace its
//      value; if no declaration exists, append `<prop>: <val>;` just
//      before the closing `}`.
//   4. If NO className resolves to a rule, fall back to splicing a
//      `style={{ <prop>: <val> }}` prop onto the JSX element. Same path
//      the TailwindAdapter takes for computed className expressions.
//
// CSS parsing: SIMPLE regex-based — we explicitly do NOT pull in
// `postcss` because it brings ~50 transitive deps and a full plugin
// surface for what is, in this code path, "find one rule by class name
// and splice one property". The parser tracks `{}` depth so nested rules
// (e.g. inside `@media`) don't fool the matcher, and skips block
// comments before searching. It does NOT try to handle:
//   - selectors with our class buried in compound forms — `.outer .btn`
//     matches because the LEAF class is `.btn`, but `.btn:hover .inner`
//     does NOT (we look for the class as the rule's primary selector).
//   - `@import`-resolved external sheets.
//   - SCSS interpolation (`.btn-#{$variant}`).
// Anything fancy falls through to the style-prop fallback, which is the
// "safe" path.
//
// Path safety mirrors TailwindAdapter:
//   - lstat-before-realpath to defeat symlink redirects.
//   - extension allowlist (`.css`, `.scss`, `.sass`, `.less` for CSS
//     write target; `.tsx`/`.jsx`/`.ts`/`.js`/... for the JSX fallback
//     target — those are validated by the shared resolver in this file).
//   - node_modules subtree refused.
//   - project walk capped at 4000 entries to keep large monorepos snappy.
//   - atomic writes (tmp file + rename in same dir).

import { createPatch } from 'diff';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  DesignWriteBackApplied,
  DesignWriteBackEdit,
} from '@shared/design';
import { createLogger } from '@shared/logger';

import { applyStylePropFallback } from './jsxStyleWriter';

const logger = createLogger('VanillaCssAdapter');

// ─── constants ─────────────────────────────────────────────────────────────

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_WALK_ENTRIES = 4000;

const ALLOWED_CSS_EXT = new Set(['.css', '.scss', '.sass', '.less']);
const ALLOWED_JSX_EXT = new Set([
  '.tsx',
  '.jsx',
  '.ts',
  '.js',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
]);
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  '.devspace',
  'out',
]);

// Strict allowlist for CSS values (declaration RHS) the adapter is
// willing to write to disk. We must refuse anything that could:
//   • break out of the declaration into the next rule (`;` followed by
//     another property/selector),
//   • close the containing block early (`}`),
//   • introduce a CSS comment that swallows real code (`/*`),
//   • smuggle JSX/JS by being copied into the style-prop fallback (`<`,
//     `>`, `"`, `'`, `{`, `}`, backtick, `=`).
//
// The set we ALLOW is alphanum + the punctuation a colour-picker / size
// input legitimately produces: `-_.,#%/()\s` plus colon (for `var()`
// fallbacks). We deliberately drop `@`, `*`, `+`, `!` to match the
// other 0.9 adapters' tighter allowlist — `@` enables at-rule
// injection, `!` enables `!important` cascade-elevation that the user
// didn't author, and `*`/`+` only matter as CSS noise. The substring
// guard below still rejects the comment closer `*/` defense-in-depth.
const CSS_VALUE_RE = /^[A-Za-z0-9_:./%#,()\s-]+$/;

// ─── path validation ───────────────────────────────────────────────────────

interface ParsedSourceRef {
  file: string;
  line: number;
  col: number;
}

function parseSourceRef(ref: string): ParsedSourceRef | null {
  if (typeof ref !== 'string' || !ref) return null;
  const m = /^(.+):(\d+):(\d+)$/.exec(ref);
  if (!m) return null;
  const file = m[1]!;
  const line = Number(m[2]);
  const col = Number(m[3]);
  if (!Number.isInteger(line) || !Number.isInteger(col)) return null;
  if (line < 1 || col < 0) return null;
  return { file, line, col };
}

async function realProjectPath(projectPath: string): Promise<string> {
  try {
    return await fs.realpath(projectPath);
  } catch {
    throw new Error('project path does not exist');
  }
}

/**
 * Validate a file path discovered during the project walk (or the JSX
 * source.ref) against the project root. Uses lstat-before-realpath to
 * defeat symlink redirection, enforces the appropriate extension
 * allowlist, and refuses node_modules subtrees.
 */
async function assertSafeFileUnderProject(
  realProject: string,
  filePath: string,
  allowedExtensions: Set<string>,
): Promise<string> {
  if (!path.isAbsolute(filePath)) {
    throw new Error('file path must be absolute');
  }
  if (filePath.split(/[\\/]/).some((seg) => seg === '..')) {
    throw new Error('file path must not contain ..');
  }

  // Symlink-leaf check BEFORE realpath — a symlink whose target sits
  // inside the project would otherwise pass the boundary check while
  // redirecting writes to an unrelated file.
  let lst: { isSymbolicLink: () => boolean; isFile: () => boolean };
  try {
    lst = await fs.lstat(filePath);
  } catch {
    throw new Error(`file not found: ${filePath}`);
  }
  if (lst.isSymbolicLink()) {
    throw new Error('file path must not be a symlink');
  }
  if (!lst.isFile()) {
    throw new Error('file path must be a regular file');
  }

  let realFile: string;
  try {
    realFile = await fs.realpath(filePath);
  } catch {
    throw new Error(`file not found: ${filePath}`);
  }
  if (realFile !== realProject && !realFile.startsWith(realProject + path.sep)) {
    throw new Error('file escapes project root');
  }

  const ext = path.extname(realFile).toLowerCase();
  if (!allowedExtensions.has(ext)) {
    throw new Error(`unsupported file extension: ${ext}`);
  }

  const rel = path.relative(realProject, realFile);
  if (rel.split(path.sep).includes('node_modules')) {
    throw new Error('path points into node_modules');
  }

  return realFile;
}

// ─── project walk ──────────────────────────────────────────────────────────

/**
 * Walk the project for CSS files, returning their absolute paths in
 * deterministic order. The walk is breadth-first with alphabetical
 * per-directory ordering so the "first match wins" rule is reproducible
 * across runs and platforms.
 */
async function collectCssFiles(projectPath: string): Promise<string[]> {
  const results: string[] = [];
  const queue: string[] = [projectPath];
  let entries = 0;

  while (queue.length > 0 && entries < MAX_WALK_ENTRIES) {
    const dir = queue.shift()!;
    let dirents: import('node:fs').Dirent[];
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    // Deterministic order.
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of dirents) {
      if (e.isSymbolicLink()) continue; // never follow symlinks during the walk
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (e.name.startsWith('.') && e.name !== '.') continue;
        queue.push(abs);
      } else if (e.isFile()) {
        entries++;
        if (entries >= MAX_WALK_ENTRIES) break;
        const ext = path.extname(e.name).toLowerCase();
        if (ALLOWED_CSS_EXT.has(ext)) results.push(abs);
      }
    }
  }
  return results;
}

// ─── CSS parsing (simple regex) ───────────────────────────────────────────

/**
 * Strip CSS block comments (`/* ... *​/`) from a source string, REPLACING
 * the comment span with equal-length whitespace so byte offsets line up
 * with the original. We need the offsets to splice property updates back
 * into the unmodified file.
 */
function stripCssComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    if (source[i] === '/' && source[i + 1] === '*') {
      // Find the closing */
      const end = source.indexOf('*/', i + 2);
      if (end === -1) {
        // Unterminated comment — replace rest of file with spaces.
        out += ' '.repeat(source.length - i);
        i = source.length;
      } else {
        // Replace [i, end+2) with whitespace, preserving newlines so
        // line numbers in errors stay stable for the operator.
        for (let j = i; j < end + 2; j++) {
          out += source[j] === '\n' ? '\n' : ' ';
        }
        i = end + 2;
      }
      continue;
    }
    out += source[i];
    i++;
  }
  return out;
}

export interface RuleMatch {
  /** Absolute path of the CSS file containing the rule. */
  filePath: string;
  /** [start, end) span of the selector (left side of the `{`). */
  selectorRange: [number, number];
  /** [start, end) span of the rule body, EXCLUSIVE of the `{` and `}`. */
  bodyRange: [number, number];
}

/**
 * Find the first top-level rule in any project CSS file whose primary
 * selector references `className`. "Top-level" means brace depth 0 in
 * the comment-stripped source — nested rules inside `@media` etc. are
 * deliberately skipped because the SAME class may be redefined at top
 * level with the "real" styles. If we want to expand to nested matches
 * in a future pass, the depth check is the place to relax.
 *
 * The match requires `.className` to appear in the selector list with a
 * word boundary before AND a boundary after (one of `\s`, `,`, `{`).
 * That excludes `.fooBar` matching when searching for `.foo`, and
 * excludes `.foo-bar` matching when searching for `.foo`. Multi-class
 * selectors (`.foo.bar`) match either token — the boundary check accepts
 * `.` as a trailing boundary too.
 */
export async function findRuleForClass(
  projectPath: string,
  className: string,
): Promise<RuleMatch | null> {
  // Validate the class name: real CSS class identifiers are
  // `[A-Za-z_][A-Za-z0-9_-]*` plus optional escape sequences we don't
  // support here. Reject anything else to keep the regex safe — a class
  // with `.` or `[` in it could otherwise blow open the matcher.
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(className)) return null;

  const cssFiles = await collectCssFiles(projectPath);
  // Pre-build the boundary regex. Class is followed by one of:
  //   • whitespace / comma / `{` — primary selector boundary.
  //   • `.` — compound class selector (`.btn.primary`).
  //   • `:` — pseudo-class or pseudo-element (`.btn:hover`).
  //   • `>` `+` `~` — combinators.
  //   • end of selector (right at `{`).
  // The class itself must be preceded by start-of-line, whitespace, `,`,
  // `>`, `+`, `~`, `}` (after a previous rule), or beginning of file.
  const classRe = new RegExp(
    // Left boundary now includes `.` so compound class selectors
    // (`.bar.foo`, `.foo.bar`) match either token. The original
    // boundary set forbade `.`, so `.foo` in `.bar.foo { ... }`
    // silently fell through to the style-prop fallback for a very
    // common pattern.
    `(?:^|[\\s,>+~}.])\\.${escapeRegex(className)}(?=[\\s.,:>+~{[])`,
    'g',
  );

  for (const filePath of cssFiles) {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch {
      continue;
    }
    if (raw.length > MAX_FILE_BYTES) continue;
    const stripped = stripCssComments(raw);

    let m: RegExpExecArray | null;
    classRe.lastIndex = 0;
    while ((m = classRe.exec(stripped)) !== null) {
      // m.index points at the leading boundary char (or -1 for "start
      // of string" case). Advance to the `.` so subsequent matches don't
      // re-hit the same position.
      const classStart = m.index + (m[0].startsWith('.') ? 0 : 1);

      // Walk forward from classStart to the next `{`, tracking brace
      // depth. The match is a top-level rule iff we're at depth 0 when
      // we hit the `{`. We also bail out if we hit a `;` or `}` first
      // (means we matched inside a property value or a closed rule).
      let depth = depthAt(stripped, classStart);
      let i = classStart;
      let braceAt = -1;
      while (i < stripped.length) {
        const ch = stripped[i]!;
        if (ch === '{') {
          braceAt = i;
          break;
        }
        if (ch === '}' || ch === ';') break;
        i++;
      }
      if (braceAt === -1) continue;
      if (depth !== 0) continue; // skip nested rules

      // Walk the body to find the matching `}`.
      let bodyDepth = 1;
      let j = braceAt + 1;
      while (j < stripped.length && bodyDepth > 0) {
        const ch = stripped[j]!;
        if (ch === '{') bodyDepth++;
        else if (ch === '}') bodyDepth--;
        j++;
      }
      if (bodyDepth !== 0) continue; // unbalanced — skip

      // Selector starts at the previous `}` or start-of-file (after any
      // leading whitespace). For our purposes we don't need an exact
      // selector start — bodyRange is what we splice into.
      const selectorStart = findSelectorStart(stripped, braceAt);
      const selectorEnd = braceAt;
      const bodyStart = braceAt + 1;
      const bodyEnd = j - 1; // index of the `}`

      return {
        filePath,
        selectorRange: [selectorStart, selectorEnd],
        bodyRange: [bodyStart, bodyEnd],
      };
    }
  }
  return null;
}

/** Brace depth at position `i` in `source` (depth 0 = top level). */
function depthAt(source: string, i: number): number {
  let depth = 0;
  for (let k = 0; k < i; k++) {
    const ch = source[k];
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
  }
  return depth;
}

/** Find where the selector of the rule ending at `braceAt` starts. We
 * scan backwards to the previous `}` or `;` (end of previous rule /
 * top-level statement) or start-of-file, then skip leading whitespace. */
function findSelectorStart(source: string, braceAt: number): number {
  let k = braceAt - 1;
  while (k >= 0) {
    const ch = source[k];
    if (ch === '}' || ch === ';') {
      k++;
      break;
    }
    k--;
  }
  if (k < 0) k = 0;
  // Skip leading whitespace.
  while (k < braceAt && /\s/.test(source[k]!)) k++;
  return k;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── property edit inside a rule body ─────────────────────────────────────

interface PropertyEdit {
  /** Absolute file offsets where the new declaration goes. */
  start: number;
  end: number;
  /** The exact text to splice in. */
  replacement: string;
  /** Human-readable summary line. */
  summary: string;
}

/**
 * Plan the splice that adds or updates `<property>: <value>;` inside a
 * rule body. The body is `source[bodyStart..bodyEnd)` (NOT including
 * the `{` or `}`).
 *
 * Search order for "is this property already declared?":
 *   1. Exact longhand match (e.g. `background-color` when editing
 *      `background-color`).
 *   2. Shorthand match (e.g. `background` when editing
 *      `background-color`, but ONLY if no longhand match was found).
 *      We replace the shorthand value verbatim — the user asked for the
 *      property to change, and overwriting the shorthand is closer to
 *      "what they meant" than appending a longhand that loses (per CSS
 *      cascade) to the still-present shorthand below it.
 *   3. No match → append `<property>: <value>;` just before `}` with
 *      basic indentation that mirrors the existing body lines.
 *
 * The longhand-before-shorthand rule is the inverse of the cascade — but
 * it's the right choice for "I clicked this color and want it to
 * change". If both exist and longhand wins, replacing longhand is what
 * the user sees in the rendered page.
 */
function planRuleBodyEdit(
  source: string,
  bodyStart: number,
  bodyEnd: number,
  property: string,
  value: string,
): PropertyEdit {
  const body = source.slice(bodyStart, bodyEnd);

  // Look for an existing declaration of the exact property. Allow the
  // property name to appear at the start of a declaration: preceded by
  // `{`, `;`, or whitespace at start-of-body.
  const exactRe = new RegExp(
    `(^|[;{\\s])(${escapeRegex(property)})(\\s*:\\s*)([^;}]*)(;|(?=}))`,
    'g',
  );
  const exactMatch = exactRe.exec(body);

  // Look for shorthand. Only certain properties have a shorthand we
  // care about — keep the list tight to avoid false positives like
  // `border-radius` "matching" `border`.
  const SHORTHANDS: Record<string, string> = {
    'background-color': 'background',
    'background-image': 'background',
    'border-color': 'border',
    'border-width': 'border',
    'border-style': 'border',
    'font-size': 'font',
    'font-family': 'font',
    'font-weight': 'font',
    'margin-top': 'margin',
    'margin-right': 'margin',
    'margin-bottom': 'margin',
    'margin-left': 'margin',
    'padding-top': 'padding',
    'padding-right': 'padding',
    'padding-bottom': 'padding',
    'padding-left': 'padding',
  };
  const shorthand = SHORTHANDS[property];

  if (exactMatch) {
    // Replace just the value portion (group 4), preserving leading prefix.
    const fullStart = exactMatch.index;
    const prefix = exactMatch[1] ?? '';
    const name = exactMatch[2] ?? '';
    const sep = exactMatch[3] ?? '';
    const oldValue = exactMatch[4] ?? '';
    const valueStart = fullStart + prefix.length + name.length + sep.length;
    const valueEnd = valueStart + oldValue.length;
    return {
      start: bodyStart + valueStart,
      end: bodyStart + valueEnd,
      replacement: value,
      summary: `updated ${property}: ${value.trim()}`,
    };
  }
  if (shorthand) {
    const shortRe = new RegExp(
      `(^|[;{\\s])(${escapeRegex(shorthand)})(\\s*:\\s*)([^;}]*)(;|(?=}))`,
      'g',
    );
    const shortMatch = shortRe.exec(body);
    if (shortMatch) {
      const fullStart = shortMatch.index;
      const prefix = shortMatch[1] ?? '';
      const name = shortMatch[2] ?? '';
      const sep = shortMatch[3] ?? '';
      const oldValue = shortMatch[4] ?? '';
      const valueStart = fullStart + prefix.length + name.length + sep.length;
      const valueEnd = valueStart + oldValue.length;
      return {
        start: bodyStart + valueStart,
        end: bodyStart + valueEnd,
        replacement: value,
        summary: `updated ${shorthand} (was a shorthand for ${property}): ${value.trim()}`,
      };
    }
  }

  // Property not declared — append before the closing `}`.
  // Figure out indentation: look at the line that contains the closing
  // `}` and the lines inside the body to find existing declaration indent.
  const indent = inferBodyIndent(body);
  const trimmedBody = body.replace(/\s+$/, '');
  // If body ends in `;` or is empty, append on a new line. Otherwise add
  // a `;` between the last declaration and our insertion to keep things
  // syntactically clean.
  const needsTerminator = trimmedBody.length > 0 && !trimmedBody.endsWith(';');
  const leadingSemi = needsTerminator ? ';' : '';
  const newDecl = `${leadingSemi}\n${indent}${property}: ${value};`;
  // Insert at the very end of the body (just before `}`).
  const insertAt = bodyStart + trimmedBody.length;
  return {
    start: insertAt,
    end: insertAt,
    replacement: newDecl,
    summary: `added ${property}: ${value.trim()}`,
  };
}

/** Heuristic for "what indent are the declarations in this rule body
 * using?". Returns a string of spaces/tabs. Falls back to "  " (two
 * spaces) when the body has no existing declarations to copy from. */
function inferBodyIndent(body: string): string {
  const lines = body.split('\n');
  for (const line of lines) {
    if (/^\s*[A-Za-z-]+\s*:/.test(line)) {
      const m = /^(\s*)/.exec(line);
      if (m && m[1] !== undefined) return m[1];
    }
  }
  return '  ';
}

// ─── value validation ─────────────────────────────────────────────────────

/**
 * Refuse CSS values that could break out of the declaration, smuggle
 * comments, or be unsafe to splice into the JSX style-prop fallback.
 * Same strict allowlist the Tailwind adapter uses for arbitrary values.
 */
function isSafeCssValue(value: string): boolean {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > 1024) return false;
  // Reject explicit declaration terminators / block closers / comment
  // openers anywhere in the middle. Trailing `;` would be fine (we
  // append our own), but we want one clean value — reject it too.
  if (/[;{}<>"'`=\\]/.test(value)) return false;
  if (value.includes('/*') || value.includes('*/')) return false;
  // Reject url() — Chromium typically ignores `javascript:` URLs in
  // stylesheets, but Electron's `<webview>` has historically been more
  // permissive, and `url(http://attacker/x.png)` would beacon the
  // user's IP on every render of the affected component. The picker
  // UI in v0.9 doesn't emit url() values, so a blanket reject is fine.
  if (/\burl\s*\(/i.test(value)) return false;
  if (!CSS_VALUE_RE.test(value)) return false;
  return true;
}

/**
 * Validate the CSS property name. Must be a kebab-case identifier
 * (allowing leading `-` for vendor prefixes).
 */
function isSafeCssProperty(prop: string): boolean {
  if (typeof prop !== 'string') return false;
  if (prop.length === 0 || prop.length > 64) return false;
  return /^-?[A-Za-z][A-Za-z0-9-]*$/.test(prop);
}

// ─── public entry point ────────────────────────────────────────────────────

/**
 * Apply a single vanilla-CSS edit. Either rewrites a property in a
 * project `.css` rule whose selector matches one of the element's
 * classNames, or falls back to splicing a `style={{}}` prop on the JSX
 * element when no className resolves.
 *
 * Always returns a DesignWriteBackApplied; failures land in `.error`.
 */
export async function applyEdit(
  projectPath: string,
  edit: DesignWriteBackEdit,
  dryRun: boolean,
): Promise<DesignWriteBackApplied> {
  const base: DesignWriteBackApplied = {
    sourceRef: edit.source?.ref ?? '',
    adapter: 'vanilla-css',
    filePath: '',
    summary: '',
  };

  try {
    if (!edit.source || !edit.source.ref) {
      return { ...base, error: 'source.ref is required' };
    }
    if (!isSafeCssProperty(edit.property)) {
      return { ...base, error: `invalid CSS property name: ${edit.property}` };
    }
    if (!isSafeCssValue(edit.value)) {
      return { ...base, error: 'invalid CSS value (unsafe characters)' };
    }

    const realProject = await realProjectPath(projectPath);

    // Validate the JSX file pointed to by source.ref. We don't yet need
    // its contents — only the fallback path reads them — but we want
    // the same path-safety guarantees up front so callers get a clean
    // error if the bridge sent a malformed ref.
    const parsedRef = parseSourceRef(edit.source.ref);
    if (!parsedRef) {
      return { ...base, error: 'source.ref must be "<absPath>:<line>:<col>"' };
    }
    const jsxFile = await assertSafeFileUnderProject(
      realProject,
      parsedRef.file,
      ALLOWED_JSX_EXT,
    );

    // 1. Try to resolve the FIRST className that maps to a project CSS
    //    rule. The bridge populates source.className as the literal
    //    space-separated list; if it's missing or empty we skip straight
    //    to the style-prop fallback.
    const classNameStr =
      typeof edit.source.className === 'string' ? edit.source.className : '';
    const tokens = classNameStr
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean);

    let match: RuleMatch | null = null;
    for (const token of tokens) {
      // Tokens have already been split on whitespace; the
      // findRuleForClass validator rejects anything that isn't a clean
      // CSS identifier, so any tokens with funky chars (e.g.
      // `${dynamic}`) just don't match — they don't error.
      const m = await findRuleForClass(realProject, token);
      if (m) {
        match = m;
        break;
      }
    }

    if (match) {
      // Validate the CSS file path against the project root using the
      // same lstat-before-realpath dance. collectCssFiles already
      // scanned within the project, but a TOCTOU swap between scan and
      // write would otherwise escape — re-validate at write time.
      const cssAbs = await assertSafeFileUnderProject(
        realProject,
        match.filePath,
        ALLOWED_CSS_EXT,
      );
      base.filePath = cssAbs;

      const stat = await fs.stat(cssAbs);
      if (!stat.isFile()) {
        return { ...base, error: 'matched CSS path is not a regular file' };
      }
      if (stat.size > MAX_FILE_BYTES) {
        return { ...base, error: 'CSS file too large for in-memory edit' };
      }
      const original = await fs.readFile(cssAbs, 'utf8');

      // NOTE: findRuleForClass operates on the COMMENT-STRIPPED string,
      // but the offsets it returns are valid against the original too
      // because stripCssComments preserves byte-offsets (it pads
      // comments with whitespace rather than deleting them). That's the
      // invariant that lets us splice directly into `original` below.
      const plan = planRuleBodyEdit(
        original,
        match.bodyRange[0],
        match.bodyRange[1],
        edit.property,
        edit.value,
      );

      const newSource =
        original.slice(0, plan.start) + plan.replacement + original.slice(plan.end);

      if (newSource === original) {
        return { ...base, summary: 'no change (edit was a no-op)', diff: undefined };
      }

      const projectRel = path.relative(realProject, cssAbs) || path.basename(cssAbs);
      const patch = createPatch(projectRel, original, newSource, undefined, undefined, {
        context: 3,
      });

      if (!dryRun) {
        await atomicWrite(cssAbs, newSource);
      }

      return { ...base, summary: plan.summary, diff: patch };
    }

    // 2. No className resolved → style-prop fallback on the JSX element.
    base.filePath = jsxFile;

    const stat = await fs.stat(jsxFile);
    if (stat.size > MAX_FILE_BYTES) {
      return { ...base, error: 'JSX file too large for in-memory parse' };
    }
    const original = await fs.readFile(jsxFile, 'utf8');
    const fallback = await applyStylePropFallback({
      original,
      projectPath: realProject,
      edit,
    });

    if (fallback.newSource === original) {
      return { ...base, summary: 'no change (edit was a no-op)', diff: undefined };
    }

    const projectRel = path.relative(realProject, jsxFile) || path.basename(jsxFile);
    const patch = createPatch(projectRel, original, fallback.newSource, undefined, undefined, {
      context: 3,
    });

    if (!dryRun) {
      await atomicWrite(jsxFile, fallback.newSource);
    }

    return {
      ...base,
      summary: `${fallback.summary} (no matching CSS rule for any className)`,
      diff: patch,
    };
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    logger.warn(`vanilla-css adapter failed: ${message}`);
    return { ...base, error: message };
  }
}

// ─── atomic write ─────────────────────────────────────────────────────────

async function atomicWrite(absPath: string, content: string): Promise<void> {
  const dir = path.dirname(absPath);
  const tmp = path.join(dir, `.${path.basename(absPath)}.tmp-${randomUUID()}`);
  try {
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, absPath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}
