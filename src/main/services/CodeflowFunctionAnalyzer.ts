import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

import { createLogger } from '@shared/logger';
import type {
  CodeflowCallConfidence,
  CodeflowFunctionEdge,
  CodeflowFunctionGraph,
  CodeflowFunctionKind,
  CodeflowFunctionNode,
} from '@shared/types';

const logger = createLogger('CodeflowFunctions');

// Same skip rules as the file-level analyzer; vendored deps and build
// artifacts shouldn't enter the function graph either.
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-electron',
  'out',
  'build',
  'target',
  '.next',
  '.turbo',
  '.cache',
  '.idea',
  '.vscode',
  '.devspace',
  '.claude',
  'release',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
]);

// We only handle JS/TS family for function extraction. Other languages need
// their own parsers (tree-sitter for Python, etc.) which is a future-phase
// expansion. Keep the rest invisible to the function graph rather than
// half-supported.
const TS_FAMILY = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const TS_SCRIPT_KIND: Record<string, ts.ScriptKind> = {
  '.ts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
};

// Caps. Function-level analysis can blow past file-level by 10-50x in a
// large codebase, so we put hard limits on traversal + payload size.
const HARD_FILE_LIMIT = 4000;
const HARD_FILE_BYTES = 1 * 1024 * 1024;
const HARD_NODE_LIMIT = 25_000;
// Per-name candidate cap when resolving low-confidence calls — prevents
// generic names like "init" or "save" from emitting fan-out spam.
const MAX_CANDIDATES_PER_LOW_CONF = 4;
// Identifiers we never try to resolve as functions because they're either
// JS builtins (the user doesn't care about them in their architecture
// graph) or we can't disambiguate them meaningfully.
const NOISE_NAMES = new Set([
  'log', 'error', 'warn', 'info', 'debug', 'trace',
  'then', 'catch', 'finally',
  'forEach', 'map', 'filter', 'reduce', 'find', 'some', 'every',
  'push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'concat', 'join', 'split',
  'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf',
  'apply', 'call', 'bind',
  'now', 'parse', 'stringify',
  'create', // too generic; many fs.create / new X / Document.create variants
  'get', 'set', 'has', 'delete',
  'add', 'remove',
  'on', 'off', 'emit',
  'open', 'close', 'read', 'write',
  'start', 'stop', 'init', 'destroy', 'dispose',
  'send', 'fetch',
  'toUpperCase', 'toLowerCase', 'trim', 'replace', 'match',
]);

interface FileMeta {
  rel: string;
  abs: string;
  size: number;
}

async function walk(projectRoot: string): Promise<FileMeta[]> {
  const out: FileMeta[] = [];
  async function recurse(dir: string, rel: string): Promise<void> {
    if (out.length >= HARD_FILE_LIMIT) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= HARD_FILE_LIMIT) return;
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await recurse(
          path.join(dir, entry.name),
          rel ? `${rel}/${entry.name}` : entry.name,
        );
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!TS_FAMILY.has(ext)) continue;
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        try {
          const stat = await fs.promises.stat(path.join(dir, entry.name));
          out.push({
            rel: relPath,
            abs: path.join(dir, entry.name),
            size: stat.size,
          });
        } catch {
          /* skip unreadable */
        }
      }
    }
  }
  await recurse(projectRoot, '');
  return out;
}

function nodeId(file: string, name: string, line: number): string {
  return `${file}::${name}:${line}`;
}

interface CallSite {
  callerId: string;     // owning function node id (or `<file>::<file>:0` for top-level calls)
  calleeName: string;
  calleeMember: string | null; // for "x.y(...)" we record member name in calleeName, owner in calleeMember
}

interface FileExtractResult {
  nodes: CodeflowFunctionNode[];
  calls: CallSite[];
}

/**
 * Walk a single source file and emit:
 *   - one node per function-like declaration (FunctionDeclaration,
 *     MethodDeclaration, ArrowFunction/FunctionExpression bound to a
 *     named identifier, ClassDeclaration treated as one node + its
 *     methods),
 *   - one CallSite per CallExpression, attributed to the innermost
 *     enclosing function node (top-level calls attribute to a synthetic
 *     "module" node so we don't lose the edge).
 *
 * We only traverse syntactically — no symbol or type info — so the output
 * is a "best effort" call graph, not a sound one.
 */
