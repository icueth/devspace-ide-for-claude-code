// CssModulesAdapter — applies one DesignWriteBackEdit to a `.module.css`
// (or .scss/.sass/.less) file by editing the rule whose source class name
// matches one of the bridge-supplied runtime class names.
//
// Phase C3b. CSS Modules pipelines (Next.js, Vite, CRA) compile a source
// rule `.primary { ... }` in `Button.module.css` to a runtime class such
// as `Button_primary__abc123`. The bridge captures these hashed runtime
// class names in `edit.source.cssModuleClasses`. We:
//
//   1. De-hash each runtime class with a small set of conventions to
//      produce a list of CANDIDATE source class names.
//   2. Walk the project for `.module.{css,scss,sass,less}` files,
//      preferring co-located files in the JSX consumer's directory.
//   3. Read each candidate file and check whether any of the candidate
//      class names appears as a `.classname` selector. First match wins.
//   4. Find the rule body via `{}` depth tracking, then replace (or
//      append) the `<property>: <value>;` declaration.
//   5. Atomic write (tmp + rename), dryRun skips disk IO.
//
// Why a regex selector finder instead of a real CSS AST? The whole adapter
// is held to the "preserve the user's exact formatting" bar set by the
// Tailwind adapter — running through a CSS AST + printer would normalize
// quotes, comments, blank lines, and nested-rule indentation. The regex
// path is conservative: we ONLY rewrite the inside of the matched
// declaration, leaving the surrounding bytes byte-for-byte unchanged.

import { createPatch } from 'diff';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  DesignWriteBackApplied,
  DesignWriteBackEdit,
} from '@shared/design';
import { createLogger } from '@shared/logger';

const logger = createLogger('CssModulesAdapter');

// Hard upper bound on a CSS source file we'll parse. Same envelope as the
// Tailwind adapter — multi-MB stylesheets are essentially always either
// generated bundles or vendor dumps that the user didn't author.
const MAX_FILE_BYTES = 4 * 1024 * 1024;

// Soft cap on the project walk. The dispatcher's detector uses 20k but
// it's looking for ANY `.module.css`; we cap lower because the walk runs
// once per edit and we want it fast even on monorepos.
const MAX_WALK_ENTRIES = 4_000;

// Allowed file extensions for the CSS write target. The JSX consumer's
// extension is validated separately by `validateConsumerExt`.
const CSS_MODULE_EXT = new Set(['.css', '.scss', '.sass', '.less']);

// Allowed JSX consumer extensions — accept the same set the Tailwind
// adapter does. We only use this for path safety on the consumer ref so
// that a crafted ref can't redirect the walk's starting directory.
const JSX_CONSUMER_EXT = new Set([
  '.tsx',
  '.jsx',
  '.ts',
  '.js',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
]);

// Directories to skip during the project walk. Mirrors
// `StyleAdapterService.existsMatching` for consistency — these are the
// trees that never contain user-authored stylesheets.
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
  '.vercel',
]);

// SECURITY: characters allowed inside a CSS declaration value. The value
// is spliced verbatim into the target stylesheet; anything outside this
// set can break out of the declaration and inject script (e.g. via a
// CSS-in-JS template or a downstream PostCSS plugin that evaluates
// `url()`/`@import`). Keep tight — the user picks values from a colour /
// number / keyword picker, so the surface is small.
//
// Quotes, angle brackets, curlies, backticks, semicolons, backslash,
// equals, and `@` are all forbidden. This list is INTENTIONALLY narrower
// than CSS's grammar — we err on the side of refusing edits rather than
// risking RCE through a poisoned value.
const CSS_VALUE_RE = /^[A-Za-z0-9_:./%#,()\s-]+$/;

// Match a CSS property name. CSS allows `-`, letters, and digits; we
// accept the common vendor-prefix shapes (`-webkit-foo`, `--custom-var`).
const CSS_PROPERTY_RE = /^-{0,2}[A-Za-z][A-Za-z0-9-]*$/;

// Identifier shape we accept for de-hashed source class names. Mirrors a
// CSS ident: letters, digits, underscores, dashes (no leading digit).
const SOURCE_CLASS_RE = /^[A-Za-z_][\w-]*$/;

// ─── public types ─────────────────────────────────────────────────────────

export interface DehashCandidate {
  /** The de-hashed source class name (a candidate to look up in the file). */
  className: string;
  /** Which heuristic produced it. Useful for logging + debugging. */
  via: 'base-class-hash' | 'class-hash' | 'class-underscore-hash' | 'identity';
}

// ─── pure helpers (exported for tests) ────────────────────────────────────

/**
 * Validate a CSS property name. Accepts kebab-case identifiers plus the
 * leading-dash forms used by vendor prefixes (`-webkit-*`) and custom
 * properties (`--my-var`). Rejects anything containing whitespace,
 * colons, or other unsafe characters.
 */
export function isValidCssProperty(prop: string): boolean {
  if (typeof prop !== 'string') return false;
  if (prop.length === 0 || prop.length > 64) return false;
  return CSS_PROPERTY_RE.test(prop);
}

/**
 * Validate a CSS value against the adapter allowlist. Returns the trimmed
 * value when safe, null otherwise. Keep the allowlist narrow — see the
 * comment on `CSS_VALUE_RE` for the security rationale.
 */
export function safeCssValue(value: string): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 256) return null;
  // Reject url() — exfil + permissive-webview risk (see VanillaCssAdapter).
  if (/\burl\s*\(/i.test(trimmed)) return null;
  if (!CSS_VALUE_RE.test(trimmed)) return null;
  return trimmed;
}

