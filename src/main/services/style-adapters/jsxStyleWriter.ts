// jsxStyleWriter — shared helper for the "fall back to `style={{...}}` on
// the JSX element" path used by every style adapter.
//
// Tailwind / vanilla-CSS / styled-components / CSS-Modules adapters all
// need the same behaviour when they decide to write inline style: add (or
// update) an inline `style={{ <property>: <value> }}` prop on the JSX
// element that the bridge anchored. The logic lives here so each adapter
// can call one function rather than copy-pasting AST splicing.
//
// The implementation mirrors what TailwindAdapter shipped in 0.8 — the
// `planStyleWrite` body is now this module's `planStyleWrite`, and a
// higher-level `applyStylePropFallback` wraps "parse the file + find the
// element + plan the write + splice" for adapters that don't already
// have an AST handy (vanilla-CSS / CSS-Modules when they need to fall
// back after failing to resolve a stylesheet rule).
//
// Path / file validation (lstat-before-realpath, extension allowlist,
// node_modules guard) is the caller's job — this module does NOT touch
// the filesystem; it operates on the already-loaded source string.

import { parse as babelParse } from '@babel/parser';

import type { DesignWriteBackEdit } from '@shared/design';

import { cssPropertyToStyleKey } from './tailwindMap';

// ─── babel walk plumbing ───────────────────────────────────────────────────
//
// Re-implemented inline (rather than imported from TailwindAdapter) so the
// adapter modules don't gain a circular dep on each other. The shapes are
// identical — both modules walk the same Babel AST.

export interface BabelNode {
  type: string;
  start: number;
  end: number;
  loc?: { start: { line: number; column: number }; end: { line: number; column: number } };
  [key: string]: unknown;
}

export interface JSXOpeningElementLike extends BabelNode {
  type: 'JSXOpeningElement';
  attributes: BabelNode[];
  name: BabelNode;
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

export function findOpeningElement(
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
        const delta = Math.min(Math.abs(startCol - col), Math.abs(startCol - (col - 1)));
        if (delta < bestColDelta) {
          bestColDelta = delta;
          best = node as JSXOpeningElementLike;
        }
      }
    }
    return true;
  });
  if (best && bestColDelta <= 8) return best;
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

export interface AttrFindResult {
  attr: BabelNode;
  stringLiteral?: BabelNode & { value: string };
  exprContainer?: BabelNode;
}

export function findAttr(elem: JSXOpeningElementLike, name: string): AttrFindResult | null {
  for (const attr of elem.attributes) {
    if (attr.type !== 'JSXAttribute') continue;
    const nameNode = attr.name as BabelNode;
    if (
      nameNode &&
      nameNode.type === 'JSXIdentifier' &&
      (nameNode as unknown as { name: string }).name === name
    ) {
      const value = attr.value as BabelNode | null | undefined;
      if (!value) return { attr };
      if (value.type === 'StringLiteral') {
        return { attr, stringLiteral: value as BabelNode & { value: string } };
      }
      if (value.type === 'JSXExpressionContainer') {
        const expr = (value as unknown as { expression: BabelNode }).expression;
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

function findOpenElementCloseInsertPos(
  source: string,
  elem: JSXOpeningElementLike,
): number {
  let i = elem.end - 1;
  if (i < 0 || i >= source.length) return elem.end;
  if (source[i] === '>') {
    if (i > 0 && source[i - 1] === '/') return i - 1;
    return i;
  }
  return elem.end;
}

function quoteIdent(s: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s) ? s : `'${escapeJsString(s)}'`;
}

function escapeJsString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export interface StylePlan {
  replacement: string;
  start: number;
  end: number;
  summary: string;
}

/**
 * Plan a `style={{ ... }}` insertion or update on the given JSX opening
 * element. Returns the new attribute source text plus the replacement
 * span [start, end) on the original file. If `existingStyle` is non-null
 * we replace its span (or its value half, when we can inline the merge);
 * otherwise we insert just before the opening element's closing `>` / `/>`.
 *
 * The caller is responsible for actually splicing the string — this fn
 * just computes WHAT and WHERE.
 */
export function planStyleWrite(
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
    const insertAt = findOpenElementCloseInsertPos(source, elem);
    const before = source.slice(elem.start, insertAt);
    const padLeft = /\s$/.test(before) ? '' : ' ';
    const replacement = `${padLeft}style={{ ${propPair} }}`;
    return {
      replacement,
      start: insertAt,
      end: insertAt,
      summary: `added style.${styleKey} = ${value}`,
    };
  }

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
    // Computed expression — too risky to merge. Replace the whole attr.
    const replacement = `style={{ ${propPair} }}`;
    return {
      replacement,
      start: attrNode.start,
      end: attrNode.end,
      summary: `replaced computed style with ${styleKey} = ${value}`,
    };
  }
  const props = (expr as unknown as { properties: BabelNode[] }).properties;
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
    const propNode = existingProp as BabelNode & { value: BabelNode };
    const valueNode = propNode.value;
    return {
      replacement: ` '${escapedValue}'`,
      start: valueNode.start,
      end: valueNode.end,
      summary: `updated style.${styleKey} = ${value}`,
    };
  }
  // Insert a new property at the END of the existing object, just before
  // the closing `}`.
  const objEnd = expr.end - 1;
  const lastInside = props.length === 0 ? '' : ', ';
  const replacement = `${lastInside}${propPair}`;
  return {
    replacement,
    start: objEnd,
    end: objEnd,
    summary: `added style.${styleKey} = ${value}`,
  };
}

