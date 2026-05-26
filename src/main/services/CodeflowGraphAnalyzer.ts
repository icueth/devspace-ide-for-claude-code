import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as ts from 'typescript';

import { createLogger } from '@shared/logger';

const execFileAsync = promisify(execFile);
import type { CodeflowGraph, CodeflowGraphNode } from '@shared/types';

// ─── Phase 1 (v0.33) static-analysis helpers ─────────────────────────────────

/** Cap for blast-radius computation. Beyond this node count the O(V²/32)
 *  bitset pass is still acceptable on big machines, but not everyone has
 *  32GB of RAM. Users are told via stats.blastSkipped. */
const BLAST_NODE_CAP = 1500;

// Simple edge type used by the pure helpers (source → target).
type Edge = { source: string; target: string };

/**
 * Tarjan's algorithm — computes all strongly-connected components.
 * Returns each SCC of size > 1 as an ordered id list, plus any self-loop
 * (source === target) as a single-element list.
 * Stamps node.inCycle = true for every node that appears in a returned SCC.
 */
export function computeCycles(
  nodeIds: string[],
  edges: Edge[],
): string[][] {
  if (nodeIds.length === 0) return [];

  // Build adjacency list (id → successor ids).
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) adj.set(id, []);
  for (const e of edges) {
    if (e.source === e.target) continue; // self-loops handled separately
    const list = adj.get(e.source);
    if (list) list.push(e.target);
  }

  // Collect self-loop node ids.
  const selfLoopIds = new Set<string>();
  for (const e of edges) {
    if (e.source === e.target && adj.has(e.source)) selfLoopIds.add(e.source);
  }

  // Tarjan iterative SCC.
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let idx = 0;
  const sccs: string[][] = [];

  // Iterative Tarjan to avoid stack overflow on deep graphs.
  for (const root of nodeIds) {
    if (index.has(root)) continue;

    // (node, neighborIdx) pairs
    const callStack: Array<{ v: string; i: number }> = [{ v: root, i: 0 }];
    index.set(root, idx);
    lowlink.set(root, idx);
    idx++;
    stack.push(root);
    onStack.add(root);

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1]!;
      const v = frame.v;
      const neighbors = adj.get(v) ?? [];

      if (frame.i < neighbors.length) {
        const w = neighbors[frame.i]!;
        frame.i++;
        if (!index.has(w)) {
          index.set(w, idx);
          lowlink.set(w, idx);
          idx++;
          stack.push(w);
          onStack.add(w);
          callStack.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
        }
      } else {
        callStack.pop();
        if (callStack.length > 0) {
          const parent = callStack[callStack.length - 1]!;
          lowlink.set(parent.v, Math.min(lowlink.get(parent.v)!, lowlink.get(v)!));
        }
        if (lowlink.get(v) === index.get(v)) {
          const scc: string[] = [];
          let w: string;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            scc.push(w);
          } while (w !== v);
          if (scc.length > 1) sccs.push(scc);
        }
      }
    }
  }

  // Add self-loops as single-element cycles.
  for (const id of selfLoopIds) sccs.push([id]);

  return sccs;
}

/**
 * Detect entry-point node ids: union of
 *   (a) nodes with zero incoming edges,
 *   (b) root-level entries matching common conventions,
 *   (c) package.json main/module/bin targets (best-effort).
 */
