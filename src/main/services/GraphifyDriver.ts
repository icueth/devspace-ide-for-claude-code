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
