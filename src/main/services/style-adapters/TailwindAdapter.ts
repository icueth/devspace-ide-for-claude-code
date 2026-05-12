// TailwindAdapter — applies one DesignWriteBackEdit to a JSX/TSX source
// file by either swapping a class in the existing className literal OR
// adding/updating a `style={{...}}` prop on the same JSX element.
//
// We use @babel/parser to locate the JSXOpeningElement at the source.ref
// position, then perform precise text-region splices on the original
// file content. The "splice the original string" approach (vs. running
// the AST through a generator) preserves the user's exact formatting,
// quote style, trailing commas, and surrounding comments — surprises in
// those areas are the #1 way style adapters lose user trust.

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

import {
  cssPropertyToStyleKey,
  swapClass,
  tailwindClassFor,
} from './tailwindMap';

const logger = createLogger('TailwindAdapter');

// Hard upper bound on a JSX source file we'll parse. Hundreds of KB are
// fine; multi-MB files indicate either a generated bundle or a tampered
// path, both of which we want to refuse early.
const MAX_FILE_BYTES = 4 * 1024 * 1024;

// ─── path validation ───────────────────────────────────────────────────────

/**
 * Resolve `<absPath>:<line>:<col>` and confirm the file lives inside the
 * project root (no symlink follow). Returns the resolved absolute path,
 * line, and col. Throws on any violation.
 */
export interface ResolvedSourceRef {
  absPath: string;
  line: number;   // 1-based
  col: number;    // 0-based or 1-based depending on bridge; we accept either
}

export function parseSourceRef(ref: string): { file: string; line: number; col: number } | null {
  if (typeof ref !== 'string' || !ref) return null;
  // Match `<file>:<line>:<col>` from the right so Windows-style absolute
  // paths (C:\foo\bar.tsx:3:7) still work — though the codebase is
  // Mac-only today, future Windows support shouldn't break here.
  const m = /^(.+):(\d+):(\d+)$/.exec(ref);
  if (!m) return null;
  const file = m[1]!;
  const line = Number(m[2]);
  const col = Number(m[3]);
  if (!Number.isInteger(line) || !Number.isInteger(col)) return null;
  if (line < 1 || col < 0) return null;
  return { file, line, col };
}

async function resolveSourceRefSafely(
  projectPath: string,
  ref: string,
): Promise<ResolvedSourceRef> {
  const parsed = parseSourceRef(ref);
  if (!parsed) throw new Error(`source.ref must be "<absPath>:<line>:<col>"`);

  // Absolute path required. Reject `..` segments outright.
  if (!path.isAbsolute(parsed.file)) {
    throw new Error('source.ref file must be absolute');
  }
  if (parsed.file.split(/[\\/]/).some((seg) => seg === '..')) {
    throw new Error('source.ref must not contain ..');
  }

  // realpath both ends to defeat symlink escapes — if either resolves
  // outside the project root we refuse the edit.
  let realProject: string;
  let realFile: string;
  try {
    realProject = await fs.realpath(projectPath);
  } catch {
    throw new Error('project path does not exist');
  }
  // Symlink-leaf check BEFORE realpath. realpath would resolve through
  // the symlink and pass the boundary check if the target is in-project,
  // which lets a malicious project hide a symlink that redirects writes
  // to a different in-project file (e.g. src/Foo.tsx -> package.json).
  // lstat on the supplied path catches that before resolution.
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

  // File extension allowlist — refuse to splice into anything that
  // isn't a JS/TS source file. Without this guard, a crafted source.ref
  // could steer writes into package.json, .env, etc., where a partial
  // babel parse with errorRecovery could yield phantom JSX matches.
  const ext = path.extname(realFile).toLowerCase();
  const ALLOWED_EXT = ['.tsx', '.jsx', '.ts', '.js', '.mjs', '.cjs', '.mts', '.cts'];
  if (!ALLOWED_EXT.includes(ext)) {
    throw new Error(`unsupported file extension for write-back: ${ext}`);
  }

  // Disallow files inside any node_modules subtree under the project —
  // editing transitive deps is never what the user intended and writing
  // to them risks corrupting the install.
  const rel = path.relative(realProject, realFile);
  if (rel.split(path.sep).includes('node_modules')) {
    throw new Error('source.ref points into node_modules');
  }

  return { absPath: realFile, line: parsed.line, col: parsed.col };
}