/**
 * De-hash one runtime class name into all plausible source class names.
 * Tries the three conventions documented in the file header, in order.
 * Always includes the identity transform as a final candidate so a
 * non-hashed runtime class (used by some bundlers in dev mode) still
 * resolves.
 *
 *   dehashRuntimeClass('Button_primary__abc123')
 *     → [{ className: 'primary', via: 'base-class-hash' },
 *        { className: 'Button_primary', via: 'class-underscore-hash' },
 *        { className: 'Button_primary__abc123', via: 'identity' }]
 *
 *   dehashRuntimeClass('primary--abc123')
 *     → [{ className: 'primary', via: 'class-hash' },
 *        { className: 'primary--abc123', via: 'identity' }]
 *
 *   dehashRuntimeClass('primary_abc123')
 *     → [{ className: 'primary', via: 'class-underscore-hash' },
 *        { className: 'primary_abc123', via: 'identity' }]
 *
 *   dehashRuntimeClass('primary')
 *     → [{ className: 'primary', via: 'identity' }]
 *
 * Convention overlap is real and accepted: `button_primary_abc123` could
 * be `<base=button>__<src=primary>__<hash>` after a slash transform OR
 * `<src=button_primary>_<hash>` from Webpack's default `localIdentName`.
 * The caller looks up every candidate in the file — whichever class is
 * actually defined there wins.
 */
export function dehashRuntimeClass(runtimeClass: string): DehashCandidate[] {
  const out: DehashCandidate[] = [];
  const seen = new Set<string>();
  const push = (className: string, via: DehashCandidate['via']): void => {
    if (!className || seen.has(className)) return;
    if (!SOURCE_CLASS_RE.test(className)) return;
    seen.add(className);
    out.push({ className, via });
  };

  if (typeof runtimeClass !== 'string' || runtimeClass.length === 0) {
    return out;
  }
  // Sanity cap: a real runtime class is well under 256 chars.
  if (runtimeClass.length > 256) return out;

  // 1. `<base>__<sourceClass>--<hash>` — Next.js + css-loader default
  //    with the `[name]__[local]--[hash:base64:5]` template.
  let m = /^([A-Za-z_][\w-]*)__([A-Za-z_][\w-]*)--[A-Za-z0-9_-]+$/.exec(runtimeClass);
  if (m) push(m[2]!, 'base-class-hash');

  // 2. `<sourceClass>--<hash>` — Vite's CSS Modules default plus several
  //    custom `generateScopedName` configurations.
  m = /^([A-Za-z_][\w-]*)--[A-Za-z0-9_-]+$/.exec(runtimeClass);
  if (m) push(m[1]!, 'class-hash');

  // 3. `<sourceClass>_<hash>` — Webpack's older default. The class name
  //    can legitimately contain underscores (`my_class_name`), so a
  //    single greedy regex would pick the wrong split. Instead we walk
  //    underscore positions from right to left, emitting EVERY candidate
  //    that has a hashable-looking tail (alphanumeric, ≥1 char) and a
  //    non-trivial head (≥3 chars, valid CSS identifier shape). The file
  //    content decides which candidate is real.
  for (let idx = runtimeClass.length - 1; idx > 0; idx--) {
    if (runtimeClass[idx] !== '_') continue;
    const head = runtimeClass.slice(0, idx);
    const tail = runtimeClass.slice(idx + 1);
    if (head.length < 3) continue;
    if (!/^[A-Za-z_][\w-]*$/.test(head)) continue;
    if (!/^[A-Za-z0-9]+$/.test(tail)) continue;
    push(head, 'class-underscore-hash');
  }

  // 4. Identity — the runtime class itself, when it looks like a valid
  //    CSS identifier. Handles dev-mode bundlers that don't hash, as
  //    well as cases where the bridge already de-hashed for us.
  if (SOURCE_CLASS_RE.test(runtimeClass)) {
    push(runtimeClass, 'identity');
  }
  return out;
}

