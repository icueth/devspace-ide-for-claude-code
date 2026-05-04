import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as ts from 'typescript';

import { detectLayer } from '@main/services/CodeflowGraphAnalyzer';
import { createLogger } from '@shared/logger';

const execFileAsync = promisify(execFile);
import type {
  CodeflowCallConfidence,
  CodeflowFunctionEdge,
  CodeflowFunctionGraph,
  CodeflowFunctionKind,
  CodeflowFunctionNode,
} from '@shared/types';

const logger = createLogger('CodeflowFunctions');

// Fallback skip rules used only when the project isn't a git repo (or
// `git ls-files` fails). When git is available we honor `.gitignore`
// instead — that's the only way to exclude project-specific noise like
// generated protobufs, vendored packages, or terraform plan artifacts
// without keeping a hand-curated list current.
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
  // Go vendoring (commonly committed but never user-authored).
  'vendor',
  // Common build / dependency artifacts across other ecosystems.
  'bin',
  'tmp',
  'obj',
  'Pods',          // iOS CocoaPods
  'Carthage',      // iOS Carthage
  '.gradle',       // Android Gradle
  '.terraform',    // Terraform plan cache
]);

// JS/TS family — extracted via the TypeScript Compiler API, full AST.
const TS_FAMILY = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const GO_EXT = '.go';