export async function detectEntryPoints(
  nodeIds: string[],
  edges: Edge[],
  projectRoot: string,
): Promise<string[]> {
  if (nodeIds.length === 0) return [];
  const nodeSet = new Set(nodeIds);

  // Count incoming edges per node.
  const inDegree = new Map<string, number>();
  for (const id of nodeIds) inDegree.set(id, 0);
  for (const e of edges) {
    if (e.source === e.target) continue;
    if (nodeSet.has(e.target)) {
      inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
    }
  }

  const entries = new Set<string>();

  // (a) Zero-incoming nodes.
  for (const [id, deg] of inDegree) {
    if (deg === 0) entries.add(id);
  }

  // (b) Convention-based root entries (case-insensitive).
  const rootEntryRe =
    /^(src\/)?(index|main|app)\.[jt]sx?$|^src\/main\/index\.[jt]sx?$|^src\/renderer\/main\.[jt]sx?$/i;
  for (const id of nodeIds) {
    if (rootEntryRe.test(id)) entries.add(id);
  }

  // (c) package.json main/module/bin fields (best-effort).
  try {
    const pkgPath = path.join(projectRoot, 'package.json');
    const raw = await fs.promises.readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as {
      main?: string;
      module?: string;
      bin?: string | Record<string, string>;
    };
    const candidates: string[] = [];
    if (typeof pkg.main === 'string') candidates.push(pkg.main);
    if (typeof pkg.module === 'string') candidates.push(pkg.module);
    if (typeof pkg.bin === 'string') candidates.push(pkg.bin);
    if (pkg.bin && typeof pkg.bin === 'object') {
      candidates.push(...Object.values(pkg.bin));
    }
    for (const c of candidates) {
      // Normalise to forward-slash project-relative.
      const rel = c.replace(/^\.\//, '').replace(/\\/g, '/');
      if (nodeSet.has(rel)) entries.add(rel);
    }
  } catch {
    /* package.json absent or malformed — skip */
  }

  return Array.from(entries);
}

/**
 * BFS from entryPoints following outgoing edges.
 * Returns the Set of reachable node ids.
 */
export function computeReachability(
  nodeIds: string[],
  edges: Edge[],
  entryPoints: string[],
): Set<string> {
  if (nodeIds.length === 0) return new Set();

  // Build outgoing adjacency list.
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) adj.set(id, []);
  for (const e of edges) {
    if (e.source === e.target) continue;
    const list = adj.get(e.source);
    if (list) list.push(e.target);
  }

  const visited = new Set<string>();
  const queue: string[] = [];
  for (const ep of entryPoints) {
    if (!visited.has(ep) && adj.has(ep)) {
      visited.add(ep);
      queue.push(ep);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const v = queue[head++]!;
    for (const w of adj.get(v) ?? []) {
      if (!visited.has(w) && adj.has(w)) {
        visited.add(w);
        queue.push(w);
      }
    }
  }
  return visited;
}

/**
 * Compute per-node transitive blast radius using Tarjan SCC condensation
 * into a DAG + reverse-topological Uint32Array bitset union.
 *
 * blastOut[v] = count of distinct nodes reachable following OUTGOING edges.
 * blastIn[v]  = count of distinct nodes that can reach v (transitive dependents).
 *
 * Returns { skipped: true } without touching nodes when nodeIds.length > BLAST_NODE_CAP.
 */
export function computeBlast(
  nodeIds: string[],
  edges: Edge[],
): { blastIn: Map<string, number>; blastOut: Map<string, number>; skipped: boolean } {
  if (nodeIds.length > BLAST_NODE_CAP) {
    return { blastIn: new Map(), blastOut: new Map(), skipped: true };
  }
  if (nodeIds.length === 0) {
    return { blastIn: new Map(), blastOut: new Map(), skipped: false };
  }

  const n = nodeIds.length;
  const idToIdx = new Map<string, number>();
  for (let i = 0; i < n; i++) idToIdx.set(nodeIds[i]!, i);

  // Build adjacency on indices (outgoing: fwd, incoming: rev).
  const fwdAdj: number[][] = Array.from({ length: n }, () => []);
  for (const e of edges) {
    if (e.source === e.target) continue;
    const s = idToIdx.get(e.source);
    const t = idToIdx.get(e.target);
    if (s !== undefined && t !== undefined) fwdAdj[s]!.push(t);
  }

  // Tarjan SCC condensation (index-based, iterative).
  const sccId = new Int32Array(n).fill(-1);
  const indexArr = new Int32Array(n).fill(-1);
  const lowlinkArr = new Int32Array(n);
  const onStackArr = new Uint8Array(n);
  const tarjanStack: number[] = [];
  let tarjanIdx = 0;
  let numSCC = 0;

  for (let root = 0; root < n; root++) {
    if (indexArr[root] !== -1) continue;
    const callStack: Array<{ v: number; i: number }> = [{ v: root, i: 0 }];
    indexArr[root] = tarjanIdx;
    lowlinkArr[root] = tarjanIdx;
    tarjanIdx++;
    tarjanStack.push(root);
    onStackArr[root] = 1;

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1]!;
      const v = frame.v;
      const neighbors = fwdAdj[v]!;

      if (frame.i < neighbors.length) {
        const w = neighbors[frame.i]!;
        frame.i++;
        if (indexArr[w] === -1) {
          indexArr[w] = tarjanIdx;
          lowlinkArr[w] = tarjanIdx;
          tarjanIdx++;
          tarjanStack.push(w);
          onStackArr[w] = 1;
          callStack.push({ v: w, i: 0 });
        } else if (onStackArr[w]) {
          if (lowlinkArr[w]! < lowlinkArr[v]!) lowlinkArr[v] = lowlinkArr[w]!;
        }
      } else {
        callStack.pop();
        if (callStack.length > 0) {
          const parent = callStack[callStack.length - 1]!;
          if (lowlinkArr[v]! < lowlinkArr[parent.v]!) lowlinkArr[parent.v] = lowlinkArr[v]!;
        }
        if (lowlinkArr[v] === indexArr[v]) {
          let w: number;
          do {
            w = tarjanStack.pop()!;
            onStackArr[w] = 0;
            sccId[w] = numSCC;
          } while (w !== v);
          numSCC++;
        }
      }
    }
  }

  // Build condensation DAG (SCC-level adjacency).
  const sccFwd: Set<number>[] = Array.from({ length: numSCC }, () => new Set<number>());
  for (let v = 0; v < n; v++) {
    const sv = sccId[v]!;
    for (const w of fwdAdj[v]!) {
      const sw = sccId[w]!;
      if (sv !== sw) sccFwd[sv]!.add(sw);
    }
  }

  // Topological order of condensation DAG via Kahn's algorithm.
  const sccInDeg = new Int32Array(numSCC);
  for (let s = 0; s < numSCC; s++) {
    for (const t of sccFwd[s]!) sccInDeg[t]++;
  }
  const topoOrder: number[] = [];
  const topoQueue: number[] = [];
  for (let s = 0; s < numSCC; s++) {
    if (sccInDeg[s] === 0) topoQueue.push(s);
  }
  while (topoQueue.length > 0) {
    const s = topoQueue.shift()!;
    topoOrder.push(s);
    for (const t of sccFwd[s]!) {
      sccInDeg[t]--;
      if (sccInDeg[t] === 0) topoQueue.push(t);
    }
  }

  const words = Math.ceil(n / 32);

  // Bitset helpers.
  function popcount(x: number): number {
    x = x - ((x >> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
    return (((x + (x >> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  function countBits(bits: Uint32Array): number {
    let c = 0;
    for (let w = 0; w < words; w++) c += popcount(bits[w]!);
    return c;
  }

  // ── blastOut (forward reachability): process topoOrder in REVERSE so that
  // when we visit SCC s, all of s's successors have already been processed.
  // For each s, union all successors' bits into s's bits.
  const blastOutBits: Uint32Array[] = Array.from({ length: numSCC }, () => new Uint32Array(words));
  // Seed each SCC with itself.
  for (let v = 0; v < n; v++) {
    const s = sccId[v]!;
    blastOutBits[s]![v >> 5]! |= (1 << (v & 31));
  }
  // Reverse-topological: sinks come at the end of topoOrder, so iterate backwards.
  for (let i = topoOrder.length - 1; i >= 0; i--) {
    const s = topoOrder[i]!;
    for (const t of sccFwd[s]!) {
      // t is a successor of s; t appears LATER in topoOrder so already processed.
      const tBits = blastOutBits[t]!;
      const sBits = blastOutBits[s]!;
      for (let w = 0; w < words; w++) sBits[w]! |= tBits[w]!;
    }
  }

  // Compute blastOut per node (all reachable excluding self).
  const blastOutMap = new Map<string, number>();
  for (let v = 0; v < n; v++) {
    const s = sccId[v]!;
    const total = countBits(blastOutBits[s]!);
    blastOutMap.set(nodeIds[v]!, total - 1); // exclude self
  }

  // ── blastIn (reverse reachability): process topoOrder FORWARD so that when
  // we visit SCC s, all of s's predecessors (in the FORWARD graph) have already
  // been processed. For each s, union all predecessors' bits into s's bits.
  // (Equivalently: for each s, push s's bits into each successor so that
  //  successor accumulates who can reach it.)
  const blastInBits: Uint32Array[] = Array.from({ length: numSCC }, () => new Uint32Array(words));
  // Seed with self.
  for (let v = 0; v < n; v++) {
    const s = sccId[v]!;
    blastInBits[s]![v >> 5]! |= (1 << (v & 31));
  }
  // Forward-topological: sources first. For each s, push s's bits into each
  // of its successors t (meaning: t can be reached FROM all nodes that can reach s).
  for (let i = 0; i < topoOrder.length; i++) {
    const s = topoOrder[i]!;
    const sBits = blastInBits[s]!;
    for (const t of sccFwd[s]!) {
      const tBits = blastInBits[t]!;
      for (let w = 0; w < words; w++) tBits[w]! |= sBits[w]!;
    }
  }

  const blastInMap = new Map<string, number>();
  for (let v = 0; v < n; v++) {
    const s = sccId[v]!;
    const total = countBits(blastInBits[s]!);
    blastInMap.set(nodeIds[v]!, total - 1);
  }

  return { blastIn: blastInMap, blastOut: blastOutMap, skipped: false };
}

const logger = createLogger('CodeflowGraph');

// Fallback skip list, used only when `git ls-files` isn't available
// (project not a git repo, or git missing). When git is available we
// honor `.gitignore` — the only way to filter project-specific noise
// (vendored deps, generated protobuf, terraform plan cache, etc.)
// without keeping a hand-curated list per ecosystem.
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
  // Vendored deps + build outputs across other ecosystems.
  'vendor',     // Go / PHP composer
  'bin',
  'tmp',
  'obj',
  'Pods',       // iOS CocoaPods
  'Carthage',   // iOS Carthage
  '.gradle',    // Android Gradle
  '.terraform', // Terraform plan cache
]);

const CODE_EXTS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.rb',
  '.php',
  '.swift',
  '.cs',
  '.cpp',
  '.cc',
  '.c',
  '.h',
  '.hpp',
  '.vue',
  '.svelte',
  '.astro',
  '.lua',
  '.sh',
  '.bash',
  '.zsh',
];

const RESOLVE_EXTS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.svelte',
  '.astro',
];

const HARD_FILE_LIMIT = 4000;
const HARD_BYTE_LIMIT = 1 * 1024 * 1024;

/**
 * Layer detection — purely heuristic but matches what most codebases do.
 * Drives the default coloring on the graph; the user can switch to "by
 * folder" if they want raw directory clusters instead.
 */
// Exported so the function-graph analyzer can stamp each function node
// with its parent file's detected layer — keeps the color "Layer" mode
// meaningful in Functions view instead of painting everything neutral.
export function detectLayer(rel: string): CodeflowGraphNode['layer'] {
  const p = rel.toLowerCase();
  if (
    /(^|\/)(test|tests|__tests__|spec|specs)(\/|$)|\.(test|spec)\.[a-z]+$/.test(p)
  ) {
    return 'test';
  }
  if (/(^|\/)(config|configs|settings)(\/|$)|\.config\.[a-z]+$/.test(p)) return 'config';
  if (/(^|\/)(types?|interfaces?|schemas?|models?|dto)(\/|$)/.test(p)) return 'model';
  if (
    /(^|\/)(components?|pages?|views?|screens?|ui|widgets?|layouts?|app(\.|\/)|renderer(\/|$))/.test(
      p,
    )
  ) {
    return 'ui';
  }
  if (/(^|\/)(api|controllers?|routes?|handlers?|endpoints?|ipc(\/|$))/.test(p)) {
    return 'api';
  }
  if (/(^|\/)(services?|managers?|providers?|repositor(y|ies)|stores?|main(\/|$))/.test(p)) {
    return 'service';
  }
  if (/(^|\/)(utils?|helpers?|libs?|common|shared|core)(\/|$)/.test(p)) return 'util';
  if (/(^|\/)(scripts?|tools?|cli)(\/|$)/.test(p)) return 'tool';
  return 'other';
}

interface FileMeta {
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
}

/**
 * Ask git for "what's actually in the project" — tracked files + untracked
 * but not gitignored. This is the right semantic for analysis: it
 * automatically excludes node_modules, vendor/, generated protobufs,
 * terraform plan caches, build artifacts, and any project-specific
 * gitignore rules without us maintaining a parallel list.
 *
 * Returns null when the project isn't a git repo or `git ls-files` errors;
 * the caller falls back to the hand-curated SKIP_DIRS walk.
 */
async function gitListFiles(projectRoot: string): Promise<string[] | null> {
  try {
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
  // Preferred path: trust git. A Go monorepo with vendored deps, a Next.js
  // app with .next/, or a terraform project with .terraform/ all "just
  // work" because their gitignores already cover the noise.
  const tracked = await gitListFiles(projectRoot);
  if (tracked) {
    const out: FileMeta[] = [];
    for (const rel of tracked) {
      if (out.length >= HARD_FILE_LIMIT) break;
      const ext = path.extname(rel).toLowerCase();
      if (!CODE_EXTS.includes(ext)) continue;
      const abs = path.join(projectRoot, rel);
      try {
        const stat = await fs.promises.stat(abs);
        if (!stat.isFile()) continue;
        out.push({ rel, abs, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        /* skip unreadable / deleted-since-listing */
      }
    }
    return out;
  }

  // Fallback path: not a git repo (or git failed). Manual walk with the
  // SKIP_DIRS list — less precise but at least won't crash on non-git
  // projects.
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
      // Skip hidden files (the entry NAME starts with .).
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await recurse(
          path.join(dir, entry.name),
          rel ? `${rel}/${entry.name}` : entry.name,
        );
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!CODE_EXTS.includes(ext)) continue;
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        try {
          const stat = await fs.promises.stat(path.join(dir, entry.name));
          out.push({
            rel: relPath,
            abs: path.join(dir, entry.name),
            size: stat.size,
            mtimeMs: stat.mtimeMs,
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

// File extension → which extractor to run. We use the TypeScript compiler's
// real parser for JS/TS family files (catches dynamic import('./literal'),
// re-exports, type-only imports, JSX-tag imports, etc. without false
// positives from strings inside comments). Other languages fall back to
// regex because pulling in their parsers isn't worth the bundle cost yet.
const TS_FAMILY = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);

const TS_SCRIPT_KIND: Record<string, ts.ScriptKind> = {
  '.ts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
};

/**
 * Pull every "this file imports that file" reference out of `src`.
 * Uses TypeScript's real parser for JS/TS so we catch:
 *   - import { x } from './foo'
 *   - import('./bar')         (dynamic, literal arg)
 *   - require('./baz')        (CJS)
 *   - export ... from './qux' (re-exports)
 *   - import type { T } from './types'   (type-only)
 * For Python and other languages we fall back to regex.
 */
function extractImportSpecifiers(src: string, ext: string, fileRel: string): string[] {
  if (TS_FAMILY.has(ext)) return extractTsImports(src, ext, fileRel);
  if (ext === '.py') return extractPyImports(src);
  // Conservative regex for other supported languages: just covers
  // the most common forms. Misses dynamic loaders.
  return extractGenericImports(src);
}

function extractTsImports(src: string, ext: string, fileRel: string): string[] {
  const kind = TS_SCRIPT_KIND[ext] ?? ts.ScriptKind.TS;
  const sf = ts.createSourceFile(
    fileRel, // file name is just for error messages, doesn't have to exist
    src,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    kind,
  );
  const out: string[] = [];

  function pushIfStringLiteral(node: ts.Node | undefined): void {
    if (!node) return;
    if (ts.isStringLiteralLike(node)) {
      const text = node.text;
      if (text) out.push(text);
    }
  }

  function visit(node: ts.Node): void {
    // import x from 'foo'  /  import { x } from 'foo'  /  import 'foo'
    if (ts.isImportDeclaration(node)) {
      pushIfStringLiteral(node.moduleSpecifier);
    }
    // export { x } from 'foo'  /  export * from 'foo'
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      pushIfStringLiteral(node.moduleSpecifier);
    }
    // import foo = require('foo')  (legacy CJS-in-TS)
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      pushIfStringLiteral(node.moduleReference.expression);
    }
    // import('./foo') and require('./foo')
    else if (ts.isCallExpression(node)) {
      const expr = node.expression;
      const isDynamicImport = expr.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        ts.isIdentifier(expr) && expr.escapedText === 'require';
      if ((isDynamicImport || isRequire) && node.arguments.length >= 1) {
        pushIfStringLiteral(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return out;
}

function extractPyImports(src: string): string[] {
  const out: string[] = [];
  // `from .foo.bar import baz` and `from foo.bar import baz`
  const reFrom = /(?:^|\n)\s*from\s+([\w.]+)\s+import\b/g;
  // `import foo.bar as alias`
  const reImport = /(?:^|\n)\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/g;
  let m: RegExpExecArray | null;
  while ((m = reFrom.exec(src)) !== null) {
    const spec = m[1];
    if (spec) out.push(spec);
  }
  while ((m = reImport.exec(src)) !== null) {
    const list = m[1];
    if (!list) continue;
    for (const seg of list.split(',')) {
      const s = seg.trim();
      if (s) out.push(s);
    }
  }
  return out;
}

function extractGenericImports(src: string): string[] {
  const out: string[] = [];
  // ES6/CJS-style as a fallback for vue/svelte/sh-style scripts.
  const reImport =
    /(?:^|\s|;)import\s*(?:(?:[\w*\s{},]+?)\s+from\s+)?['"]([^'"\n]+)['"]/g;
  const reRequire = /(?:^|\W)require\s*\(\s*['"]([^'"\n]+)['"]/g;
  for (const re of [reImport, reRequire]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const spec = m[1];
      if (spec) out.push(spec);
    }
  }
  return out;
}

interface PathAlias {
  // Pattern WITHOUT trailing /* — e.g. "@renderer", "@/", "~"
  prefix: string;
  // Resolution targets (project-relative), without trailing /* — e.g. "src/renderer"
  targets: string[];
}

interface ResolveCtx {
  byRel: Map<string, FileMeta>;
  byAbs: Map<string, string>; // abs path → rel
  aliases: PathAlias[];
}

// Strip JSON5-style comments so JSON.parse can swallow tsconfig.json — TS
// allows line and block comments, vanilla JSON.parse rejects them. We don't
// try to handle trailing commas; if a config has those, we fall back to no
// aliases and keep whatever edges plain relative imports produce.
function stripJsonComments(raw: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  let escape = false;
  while (i < raw.length) {
    const ch = raw[i];
    if (escape) {
      out += ch;
      escape = false;
      i++;
      continue;
    }
    if (ch === '\\' && inString) {
      out += ch;
      escape = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      i++;
      continue;
    }
    if (!inString) {
      if (ch === '/' && raw[i + 1] === '/') {
        while (i < raw.length && raw[i] !== '\n') i++;
        continue;
      }
      if (ch === '/' && raw[i + 1] === '*') {
        i += 2;
        while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Pull `compilerOptions.paths` from tsconfig.json (and friends) so we can
 * resolve aliased imports like `@renderer/foo` → `src/renderer/foo`. Without
 * this, projects that lean on path aliases come out as scattered dots with
 * no edges, which is the wrong story.
 *
 * Also reads `vite.config.*` and `electron.vite.config.*` for `resolve.alias`
 * via a regex peek — not a full parse, but catches the 90% case where
 * aliases are defined as string literals.
 */
async function loadAliases(projectRoot: string): Promise<PathAlias[]> {
  const out: PathAlias[] = [];

  for (const fname of [
    'tsconfig.json',
    'tsconfig.base.json',
    'tsconfig.node.json',
    'jsconfig.json',
  ]) {
    const file = path.join(projectRoot, fname);
    let raw: string;
    try {
      raw = await fs.promises.readFile(file, 'utf8');
    } catch {
      continue;
    }
    let cfg: {
      compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
    };
    try {
      cfg = JSON.parse(stripJsonComments(raw));
    } catch (e) {
      logger.warn(`tsconfig parse failed: ${(e as Error).message}`);
      continue;
    }
    const paths = cfg?.compilerOptions?.paths ?? {};
    const baseUrl = cfg?.compilerOptions?.baseUrl ?? '.';
    for (const [pattern, targets] of Object.entries(paths)) {
      if (!Array.isArray(targets) || targets.length === 0) continue;
      const stripStar = (s: string) => s.replace(/\/\*$/, '').replace(/\*$/, '');
      const prefix = stripStar(pattern);
      const resolvedTargets = targets
        .map((t) => path.posix.normalize(path.posix.join(baseUrl, stripStar(t))))
        .filter(Boolean);
      out.push({ prefix, targets: resolvedTargets });
    }
  }

  // Vite-style alias literals: `'@': resolve(__dirname, 'src')` or
  // `'@renderer': resolve(__dirname, 'src/renderer')`. We only catch the
  // simple form — fancier dynamic configs require running the user's
  // bundler, which is out of scope.
  for (const fname of [
    'vite.config.ts',
    'vite.config.js',
    'vite.config.mjs',
    'electron.vite.config.ts',
    'electron.vite.config.js',
    'electron.vite.config.mjs',
  ]) {
    const file = path.join(projectRoot, fname);
    let raw: string;
    try {
      raw = await fs.promises.readFile(file, 'utf8');
    } catch {
      continue;
    }
    // Match `'@foo': resolve(__dirname, 'src/foo')` and quote-string variants.
    const re =
      /['"](@[\w\-./]+|~[\w\-./]+)['"]\s*:\s*(?:resolve|path\.resolve|join|path\.join)\s*\([^)]*['"]([^'"]+)['"]\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      const prefix = m[1]!;
      const target = m[2]!;
      // Don't double-add if tsconfig already covers it.
      if (out.some((a) => a.prefix === prefix)) continue;
      out.push({ prefix, targets: [target] });
    }
  }

  if (out.length) {
    logger.info(
      `loaded ${out.length} path alias${out.length === 1 ? '' : 'es'}: ${out
        .map((a) => `${a.prefix} → ${a.targets[0]}`)
        .join(', ')}`,
    );
  }
  return out;
}

/**
 * Try a single bare-relative target string against the file index. Returns
 * the matching project-relative path or null. Probes direct hit, extension
 * variants, then directory-index. Pulled out as a helper because we call it
 * from both relative resolution and every aliased candidate.
 */
function probeTarget(target: string, ctx: ResolveCtx): string | null {
  if (ctx.byRel.has(target)) return target;
  for (const ext of RESOLVE_EXTS) {
    if (ctx.byRel.has(target + ext)) return target + ext;
  }
  for (const ext of RESOLVE_EXTS) {
    if (ctx.byRel.has(`${target}/index${ext}`)) return `${target}/index${ext}`;
  }
  return null;
}

function resolveSpec(
  spec: string,
  fromRel: string,
  ctx: ResolveCtx,
): string | null {
  // Python "from .foo.bar import x" — translate dots to path. Catch this
  // before the bare-specifier filter so dotted Python imports don't slip
  // through as "starts with .".
  if (spec.startsWith('.') && /^\.+[\w.]*$/.test(spec) && !spec.includes('/')) {
    const fromDir = path.posix.dirname(fromRel);
    const dots = (spec.match(/^\.+/) ?? [''])[0].length;
    const rest = spec.slice(dots).replace(/\./g, '/');
    let dir = fromDir;
    for (let i = 1; i < dots; i++) dir = path.posix.dirname(dir);
    const candidate = rest ? `${dir}/${rest}.py` : `${dir}.py`;
    if (ctx.byRel.has(candidate)) return candidate;
    const init = `${dir}/${rest}/__init__.py`;
    if (ctx.byRel.has(init)) return init;
    return null;
  }

  // Path aliases (tsconfig paths, vite resolve.alias) come BEFORE the bare
  // filter — `@renderer/foo` looks like a bare specifier syntactically but
  // is actually a project-internal reference once you apply the mapping.
  for (const alias of ctx.aliases) {
    if (
      spec === alias.prefix ||
      spec.startsWith(alias.prefix.endsWith('/') ? alias.prefix : `${alias.prefix}/`)
    ) {
      const tail = spec.slice(alias.prefix.length).replace(/^\//, '');
      for (const target of alias.targets) {
        const full = tail
          ? path.posix.normalize(`${target}/${tail}`)
          : target;
        const hit = probeTarget(full, ctx);
        if (hit) return hit;
      }
    }
  }

  // Bare specifiers (npm packages, builtins) — skip after alias resolution
  // had its chance.
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null;

  const fromDir = path.posix.dirname(fromRel);
  const target = path.posix.normalize(`${fromDir}/${spec}`);
  return probeTarget(target, ctx);
}

export async function buildGraph(projectRoot: string): Promise<CodeflowGraph> {
  const t0 = Date.now();
  const [files, aliases] = await Promise.all([
    walk(projectRoot),
    loadAliases(projectRoot),
  ]);
  const byRel = new Map<string, FileMeta>();
  const byAbs = new Map<string, string>();
  for (const f of files) {
    byRel.set(f.rel, f);
    byAbs.set(f.abs, f.rel);
  }
  const ctx: ResolveCtx = { byRel, byAbs, aliases };

  const nodes: CodeflowGraphNode[] = [];
  const edgeMap = new Map<
    string,
    { source: string; target: string; weight: number; kind: 'import' }
  >();
  const langCounts = new Map<string, number>();
  let importsParsed = 0;
  let importsResolved = 0;

  for (const f of files) {
    let content = '';
    if (f.size > HARD_BYTE_LIMIT) {
      // Skip body but keep node — large files (minified bundles, vendored
      // blobs) shouldn't drag the parser down.
      logger.warn(`skipping content of ${f.rel} (${f.size} bytes)`);
    } else {
      try {
        content = await fs.promises.readFile(f.abs, 'utf8');
      } catch {
        /* unreadable, treat as empty */
      }
    }

    const ext = path.extname(f.rel).slice(1) || 'other';
    langCounts.set(ext, (langCounts.get(ext) ?? 0) + 1);
    const loc = content ? content.split('\n').length : 0;

    nodes.push({
      id: f.rel,
      name: path.basename(f.rel),
      folder: path.dirname(f.rel) === '.' ? 'root' : path.dirname(f.rel),
      ext,
      layer: detectLayer(f.rel),
      size: f.size,
      loc,
      degree: 0, // filled in after edges resolve
    });

    if (!content) continue;

    const fileExt = path.extname(f.rel).toLowerCase();
    let specs: string[];
    try {
      specs = extractImportSpecifiers(content, fileExt, f.rel);
    } catch (e) {
      // TS parser can throw on syntactically broken files. Skip them rather
      // than aborting the whole graph build.
      logger.warn(`extract failed for ${f.rel}: ${(e as Error).message}`);
      specs = [];
    }
    importsParsed += specs.length;
    for (const spec of specs) {
      const resolved = resolveSpec(spec, f.rel, ctx);
      if (!resolved || resolved === f.rel) continue;
      importsResolved += 1;
      const key = `${f.rel}\0${resolved}`;
      const existing = edgeMap.get(key);
      if (existing) {
        existing.weight += 1;
      } else {
        edgeMap.set(key, {
          source: f.rel,
          target: resolved,
          weight: 1,
          kind: 'import',
        });
      }
    }
  }

  const edges = Array.from(edgeMap.values());

  // Compute degree (in + out) per node so the renderer can size them by
  // connection count without having to walk edges itself.
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  for (const n of nodes) n.degree = degree.get(n.id) ?? 0;

  // ─── Phase 1 (v0.33) static analysis ─────────────────────────────────────
  const nodeIds = nodes.map((n) => n.id);
  const edgesSimple: { source: string; target: string }[] = edges;

  // 1. Cycles (Tarjan SCC).
  const cycles = computeCycles(nodeIds, edgesSimple);
  const cycleNodeSet = new Set<string>(cycles.flat());
  for (const n of nodes) if (cycleNodeSet.has(n.id)) n.inCycle = true;

  // 2. Entry points.
  const entryPoints = await detectEntryPoints(nodeIds, edgesSimple, projectRoot);

  // 3. Reachability.
  const reachable = computeReachability(nodeIds, edgesSimple, entryPoints);
  let deadCodeCount = 0;
  for (const n of nodes) {
    n.reachable = reachable.has(n.id);
    if (!n.reachable) deadCodeCount++;
  }

  // 4. Blast radius.
  const blast = computeBlast(nodeIds, edgesSimple);
  let blastSkipped: boolean | undefined;
  if (blast.skipped) {
    blastSkipped = true;
  } else {
    for (const n of nodes) {
      n.blastOut = blast.blastOut.get(n.id) ?? 0;
      n.blastIn = blast.blastIn.get(n.id) ?? 0;
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  const totalLanguageNodes = Array.from(langCounts.values()).reduce(
    (a, b) => a + b,
    0,
  ) || 1;
  const languages = Array.from(langCounts.entries())
    .map(([ext, count]) => ({
      ext,
      count,
      pct: Math.round((count / totalLanguageNodes) * 1000) / 10,
    }))
    .sort((a, b) => b.count - a.count);

  const totalLines = nodes.reduce((acc, n) => acc + n.loc, 0);
  const elapsedMs = Date.now() - t0;
  // Stable hash over node ids — used by the augment store to detect when
  // the codebase has shifted enough that saved soft edges should be dropped.
  const fingerprint = createHash('sha256')
    .update(
      [...nodes.map((n) => n.id)].sort().join('\n'),
    )
    .digest('hex');
  logger.info(
    `built graph for ${projectRoot} in ${elapsedMs}ms — ${nodes.length} nodes, ${edges.length} edges, ${aliases.length} aliases, ${importsParsed} imports parsed (${importsResolved} resolved)`,
  );
  return {
    nodes,
    edges,
    stats: {
      totalFiles: nodes.length,
      totalLines,
      totalEdges: edges.length,
      languages,
      truncated: files.length >= HARD_FILE_LIMIT,
      elapsedMs,
      importsParsed,
      importsResolved,
      aliasCount: aliases.length,
      fingerprint,
      cycles,
      deadCodeCount,
      entryPoints,
      ...(blastSkipped ? { blastSkipped: true } : {}),
    },
  };
}