/**
 * Locate the rule body for `.<className>` in a CSS source string. Returns
 * a `{ openBrace, closeBrace }` pair where `openBrace` is the index of
 * the `{` that opens the rule body and `closeBrace` is the index of the
 * matching `}`. Returns null when no matching rule exists.
 *
 * The selector regex matches `.className` followed by either `{`, `,`, a
 * pseudo-class (`:hover`), a descendant combinator (` `), or a child
 * combinator (`>`). For 0.9, we ONLY edit the BASE rule — when the same
 * class appears as `.primary:hover` we skip it and keep looking. This
 * mirrors the comment in the task brief: pseudo-state variants are
 * preserved unchanged.
 *
 * The body finder tracks `{}` depth so it correctly handles Sass nested
 * rules — `.outer { .inner { ... } }` still resolves `.inner`'s body
 * to the inner `{...}` even though it lives inside `.outer`.
 *
 * String / comment skipping: CSS doesn't allow `{` inside strings or
 * comments BUT Sass-style line comments do. We strip block comments and
 * line comments before counting braces.
 */
export function findRuleBody(
  source: string,
  className: string,
): { openBrace: number; closeBrace: number } | null {
  if (!SOURCE_CLASS_RE.test(className)) return null;
  // Escape any regex metachars (`-` is the only one our charset allows
  // that needs care; SOURCE_CLASS_RE already rejects others).
  const escaped = className.replace(/-/g, '\\-');
  // Look for `.className` followed by a selector-terminator. We use a
  // word-boundary-like trailing char-class to refuse partial matches
  // like `.primaryButton` when looking for `.primary`.
  //
  // Allowed terminators:
  //   `{`  — direct rule open: `.primary { ... }`
  //   `,`  — selector list continuation: `.primary, .secondary { ... }`
  //   ` `  — descendant combinator: `.primary span { ... }`
  //   `>`  — child combinator
  //   `+`  — adjacent sibling
  //   `~`  — general sibling
  //   `\n` / `\t` — whitespace before any of the above
  //
  // Pseudo-class (`:`) and attribute (`[`) terminators are EXCLUDED —
  // we don't want to land on `.primary:hover` or `.primary[disabled]`
  // when looking for the base rule.
  const selectorRe = new RegExp(
    `\\.${escaped}(?=[\\s,{>+~])`,
    'g',
  );

  // Strip comments before scanning. We only need to neutralize them for
  // brace counting; the offsets used by the regex stay correct as long
  // as we operate on a mirror string of the same length. Replacing each
  // comment char-for-char with spaces preserves byte offsets.
  const neutralized = neutralizeCommentsAndStrings(source);

  let m: RegExpExecArray | null;
  while ((m = selectorRe.exec(neutralized)) !== null) {
    const matchEnd = m.index + m[0].length;
    // From matchEnd, walk forward past the selector list (commas, other
    // selectors) until we hit the rule's opening `{`. If we hit `;` or
    // end-of-file first, this wasn't a rule (could be a `@include`).
    const openBrace = findRuleOpenBrace(neutralized, matchEnd);
    if (openBrace < 0) continue;
    // Confirm this match is for the BASE rule (no `:pseudo` between the
    // class and the `{`). The match was already constrained to a
    // terminator that isn't `:`, but the FULL selector between matchEnd
    // and openBrace might still contain `:` (e.g. `.primary span:hover`
    // → that's fine, the `:hover` applies to `span`, not `.primary`).
    //
    // The case we WANT to skip is `.primary:hover { ... }` where the `:`
    // immediately follows `.primary` — that variant is already rejected
    // by the regex terminator. So we can accept any rule that opens.
    const closeBrace = findMatchingCloseBrace(neutralized, openBrace);
    if (closeBrace < 0) continue;
    return { openBrace, closeBrace };
  }
  return null;
}

