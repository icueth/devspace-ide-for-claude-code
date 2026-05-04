import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { resolveClaudeBinary } from '@main/services/ClaudeCliLauncher';
import { resolveInteractiveShellEnv } from '@main/utils/shellEnv';
import { createLogger } from '@shared/logger';
import type {
  CodeflowEdgeKind,
  CodeflowFunctionEdge,
  CodeflowFunctionGraph,
  CodeflowGraph,
  CodeflowGraphEdge,
} from '@shared/types';

// On-disk shape of `<project>/.claude/codeflow/augment.json`. Stores the
// graph fingerprint at write time so we can drop the cache when the user
// has refactored enough that node ids no longer line up.
interface PersistedAugment {
  savedAt: number;
  graphFingerprint: string;
  softEdges: CodeflowGraphEdge[];
}

function augmentFile(projectRoot: string): string {
  return path.join(projectRoot, '.claude', 'codeflow', 'augment.json');
}

export async function saveAugment(
  projectRoot: string,
  graphFingerprint: string,
  softEdges: CodeflowGraphEdge[],
): Promise<void> {
  const file = augmentFile(projectRoot);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const payload: PersistedAugment = {
    savedAt: Date.now(),
    graphFingerprint,
    softEdges,
  };
  await fs.promises.writeFile(file, JSON.stringify(payload, null, 2));
}

/**
 * Load the persisted soft edges if they were saved against a graph with the
 * same fingerprint. Returns null when no augment exists OR when the project
 * structure has shifted (different fingerprint) — the caller should treat
 * stale augment as "needs re-augment" rather than show possibly-wrong edges.
 */
export async function loadAugment(
  projectRoot: string,
  currentFingerprint: string,
): Promise<{ softEdges: CodeflowGraphEdge[]; savedAt: number } | null> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(augmentFile(projectRoot), 'utf8');
  } catch {
    return null;
  }
  let parsed: PersistedAugment;
  try {
    parsed = JSON.parse(raw) as PersistedAugment;
  } catch {
    return null;
  }
  if (parsed.graphFingerprint !== currentFingerprint) return null;
  if (!Array.isArray(parsed.softEdges)) return null;
  return { softEdges: parsed.softEdges, savedAt: parsed.savedAt };
}

export async function clearAugment(projectRoot: string): Promise<void> {
  try {
    await fs.promises.unlink(augmentFile(projectRoot));
  } catch {
    /* already absent */
  }
}

const logger = createLogger('CodeflowAugment');

// Hard cap to keep prompt size reasonable on large monorepos. The graph is
// passed verbatim — Claude doesn't need every file, just node ids and the
// shape of existing edges.
const MAX_NODES_IN_PROMPT = 600;
const MAX_EDGES_IN_PROMPT = 1500;
const MAX_SOFT_EDGES = 80;

const VALID_KINDS: ReadonlySet<CodeflowEdgeKind> = new Set([
  'event',
  'plugin',
  'config',
  'dynamic',
  'inferred',
]);

interface JobState {
  child: ChildProcess | null;
  cancelled: boolean;
  // Updated as Claude streams events so the UI can show "Reading…" / "Grep…"
  // beat-by-beat instead of staring at a spinner.
  message: string;
}

const jobs = new Map<string, JobState>();

export type AugmentProgress = (msg: string) => void;

export function isAugmenting(projectPath: string): boolean {
  return !!jobs.get(path.resolve(projectPath))?.child;
}

export function cancelAugment(projectPath: string): void {
  const key = path.resolve(projectPath);
  const job = jobs.get(key);
  if (!job) return;
  job.cancelled = true;
  try {
    job.child?.kill('SIGTERM');
  } catch {
    /* ignore */
  }
}

/**
 * Ask Claude to walk the codebase and add SOFT edges that static analysis
 * can't see — event bus wiring, plugin registries, dynamic dispatch, config-
 * driven coupling. Returns merged graph (existing import edges + Claude's
 * soft edges, deduplicated). Pure function: doesn't write to disk.
 */