// Per-language regex patterns for **declarations**. Each pattern's first
// capture group is the function/method name. We pick the keyword-led
// shapes only so we don't false-positive on every paren-call in a comment.
// Calls are matched separately with a universal regex below.
const DECL_PATTERNS: Record<string, RegExp> = {
  '.go':     /(?:^|\n)\s*func\s+(?:\([^)]+\)\s+)?(\w+)\s*[<(]/g,
  '.py':     /(?:^|\n)\s*(?:async\s+)?def\s+(\w+)\s*\(/g,
  '.pyw':    /(?:^|\n)\s*(?:async\s+)?def\s+(\w+)\s*\(/g,
  '.pyi':    /(?:^|\n)\s*(?:async\s+)?def\s+(\w+)\s*\(/g,
  '.rs':     /(?:^|\n)\s*(?:pub\s+(?:\([^)]*\)\s+)?)?(?:async\s+)?fn\s+(\w+)\s*[<(]/g,
  '.rb':     /(?:^|\n)\s*def\s+(?:self\.)?(\w+)/g,
  '.php':    /(?:^|\n)\s*(?:public|private|protected|static|final|abstract)?\s*(?:public|private|protected|static|final|abstract)?\s*function\s+(\w+)\s*\(/g,
  '.swift':  /(?:^|\n)\s*(?:public|private|internal|fileprivate|open)?\s*(?:static\s+)?func\s+(\w+)\s*[<(]/g,
  '.kt':     /(?:^|\n)\s*(?:public|private|protected|internal)?\s*(?:suspend\s+)?fun\s+(?:<[^>]+>\s+)?(\w+)\s*\(/g,
  '.kts':    /(?:^|\n)\s*(?:public|private|protected|internal)?\s*(?:suspend\s+)?fun\s+(?:<[^>]+>\s+)?(\w+)\s*\(/g,
  '.scala':  /(?:^|\n)\s*(?:override\s+)?(?:private|protected|public)?\s*def\s+(\w+)\s*[\[(:]/g,
  '.lua':    /(?:^|\n)\s*(?:local\s+)?function\s+(?:[\w.]+:)?(?:[\w.]+\.)?(\w+)\s*\(/g,
  '.cs':     /(?:^|\n)\s*(?:public|private|protected|internal|static|virtual|override|abstract|sealed|async)\s+(?:[\w<>,\s\[\]]+)\s+(\w+)\s*\(/g,
  '.java':   /(?:^|\n)\s*(?:public|private|protected|static|final|abstract|synchronized)\s+(?:[\w<>,\s\[\]]+)\s+(\w+)\s*\(/g,
  '.dart':   /(?:^|\n)\s*(?:Future<[^>]+>|void|[\w<>,\s\[\]]+?)\s+(\w+)\s*\(/g,
  '.ex':     /(?:^|\n)\s*defp?\s+(\w+)/g,
  '.exs':    /(?:^|\n)\s*defp?\s+(\w+)/g,
  '.erl':    /(?:^|\n)(\w+)\s*\([^)]*\)\s*->/g,
  '.hs':     /(?:^|\n)(\w+)\s*::/g, // Haskell type signatures
  '.r':      /(?:^|\n)\s*(\w+)\s*<-\s*function\s*\(/g,
  '.R':      /(?:^|\n)\s*(\w+)\s*<-\s*function\s*\(/g,
  '.jl':     /(?:^|\n)\s*function\s+(\w+)\s*\(/g,
  '.sh':     /(?:^|\n)\s*(?:function\s+)?(\w+)\s*\(\s*\)\s*\{/g,
  '.bash':   /(?:^|\n)\s*(?:function\s+)?(\w+)\s*\(\s*\)\s*\{/g,
  '.zsh':    /(?:^|\n)\s*(?:function\s+)?(\w+)\s*\(\s*\)\s*\{/g,
};

const SUPPORTED_FUNCTION_EXTS = new Set([
  ...TS_FAMILY,
  ...Object.keys(DECL_PATTERNS),
]);

// Universal regex for "what looks like a function call". We filter the
// matches against language keywords below so `if (...)`, `for (...)`,
// etc. don't emit edges.
const CALL_RE = /\b(\w+)\s*\(/g;

// Keywords + common builtins/syntax across the supported languages —
// anything in this set is dropped from call-site extraction. Better to
// miss a real call than to emit hundreds of false `if/for/while/...`
// edges that drown the canvas.
const LANGUAGE_KEYWORDS = new Set([
  // Control flow / declarations across most languages
  'if', 'else', 'elif', 'elsif', 'unless', 'until',
  'for', 'foreach', 'while', 'do', 'loop', 'repeat',
  'switch', 'case', 'when', 'match', 'select',
  'return', 'yield', 'break', 'continue', 'goto', 'pass',
  'function', 'fun', 'fn', 'def', 'func', 'lambda', 'sub',
  'class', 'struct', 'enum', 'union', 'interface', 'trait', 'protocol', 'impl',
  'type', 'typedef', 'typealias', 'using', 'namespace', 'module', 'package',
  'public', 'private', 'protected', 'internal', 'fileprivate', 'open',
  'static', 'final', 'abstract', 'virtual', 'override', 'sealed',
  'const', 'let', 'var', 'val', 'mut', 'volatile', 'readonly',
  'async', 'await', 'sync', 'spawn', 'go', 'defer',
  'try', 'catch', 'finally', 'throw', 'throws', 'raise', 'rescue', 'ensure',
  'new', 'delete', 'sizeof', 'typeof', 'instanceof',
  'in', 'is', 'as', 'not', 'and', 'or', 'xor',
  'true', 'false', 'null', 'nil', 'undefined', 'None', 'True', 'False',
  'this', 'self', 'super', 'me',
  'with', 'from', 'import', 'export', 'use', 'require',
  'extends', 'implements', 'inherits',
  // Stuff that looks like calls but is rarely interesting cross-module
  'print', 'println', 'printf', 'sprintf', 'fprintf', 'log', 'debug',
  'error', 'warn', 'info', 'trace', 'fatal',
  'len', 'length', 'size', 'count', 'cap',
  'make', 'append', 'copy', 'panic', 'recover',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'String', 'Number', 'Boolean', 'Array', 'Object', 'Map', 'Set', 'Date',
  'JSON', 'Math', 'Promise', 'RegExp',
  'console', 'window', 'document', 'process', 'global',
  // Bash / shell builtins
  'echo', 'cd', 'cp', 'mv', 'rm', 'mkdir', 'cat', 'grep', 'awk', 'sed',
  'export', 'source', 'eval', 'exec', 'test',
]);
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

/**
 * Ask git for the file list it considers "in the project" — tracked +
 * untracked-but-not-ignored. This is the right semantic for codeflow
 * analysis: it automatically excludes node_modules, vendor/, generated
 * files, build artifacts, and any project-specific gitignore rules
 * without us having to maintain a parallel list.
 *
 * Returns null when the project isn't a git repo or `git ls-files` fails
 * for any reason; the caller falls back to a hand-curated SKIP_DIRS walk.
 */
async function gitListFiles(projectRoot: string): Promise<string[] | null> {
  try {
    // `--cached` tracked, `--others` untracked, `--exclude-standard`
    // applies the user's .gitignore + global excludes. `-z` makes paths
    // NUL-separated so newlines in filenames don't break parsing.
    const { stdout } = await execFileAsync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd: projectRoot, maxBuffer: 64 * 1024 * 1024 },
    );
    const paths = stdout.split('\0').filter(Boolean);
    if (paths.length === 0) return null;
    return paths;
  } catch {
    return null;
  }
}

async function walk(projectRoot: string): Promise<FileMeta[]> {
  // Preferred path: trust git's view of the project. This honors every
  // .gitignore + .git/info/exclude + global excludes config the user has,
  // which is the only way to keep a Go monorepo (with `vendor/`,
  // `gen/proto/`, etc.) clean without bespoke per-project rules.
  const tracked = await gitListFiles(projectRoot);
  if (tracked) {
    const out: FileMeta[] = [];
    for (const rel of tracked) {
      if (out.length >= HARD_FILE_LIMIT) break;
      const ext = path.extname(rel).toLowerCase();
      if (!SUPPORTED_FUNCTION_EXTS.has(ext)) continue;
      const abs = path.join(projectRoot, rel);
      try {
        const stat = await fs.promises.stat(abs);
        if (!stat.isFile()) continue;
        out.push({ rel, abs, size: stat.size });
      } catch {
        /* skip unreadable / deleted-since-listing */
      }
    }
    return out;
  }

  // Fallback path: not a git repo (or git failed). Walk ourselves with the
  // hand-curated SKIP_DIRS list — less precise but at least won't blow up.
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
        if (!SUPPORTED_FUNCTION_EXTS.has(ext)) continue;
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
  if (!TS_FAMILY.has(ext)) return extractRegexFile(rel, src, ext);
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
  // Cache the file's detected layer once — it's the same for every node
  // we produce from this file.
  const fileLayer = detectLayer(rel);

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
      layer: fileLayer,
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
      layer: fileLayer,
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
// Where Claude Code will look for the function-level architecture summary.
// Lives next to the file-level docs so the existing CLAUDE.md pointer +
// codeflow-context skill can include it without parallel infrastructure.
function functionMapDir(projectRoot: string): string {
  return path.join(projectRoot, '.claude', 'codeflow');
}
function functionGraphJsonFile(projectRoot: string): string {
  return path.join(functionMapDir(projectRoot), 'function-graph.json');
}
function functionMapMdFile(projectRoot: string): string {
  return path.join(functionMapDir(projectRoot), 'function-map.md');
}

/**
 * Render a concise Markdown summary of the function call graph aimed at
 * Claude Code: top inbound hubs, cross-file bridges, and a per-file
 * exported-functions index. Bounded to ~500 lines so it fits comfortably
 * in a session's auto-loaded context budget; the JSON sibling carries the
 * full data for advanced lookups.
 */
function renderFunctionMap(
  graph: CodeflowFunctionGraph,
  generatedAt: number,
): string {
  // Index inbound edges per node so we can sort by "most called".
  const inbound = new Map<string, number>();
  const outbound = new Map<string, number>();
  for (const e of graph.edges) {
    inbound.set(e.target, (inbound.get(e.target) ?? 0) + e.count);
    outbound.set(e.source, (outbound.get(e.source) ?? 0) + e.count);
  }
  const byId = new Map<string, (typeof graph.nodes)[number]>();
  for (const n of graph.nodes) byId.set(n.id, n);

  const HUB_LIMIT = 25;
  const BRIDGE_LIMIT = 20;
  const PER_FILE_EXPORTS_LIMIT = 8;

  const hubs = [...graph.nodes]
    .map((n) => ({ node: n, inbound: inbound.get(n.id) ?? 0 }))
    .filter((x) => x.inbound > 0)
    .sort((a, b) => b.inbound - a.inbound)
    .slice(0, HUB_LIMIT);

  // Cross-subsystem bridges: a function whose callers span >= 2 distinct
  // top-level directories. These are the seams where subsystems meet.
  const topDir = (file: string) => {
    const i = file.indexOf('/');
    return i >= 0 ? file.slice(0, i) : file;
  };
  const bridges = [...graph.nodes]
    .map((n) => {
      const callers = graph.edges.filter((e) => e.target === n.id);
      const dirs = new Set(
        callers
          .map((e) => byId.get(e.source)?.file)
          .filter((f): f is string => !!f)
          .map(topDir),
      );
      return { node: n, callerCount: callers.length, dirCount: dirs.size, dirs };
    })
    .filter((x) => x.dirCount >= 2 && x.callerCount >= 3)
    .sort((a, b) => b.dirCount - a.dirCount || b.callerCount - a.callerCount)
    .slice(0, BRIDGE_LIMIT);

  // Per-file exported functions, grouped by file.
  const exportsByFile = new Map<string, (typeof graph.nodes)[number][]>();
  for (const n of graph.nodes) {
    if (!n.exported) continue;
    let arr = exportsByFile.get(n.file);
    if (!arr) {
      arr = [];
      exportsByFile.set(n.file, arr);
    }
    arr.push(n);
  }
  const sortedFiles = [...exportsByFile.keys()].sort();

  const fmtNode = (n: (typeof graph.nodes)[number]) =>
    n.className ? `${n.className}.${n.name}` : n.name;

  const out: string[] = [];
  out.push(`# Function call map`);
  out.push('');
  out.push(
    `Generated ${new Date(generatedAt).toISOString().slice(0, 10)} · ` +
      `${graph.nodes.length} functions · ${graph.edges.length} cross-file edges ` +
      `(${graph.stats.confidence.high} high-confidence, ${graph.stats.confidence.low} ambiguous)`,
  );
  out.push('');
  out.push(
    'This file is a structural index of the codebase\'s functions and how they call each other across files. The companion `function-graph.json` has the full data; this Markdown is a curated summary for quick context.',
  );
  out.push('');

  out.push(`## High-traffic hubs`);
  out.push('');
  out.push('Functions called from the most other places — entry points, shared utilities, and core service methods. These are usually the right starting point for "where does X happen" questions.');
  out.push('');
  if (hubs.length === 0) {
    out.push('_(no inbound edges resolved — try Re-augment or check that import paths resolve)_');
  } else {
    for (const h of hubs) {
      out.push(
        `- **\`${fmtNode(h.node)}\`** (\`${h.node.file}:${h.node.line}\`) — called from ${h.inbound} place${h.inbound === 1 ? '' : 's'}`,
      );
    }
  }
  out.push('');

  out.push(`## Cross-subsystem bridges`);
  out.push('');
  out.push('Functions whose callers span multiple top-level directories. Touching these typically affects more than one subsystem at once.');
  out.push('');
  if (bridges.length === 0) {
    out.push('_(no multi-subsystem bridges detected)_');
  } else {
    for (const b of bridges) {
      const dirs = [...b.dirs].sort().join(', ');
      out.push(
        `- **\`${fmtNode(b.node)}\`** (\`${b.node.file}:${b.node.line}\`) — ${b.callerCount} callers across ${b.dirCount} subsystems: \`${dirs}\``,
      );
    }
  }
  out.push('');

  out.push(`## Per-file exported functions`);
  out.push('');
  out.push('Quick index of what each file exposes. Use this to find the right file before drilling into hubs/bridges above.');
  out.push('');
  for (const file of sortedFiles) {
    const fns = exportsByFile.get(file)!;
    const top = fns
      .sort((a, b) => (inbound.get(b.id) ?? 0) - (inbound.get(a.id) ?? 0))
      .slice(0, PER_FILE_EXPORTS_LIMIT);
    out.push(`### \`${file}\``);
    out.push('');
    for (const n of top) {
      const inN = inbound.get(n.id) ?? 0;
      const outN = outbound.get(n.id) ?? 0;
      out.push(
        `- \`${fmtNode(n)}\` — line ${n.line} · in ${inN} · out ${outN}`,
      );
    }
    if (fns.length > top.length) {
      out.push(`- _(+ ${fns.length - top.length} more)_`);
    }
    out.push('');
  }

  return out.join('\n');
}

async function persistFunctionGraph(
  projectRoot: string,
  graph: CodeflowFunctionGraph,
): Promise<void> {
  await fs.promises.mkdir(functionMapDir(projectRoot), { recursive: true });
  // Raw graph for tooling / Claude lookups; pretty-printed so a human
  // (or Claude reading via Read tool) can grep through it readably.
  await fs.promises.writeFile(
    functionGraphJsonFile(projectRoot),
    JSON.stringify(graph, null, 2),
  );
  await fs.promises.writeFile(
    functionMapMdFile(projectRoot),
    renderFunctionMap(graph, Date.now()),
  );
}

/**
 * Generic regex-based extractor used for every non-TS language. Worse
 * than the AST path on accuracy (it'll occasionally pick up commented-
 * out declarations and miss multi-line edge cases) but covers Go,
 * Python, Rust, Ruby, PHP, Swift, Kotlin, Lua, C#, Java, Dart, Elixir,
 * Erlang, Haskell, R, Julia, and shell with one code path. Cross-file
 * resolution is name-based (same as TS) — no scope, no type check.
 *
 * Caller attribution: each call site is attributed to the most recent
 * declared function in the same file, which is right for top-down
 * top-level languages but not great for class methods. We still avoid
 * intra-file edges so this only matters for the "which caller" panel
 * accuracy, not for the cross-file graph topology.
 */
function extractRegexFile(rel: string, src: string, ext: string): FileExtractResult {
  const nodes: CodeflowFunctionNode[] = [];
  const calls: CallSite[] = [];
  const fileLayer = detectLayer(rel);
  const moduleId = nodeId(rel, '<module>', 1);
  let hasModuleCalls = false;

  // Stripping line/block/hash comments out of the source before regex
  // scanning eliminates a huge chunk of false positives (commented-out
  // function() calls that the universal CALL_RE would otherwise match).
  // The replacement preserves newline count so line numbers stay
  // accurate.
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '')
    .replace(/(^|\n)\s*#[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));

  // Build a quick line index so a call's offset → 1-based line.
  const lineStarts: number[] = [0];
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] === '\n') lineStarts.push(i + 1);
  }
  const lineFor = (offset: number): number => {
    // Binary search would be tighter; linear is fine for our file sizes.
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  // Phase 1 — function declarations. Sorted by line so the call-site
  // attribution loop below can find the nearest preceding declaration
  // with a simple pointer.
  const declPattern = DECL_PATTERNS[ext];
  if (declPattern) {
    declPattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = declPattern.exec(stripped)) !== null) {
      const name = m[1];
      if (!name) continue;
      // Skip declarations whose name happens to match a keyword (some
      // langs let you use keywords as identifiers; rare but possible).
      if (LANGUAGE_KEYWORDS.has(name)) continue;
      const line = lineFor(m.index);
      const id = nodeId(rel, name, line);
      nodes.push({
        id,
        name,
        file: rel,
        line,
        kind: 'function',
        // Heuristic: declarations starting with capital letter in
        // public-by-default langs (Go, Rust, PHP) read as exported.
        // For the rest we set false; cross-file resolution doesn't
        // gate on this so the only consequence is the renderer's
        // ranking.
        exported:
          (ext === '.go' || ext === '.rs' || ext === '.php') &&
          /^[A-Z]/.test(name),
        className: null,
        layer: fileLayer,
        degree: 0,
      });
    }
  }

  // Sort declarations by line so we can binary-search "innermost
  // enclosing function" by line number for each call site.
  nodes.sort((a, b) => a.line - b.line);

  // Phase 2 — call sites. We attribute each call to the most recent
  // preceding declaration in the same file, modulo any synthetic
  // module node when the call appears before the first declaration.
  CALL_RE.lastIndex = 0;
  let cm: RegExpExecArray | null;
  while ((cm = CALL_RE.exec(stripped)) !== null) {
    const callee = cm[1];
    if (!callee) continue;
    if (LANGUAGE_KEYWORDS.has(callee)) continue;
    if (NOISE_NAMES.has(callee)) continue;
    const line = lineFor(cm.index);
    // Find caller — last declaration whose line <= current line. Linear
    // back-walk; for the typical declaration count per file (<200) this
    // is cheap.
    let callerId = moduleId;
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (nodes[i]!.line <= line) {
        callerId = nodes[i]!.id;
        break;
      }
    }
    if (callerId === moduleId) hasModuleCalls = true;
    calls.push({ callerId, calleeName: callee, calleeMember: null });
  }

  if (hasModuleCalls) {
    nodes.unshift({
      id: moduleId,
      name: '<module>',
      file: rel,
      line: 1,
      kind: 'function',
      exported: false,
      className: null,
      layer: fileLayer,
      degree: 0,
    });
  }

  return { nodes, calls };
}

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

  const result: CodeflowFunctionGraph = {
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

  // Persist alongside the file-level docs so Claude Code in the project's
  // terminal can read the function map through the same .claude/CLAUDE.md
  // pointer + codeflow-context skill that already loads codebase.md and
  // flow-*.md. Best-effort — if the disk write fails the renderer still
  // gets the graph.
  void persistFunctionGraph(projectRoot, result).catch((err) => {
    logger.warn(`persistFunctionGraph failed: ${(err as Error).message}`);
  });

  return result;
}