// ─── AST inspection ────────────────────────────────────────────────────────

// We only need a tiny subset of @babel/types; importing the full module
// pulls in its ~MB of helpers. The shape we care about is:
//
//   JSXOpeningElement { name, attributes: JSXAttribute[], start, end, loc }
//   JSXAttribute      { name: JSXIdentifier, value: JSXAttributeValue?, start, end }
//   StringLiteral     { value, start, end, extra: { raw: string, rawValue: string } }
//   JSXExpressionContainer { expression: ObjectExpression?, start, end }
//
// Define minimal local types instead of leaning on @babel/types so we
// don't take an extra type-import dependency for a few field reads.

interface BabelNode {
  type: string;
  start: number;
  end: number;
  loc?: { start: { line: number; column: number }; end: { line: number; column: number } };
  // Children union — typed as unknown to avoid coupling to the full t.Node tree.
  [key: string]: unknown;
}

interface JSXOpeningElementLike extends BabelNode {
  type: 'JSXOpeningElement';
  attributes: BabelNode[];
  name: BabelNode;
}

/** Tree walker. Visits every node depth-first, calling `visit` and
 * descending into the children as long as visit returns true. */
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
 * Find the JSXOpeningElement that best matches the given line/col. The
 * bridge usually points at the start of the element (the `<` token);
 * the column may be 0- or 1-based depending on the originating tool, so
 * we accept the nearest element whose opening starts on the same line.
 */
function findOpeningElement(
  ast: BabelNode,
  line: number,
  col: number,
): JSXOpeningElementLike | null {
  let best: JSXOpeningElementLike | null = null;
  let bestColDelta = Infinity;
  walk(ast, (node) => {
    if (node.type === 'JSXOpeningElement' && node.loc) {
      const startLine = node.loc.start.line;
      const startCol = node.loc.start.column;
      if (startLine === line) {
        // Compare 0-based to col; if `col` was sent as 1-based we
        // tolerate by trying both deltas.
        const delta = Math.min(Math.abs(startCol - col), Math.abs(startCol - (col - 1)));
        if (delta < bestColDelta) {
          bestColDelta = delta;
          best = node as JSXOpeningElementLike;
        }
      }
    }
    return true;
  });
  // Tolerate small column drift (bridge instrumentation can be a few
  // chars off from the literal `<` token).
  if (best && bestColDelta <= 8) return best;
  // Fallback: if no element on that line, accept the deepest element
  // whose range contains the (line, col) position — useful when the
  // bridge points inside an attribute rather than the opening tag.
  let containing: JSXOpeningElementLike | null = null;
  let containingSize = Infinity;
  walk(ast, (node) => {
    if (node.type === 'JSXOpeningElement' && node.loc) {
      const inside =
        line >= node.loc.start.line &&
        line <= node.loc.end.line &&
        (line !== node.loc.start.line || col >= node.loc.start.column - 1) &&
        (line !== node.loc.end.line || col <= node.loc.end.column + 1);
      if (inside) {
        const size = node.end - node.start;
        if (size < containingSize) {
          containingSize = size;
          containing = node as JSXOpeningElementLike;
        }
      }
    }
    return true;
  });
  return containing;
}

interface AttrFindResult {
  /** The JSXAttribute node. */
  attr: BabelNode;
  /** When the attribute value is a StringLiteral, the literal node (so we
   * can splice the inner string region without disturbing the quotes). */
  stringLiteral?: BabelNode & { value: string };
  /** When the value is a `{...}` expression container, the container node. */
  exprContainer?: BabelNode;
}

