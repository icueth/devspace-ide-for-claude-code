// StyledComponentsAdapter — applies one DesignWriteBackEdit to a
// styled-components declaration site by rewriting the CSS body of its
// tagged template literal.
//
// Phase C3b. The bridge captures
//   source.styledComponent = { displayName, ref }
// where `ref = "<absPath>:<line>:<col>"` points at the DECLARATION of
// the styled component (the `styled.div\`...\`` site), NOT the JSX
// consumer. We resolve that ref, walk the AST to the surrounding
// TaggedTemplateExpression, parse the template's CSS body, add/replace
// the requested property, and splice the new template literal back.
//
// Why splice the original source instead of running through a generator:
// styled-components templates frequently contain `${theme.color}` style
// interpolations. We MUST preserve every placeholder span byte-for-byte
// (formatting, parens, comments inside the expression). The only way to
// guarantee that is to lift each expression's source slice via
// `source.slice(expr.start, expr.end)` and stitch it back unchanged.
//
// The "CSS text view" we operate on is the concatenation of
// `quasi.quasis[i].value.raw` with a stable placeholder token between
// each pair. We do the regex edit on that view, then split it back into
// fresh `raw` chunks. If the chunk count after editing doesn't match
// `quasis.length` we know the edit straddled a `${...}` boundary and we
// REJECT — too risky to rewrite around interpolated code.

import { parse as babelParse } from '@babel/parser';
import { createPatch } from 'diff';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  DesignWriteBackApplied,
  DesignWriteBackEdit,
} from '@shared/design';
import { createLogger } from '@shared/logger';

const logger = createLogger('StyledComponentsAdapter');

// Hard upper bound on a source file we'll parse. Hundreds of KB are
// fine; multi-MB files indicate either a generated bundle or a tampered
// path, both of which we want to refuse early. Mirrors TailwindAdapter.
const MAX_FILE_BYTES = 4 * 1024 * 1024;

// Placeholder used between quasis in the "CSS text view". NUL bytes
// cannot appear in real CSS source, so splitting on this token is
// unambiguous. Index is included so we can detect straddle by chunk
// count after the edit.
const INTERP_PLACEHOLDER_RE = /\x00DEVSPACE_INTERP_(\d+)\x00/g;
function interpPlaceholder(i: number): string {
  return `\x00DEVSPACE_INTERP_${i}\x00`;
}

// ─── path validation (mirrors TailwindAdapter) ─────────────────────────────

interface ParsedRef {
  file: string;
  line: number;
  col: number;
}