function extractFromFile(rel: string, src: string, ext: string): FileExtractResult {
  const kind = TS_SCRIPT_KIND[ext] ?? ts.ScriptKind.TS;
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, kind);

  const nodes: CodeflowFunctionNode[] = [];
  const calls: CallSite[] = [];
  const lineFor = (pos: number) =>
    ts.getLineAndCharacterOfPosition(sf, pos).line + 1;

  // Synthetic "module" node so top-level calls have somewhere to live.
  const moduleId = nodeId(rel, '<module>', 1);
  let hasModuleCalls = false;
  // Stack of innermost enclosing function-node ids during traversal.
  const fnStack: string[] = [];

  function pushNode(
    name: string,
    line: number,
    kind: CodeflowFunctionKind,
    exported: boolean,
    className: string | null,
  ): string {
    const id = nodeId(rel, name, line);
    nodes.push({
      id,
      name,
      file: rel,
      line,
      kind,
      exported,
      className,
      degree: 0,
    });
    return id;
  }

  function isExported(node: ts.Node): boolean {
    const mods = ts.canHaveModifiers(node)
      ? ts.getModifiers(node) ?? []
      : [];
    return mods.some(
      (m) =>
        m.kind === ts.SyntaxKind.ExportKeyword ||
        m.kind === ts.SyntaxKind.DefaultKeyword,
    );
  }

  function visit(node: ts.Node, currentClass: string | null): void {
    // FunctionDeclaration: `function foo() {...}`
    if (ts.isFunctionDeclaration(node) && node.name) {
      const id = pushNode(
        node.name.text,
        lineFor(node.name.getStart(sf)),
        'function',
        isExported(node),
        null,
      );
      fnStack.push(id);
      ts.forEachChild(node, (c) => visit(c, currentClass));
      fnStack.pop();
      return;
    }

    // MethodDeclaration: `class X { foo() {...} }`
    if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      const id = pushNode(
        node.name.text,
        lineFor(node.name.getStart(sf)),
        'method',
        isExported(node),
        currentClass,
      );
      fnStack.push(id);
      ts.forEachChild(node, (c) => visit(c, currentClass));
      fnStack.pop();
      return;
    }

    // ClassDeclaration: emit one node for the class itself (for the
    // top-level "class X" reference) plus recurse so methods are picked
    // up with className filled in.
    if (ts.isClassDeclaration(node) && node.name) {
      const className = node.name.text;
      pushNode(
        className,
        lineFor(node.name.getStart(sf)),
        'class',
        isExported(node),
        null,
      );
      ts.forEachChild(node, (c) => visit(c, className));
      return;
    }

    // VariableDeclaration with arrow/function expression init bound to an
    // identifier: `const foo = () => {...}` or `const foo = function() {…}`.
    // This catches the dominant style in modern React/TS codebases.
    if (
      ts.isVariableDeclaration(node) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer))
    ) {
      const parent = node.parent?.parent; // VariableStatement
      const exported =
        parent && ts.isVariableStatement(parent) && isExported(parent);
      const id = pushNode(
        node.name.text,
        lineFor(node.name.getStart(sf)),
        'arrow',
        !!exported,
        currentClass,
      );
      fnStack.push(id);
      ts.forEachChild(node.initializer, (c) => visit(c, currentClass));
      fnStack.pop();
      return;
    }

    // CallExpression: figure out callee name and attribute to the
    // innermost enclosing function. PropertyAccessExpression (a.b.c())
    // collapses to last segment + carrier.
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      let calleeName: string | null = null;
      let calleeMember: string | null = null;
      if (ts.isIdentifier(expr)) {
        calleeName = expr.text;
      } else if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
        calleeName = expr.name.text;
        // Best-effort: capture the leftmost identifier as carrier so we
        // can later guess whether it's a class instance method call.
        let cur: ts.Expression = expr.expression;
        while (ts.isPropertyAccessExpression(cur)) cur = cur.expression;
        calleeMember = ts.isIdentifier(cur) ? cur.text : null;
      }
      if (calleeName && !NOISE_NAMES.has(calleeName)) {
        const callerId = fnStack[fnStack.length - 1] ?? moduleId;
        if (callerId === moduleId) hasModuleCalls = true;
        calls.push({ callerId, calleeName, calleeMember });
      }
    }

    ts.forEachChild(node, (c) => visit(c, currentClass));
  }

  visit(sf, null);

  // Materialize the synthetic module node only if it actually has outbound
  // calls — keeps node count down for files that are pure declarations.
  if (hasModuleCalls) {
    nodes.unshift({
      id: moduleId,
      name: '<module>',
      file: rel,
      line: 1,
      kind: 'function',
      exported: false,
      className: null,
      degree: 0,
    });
  }

  return { nodes, calls };
}