function findAttr(elem: JSXOpeningElementLike, name: string): AttrFindResult | null {
  for (const attr of elem.attributes) {
    if (attr.type !== 'JSXAttribute') continue;
    const nameNode = attr.name as BabelNode;
    if (nameNode && nameNode.type === 'JSXIdentifier' && (nameNode as unknown as { name: string }).name === name) {
      const value = attr.value as BabelNode | null | undefined;
      if (!value) return { attr };
      if (value.type === 'StringLiteral') {
        return { attr, stringLiteral: value as BabelNode & { value: string } };
      }
      if (value.type === 'JSXExpressionContainer') {
        const expr = (value as unknown as { expression: BabelNode }).expression;
        // className={"..."} where the expression is itself a string
        // literal — treat the same as the bare-literal case for swaps.
        if (expr && expr.type === 'StringLiteral') {
          return {
            attr,
            stringLiteral: expr as BabelNode & { value: string },
            exprContainer: value,
          };
        }
        return { attr, exprContainer: value };
      }
    }
  }
  return null;
}

// ─── transforms ────────────────────────────────────────────────────────────

/**
 * Compute the class-swap transform. Returns the new className literal
 * value (without surrounding quotes) and a human-readable summary line.
 */
function planClassSwap(
  current: string,
  newClass: string,
): { newClasses: string; summary: string } {
  const out = swapClass(current, newClass);
  // Concise summary: highlight the new class even when the swap stripped
  // multiple conflicting classes.
  return { newClasses: out, summary: `class "${newClass}" applied` };
}

/**
 * Plan a `style={{ ... }}` insertion or update. Returns the new attribute
 * source text (e.g. `style={{ backgroundColor: '#3b82f6' }}`) plus the
 * replacement span [start, end) on the original file. If `existing` is
 * non-null we replace its span; otherwise we insert just before the
 * opening element's closing `>` or `/>`.
 */
interface StylePlan {
  replacement: string;
  start: number;
  end: number;
  summary: string;
}

function planStyleWrite(
  source: string,
  elem: JSXOpeningElementLike,
  existingStyle: AttrFindResult | null,
  property: string,
  value: string,
): StylePlan {
  const styleKey = cssPropertyToStyleKey(property);
  if (!styleKey) {
    throw new Error(`invalid CSS property name: ${property}`);
  }
  const escapedValue = escapeJsString(value);
  const propPair = `${quoteIdent(styleKey)}: '${escapedValue}'`;

  if (!existingStyle) {
    // No style attribute — insert one before the closing `>` / `/>`.
    // Locate the closing token by scanning from elem.end backwards.
    const insertAt = findOpenElementCloseInsertPos(source, elem);
    const before = source.slice(elem.start, insertAt);
    // Pad with a leading space if the char before the insertion isn't
    // already whitespace.
    const padLeft = /\s$/.test(before) ? '' : ' ';
    const replacement = `${padLeft}style={{ ${propPair} }}`;
    return {
      replacement,
      start: insertAt,
      end: insertAt,
      summary: `added style.${styleKey} = ${value}`,
    };
  }

  // Existing style attribute. Try to update inline; if its expression
  // isn't a plain ObjectExpression we replace the whole attribute as a
  // last resort.
  const exprContainer = existingStyle.exprContainer;
  const attrNode = existingStyle.attr;
  if (!exprContainer) {
    // style="..." (string literal — non-standard, but accept it). Replace
    // the entire attribute.
    const replacement = `style={{ ${propPair} }}`;
    return {
      replacement,
      start: attrNode.start,
      end: attrNode.end,
      summary: `replaced style with ${styleKey} = ${value}`,
    };
  }
  const expr = (exprContainer as unknown as { expression: BabelNode | null }).expression;
  if (!expr || expr.type !== 'ObjectExpression') {
    // Computed expression (e.g. style={someObj}) — too risky to merge.
    // Replace the entire attribute.
    const replacement = `style={{ ${propPair} }}`;
    return {
      replacement,
      start: attrNode.start,
      end: attrNode.end,
      summary: `replaced computed style with ${styleKey} = ${value}`,
    };
  }
  const props = (expr as unknown as { properties: BabelNode[] }).properties;
  // Look for an existing property whose key matches (ObjectProperty with
  // a string-or-ident key equal to styleKey).
  const existingProp = props.find((p) => {
    if (p.type !== 'ObjectProperty') return false;
    const key = (p as unknown as { key: BabelNode; computed?: boolean }).key;
    if (!key) return false;
    if (key.type === 'Identifier') {
      return (key as unknown as { name: string }).name === styleKey;
    }
    if (key.type === 'StringLiteral') {
      return (key as unknown as { value: string }).value === styleKey;
    }
    return false;
  });
  if (existingProp) {
    // Replace the value half of the existing key/value pair. Use a tight
    // splice: from the colon+1 to the property's end.
    const propNode = existingProp as BabelNode & { value: BabelNode };
    const valueNode = propNode.value;
    return {
      replacement: ` '${escapedValue}'`,
      start: valueNode.start,
      end: valueNode.end,
      summary: `updated style.${styleKey} = ${value}`,
    };
  }
  // Insert a new property at the END of the existing object. Position
  // ourselves just before the closing `}`.
  // The ObjectExpression's `end` is one past `}`. Step back to find the
  // `}`, then insert before it (with a leading comma if the object isn't
  // empty).
  const objEnd = expr.end - 1; // position of `}`
  const lastInside = props.length === 0 ? '' : ', ';
  // Preserve any whitespace before `}` — if it's already on its own line
  // we add a comma+space; otherwise inline.
  const replacement = `${lastInside}${propPair}`;
  return {
    replacement,
    start: objEnd,
    end: objEnd,
    summary: `added style.${styleKey} = ${value}`,
  };
}