function parseSourceRef(ref: string): ParsedRef | null {
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

interface ResolvedSourceRef {
  absPath: string;
  line: number;
  col: number;
}

async function resolveSourceRefSafely(
  projectPath: string,
  ref: string,
): Promise<ResolvedSourceRef> {
  const parsed = parseSourceRef(ref);
  if (!parsed) throw new Error('source.ref must be "<absPath>:<line>:<col>"');

  if (!path.isAbsolute(parsed.file)) {
    throw new Error('source.ref file must be absolute');
  }
  if (parsed.file.split(/[\\/]/).some((seg) => seg === '..')) {
    throw new Error('source.ref must not contain ..');
  }

  let realProject: string;
  let realFile: string;
  try {
    realProject = await fs.realpath(projectPath);
  } catch {
    throw new Error('project path does not exist');
  }
  // lstat the leaf BEFORE realpath. realpath dereferences symlinks; a
  // crafted in-project symlink could otherwise redirect the write to a
  // different in-project file. Catch the symlink at the leaf.
  let lst: { isSymbolicLink: () => boolean; isFile: () => boolean } | null;
  try {
    lst = await fs.lstat(parsed.file);
  } catch {
    throw new Error(`source.ref file not found: ${parsed.file}`);
  }
  if (lst.isSymbolicLink()) {
    throw new Error('source.ref must not be a symlink');
  }
  if (!lst.isFile()) {
    throw new Error('source.ref must be a regular file');
  }
  try {
    realFile = await fs.realpath(parsed.file);
  } catch {
    throw new Error(`source.ref file not found: ${parsed.file}`);
  }
  if (
    realFile !== realProject &&
    !realFile.startsWith(realProject + path.sep)
  ) {
    throw new Error('source.ref escapes project root');
  }

  // Extension allowlist. styled-components is JS/TS only; refusing other
  // extensions here protects partial-AST hazards in unsupported file
  // types (`.json`, `.env`, etc).
  const ext = path.extname(realFile).toLowerCase();
  const ALLOWED_EXT = ['.tsx', '.jsx', '.ts', '.js', '.mjs', '.cjs', '.mts', '.cts'];
  if (!ALLOWED_EXT.includes(ext)) {
    throw new Error(`unsupported file extension for write-back: ${ext}`);
  }

  // Never touch transitive deps.
  const rel = path.relative(realProject, realFile);
  if (rel.split(path.sep).includes('node_modules')) {
    throw new Error('source.ref points into node_modules');
  }

  return { absPath: realFile, line: parsed.line, col: parsed.col };
}

// ─── AST walker ────────────────────────────────────────────────────────────

interface BabelNode {
  type: string;
  start: number;
  end: number;
  loc?: { start: { line: number; column: number }; end: { line: number; column: number } };
  [key: string]: unknown;
}

interface TemplateElementNode extends BabelNode {
  type: 'TemplateElement';
  value: { raw: string; cooked?: string };
  tail: boolean;
}

interface TemplateLiteralNode extends BabelNode {
  type: 'TemplateLiteral';
  quasis: TemplateElementNode[];
  expressions: BabelNode[];
}

interface TaggedTemplateExpressionNode extends BabelNode {
  type: 'TaggedTemplateExpression';
  tag: BabelNode;
  quasi: TemplateLiteralNode;
}

function walk(node: BabelNode, visit: (n: BabelNode) => boolean): void {
  if (!node || typeof node !== 'object') return;
  const descend = visit(node);
  if (!descend) return;
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'extra' || key === 'tokens' || key === 'comments') continue;
    const value = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object' && 'type' in (item as object)) {
          walk(item as BabelNode, visit);
        }
      }
    } else if (value && typeof value === 'object' && 'type' in (value as object)) {
      walk(value as BabelNode, visit);
    }
  }
}

/**
 * Find the smallest TaggedTemplateExpression node whose source range
 * contains `(line, col)` (1-based line; column may be 0- or 1-based,
 * we tolerate either with a fudge factor). We prefer the smallest
 * containing node so nested taggedTemplates resolve to the inner one.
 */
function findTaggedTemplateAt(
  ast: BabelNode,
  line: number,
  col: number,
): TaggedTemplateExpressionNode | null {
  let best: TaggedTemplateExpressionNode | null = null;
  let bestSize = Infinity;
  walk(ast, (node) => {
    if (node.type === 'TaggedTemplateExpression' && node.loc) {
      const inside =
        line >= node.loc.start.line &&
        line <= node.loc.end.line &&
        // Tolerate ±1 column drift between bridge instrumentation and
        // babel's loc — bridges report different conventions in the wild.
        (line !== node.loc.start.line || col >= node.loc.start.column - 1) &&
        (line !== node.loc.end.line || col <= node.loc.end.column + 1);
      if (inside) {
        const size = node.end - node.start;
        if (size < bestSize) {
          bestSize = size;
          best = node as TaggedTemplateExpressionNode;
        }
      }
    }
    return true;
  });
  return best;
}

// ─── tag classification ────────────────────────────────────────────────────

