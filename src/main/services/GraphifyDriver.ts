import { spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { app } from 'electron';

import {
  bundledGraphifyExists,
  getBundledGraphifyBinary,
} from '@main/utils/graphifyPaths';
import {
  adaptFunctionGraph,
  type GraphifyGraph,
} from '@main/services/graphifyAdapter';
import { createLogger } from '@shared/logger';
import type { CodeflowFunctionGraph } from '@shared/types';

const logger = createLogger('GraphifyDriver');

const EXTRACT_TIMEOUT_MS = 120_000;

// Per-project graphify output dir under userData (NOT the user's repo). Stable
// per project so graphify's manifest+graph.json enable incremental re-extracts
// (only changed files re-parse).
function outDirFor(projectRoot: string): string {
  const key = crypto.createHash('sha1').update(projectRoot).digest('hex').slice(0, 16);
  return path.join(app.getPath('userData'), 'graphify-cache', key);
}

function graphPathFor(projectRoot: string): string {
  return path.join(outDirFor(projectRoot), 'graphify-out', 'graph.json');
}

const activeChildren = new Map<string, ChildProcess>();

function runExtract(projectRoot: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!bundledGraphifyExists()) {
      reject(new Error('graphify binary is not bundled for this platform'));
      return;
    }
    const bin = getBundledGraphifyBinary();
    const out = outDirFor(projectRoot);
    fs.mkdirSync(out, { recursive: true });

    // Single root = the project, so graphify emits project-relative source_file
    // paths. --no-cluster keeps it to the structural graph (no LLM, fully
    // offline); community labelling is a separate Phase-3 concern.
    const args = ['extract', projectRoot, '--out', out, '--no-cluster'];
    const child = spawn(bin, args, {
      cwd: projectRoot,
      env: { ...process.env, GRAPHIFY_QUERY_LOG_DISABLE: '1' },
    });
    activeChildren.set(projectRoot, child);

    let stderr = '';
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`graphify extract timed out after ${EXTRACT_TIMEOUT_MS}ms`));
    }, EXTRACT_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      activeChildren.delete(projectRoot);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      activeChildren.delete(projectRoot);
      if (code === 0) {
        resolve();
      } else {
        // graphify exits non-zero on the graph-size cap and on fatal errors.
        reject(new Error(`graphify extract exited ${code}: ${stderr.slice(0, 500)}`));
      }
    });
  });
}

/**
 * Build the function-level graph by running the bundled graphify binary and
 * adapting its output to CodeflowFunctionGraph. Drop-in replacement for the
 * old CodeflowFunctionAnalyzer.buildFunctionGraph — same signature + return
 * shape, so the IPC handler and renderer are unchanged.
 */
export async function buildFunctionGraph(
  projectRoot: string,
): Promise<CodeflowFunctionGraph> {
  const t0 = Date.now();
  await runExtract(projectRoot);

  let raw: string;
  try {
    raw = await fs.promises.readFile(graphPathFor(projectRoot), 'utf8');
  } catch {
    throw new Error(`graphify produced no graph.json at ${graphPathFor(projectRoot)}`);
  }

  let g: GraphifyGraph;
  try {
    g = JSON.parse(raw) as GraphifyGraph;
  } catch (err) {
    throw new Error(`graphify graph.json is not valid JSON: ${(err as Error).message}`);
  }

  const graph = adaptFunctionGraph(g, Date.now() - t0);
  logger.info(
    `built function graph for ${path.basename(projectRoot)}: ` +
      `${graph.stats.totalFunctions} fns, ${graph.stats.totalEdges} edges`,
  );
  return graph;
}

export type GraphifyQueryMode = 'query' | 'path' | 'explain';

const QUERY_TIMEOUT_MS = 60_000;

/**
 * Run a one-shot graphify query against the cached graph.json (built by the
 * last buildFunctionGraph). Returns graphify's plain-text result. Modes:
 *   query   <question>  — BFS/DFS scoped subgraph for a natural-language query
 *   path    <A> <B>     — shortest path between two symbols
 *   explain <X>         — a node plus its neighbours
 * Offline + read-only; never rebuilds the graph.
 */
export async function query(
  projectRoot: string,
  mode: GraphifyQueryMode,
  args: string[],
): Promise<string> {
  if (!bundledGraphifyExists()) {
    throw new Error('graphify binary is not bundled for this platform');
  }
  const graphPath = graphPathFor(projectRoot);
  if (!fs.existsSync(graphPath)) {
    throw new Error('No graph yet — open the Codeflow graph first so graphify can build it.');
  }
  const cleaned = args.map((a) => a.trim()).filter(Boolean);
  if (cleaned.length === 0) throw new Error('query is empty');
  if (mode === 'path' && cleaned.length < 2) {
    throw new Error('path needs two nodes (from and to)');
  }

  const bin = getBundledGraphifyBinary();
  const cliArgs = [mode, ...cleaned, '--graph', graphPath];
  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, cliArgs, {
      cwd: projectRoot,
      env: { ...process.env, GRAPHIFY_QUERY_LOG_DISABLE: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`graphify ${mode} timed out`));
    }, QUERY_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim() || '(no results)');
      else reject(new Error(`graphify ${mode} exited ${code}: ${(stderr || stdout).slice(0, 400)}`));
    });
  });
}

/** Kill any in-flight graphify child for a project (workspace close). */
export function disposeProject(projectRoot: string): void {
  const child = activeChildren.get(projectRoot);
  if (child) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    activeChildren.delete(projectRoot);
  }
}