/**
 * Parse the JSX source and return an AST. Plugin set is broad on purpose
 * — projects in the wild mix JSX, TypeScript, decorators, etc. Adapters
 * sharing this fn share the parse-shape so behaviour stays consistent.
 */
export function parseJsxSource(original: string): BabelNode {
  return babelParse(original, {
    sourceType: 'module',
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
}

// ─── public high-level API ─────────────────────────────────────────────────

export interface ApplyStylePropInput {
  /** The full source text of the JSX file. */
  original: string;
  /** Absolute path to the project root. Reserved for future logging. */
  projectPath: string;
  /** The DesignWriteBackEdit being applied. */
  edit: DesignWriteBackEdit;
}

export interface ApplyStylePropResult {
  newSource: string;
  summary: string;
  /** 1-based line / 0-based col of the JSXOpeningElement we edited. */
  insertedAt: { line: number; col: number };
}

/**
 * Splice a `style={{ <property>: <value> }}` prop onto the JSX element
 * anchored by `edit.source.ref`. Returns the new source text plus a
 * summary line suitable for the renderer's toast.
 *
 * The function assumes the caller has already validated `edit.source.ref`
 * against its project root (extension allowlist, lstat-before-realpath,
 * node_modules guard) — it does NOT touch the filesystem.
 *
 * Throws when:
 *   - `edit.source.ref` doesn't parse as `<file>:<line>:<col>`
 *   - the JSX file fails to parse
 *   - no JSXOpeningElement can be located at that anchor
 *   - the CSS property name can't be mapped to a React style key
 */
export async function applyStylePropFallback(
  input: ApplyStylePropInput,
): Promise<ApplyStylePropResult> {
  const { original, edit } = input;
  const ref = edit.source?.ref ?? '';
  const refMatch = /^(.+):(\d+):(\d+)$/.exec(ref);
  if (!refMatch) {
    throw new Error('source.ref must be "<absPath>:<line>:<col>"');
  }
  const line = Number(refMatch[2]);
  const col = Number(refMatch[3]);

  const ast = parseJsxSource(original);
  const elem = findOpeningElement(ast, line, col);
  if (!elem) {
    throw new Error('JSX element not found at source.ref');
  }

  const styleAttr = findAttr(elem, 'style');
  const plan = planStyleWrite(original, elem, styleAttr, edit.property, edit.value);
  const newSource =
    original.slice(0, plan.start) + plan.replacement + original.slice(plan.end);

  return {
    newSource,
    summary: plan.summary,
    insertedAt: {
      line: elem.loc?.start.line ?? line,
      col: elem.loc?.start.column ?? col,
    },
  };
}