/**
 * Determine whether the `tag` of a TaggedTemplateExpression is a
 * styled-components declaration. Accepted forms:
 *
 *   styled.div`...`                                  (MemberExpression)
 *   styled(Base)`...`                                (CallExpression)
 *   styled(Base).attrs(...)`...`                     (MemberExpression on CallExpression)
 *   styled.div.attrs(...)`...`                       (MemberExpression on MemberExpression)
 *
 * Rejected:
 *   css`...`         — emotion classname helper, different semantics
 *   keyframes`...`   — produces an animation name, not a component
 *   anything else
 */
function isStyledTag(tag: BabelNode): boolean {
  // Walk down through `.attrs(...)`, `.withConfig(...)`, `.shouldForwardProp(...)`
  // and arbitrary call/member chains until we hit the root token. The
  // root MUST be either:
  //   Identifier { name: 'styled' }                       → styled (bare, rare)
  //   MemberExpression { object: 'styled', property: x }  → styled.div
  //   CallExpression { callee: 'styled', arguments: [_] } → styled(Base)
  //
  // We're conservative: anything we don't recognize is rejected.
  let cur: BabelNode | null = tag;
  // Unwrap up to 8 chained `.attrs(...)` / `.withConfig(...)` layers.
  // That's a generous upper bound — real code never chains that deep.
  for (let depth = 0; depth < 8 && cur; depth++) {
    if (cur.type === 'Identifier') {
      const name = (cur as unknown as { name: string }).name;
      // Bare `styled\`...\`` is not legal styled-components syntax (you
      // can't call the factory without a tag/base), so reject it.
      // Bare `css\`...\`` / `keyframes\`...\`` also reject here.
      return name === 'styled' ? false : false;
    }
    if (cur.type === 'MemberExpression') {
      const me = cur as unknown as {
        object: BabelNode;
        property: BabelNode;
        computed?: boolean;
      };
      const obj: BabelNode = me.object;
      const prop: BabelNode = me.property;
      const computed = !!me.computed;
      // styled.div — object is the `styled` Identifier, property is a
      // tag-name Identifier (or string literal for computed, which we
      // don't accept — that's `styled[someVar]`).
      if (
        !computed &&
        obj &&
        obj.type === 'Identifier' &&
        (obj as unknown as { name: string }).name === 'styled' &&
        prop &&
        (prop.type === 'Identifier' || prop.type === 'JSXIdentifier')
      ) {
        return true;
      }
      // Otherwise unwind into the object side: e.g.
      //   styled(Base).attrs(...) → MemberExpression where object is the
      //   CallExpression, property is 'attrs'.
      cur = obj;
      continue;
    }
    if (cur.type === 'CallExpression') {
      const ce = cur as unknown as { callee: BabelNode };
      const callee: BabelNode = ce.callee;
      if (!callee) return false;
      // styled(Base) — callee is the `styled` Identifier.
      if (callee.type === 'Identifier') {
        const calleeName = (callee as unknown as { name: string }).name;
        return calleeName === 'styled';
      }
      // styled.attrs(...) etc. — unwrap into the callee.
      cur = callee;
      continue;
    }
    // Any other node type at this position (e.g. ConditionalExpression,
    // ArrowFunctionExpression) is not a recognizable styled-components
    // declaration.
    return false;
  }
  return false;
}

// ─── CSS body editing ──────────────────────────────────────────────────────