/** Find the position to insert a new attribute — right before the `>` or
 * `/>` that closes the opening element. */
function findOpenElementCloseInsertPos(
  source: string,
  elem: JSXOpeningElementLike,
): number {
  // elem.end is the index AFTER the closing token. Walk backwards to
  // skip whitespace, then position before the `>` (or before `/` of `/>`).
  let i = elem.end - 1;
  if (i < 0 || i >= source.length) return elem.end;
  if (source[i] === '>') {
    // Self-closing `/>` — back up to the `/` so the insertion lands
    // before it; otherwise just back up to `>`.
    if (i > 0 && source[i - 1] === '/') return i - 1;
    return i;
  }
  return elem.end;
}

/** Quote a JS object-property identifier safely. If the styleKey is a
 * valid ES identifier we leave it bare; otherwise we wrap in single
 * quotes (e.g. `'-webkit-transform'` would otherwise be a syntax error).
 */
function quoteIdent(s: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s) ? s : `'${escapeJsString(s)}'`;
}

function escapeJsString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// ─── public entry point ────────────────────────────────────────────────────

/**
 * Apply a single Tailwind edit to disk (or compute the diff when dryRun).
 * Always returns a DesignWriteBackApplied; failures land in `.error`.
 */
export async function applyEdit(
  projectPath: string,
  edit: DesignWriteBackEdit,
  dryRun: boolean,
): Promise<DesignWriteBackApplied> {
  const base: DesignWriteBackApplied = {
    sourceRef: edit.source?.ref ?? '',
    adapter: 'tailwind',
    filePath: '',
    summary: '',
  };
  try {
    if (!edit.source || !edit.source.ref) {
      return { ...base, error: 'source.ref is required' };
    }
    const { absPath } = await resolveSourceRefSafely(projectPath, edit.source.ref);
    base.filePath = absPath;

    const stat = await fs.stat(absPath);
    if (!stat.isFile()) {
      return { ...base, error: 'source.ref is not a regular file' };
    }
    if (stat.size > MAX_FILE_BYTES) {
      return { ...base, error: 'source file too large for in-memory parse' };
    }
    const original = await fs.readFile(absPath, 'utf8');

    const parsed = parseSourceRef(edit.source.ref)!;
    // Parse with broad plugin support — projects in the wild mix JSX,
    // TypeScript, decorators, etc.
    const ast = babelParse(original, {
      sourceType: 'module',
      // errorRecovery: false — a partial AST has wrong node ranges near
      // the recovery boundary; splicing into a "best-effort" AST can
      // corrupt unrelated code. If the file has syntax errors the user
      // must fix them before we'll touch it.
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

    const elem = findOpeningElement(ast, parsed.line, parsed.col);
    if (!elem) {
      return { ...base, error: 'JSX element not found at source.ref' };
    }

    // Decide strategy: class swap when (a) bridge says classOrigin is
    // literal AND (b) we have a usable Tailwind class for the property.
    const classOrigin = edit.source.classOrigin ?? 'absent';

    // Caller-supplied `tailwindClass` strings are spliced verbatim into
    // the JSX className literal. Reject anything that doesn't look like
    // a Tailwind class token to prevent attribute-breakout into JSX/JS.
    // Allows variants (`hover:`, `md:`), arbitrary-value brackets, and
    // important `!`. Anything with whitespace, quotes, angle brackets,
    // curlies, backticks, semicolons, or `=` is refused.
    const TAILWIND_CLASS_RE =
      /^(?:[a-z0-9-]+:)*!?-?[a-z][a-z0-9-]*(?:\[[A-Za-z0-9_:./%#,-]+\])?$/;
    if (edit.tailwindClass !== undefined) {
      if (
        typeof edit.tailwindClass !== 'string' ||
        !TAILWIND_CLASS_RE.test(edit.tailwindClass)
      ) {
        return { ...base, error: 'invalid tailwindClass' };
      }
    }

    const preferredClass =
      edit.tailwindClass ?? tailwindClassFor(edit.property, edit.value);

    const canSwap =
      classOrigin === 'literal' &&
      typeof preferredClass === 'string' &&
      preferredClass.length > 0;

    let newSource: string;
    let summary: string;

    if (canSwap) {
      const classAttr = findAttr(elem, 'className');
      if (classAttr && classAttr.stringLiteral) {
        const current = (classAttr.stringLiteral as unknown as { value: string }).value;
        const plan = planClassSwap(current, preferredClass!);
        // The literal's `start` points at the opening quote, `end` at one
        // past the closing quote. Replace the INNER region only so the
        // user's existing quote style survives.
        const innerStart = classAttr.stringLiteral.start + 1;
        const innerEnd = classAttr.stringLiteral.end - 1;
        newSource =
          original.slice(0, innerStart) +
          plan.newClasses +
          original.slice(innerEnd);
        summary = plan.summary;
      } else {
        // No className present even though classOrigin claimed 'literal'.
        // Defensive — fall through to style write.
        const styleAttr = findAttr(elem, 'style');
        const stylePlan = planStyleWrite(
          original,
          elem,
          styleAttr,
          edit.property,
          edit.value,
        );
        newSource =
          original.slice(0, stylePlan.start) +
          stylePlan.replacement +
          original.slice(stylePlan.end);
        summary = stylePlan.summary;
      }
    } else {
      // Style-prop write fallback.
      const styleAttr = findAttr(elem, 'style');
      const stylePlan = planStyleWrite(
        original,
        elem,
        styleAttr,
        edit.property,
        edit.value,
      );
      newSource =
        original.slice(0, stylePlan.start) +
        stylePlan.replacement +
        original.slice(stylePlan.end);
      summary = stylePlan.summary;
    }

    if (newSource === original) {
      return {
        ...base,
        summary: 'no change (edit was a no-op)',
        diff: undefined,
      };
    }

    // Generate a unified diff against the project root for stable rel paths.
    const projectRel = path.relative(projectPath, absPath) || path.basename(absPath);
    const patch = createPatch(projectRel, original, newSource, undefined, undefined, {
      context: 3,
    });

    if (!dryRun) {
      const dir = path.dirname(absPath);
      const tmp = path.join(dir, `.${path.basename(absPath)}.tmp-${randomUUID()}`);
      try {
        await fs.writeFile(tmp, newSource, 'utf8');
        await fs.rename(tmp, absPath);
      } catch (err) {
        // Clean up tmp on failure — leaving orphan .tmp- files behind
        // confuses watcher tools and makes "did the write land?"
        // ambiguous to the user.
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw err;
      }
    }

    return {
      ...base,
      summary,
      diff: patch,
    };
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    logger.warn(`tailwind adapter failed: ${message}`);
    return { ...base, error: message };
  }
}

// ─── re-exports ─────────────────────────────────────────────────────────────

// Re-export the pure helpers so consumers (and the test agent) can pull
// them from the adapter module directly without reaching into tailwindMap.
export {
  cssPropertyToStyleKey,
  parseTailwindClassString,
  prefixForClass,
  swapClass,
  tailwindClassFor,
} from './tailwindMap';