export async function augmentGraph(
  projectPath: string,
  graph: CodeflowGraph,
  onProgress: AugmentProgress,
): Promise<CodeflowGraphEdge[]> {
  const key = path.resolve(projectPath);
  if (jobs.get(key)?.child) {
    throw new Error('augment already running for this project');
  }

  const claudeBin = await resolveClaudeBinary();
  if (!claudeBin) {
    throw new Error(
      "claude binary not found on PATH — install Claude Code CLI to augment.",
    );
  }

  const env = await resolveInteractiveShellEnv();
  const job: JobState = { child: null, cancelled: false, message: 'Starting…' };
  jobs.set(key, job);
  onProgress(job.message);

  // Build the prompt. Trim to keep request size bounded: nodes are a flat
  // list of paths, edges are a compact "src→tgt" listing.
  const nodeIds = graph.nodes.map((n) => n.id);
  const trimmedNodes = nodeIds.slice(0, MAX_NODES_IN_PROMPT);
  const trimmedEdges = graph.edges.slice(0, MAX_EDGES_IN_PROMPT);
  const trimmedNodesNote =
    nodeIds.length > MAX_NODES_IN_PROMPT
      ? ` (${nodeIds.length} total, top ${MAX_NODES_IN_PROMPT} shown)`
      : '';
  const trimmedEdgesNote =
    graph.edges.length > MAX_EDGES_IN_PROMPT
      ? ` (${graph.edges.length} total, top ${MAX_EDGES_IN_PROMPT} shown)`
      : '';

  const prompt = [
    `Augment this dependency graph with SOFT edges that static import analysis missed.`,
    '',
    'Static analysis already captured every `import`/`require`/`from … import` reference.',
    'You should NOT repeat those. Look for relationships the AST cannot see:',
    '',
    '- **event** — file A emits an event/topic, file B listens for it',
    '- **plugin** — file A registers / loads file B by name from a config or registry',
    '- **config** — file A is a config that drives behavior in file B (no import)',
    '- **dynamic** — `import(\\`./views/${name}\\`)`, dynamic require, DI container, reflection',
    '- **inferred** — strong functional coupling that doesn\'t fit the above buckets',
    '',
    'Use Read/Glob/Grep to investigate. Only emit edges for relationships you can defend',
    'with a concrete code reference (file:line). Skip relationships you\'re unsure about.',
    '',
    '**Output format**: one JSON object per line, NO markdown fence, NO preamble. Each line:',
    '```',
    '{"source":"src/foo.ts","target":"src/bar.ts","kind":"event","weight":1,"reason":"foo.ts:42 emits \'login\'; bar.ts:17 listens"}',
    '```',
    '',
    `Cap output at ${MAX_SOFT_EDGES} soft edges. Use the highest-impact relationships first.`,
    '',
    `## Static graph (${graph.nodes.length} nodes, ${graph.edges.length} edges)`,
    '',
    `### Nodes${trimmedNodesNote}`,
    trimmedNodes.join('\n'),
    '',
    `### Existing edges${trimmedEdgesNote}`,
    trimmedEdges.map((e) => `${e.source} -> ${e.target}`).join('\n'),
  ].join('\n');

  const args = [
    '--print',
    '--permission-mode',
    'acceptEdits',
    '--output-format',
    'stream-json',
    '--verbose',
    '--allowedTools',
    'Read,Glob,Grep',
  ];

  return new Promise<CodeflowGraphEdge[]>((resolve, reject) => {
    logger.info(`augmenting graph for ${projectPath}`);
    const child = spawn(claudeBin, args, {
      cwd: projectPath,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    job.child = child;
    child.stdin?.write(prompt);
    child.stdin?.end();

    let lineBuf = '';
    let stderrBuf = '';
    let resultText = '';
    let toolCount = 0;

    const handleEvent = (raw: string) => {
      let evt: unknown;
      try {
        evt = JSON.parse(raw);
      } catch {
        return;
      }
      const e = evt as {
        type?: string;
        message?: {
          content?: Array<
            | { type: 'text'; text?: string }
            | {
                type: 'tool_use';
                name?: string;
                input?: Record<string, unknown>;
              }
          >;
        };
        result?: string;
      };

      if (e.type === 'assistant' && e.message?.content) {
        for (const block of e.message.content) {
          if (block.type === 'tool_use') {
            toolCount += 1;
            const name = block.name ?? 'tool';
            const input = block.input ?? {};
            const fp = (input.file_path as string) || (input.path as string) || '';
            const pat = (input.pattern as string) || (input.query as string) || '';
            const shortPath = (p: string) => {
              if (!p) return '';
              const segs = p.split('/');
              return segs.length > 4 ? `…/${segs.slice(-3).join('/')}` : p;
            };
            const desc =
              name === 'Read' ? `📖 ${shortPath(fp)}` :
              name === 'Glob' ? `🔎 ${pat}` :
              name === 'Grep' ? `🔍 "${pat}"` :
              `🔧 ${name}`;
            job.message = `${desc}  (${toolCount} tools)`;
            onProgress(job.message);
          }
        }
      }

      // The `result` event arrives at the very end with the full text response.
      // We rely on this rather than collecting text deltas because Claude
      // sometimes streams partial JSON across multiple text blocks.
      if (e.type === 'result' && typeof e.result === 'string') {
        resultText = e.result;
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      lineBuf += chunk.toString('utf8');
      let nl: number;
      while ((nl = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (line) handleEvent(line);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      jobs.delete(key);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      jobs.delete(key);
      if (lineBuf.trim()) handleEvent(lineBuf.trim());

      if (job.cancelled || signal === 'SIGTERM' || signal === 'SIGKILL') {
        reject(new Error('cancelled'));
        return;
      }
      if (code !== 0) {
        const trimmed = stderrBuf.trim() || resultText.slice(-300);
        reject(new Error(`claude exited ${code}${trimmed ? `: ${trimmed}` : ''}`));
        return;
      }

      const softEdges = parseSoftEdges(resultText, graph);
      logger.info(
        `augment complete: ${softEdges.length} soft edges from ${toolCount} tool calls`,
      );
      // Persist so reopening the project skips re-augment until the graph
      // fingerprint changes. Best-effort — if disk is read-only or quota
      // exhausted we still return the in-memory result.
      void saveAugment(projectPath, graph.stats.fingerprint, softEdges).catch(
        (err) => logger.warn(`saveAugment failed: ${(err as Error).message}`),
      );
      resolve(softEdges);
    });
  });
}

/**
 * Parse Claude's response — newline-delimited JSON objects. We accept some
 * leniency: lines that aren't valid JSON are skipped, fenced code blocks
 * are stripped, edges referring to unknown node ids are dropped (Claude
 * sometimes hallucinates filenames).
 */
function parseSoftEdges(
  text: string,
  graph: CodeflowGraph,
): CodeflowGraphEdge[] {
  const known = new Set(graph.nodes.map((n) => n.id));
  const existing = new Set(
    graph.edges.map((e) => `${e.source}\0${e.target}`),
  );
  const out: CodeflowGraphEdge[] = [];

  // Strip ```json … ``` fences if Claude added any despite the prompt.
  const cleaned = text
    .replace(/```(?:json)?\s*\n/g, '')
    .replace(/\n```/g, '');

  for (const rawLine of cleaned.split('\n')) {
    const line = rawLine.trim();
    if (!line || !line.startsWith('{')) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const e = obj as {
      source?: unknown;
      target?: unknown;
      kind?: unknown;
      weight?: unknown;
      reason?: unknown;
    };
    const source = typeof e.source === 'string' ? e.source : null;
    const target = typeof e.target === 'string' ? e.target : null;
    if (!source || !target || source === target) continue;
    if (!known.has(source) || !known.has(target)) continue;

    const kindRaw = typeof e.kind === 'string' ? e.kind : 'inferred';
    const kind = (VALID_KINDS.has(kindRaw as CodeflowEdgeKind)
      ? kindRaw
      : 'inferred') as CodeflowEdgeKind;
    const weight =
      typeof e.weight === 'number' && e.weight > 0 ? Math.min(e.weight, 5) : 1;
    const reason = typeof e.reason === 'string' ? e.reason.slice(0, 240) : undefined;

    // Skip if static graph already has this edge in either direction —
    // Claude was told not to repeat, but be defensive.
    if (
      existing.has(`${source}\0${target}`) ||
      existing.has(`${target}\0${source}`)
    ) {
      continue;
    }

    out.push({ source, target, kind, weight, reason });
    if (out.length >= MAX_SOFT_EDGES) break;
  }
  return out;
}

// ─── Function-level augment ─────────────────────────────────────────────────
//
// Mirrors the file-level augment above but operates over function-id node
// space (`<file>::<name>:<line>`). Asks Claude to find function-call
// relationships the static name-match analyzer missed: callbacks passed as
// args, plugin/handler dispatch, interface method dispatch, dynamic
// require/import targets resolved at runtime, etc. Persists to a sibling
// JSON file so reopening Functions mode picks up cached soft edges keyed
// by the function-graph's own fingerprint.

interface PersistedFunctionAugment {
  savedAt: number;
  graphFingerprint: string;
  softEdges: CodeflowFunctionEdge[];
}

function functionAugmentFile(projectRoot: string): string {
  return path.join(projectRoot, '.claude', 'codeflow', 'function-augment.json');
}

// Function-graph fingerprint — sha-style stable string the renderer uses
// to invalidate the saved augment when the function set has shifted.
// Computed cheap (hash of sorted node ids) so the renderer can do it
// inline without re-running the analyzer.
function fingerprintFunctionGraph(graph: CodeflowFunctionGraph): string {
  const ids = graph.nodes.map((n) => n.id).sort().join('\n');
  // Reuse Node's built-in crypto rather than adding a dep.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(ids).digest('hex');
}

export async function saveFunctionAugment(
  projectRoot: string,
  graphFingerprint: string,
  softEdges: CodeflowFunctionEdge[],
): Promise<void> {
  const file = functionAugmentFile(projectRoot);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const payload: PersistedFunctionAugment = {
    savedAt: Date.now(),
    graphFingerprint,
    softEdges,
  };
  await fs.promises.writeFile(file, JSON.stringify(payload, null, 2));
}

export async function loadFunctionAugment(
  projectRoot: string,
  currentFingerprint: string,
): Promise<{ softEdges: CodeflowFunctionEdge[]; savedAt: number } | null> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(functionAugmentFile(projectRoot), 'utf8');
  } catch {
    return null;
  }
  let parsed: PersistedFunctionAugment;
  try {
    parsed = JSON.parse(raw) as PersistedFunctionAugment;
  } catch {
    return null;
  }
  if (parsed.graphFingerprint !== currentFingerprint) return null;
  if (!Array.isArray(parsed.softEdges)) return null;
  return { softEdges: parsed.softEdges, savedAt: parsed.savedAt };
}

export function isFunctionAugmenting(projectPath: string): boolean {
  return !!functionJobs.get(path.resolve(projectPath))?.child;
}

export function cancelFunctionAugment(projectPath: string): void {
  const key = path.resolve(projectPath);
  const job = functionJobs.get(key);
  if (!job) return;
  job.cancelled = true;
  try {
    job.child?.kill('SIGTERM');
  } catch {
    /* ignore */
  }
}

const functionJobs = new Map<string, JobState>();

const MAX_FUNCTION_NODES_IN_PROMPT = 800;
const MAX_FUNCTION_EDGES_IN_PROMPT = 2000;
const MAX_FUNCTION_SOFT_EDGES = 120;

/**
 * Same shape as `augmentGraph` but operates on the function-level call
 * graph. Sends a sample of function ids + existing edges to Claude and
 * asks for relationships static name-resolution missed.
 */
export async function augmentFunctionGraph(
  projectPath: string,
  graph: CodeflowFunctionGraph,
  onProgress: AugmentProgress,
): Promise<CodeflowFunctionEdge[]> {
  const key = path.resolve(projectPath);
  if (functionJobs.get(key)?.child) {
    throw new Error('function augment already running for this project');
  }

  const claudeBin = await resolveClaudeBinary();
  if (!claudeBin) {
    throw new Error(
      "claude binary not found on PATH — install Claude Code CLI to use Augment.",
    );
  }

  const env = await resolveInteractiveShellEnv();
  const job: JobState = { child: null, cancelled: false, message: 'Starting…' };
  functionJobs.set(key, job);
  onProgress(job.message);

  // Trim — function graphs can be huge. Keep the highest-degree nodes
  // (most signal) and a representative slice of edges.
  const sortedByDegree = [...graph.nodes].sort((a, b) => b.degree - a.degree);
  const trimmedNodes = sortedByDegree.slice(0, MAX_FUNCTION_NODES_IN_PROMPT);
  const trimmedNodesNote =
    graph.nodes.length > MAX_FUNCTION_NODES_IN_PROMPT
      ? ` (${graph.nodes.length} total, top ${MAX_FUNCTION_NODES_IN_PROMPT} by degree shown)`
      : '';
  const trimmedEdges = graph.edges.slice(0, MAX_FUNCTION_EDGES_IN_PROMPT);
  const trimmedEdgesNote =
    graph.edges.length > MAX_FUNCTION_EDGES_IN_PROMPT
      ? ` (${graph.edges.length} total, top ${MAX_FUNCTION_EDGES_IN_PROMPT} shown)`
      : '';

  const prompt = [
    'Augment this FUNCTION-level call graph with SOFT edges that name-based static analysis missed.',
    '',
    'Static analysis already captured every cross-file call where the callee\'s identifier is unique. You should NOT repeat those. Look for relationships that need code reading to see:',
    '',
    '- **dynamic** — function passed as a callback / handler / hook (e.g. `app.on(\'event\', someHandler)`, `useEffect(callback, ...)`)',
    '- **plugin** — function registered into a plugin/handler registry by name and dispatched by string',
    '- **inferred** — interface method dispatch where the concrete impl can\'t be name-resolved (e.g. `repo.Save()` resolving to `UserRepo.Save` vs `OrderRepo.Save`)',
    '- **event** — pub/sub coupling at the function level: function A emits, function B handles',
    '',
    'Use Read/Glob/Grep to investigate. Only emit edges you can defend with a concrete code reference (file:line).',
    '',
    '**Output format**: one JSON object per line, NO markdown fence, NO preamble. Each line:',
    '```',
    '{"source":"src/foo.ts::handle:42","target":"src/bar.ts::onLogin:17","kind":"dynamic","weight":1,"reason":"foo.ts:42 passes onLogin as the auth callback"}',
    '```',
    '',
    'Use the EXACT node ids from the list below for source/target. Do not invent new ids.',
    `Cap output at ${MAX_FUNCTION_SOFT_EDGES} soft edges. Use the highest-impact relationships first.`,
    '',
    `## Function graph (${graph.nodes.length} nodes, ${graph.edges.length} edges)`,
    '',
    `### Nodes${trimmedNodesNote}`,
    trimmedNodes.map((n) => `${n.id}\t(kind=${n.kind}${n.exported ? ', exported' : ''}, degree=${n.degree})`).join('\n'),
    '',
    `### Existing edges${trimmedEdgesNote}`,
    trimmedEdges.map((e) => `${e.source} -> ${e.target} (${e.confidence})`).join('\n'),
  ].join('\n');

  const args = [
    '--print',
    '--dangerously-skip-permissions',
    '--output-format',
    'stream-json',
    '--verbose',
    '--allowed-tools',
    'Read Glob Grep',
  ];

  return new Promise<CodeflowFunctionEdge[]>((resolve, reject) => {
    logger.info(`augmenting function graph for ${projectPath}`);
    const child = spawn(claudeBin, args, {
      cwd: projectPath,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    job.child = child;
    child.stdin?.write(prompt);
    child.stdin?.end();

    let lineBuf = '';
    let stderrBuf = '';
    let resultText = '';
    let toolCount = 0;

    const handleEvent = (raw: string) => {
      let evt: unknown;
      try {
        evt = JSON.parse(raw);
      } catch {
        return;
      }
      const e = evt as {
        type?: string;
        message?: {
          content?: Array<
            | { type: 'text'; text?: string }
            | {
                type: 'tool_use';
                name?: string;
                input?: Record<string, unknown>;
              }
          >;
        };
        result?: string;
      };

      if (e.type === 'assistant' && e.message?.content) {
        for (const block of e.message.content) {
          if (block.type === 'tool_use') {
            toolCount += 1;
            const name = block.name ?? 'tool';
            const input = block.input ?? {};
            const fp = (input.file_path as string) || (input.path as string) || '';
            const pat = (input.pattern as string) || (input.query as string) || '';
            const shortPath = (p: string) => {
              if (!p) return '';
              const segs = p.split('/');
              return segs.length > 4 ? `…/${segs.slice(-3).join('/')}` : p;
            };
            const desc =
              name === 'Read' ? `📖 ${shortPath(fp)}` :
              name === 'Glob' ? `🔎 ${pat}` :
              name === 'Grep' ? `🔍 "${pat}"` :
              `🔧 ${name}`;
            job.message = `${desc}  (${toolCount} tools)`;
            onProgress(job.message);
          }
        }
      }

      if (e.type === 'result' && typeof e.result === 'string') {
        resultText = e.result;
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      lineBuf += chunk.toString('utf8');
      let nl: number;
      while ((nl = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (line) handleEvent(line);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      functionJobs.delete(key);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      functionJobs.delete(key);
      if (lineBuf.trim()) handleEvent(lineBuf.trim());

      if (job.cancelled || signal === 'SIGTERM' || signal === 'SIGKILL') {
        reject(new Error('cancelled'));
        return;
      }
      if (code !== 0) {
        const trimmed = stderrBuf.trim() || resultText.slice(-300);
        reject(new Error(`claude exited ${code}${trimmed ? `: ${trimmed}` : ''}`));
        return;
      }

      const softEdges = parseFunctionSoftEdges(resultText, graph);
      logger.info(
        `function augment complete: ${softEdges.length} soft edges from ${toolCount} tool calls`,
      );
      void saveFunctionAugment(
        projectPath,
        fingerprintFunctionGraph(graph),
        softEdges,
      ).catch((err) =>
        logger.warn(`saveFunctionAugment failed: ${(err as Error).message}`),
      );
      resolve(softEdges);
    });
  });
}

const FUNCTION_VALID_KINDS: ReadonlySet<'dynamic' | 'event' | 'plugin' | 'inferred'> =
  new Set(['dynamic', 'event', 'plugin', 'inferred'] as const);

function parseFunctionSoftEdges(
  text: string,
  graph: CodeflowFunctionGraph,
): CodeflowFunctionEdge[] {
  const known = new Set(graph.nodes.map((n) => n.id));
  const existing = new Set(
    graph.edges.map((e) => `${e.source}\0${e.target}`),
  );
  const out: CodeflowFunctionEdge[] = [];

  const cleaned = text
    .replace(/```(?:json)?\s*\n/g, '')
    .replace(/\n```/g, '');

  for (const rawLine of cleaned.split('\n')) {
    const line = rawLine.trim();
    if (!line || !line.startsWith('{')) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const e = obj as {
      source?: unknown;
      target?: unknown;
      weight?: unknown;
      kind?: unknown;
    };
    const source = typeof e.source === 'string' ? e.source : null;
    const target = typeof e.target === 'string' ? e.target : null;
    if (!source || !target || source === target) continue;
    // Strict: drop edges Claude hallucinated against ids that don't exist
    // in the current function graph.
    if (!known.has(source) || !known.has(target)) continue;
    const kindRaw = typeof e.kind === 'string' ? e.kind : 'inferred';
    if (!FUNCTION_VALID_KINDS.has(kindRaw as never)) continue;
    const weight =
      typeof e.weight === 'number' && e.weight > 0 ? Math.min(e.weight, 5) : 1;

    if (
      existing.has(`${source}\0${target}`) ||
      existing.has(`${target}\0${source}`)
    ) {
      continue;
    }

    out.push({
      source,
      target,
      count: weight,
      // Soft edges from Claude are by definition lower confidence than the
      // static cross-file resolution. Render them as 'low' so they share
      // the dashed-line styling with name-collision low-confidence edges.
      confidence: 'low',
    });
    if (out.length >= MAX_FUNCTION_SOFT_EDGES) break;
  }
  return out;
}

export async function clearFunctionAugment(projectRoot: string): Promise<void> {
  try {
    await fs.promises.unlink(functionAugmentFile(projectRoot));
  } catch {
    /* already absent */
  }
}