/**
 * From `start`, scan forward to find the `{` that opens a rule. Returns
 * its index, or -1 if we hit `;`, `}`, or EOF first. The neutralized
 * string has comments + string contents replaced with spaces so we
 * can't mis-fire on a `;` inside a string.
 */
function findRuleOpenBrace(neutralized: string, start: number): number {
  for (let i = start; i < neutralized.length; i++) {
    const ch = neutralized[i];
    if (ch === '{') return i;
    if (ch === ';' || ch === '}') return -1;
  }
  return -1;
}

/**
 * From an opening `{`, find the index of the matching `}`. Tracks
 * brace depth — works for Sass nested rules.
 */
function findMatchingCloseBrace(neutralized: string, openBrace: number): number {
  let depth = 0;
  for (let i = openBrace; i < neutralized.length; i++) {
    const ch = neutralized[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Replace block comments (`/* ... *​/`), line comments (`// ... \n`), and
 * the contents of single/double-quoted strings with spaces, preserving
 * byte offsets. The brace counter operates on this mirror string so a
 * stray `{` inside a comment or a string literal doesn't throw off
 * depth tracking.
 *
 * We deliberately handle `//` comments even for plain CSS — they're a
 * syntax error in CSS but Sass/Less projects routinely use them, and
 * our worst case is silently dropping a stray `//` inside a CSS value
 * (which we'd reject anyway in `safeCssValue`).
 */
function neutralizeCommentsAndStrings(source: string): string {
  // Pre-allocate a char array we'll mutate.
  const out = source.split('');
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    // Block comment
    if (ch === '/' && next === '*') {
      let j = i + 2;
      while (j < source.length - 1 && !(source[j] === '*' && source[j + 1] === '/')) {
        if (source[j] !== '\n') out[j] = ' ';
        j++;
      }
      // Blank out the `/*` and `*/` markers too, but not newlines.
      out[i] = ' ';
      out[i + 1] = ' ';
      if (j < source.length - 1) {
        out[j] = ' ';
        out[j + 1] = ' ';
        i = j + 2;
      } else {
        i = source.length;
      }
      continue;
    }
    // Line comment (Sass / Less)
    if (ch === '/' && next === '/') {
      let j = i;
      while (j < source.length && source[j] !== '\n') {
        out[j] = ' ';
        j++;
      }
      i = j;
      continue;
    }
    // String literal — single or double quoted. CSS values inside `url("...")`
    // or `content: "..."` can contain `{` `}` `;` chars; blank them out.
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const startQuote = i;
      let j = i + 1;
      while (j < source.length && source[j] !== quote) {
        // Honour backslash escapes.
        if (source[j] === '\\' && j + 1 < source.length) {
          out[j] = ' ';
          out[j + 1] = ' ';
          j += 2;
          continue;
        }
        if (source[j] !== '\n') out[j] = ' ';
        j++;
      }
      out[startQuote] = ' ';
      if (j < source.length) {
        out[j] = ' ';
        i = j + 1;
      } else {
        i = source.length;
      }
      continue;
    }
    i++;
  }
  return out.join('');
}

/**
 * Within a rule body (`{...}`), replace or append a `<property>: <value>;`
 * declaration. Returns the new full file content. The caller passes the
 * indices of the opening `{` and closing `}` so this function doesn't
 * need to re-find them.
 *
 * Behavior:
 *   • If the property already appears as a top-level declaration in the
 *     body (NOT inside a nested rule), replace its value. We walk the
 *     body tracking nested `{}` depth so a `padding` inside a `&:hover`
 *     nested rule doesn't get rewritten.
 *   • Otherwise, append `  <property>: <value>;` before the closing `}`,
 *     preserving the existing indentation by sampling the indentation
 *     of the last non-blank line in the body.
 */
export function applyDeclarationEdit(
  source: string,
  openBrace: number,
  closeBrace: number,
  property: string,
  value: string,
): { newSource: string; summary: string } {
  // Operate on the body region as raw text so we preserve every original
  // byte outside our edit window.
  const bodyStart = openBrace + 1;
  const bodyEnd = closeBrace;

  // Build a neutralized mirror of the body for declaration scanning, so
  // comments/strings/nested-rule contents don't trick our property regex.
  const fullNeutralized = neutralizeCommentsAndStrings(source);
  // Walk the body at depth 0 (the outer rule), collecting top-level
  // declaration spans `<prop> : <value> ;`. When we find one matching
  // `property`, return its value span so we can splice the new value in.
  const escapedProp = property.replace(/-/g, '\\-');
  // Top-level scan. We can't use a global regex without depth tracking,
  // so do a manual walk.
  let depth = 0;
  let i = bodyStart;
  while (i < bodyEnd) {
    const ch = fullNeutralized[i];
    if (ch === '{') {
      depth++;
      i++;
      continue;
    }
    if (ch === '}') {
      depth--;
      i++;
      continue;
    }
    if (depth === 0) {
      // At this depth, try to match `<prop>\s*:\s*<value>\s*;` starting at i.
      // We anchor by looking for a non-whitespace token start.
      if (/[A-Za-z\-_]/.test(ch ?? '')) {
        const decl = matchDeclarationAt(fullNeutralized, source, i, bodyEnd, escapedProp);
        if (decl) {
          // Replace the value span inclusive of trailing `;`.
          // `decl.valueStart` is just after `:` + whitespace; `decl.valueEnd`
          // is the index of `;`. We keep the leading colon-space layout
          // by replacing only `[valueStart, valueEnd)`.
          const before = source.slice(0, decl.valueStart);
          const after = source.slice(decl.valueEnd);
          const newSource = before + value + after;
          return {
            newSource,
            summary: `updated ${property} = ${value}`,
          };
        }
        // Skip past this declaration (or chunk) to avoid a re-scan that
        // could loop. Advance to the next `;` or `{` or `}`.
        let j = i;
        while (j < bodyEnd) {
          const c = fullNeutralized[j];
          if (c === ';' || c === '{' || c === '}') break;
          j++;
        }
        i = j === i ? i + 1 : j;
        continue;
      }
    }
    i++;
  }

  // Property not found — append a new declaration just before `}`. Sample
  // the existing indentation by finding the last newline + leading
  // whitespace inside the body.
  const bodyText = source.slice(bodyStart, bodyEnd);
  const indent = guessBodyIndent(bodyText);
  // Decide whether the body is empty / single-line vs. multi-line.
  const isMultiLine = /\n/.test(bodyText);
  let insertion: string;
  if (isMultiLine) {
    // If the body ends with whitespace before `}`, slot our line in just
    // before the closing brace's leading whitespace. We do this by
    // inserting at the position of the last `\n` in the body + 1, so the
    // new line carries the matching indent.
    const lastNewline = bodyText.lastIndexOf('\n');
    if (lastNewline >= 0) {
      // Insert AFTER the last newline so the new declaration lands on
      // its own line; the indent it carries comes from `indent`. We
      // include a trailing newline so the existing closing-brace line
      // keeps its position.
      const insertAt = bodyStart + lastNewline + 1;
      const before = source.slice(0, insertAt);
      const after = source.slice(insertAt);
      insertion = `${indent}${property}: ${value};\n`;
      return {
        newSource: before + insertion + after,
        summary: `added ${property} = ${value}`,
      };
    }
  }
  // Single-line body (`.x { color: red; }`) — insert with a space before
  // the closing brace.
  const before = source.slice(0, bodyEnd);
  const after = source.slice(bodyEnd);
  const needsSpace = before.length > 0 && !/\s$/.test(before);
  const needsTrailingSpace = !/^\s/.test(after);
  insertion = `${needsSpace ? ' ' : ''}${property}: ${value};${needsTrailingSpace ? ' ' : ''}`;
  return {
    newSource: before + insertion + after,
    summary: `added ${property} = ${value}`,
  };
}

interface DeclarationMatch {
  /** Start of the value portion (right after `:` + whitespace). */
  valueStart: number;
  /** End of the value portion, i.e. the index of the `;` terminator. */
  valueEnd: number;
}

/**
 * Try to match `<property>\s*:\s*<value>;` starting at `pos` inside the
 * neutralized mirror. We need the neutralized string so that semicolons
 * inside `url("...;")` don't terminate the value early. Returns null
 * when the chunk at `pos` isn't this property's declaration.
 *
 * NB: we match against `neutralized` but slice from the original `source`
 * for the returned indices — they index the same byte offsets in both.
 */
function matchDeclarationAt(
  neutralized: string,
  _source: string,
  pos: number,
  limit: number,
  escapedProp: string,
): DeclarationMatch | null {
  // Regex anchored at pos. RegExp `lastIndex` doesn't anchor `^` so we
  // use a sticky regex (`y` flag).
  const re = new RegExp(`${escapedProp}\\s*:\\s*`, 'y');
  re.lastIndex = pos;
  const m = re.exec(neutralized);
  if (!m || m.index !== pos) return null;
  const valueStart = pos + m[0].length;
  if (valueStart >= limit) return null;
  // Scan forward to the next `;` at the same depth-0 (we're already at
  // depth 0 because the caller only invokes us there, and a `{` inside
  // the value is invalid CSS).
  let j = valueStart;
  while (j < limit) {
    const ch = neutralized[j];
    if (ch === ';') return { valueStart, valueEnd: j };
    if (ch === '{' || ch === '}') return null;
    j++;
  }
  return null;
}

/**
 * Sample the indent of the last non-blank line in a rule body. Falls
 * back to two spaces.
 */
function guessBodyIndent(bodyText: string): string {
  const lines = bodyText.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const m = /^([ \t]+)\S/.exec(line);
    if (m) return m[1]!;
  }
  return '  ';
}

// ─── path safety ──────────────────────────────────────────────────────────

interface SafeProject {
  realProject: string;
}

async function resolveProjectSafely(projectPath: string): Promise<SafeProject> {
  if (!path.isAbsolute(projectPath)) {
    throw new Error('projectPath must be absolute');
  }
  if (projectPath.split(/[\\/]/).some((seg) => seg === '..')) {
    throw new Error('projectPath must not contain ..');
  }
  let realProject: string;
  try {
    realProject = await fs.realpath(projectPath);
  } catch {
    throw new Error('project path does not exist');
  }
  return { realProject };
}

/**
 * Resolve and validate the consumer JSX file's `<file>:<line>:<col>` ref.
 * We only need the file part — line/col aren't used by this adapter —
 * but we still validate the full triple to keep the contract identical
 * to TailwindAdapter so the dispatcher's expectations match.
 *
 * Returns null when the ref is missing or unparseable; throws on path
 * safety violations (parent does node_modules / symlink / extension
 * checks below).
 */
function parseSourceRef(ref: string | undefined): { file: string } | null {
  if (typeof ref !== 'string' || !ref) return null;
  const m = /^(.+):(\d+):(\d+)$/.exec(ref);
  if (!m) return null;
  return { file: m[1]! };
}

async function validateConsumerFile(
  realProject: string,
  consumerFile: string,
): Promise<string> {
  if (!path.isAbsolute(consumerFile)) {
    throw new Error('source.ref file must be absolute');
  }
  if (consumerFile.split(/[\\/]/).some((seg) => seg === '..')) {
    throw new Error('source.ref must not contain ..');
  }
  // lstat before realpath — see TailwindAdapter notes on symlink leaf
  // attacks.
  let lst: { isSymbolicLink: () => boolean; isFile: () => boolean };
  try {
    lst = await fs.lstat(consumerFile);
  } catch {
    throw new Error(`source.ref file not found: ${consumerFile}`);
  }
  if (lst.isSymbolicLink()) {
    throw new Error('source.ref must not be a symlink');
  }
  if (!lst.isFile()) {
    throw new Error('source.ref must be a regular file');
  }
  let realFile: string;
  try {
    realFile = await fs.realpath(consumerFile);
  } catch {
    throw new Error(`source.ref file not found: ${consumerFile}`);
  }
  if (
    realFile !== realProject &&
    !realFile.startsWith(realProject + path.sep)
  ) {
    throw new Error('source.ref escapes project root');
  }
  const ext = path.extname(realFile).toLowerCase();
  if (!JSX_CONSUMER_EXT.has(ext)) {
    throw new Error(`unsupported consumer file extension: ${ext}`);
  }
  const rel = path.relative(realProject, realFile);
  if (rel.split(path.sep).includes('node_modules')) {
    throw new Error('source.ref points into node_modules');
  }
  return realFile;
}

/**
 * Validate that a candidate CSS module file is in-project, not a
 * symlink, and has an allowed extension. Returns the realpath on
 * success; throws on violation.
 */
async function validateModuleFile(
  realProject: string,
  candidate: string,
): Promise<string> {
  let lst: { isSymbolicLink: () => boolean; isFile: () => boolean };
  try {
    lst = await fs.lstat(candidate);
  } catch {
    throw new Error(`module file not found: ${candidate}`);
  }
  if (lst.isSymbolicLink()) {
    throw new Error('module file must not be a symlink');
  }
  if (!lst.isFile()) {
    throw new Error('module file must be a regular file');
  }
  let real: string;
  try {
    real = await fs.realpath(candidate);
  } catch {
    throw new Error(`module file not found: ${candidate}`);
  }
  if (real !== realProject && !real.startsWith(realProject + path.sep)) {
    throw new Error('module file escapes project root');
  }
  const ext = path.extname(real).toLowerCase();
  if (!CSS_MODULE_EXT.has(ext)) {
    throw new Error(`unsupported module file extension: ${ext}`);
  }
  const rel = path.relative(realProject, real);
  if (rel.split(path.sep).includes('node_modules')) {
    throw new Error('module file points into node_modules');
  }
  return real;
}

// ─── project walk ─────────────────────────────────────────────────────────

/**
 * Walk the project breadth-first collecting `.module.{css,scss,sass,less}`
 * file paths. Skips heavy directories and caps total entries at
 * MAX_WALK_ENTRIES so the scan stays bounded on monorepos. When
 * `preferDir` is provided, files inside it are emitted first.
 */
async function findCssModuleCandidates(
  realProject: string,
  preferDir: string | null,
): Promise<string[]> {
  const matches: string[] = [];
  const preferred: string[] = [];
  let inspected = 0;
  const queue: string[] = [realProject];
  while (queue.length > 0 && inspected < MAX_WALK_ENTRIES) {
    const dir = queue.shift()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        // Defensive: never descend into a symlinked dir (cycle / escape).
        // We use lstat indirectly here; readdir's `isDirectory()` already
        // reports false for symlinks because we don't pass `{ withFileTypes: true }`
        // with symlink-following. Still, lstat the entry explicitly for
        // paranoid certainty.
        try {
          const lst = await fs.lstat(abs);
          if (lst.isSymbolicLink()) continue;
        } catch {
          continue;
        }
        queue.push(abs);
        continue;
      }
      if (!e.isFile()) continue;
      inspected++;
      if (inspected >= MAX_WALK_ENTRIES) break;
      if (!/\.module\.(css|scss|sass|less)$/i.test(e.name)) continue;
      if (preferDir && abs.startsWith(preferDir + path.sep)) {
        preferred.push(abs);
      } else if (preferDir && path.dirname(abs) === preferDir) {
        // Same-directory match — also preferred.
        preferred.push(abs);
      } else {
        matches.push(abs);
      }
    }
  }
  // Preferred-first ordering.
  return [...preferred, ...matches];
}