// Reuse the same character allowlist Tailwind uses for arbitrary values.
// CSS body values get spliced verbatim into a template literal — any
// character outside this set risks either breaking out of the template
// (backtick) or smuggling JS (${...}) into the editable region.
//
// Allowed: A-Z, a-z, 0-9, plus a small punctuation set covering hex
// colours, units, percentages, paths, function calls (no quoted args),
// and whitespace.
const SAFE_VALUE_RE = /^[A-Za-z0-9_:./%#,()\s-]+$/;

function safeCssValue(value: string): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > 256) return null;
  // Hard reject: chars that could break out of a tagged template literal
  // or smuggle a `${...}` interpolation. SAFE_VALUE_RE already excludes
  // these but we keep the explicit check so the intent is obvious.
  if (/[`$<>{};"'\\]/.test(value)) return null;
  // Reject url() — exfil + permissive-webview risk (see VanillaCssAdapter).
  if (/\burl\s*\(/i.test(value)) return null;
  if (!SAFE_VALUE_RE.test(value)) return null;
  return value.trim();
}

// CSS property names are kebab-case identifiers plus the optional vendor
// prefix. Lock the set down to defeat regex-injection through `property`.
const SAFE_PROPERTY_RE = /^-?[a-z][a-z0-9-]*$/;

function safeCssProperty(prop: string): string | null {
  if (typeof prop !== 'string') return null;
  if (prop.length === 0 || prop.length > 64) return null;
  const lower = prop.toLowerCase();
  if (!SAFE_PROPERTY_RE.test(lower)) return null;
  return lower;
}

/** Escape a CSS property name for use inside a RegExp source. Because
 * SAFE_PROPERTY_RE already restricts to `[a-z0-9-]` the only char that
 * needs escaping is `-` (and only outside character classes — we use it
 * in the pattern body, so it's literal). Belt-and-braces. */
function regexEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

interface CssEditResult {
  view: string;
  summary: string;
}

/**
 * Apply the CSS property edit to a "view" string (concatenated raws
 * with placeholder tokens between quasis). Returns the new view and a
 * one-line summary. Throws on straddle-detected or unsafe edits.
 */
function editCssView(view: string, property: string, value: string): CssEditResult {
  const safeProp = safeCssProperty(property);
  if (!safeProp) throw new Error(`invalid CSS property name: ${property}`);
  const safeVal = safeCssValue(value);
  if (!safeVal) throw new Error('invalid CSS value (unsafe characters or empty)');

  // Match `prop: <value>;` where the declaration is bounded by `;`, `{`,
  // start-of-input, or a brace pair. We deliberately forbid `;`, `{`, `}`
  // inside the captured value so we stay within one declaration and
  // can't accidentally cross block boundaries.
  //
  // Anchors:
  //   - left: start-of-input | `;` | `{` (so we don't match inside a
  //     longer property name like `border-color` when editing `color`)
  //   - right: `;` | end-of-input | `}` (so we still update the LAST
  //     declaration in a block even if it has no trailing semicolon)
  // Anchor: start-of-input OR a `;`/`{` OR a newline followed by optional
  // whitespace. The original `(^|[;{]\s*)` couldn't anchor anywhere in a
  // multi-line indented body — `^` (with /m) lands on a space, never on
  // the property name, and `[;{]` doesn't match a newline. Adding the
  // `\n\s*` branch lets the regex find every existing declaration in a
  // body like:
  //
  //   styled.div`
  //     color: red;
  //     background: blue;
  //   `
  //
  // We scan ALL matches at depth 0 (skipping declarations inside nested
  // rules) and pick the LAST one — CSS cascade lets the later
  // declaration win, so that's what the user actually sees rendered.
  // Stripping block comments first prevents a `/* color: red */`
  // sentence from being mistaken for a live declaration.
  const viewForScan = stripCssBlockComments(view);
  const propPattern = new RegExp(
    `(^|\\n\\s*|[;{]\\s*)(${regexEscape(safeProp)})\\s*:\\s*([^;{}]+?)(\\s*)(?=;|\\}|$)`,
    'g',
  );

  // Find the last match at brace depth 0 of the OUTER body. The template
  // body has no synthetic open brace; track only the depth introduced by
  // nested-rule `{ … }` blocks (Sass-style `& { … }`).
  let chosenMatch: RegExpExecArray | null = null;
  let mScan: RegExpExecArray | null;
  while ((mScan = propPattern.exec(viewForScan)) !== null) {
    if (depthAt(viewForScan, mScan.index) === 0) {
      chosenMatch = mScan;
    }
  }
  if (chosenMatch) {
    const match = chosenMatch;
    // match[1] = left boundary, match[2] = prop, match[3] = value,
    // match[4] = trailing whitespace before `;`. valueStart is therefore
    // `match.index + match[1].length + match[2].length + (colon+space
    // chars matched by `\\s*:\\s*`)`. Easiest: locate `:` after match[1]
    // and skip its surrounding whitespace explicitly.
    const colonIdx = view.indexOf(':', match.index + match[1]!.length);
    if (colonIdx < 0) {
      // Shouldn't happen — regex required `:`. Bail safely.
      throw new Error(`internal: lost ":" while scanning declaration`);
    }
    const valueStart = colonIdx + 1 + leadingWhitespaceWidth(view, colonIdx + 1);
    const valueEnd = valueStart + match[3]!.length;
    const currentValue = view.slice(valueStart, valueEnd);
    if (containsPlaceholder(currentValue)) {
      throw new Error(
        `current value of "${safeProp}" contains an interpolation — refusing to overwrite`,
      );
    }
    const newView =
      view.slice(0, valueStart) + safeVal + view.slice(valueEnd);
    return {
      view: newView,
      summary: `updated ${safeProp} = ${safeVal}`,
    };
  }

  // Not present — append a new declaration. Per spec: if the body has a
  // trailing `}` (multi-block CSS) insert BEFORE that closing brace;
  // otherwise append at the very end.
  const trimmedRight = view.replace(/\s+$/, '');
  const endsWithBrace = trimmedRight.endsWith('}');

  let insertedView: string;
  if (endsWithBrace) {
    // Find the OUTERMOST closing `}` (depth-0). For a body with nested
    // Sass-style rules (`& { ... }`), `view.lastIndexOf('}')` is the
    // nested rule's brace, NOT the outer template's. Inserting there
    // would write the new declaration *inside* the nested rule —
    // silently retargeting the user's edit to a child selector.
    let closeIdx = -1;
    {
      const scan = stripCssBlockComments(view);
      let d = 0;
      for (let i = 0; i < scan.length; i++) {
        const c = scan.charCodeAt(i);
        if (c === 0x7b) d++;
        else if (c === 0x7d) {
          d--;
          if (d === 0) closeIdx = i;
        }
      }
      // No outer-zero close found — fall back to lastIndexOf only when
      // depth tracking didn't pin a top-level brace (i.e. the body has
      // no nested rules; the trailing `}` is therefore outer).
      if (closeIdx < 0) closeIdx = view.lastIndexOf('}');
    }
    if (closeIdx < 0) {
      // Shouldn't happen — `endsWithBrace` was true on trimmedRight.
      insertedView = appendDeclaration(view, safeProp, safeVal);
    } else {
      // Sanity check: the position we're splicing into must not be
      // inside an interpolation placeholder. The placeholder is the
      // NUL-wrapped token DEVSPACE_INTERP_<n>; check the few chars
      // around `closeIdx`.
      if (
        view.charAt(closeIdx - 1) === '\x00' ||
        view.lastIndexOf('\x00DEVSPACE_INTERP_', closeIdx) >
          view.lastIndexOf('\x00', closeIdx - 1)
      ) {
        // Unlikely (placeholders are tokens, not braces), but bail safely.
        throw new Error('refusing to splice into interpolation region');
      }
      const before = view.slice(0, closeIdx);
      const after = view.slice(closeIdx);
      // Choose newline + indent based on what we see right before the `}`.
      const indentMatch = /(?:^|\n)([ \t]*)\}\s*$/.exec(view);
      const indent = indentMatch ? indentMatch[1] : '';
      const padded = before.endsWith('\n')
        ? `${indent}  ${safeProp}: ${safeVal};\n`
        : `\n${indent}  ${safeProp}: ${safeVal};\n${indent}`;
      insertedView = before + padded + after.slice(after.indexOf('}'));
    }
  } else {
    insertedView = appendDeclaration(view, safeProp, safeVal);
  }

  return {
    view: insertedView,
    summary: `added ${safeProp}: ${safeVal}`,
  };
}

function appendDeclaration(view: string, prop: string, value: string): string {
  // Match the trailing-whitespace shape so the resulting body stays
  // visually consistent. Common patterns:
  //   `color: red;`          (no newline)             → `…red;\n  prop: val;`
  //   `color: red;\n`        (one newline)            → `…red;\n  prop: val;\n`
  //   `color: red;\n  `      (newline + indent)       → keep indent + add prop
  const trimmedRight = view.replace(/[ \t]+$/, '');
  const trailingWs = view.slice(trimmedRight.length);
  // Reuse the indent we see on the last existing declaration (if any).
  const lastLineMatch = /(?:^|\n)([ \t]*)[A-Za-z-]+\s*:/g.exec(trimmedRight);
  const indent = lastLineMatch ? lastLineMatch[1] : '  ';
  // Always finish with a semicolon and a newline.
  // Ensure the existing body terminates cleanly before we append.
  let body = trimmedRight;
  // Strip trailing newlines so we control the framing; we'll re-emit
  // ONE newline after the appended declaration.
  body = body.replace(/[\r\n]+$/, '');
  // Make sure the previous declaration ends with `;`.
  if (body.length > 0 && !body.endsWith(';') && !body.endsWith('{') && !body.endsWith('}')) {
    body = body + ';';
  }
  // Compose the final view. Preserve the original trailing whitespace
  // shape if it was just blanks (no newline).
  if (trailingWs.includes('\n')) {
    return `${body}\n${indent}${prop}: ${value};\n`;
  }
  return `${body}\n${indent}${prop}: ${value};${trailingWs}`;
}

function containsPlaceholder(s: string): boolean {
  INTERP_PLACEHOLDER_RE.lastIndex = 0;
  return INTERP_PLACEHOLDER_RE.test(s);
}

// Count `{`/`}` from offset 0 through `pos`, treating string-context and
// CSS comments as transparent. Used to skip declarations that live
// inside nested rules (`& { ... }`) when scanning a styled-components
// template body.
function depthAt(s: string, pos: number): number {
  let depth = 0;
  for (let i = 0; i < pos && i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x7b /* { */) depth++;
    else if (c === 0x7d /* } */) depth--;
  }
  return depth;
}

function leadingWhitespaceWidth(s: string, from: number): number {
  let i = from;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 0x20 || c === 0x09) i++;
    else break;
  }
  return i - from;
}

// Replace `/* ... */` block comments with same-length whitespace so byte
// offsets between the stripped view and the live view stay aligned.
// Line comments (`//`) are intentionally NOT stripped — invalid in plain
// CSS but legal in Sass / styled-components — leaving them in the scan
// view doesn't affect declaration regex behaviour because `//` doesn't
// match the property pattern.
function stripCssBlockComments(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      const stop = end < 0 ? s.length : end + 2;
      for (let j = i; j < stop; j++) out += s[j] === '\n' ? '\n' : ' ';
      i = stop;
      continue;
    }
    out += s[i];
    i++;
  }
  return out;
}

