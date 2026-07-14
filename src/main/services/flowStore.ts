// Agent Flow — persistence. Plain, curatable JSON under the project so a flow
// is a reviewable artifact (diffable, shareable, editable by hand):
//   <projectPath>/.devspace/flows/<id>.flow.json   the graph
//   <projectPath>/.devspace/flows/runs/<runId>.json the run journal
//
// Same contract as taskStore: a missing or corrupt file is never fatal — it
// degrades to "not there" so one bad hand-edit can't take the whole view down.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { atomicWriteAsync } from '@main/utils/atomicWrite';
import type { FlowGraph, FlowRun } from '@shared/flowTypes';

export function flowsDir(projectPath: string): string {
  return path.join(projectPath, '.devspace', 'flows');
}

export function runsDir(projectPath: string): string {
  return path.join(flowsDir(projectPath), 'runs');
}

// Flow/run ids become file names. Generated ids are short base36, but flow
// files can arrive from anywhere (a cloned repo, a hand edit) and run ids from
// any MCP caller — an id containing '/' or '..' would escape .devspace/flows
// through path.join, so anything outside this charset is rejected at the
// boundary (CLAUDE.md: validate input at system boundaries).
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function isSafeFlowId(id: unknown): id is string {
  return typeof id === 'string' && SAFE_ID.test(id);
}

function flowFile(projectPath: string, id: string): string {
  if (!isSafeFlowId(id)) throw new Error(`invalid flow id: ${String(id)}`);
  return path.join(flowsDir(projectPath), `${id}.flow.json`);
}

function runFile(projectPath: string, runId: string): string {
  if (!isSafeFlowId(runId)) throw new Error(`invalid run id: ${String(runId)}`);
  return path.join(runsDir(projectPath), `${runId}.json`);
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8')) as T;
  } catch {
    return null; // missing or corrupt — caller treats as absent
  }
}

// Guard the two shape assumptions the engine and the renderer both rely on:
// an id, and arrays for nodes/edges. A hand-edited file missing them is
// dropped rather than allowed to crash the canvas / scheduler.
function isFlowGraph(v: unknown): v is FlowGraph {
  const g = v as Partial<FlowGraph> | null;
  return (
    !!g && isSafeFlowId(g.id) && Array.isArray(g.nodes) && Array.isArray(g.edges)
  );
}

export async function loadFlows(projectPath: string): Promise<FlowGraph[]> {
  let names: string[];
  try {
    names = await fs.promises.readdir(flowsDir(projectPath));
  } catch {
    return []; // no flows dir yet
  }

  const files = names.filter((n) => n.endsWith('.flow.json'));
  const parsed = await Promise.all(
    files.map((n) => readJson<FlowGraph>(path.join(flowsDir(projectPath), n))),
  );
  return parsed
    .filter(isFlowGraph)
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
}

export async function saveFlow(projectPath: string, graph: FlowGraph): Promise<void> {
  // atomicWriteAsync mkdir's parents, so .devspace/flows need not exist yet.
  await atomicWriteAsync(
    flowFile(projectPath, graph.id),
    JSON.stringify(graph, null, 2),
  );
}

export async function deleteFlow(projectPath: string, id: string): Promise<void> {
  await fs.promises.rm(flowFile(projectPath, id), { force: true });
}

// A run permanently adds one journal file, so prune on write — without a cap a
// long-lived project accumulates thousands and every list pays for all of them.
const RUNS_KEEP = 60;

export async function saveRun(projectPath: string, run: FlowRun): Promise<void> {
  await atomicWriteAsync(runFile(projectPath, run.id), JSON.stringify(run, null, 2));
  await pruneRuns(projectPath).catch(() => undefined);
}

async function pruneRuns(projectPath: string): Promise<void> {
  const dir = runsDir(projectPath);
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return;
  }
  const files = names.filter((n) => n.endsWith('.json'));
  if (files.length <= RUNS_KEEP) return;
  const stated = await statByMtime(dir, files);
  await Promise.all(
    stated.slice(RUNS_KEEP).map(({ name }) =>
      fs.promises.rm(path.join(dir, name), { force: true }),
    ),
  );
}

/** Newest-first by mtime — lets callers pick a tail without parsing every file. */
async function statByMtime(
  dir: string,
  files: string[],
): Promise<Array<{ name: string; mtime: number }>> {
  const stated = await Promise.all(
    files.map(async (name) => ({
      name,
      mtime:
        (await fs.promises.stat(path.join(dir, name)).catch(() => null))
          ?.mtimeMs ?? 0,
    })),
  );
  return stated.sort((a, b) => b.mtime - a.mtime);
}

export async function loadRun(
  projectPath: string,
  runId: string,
): Promise<FlowRun | null> {
  if (!isSafeFlowId(runId)) return null;
  const r = await readJson<FlowRun>(runFile(projectPath, runId));
  return r && typeof r.id === 'string' && Array.isArray(r.nodes) ? r : null;
}

/** Most recent runs first — the renderer only ever shows a short tail, so only
 *  the newest `limit` journals (by mtime) are parsed at all. */
export async function loadRecentRuns(
  projectPath: string,
  limit = 20,
): Promise<FlowRun[]> {
  let names: string[];
  try {
    names = await fs.promises.readdir(runsDir(projectPath));
  } catch {
    return [];
  }

  const newest = (
    await statByMtime(runsDir(projectPath), names.filter((n) => n.endsWith('.json')))
  ).slice(0, limit);
  const parsed = await Promise.all(
    newest.map(({ name }) => readJson<FlowRun>(path.join(runsDir(projectPath), name))),
  );
  return parsed
    .filter((r): r is FlowRun => !!r && typeof r.id === 'string' && Array.isArray(r.nodes))
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}