/**
 * Locate the first `.module.*` file containing one of the candidate
 * source class names as a base rule. Returns the file path + the
 * candidate class name that matched, or null when nothing matches.
 */
async function findMatchingModuleFile(
  realProject: string,
  candidates: DehashCandidate[],
  preferDir: string | null,
): Promise<{ file: string; className: string } | null> {
  if (candidates.length === 0) return null;
  const files = await findCssModuleCandidates(realProject, preferDir);
  for (const file of files) {
    let real: string;
    try {
      real = await validateModuleFile(realProject, file);
    } catch (err) {
      logger.debug(`skipping module file: ${(err as Error).message}`);
      continue;
    }
    let stat: import('node:fs').Stats;
    try {
      stat = await fs.stat(real);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) {
      continue;
    }
    let content: string;
    try {
      content = await fs.readFile(real, 'utf8');
    } catch {
      continue;
    }
    for (const cand of candidates) {
      // Cheap pre-check before running the full body finder.
      // Use a basic substring scan — false positives are fine, the body
      // finder is the source of truth.
      if (!content.includes(`.${cand.className}`)) continue;
      const found = findRuleBody(content, cand.className);
      if (found) {
        return { file: real, className: cand.className };
      }
    }
  }
  return null;
}

// ─── public entry point ───────────────────────────────────────────────────