/**
 * Build the project's function-level call graph. Two-phase:
 *   1. Per-file extract: AST → function nodes + call-site records.
 *   2. Resolve: index nodes by name, match each call site to one or more
 *      candidate declarations, emit edges.
 *
 * Returns a graph compatible with the renderer's d3 force layout — same
 * shape as the file-level graph but with function granularity.
 */
export async function buildFunctionGraph(
  projectRoot: string,
): Promise<CodeflowFunctionGraph> {
  const t0 = Date.now();
  const files = await walk(projectRoot);
  const allNodes: CodeflowFunctionNode[] = [];
  const allCalls: CallSite[] = [];

  for (const f of files) {
    if (allNodes.length >= HARD_NODE_LIMIT) break;
    if (f.size > HARD_FILE_BYTES) continue;
    let content: string;
    try {
      content = await fs.promises.readFile(f.abs, 'utf8');
    } catch {
      continue;
    }
    let result: FileExtractResult;
    try {
      result = extractFromFile(f.rel, content, path.extname(f.rel).toLowerCase());
    } catch (err) {
      logger.warn(`extract failed for ${f.rel}: ${(err as Error).message}`);
      continue;
    }
    for (const n of result.nodes) {
      if (allNodes.length >= HARD_NODE_LIMIT) break;
      allNodes.push(n);
    }
    allCalls.push(...result.calls);
  }

  // Index nodes by name for resolution. Same name can appear in multiple
  // files (e.g. multiple "save" methods) — store all candidates.
  const byName = new Map<string, CodeflowFunctionNode[]>();
  for (const n of allNodes) {
    let arr = byName.get(n.name);
    if (!arr) {
      arr = [];
      byName.set(n.name, arr);
    }
    arr.push(n);
  }

  const edgeMap = new Map<
    string,
    { source: string; target: string; count: number; confidence: CodeflowCallConfidence }
  >();
  let callsResolved = 0;
  let highCount = 0;
  let lowCount = 0;

  for (const call of allCalls) {
    const candidates = byName.get(call.calleeName);
    if (!candidates || candidates.length === 0) continue;
    // Identify caller's owning file from its id — same-file calls don't
    // contribute to the cross-file graph (otherwise every file becomes a
    // dense self-cluster that drowns out real coupling).
    const callerFile = call.callerId.split('::')[0]!;
    const crossFile = candidates.filter((c) => c.file !== callerFile);
    if (crossFile.length === 0) continue;

    callsResolved += 1;

    let confidence: CodeflowCallConfidence;
    let targets: CodeflowFunctionNode[];
    if (crossFile.length === 1) {
      confidence = 'high';
      targets = crossFile;
      highCount += 1;
    } else {
      confidence = 'low';
      // For ambiguous names emit edges to a handful of candidates rather
      // than dropping the call entirely. Cap so generic names don't fan
      // out into hundreds of edges.
      targets = crossFile.slice(0, MAX_CANDIDATES_PER_LOW_CONF);
      lowCount += 1;
    }

    for (const target of targets) {
      const key = `${call.callerId}\0${target.id}\0${confidence}`;
      const existing = edgeMap.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        edgeMap.set(key, {
          source: call.callerId,
          target: target.id,
          count: 1,
          confidence,
        });
      }
    }
  }

  const edges = Array.from(edgeMap.values());

  // Compute degree (in + out) so the renderer can size + filter without
  // scanning edges.
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  for (const n of allNodes) n.degree = degree.get(n.id) ?? 0;

  const elapsedMs = Date.now() - t0;
  logger.info(
    `function graph for ${projectRoot} in ${elapsedMs}ms — ${allNodes.length} nodes, ${edges.length} edges, ${callsResolved}/${allCalls.length} calls resolved`,
  );

  return {
    nodes: allNodes,
    edges,
    stats: {
      totalFunctions: allNodes.length,
      totalEdges: edges.length,
      callsSeen: allCalls.length,
      callsResolved,
      confidence: { high: highCount, low: lowCount },
      truncated:
        allNodes.length >= HARD_NODE_LIMIT || files.length >= HARD_FILE_LIMIT,
      elapsedMs,
    },
  };
}