// ─── view ⇄ quasis conversion ──────────────────────────────────────────────

interface BuiltView {
  view: string;
}

function buildCssView(quasi: TemplateLiteralNode): BuiltView {
  const parts: string[] = [];
  for (let i = 0; i < quasi.quasis.length; i++) {
    parts.push(quasi.quasis[i]!.value.raw);
    if (i < quasi.expressions.length) {
      parts.push(interpPlaceholder(i));
    }
  }
  return { view: parts.join('') };
}

/**
 * Split an edited CSS view back into raw quasi chunks. Returns null
 * when the chunk count doesn't match the original quasis count — that
 * signals the edit either created or removed an interpolation
 * boundary, which is a straddle scenario we refuse.
 */
function splitCssView(
  view: string,
  expectedQuasiCount: number,
  expectedExpressionCount: number,
): string[] | null {
  // We need to split by the placeholder regex AND verify the encountered
  // indices are 0..N-1 in order. Using exec in a loop gives us both.
  const raws: string[] = [];
  let lastEnd = 0;
  let expectedIdx = 0;
  // Fresh regex state for each call.
  INTERP_PLACEHOLDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INTERP_PLACEHOLDER_RE.exec(view)) !== null) {
    const i = Number(m[1]);
    if (i !== expectedIdx) return null;
    raws.push(view.slice(lastEnd, m.index));
    lastEnd = m.index + m[0].length;
    expectedIdx++;
  }
  raws.push(view.slice(lastEnd));
  if (raws.length !== expectedQuasiCount) return null;
  if (expectedIdx !== expectedExpressionCount) return null;
  return raws;
}