/**
 * Apply a single CSS-Modules edit to disk (or compute the diff when
 * dryRun). Always returns a DesignWriteBackApplied; failures land in
 * `.error` so the dispatcher can surface them per-edit.
 */
export async function applyEdit(
  projectPath: string,
  edit: DesignWriteBackEdit,
  dryRun: boolean,
): Promise<DesignWriteBackApplied> {
  const base: DesignWriteBackApplied = {
    sourceRef: edit?.source?.ref ?? '',
    adapter: 'css-modules',
    filePath: '',
    summary: '',
  };
  try {
    if (!edit || typeof edit !== 'object') {
      return { ...base, error: 'edit is required' };
    }
    if (!edit.source || typeof edit.source !== 'object') {
      return { ...base, error: 'edit.source is required' };
    }
    const runtimeClasses = edit.source.cssModuleClasses ?? [];
    if (!Array.isArray(runtimeClasses) || runtimeClasses.length === 0) {
      return { ...base, error: 'source.cssModuleClasses is empty' };
    }
    // Cap the input to defend against pathological inputs to the regex
    // engine. UI sends at most a handful of classes per element.
    if (runtimeClasses.length > 32) {
      return { ...base, error: 'too many cssModuleClasses (max 32)' };
    }
    // Validate CSS property + value before doing any IO.
    if (!isValidCssProperty(edit.property)) {
      return { ...base, error: `invalid CSS property name: ${edit.property}` };
    }
    const safeValue = safeCssValue(edit.value);
    if (safeValue === null) {
      return { ...base, error: 'invalid CSS value (failed allowlist)' };
    }

    const { realProject } = await resolveProjectSafely(projectPath);

    // Compute candidates from every runtime class. De-duplicate by
    // className across the runtime-class list.
    const seen = new Set<string>();
    const allCandidates: DehashCandidate[] = [];
    for (const rc of runtimeClasses) {
      if (typeof rc !== 'string') continue;
      for (const cand of dehashRuntimeClass(rc)) {
        if (seen.has(cand.className)) continue;
        seen.add(cand.className);
        allCandidates.push(cand);
      }
    }
    if (allCandidates.length === 0) {
      return { ...base, error: 'no usable source class names from cssModuleClasses' };
    }

    // Compute a prefer-dir for the walk. When the consumer ref points at
    // a valid project file, prefer module files in its directory + its
    // descendants. We validate the consumer file for path safety as a
    // side effect.
    let preferDir: string | null = null;
    const consumerParsed = parseSourceRef(edit.source.ref);
    if (consumerParsed) {
      try {
        const consumerReal = await validateConsumerFile(realProject, consumerParsed.file);
        preferDir = path.dirname(consumerReal);
      } catch (err) {
        // Bad consumer ref isn't fatal — we just lose the co-located
        // preference. Log and fall through to a project-wide scan.
        logger.debug(`consumer ref not usable for preferDir: ${(err as Error).message}`);
        preferDir = null;
      }
    }

    const match = await findMatchingModuleFile(realProject, allCandidates, preferDir);
    if (!match) {
      return {
        ...base,
        error: 'no CSS module rule matches className(s)',
      };
    }
    base.filePath = match.file;

    const original = await fs.readFile(match.file, 'utf8');
    if (original.length > MAX_FILE_BYTES) {
      return { ...base, error: 'CSS module file too large for in-memory edit' };
    }
    // Re-find the rule on the freshly-read content (in case it was
    // changed between the discovery pass and now — extremely small race
    // window but cheap to defend against).
    const body = findRuleBody(original, match.className);
    if (!body) {
      return { ...base, error: 'rule disappeared between scan and edit' };
    }

    const { newSource, summary } = applyDeclarationEdit(
      original,
      body.openBrace,
      body.closeBrace,
      edit.property,
      safeValue,
    );

    if (newSource === original) {
      return {
        ...base,
        summary: 'no change (edit was a no-op)',
        diff: undefined,
      };
    }

    const projectRel = path.relative(realProject, match.file) || path.basename(match.file);
    const patch = createPatch(projectRel, original, newSource, undefined, undefined, {
      context: 3,
    });

    if (!dryRun) {
      const dir = path.dirname(match.file);
      const tmp = path.join(dir, `.${path.basename(match.file)}.tmp-${randomUUID()}`);
      try {
        await fs.writeFile(tmp, newSource, 'utf8');
        await fs.rename(tmp, match.file);
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw err;
      }
    }

    return {
      ...base,
      summary: `.${match.className}: ${summary}`,
      diff: patch,
    };
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    logger.warn(`css-modules adapter failed: ${message}`);
    return { ...base, error: message };
  }
}