/**
 * Rebuild the full template literal source text (including the
 * surrounding backticks) given the new raw chunks and the original
 * source for each interpolation. The interpolation source slices come
 * straight from `original.slice(expr.start, expr.end)` so user
 * formatting inside `${...}` survives untouched.
 */
function rebuildTemplateLiteral(
  newRaws: string[],
  expressionSlices: string[],
): string {
  if (newRaws.length !== expressionSlices.length + 1) {
    throw new Error('internal: raw/expression length mismatch');
  }
  const parts: string[] = ['`'];
  for (let i = 0; i < newRaws.length; i++) {
    parts.push(newRaws[i]!);
    if (i < expressionSlices.length) {
      parts.push('${');
      parts.push(expressionSlices[i]!);
      parts.push('}');
    }
  }
  parts.push('`');
  return parts.join('');
}

// ─── public entry point ────────────────────────────────────────────────────

/**
 * Apply a single styled-components edit. Returns a
 * DesignWriteBackApplied; failures land in `.error`.
 */
export async function applyEdit(
  projectPath: string,
  edit: DesignWriteBackEdit,
  dryRun: boolean,
): Promise<DesignWriteBackApplied> {
  const base: DesignWriteBackApplied = {
    sourceRef: edit.source?.styledComponent?.ref ?? edit.source?.ref ?? '',
    adapter: 'styled-components',
    filePath: '',
    summary: '',
  };

  try {
    // Pick the right ref. Per spec: prefer source.styledComponent.ref;
    // fall back to source.ownerRef. The plain `source.ref` (consumer
    // JSX) is NOT correct for this adapter — it points at the JSX call
    // site, not the declaration.
    const declRef = edit.source?.styledComponent?.ref ?? edit.source?.ownerRef;
    if (!declRef) {
      return {
        ...base,
        error: 'styled-components adapter requires source.styledComponent.ref or source.ownerRef',
      };
    }

    const { absPath, line, col } = await resolveSourceRefSafely(projectPath, declRef);
    base.filePath = absPath;
    // Echo the actual ref we used, so the renderer can match it back to
    // its outgoing edit batch.
    base.sourceRef = declRef;

    const stat = await fs.stat(absPath);
    if (!stat.isFile()) {
      return { ...base, error: 'source.ref is not a regular file' };
    }
    if (stat.size > MAX_FILE_BYTES) {
      return { ...base, error: 'source file too large for in-memory parse' };
    }
    const original = await fs.readFile(absPath, 'utf8');

    const ast = babelParse(original, {
      sourceType: 'module',
      // errorRecovery: false — partial ASTs report wrong node ranges
      // near recovery boundaries. Refuse to write into a syntax-broken
      // file rather than splice into best-effort coordinates.
      errorRecovery: false,
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      plugins: [
        'jsx',
        'typescript',
        'decorators-legacy',
        'classProperties',
        'classPrivateProperties',
        'classPrivateMethods',
        'topLevelAwait',
        'importMeta',
        'importAssertions',
        'optionalChaining',
        'nullishCoalescingOperator',
      ],
    }) as unknown as BabelNode;

    const tagged = findTaggedTemplateAt(ast, line, col);
    if (!tagged) {
      return {
        ...base,
        error: 'no styled-components declaration at source.ref',
      };
    }
    if (!isStyledTag(tagged.tag)) {
      return {
        ...base,
        error: 'no styled-components declaration at source.ref',
      };
    }

    const quasi = tagged.quasi;
    if (!quasi || quasi.type !== 'TemplateLiteral' || !Array.isArray(quasi.quasis)) {
      return { ...base, error: 'tagged template has no usable quasi' };
    }

    // Build the CSS text view from quasi raws with placeholders.
    const { view } = buildCssView(quasi);

    // Validate property/value here (early failure before AST work).
    let editResult: CssEditResult;
    try {
      editResult = editCssView(view, edit.property, edit.value);
    } catch (err) {
      return { ...base, error: (err as Error).message };
    }

    // Split the new view back into raw quasi chunks. Reject if the
    // boundary count doesn't survive the edit — that means we
    // straddled a placeholder.
    const newRaws = splitCssView(
      editResult.view,
      quasi.quasis.length,
      quasi.expressions.length,
    );
    if (!newRaws) {
      return {
        ...base,
        error: 'edit would straddle a template-literal interpolation',
      };
    }

    // Lift the source text of every interpolation EXACTLY — including
    // any whitespace / comments inside the `${...}` braces. We DON'T use
    // the babel start/end of just the expression because expression.start
    // is right after `${` (no whitespace) and expression.end is right
    // before `}` — that's what we want. If somehow expression.end
    // points OUTSIDE the surrounding braces of the template, refuse to
    // rebuild.
    const expressionSlices: string[] = [];
    for (let i = 0; i < quasi.expressions.length; i++) {
      const expr = quasi.expressions[i]!;
      if (
        typeof expr.start !== 'number' ||
        typeof expr.end !== 'number' ||
        expr.start < 0 ||
        expr.end > original.length ||
        expr.start >= expr.end
      ) {
        return {
          ...base,
          error: 'internal: invalid expression range in template literal',
        };
      }
      // Note: expr.start is right after `${` and expr.end is right
      // before `}` — i.e. expr.start..expr.end is the EXPRESSION text
      // without the framing delimiters. We re-emit `${ ... }` around it.
      expressionSlices.push(original.slice(expr.start, expr.end));
    }

    const newTemplateText = rebuildTemplateLiteral(newRaws, expressionSlices);

    // Splice region is `[quasi.start, quasi.end]` — covers the entire
    // template literal (including both backticks). We replace it
    // wholesale with the rebuilt text.
    if (
      typeof quasi.start !== 'number' ||
      typeof quasi.end !== 'number' ||
      quasi.start < 0 ||
      quasi.end > original.length ||
      quasi.start >= quasi.end
    ) {
      return { ...base, error: 'internal: invalid template literal range' };
    }
    const newSource =
      original.slice(0, quasi.start) +
      newTemplateText +
      original.slice(quasi.end);

    if (newSource === original) {
      return {
        ...base,
        summary: 'no change (edit was a no-op)',
        diff: undefined,
      };
    }

    // Generate unified diff for the preview pane.
    const projectRel = path.relative(projectPath, absPath) || path.basename(absPath);
    const patch = createPatch(
      projectRel,
      original,
      newSource,
      undefined,
      undefined,
      { context: 3 },
    );

    if (!dryRun) {
      const dir = path.dirname(absPath);
      const tmp = path.join(dir, `.${path.basename(absPath)}.tmp-${randomUUID()}`);
      try {
        await fs.writeFile(tmp, newSource, 'utf8');
        await fs.rename(tmp, absPath);
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw err;
      }
    }

    return {
      ...base,
      summary: editResult.summary,
      diff: patch,
    };
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    logger.warn(`styled-components adapter failed: ${message}`);
    return { ...base, error: message };
  }
}
