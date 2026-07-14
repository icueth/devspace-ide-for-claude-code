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

function flowFile(projectPath: string, id: string): string {
  return path.join(flowsDir(projectPath), `${id}.flow.json`);
}

function runFile(projectPath: string, runId: string): string {
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
    !!g &&
    typeof g.id === 'string' &&
    g.id.length > 0 &&
    Array.isArray(g.nodes) &&
    Array.isArray(g.edges)
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

export async function saveRun(projectPath: string, run: FlowRun): Promise<void> {
  await atomicWriteAsync(runFile(projectPath, run.id), JSON.stringify(run, null, 2));
}

export async function loadRun(
  projectPath: string,
  runId: string,
): Promise<FlowRun | null> {
  const r = await readJson<FlowRun>(runFile(projectPath, runId));
  return r && typeof r.id === 'string' && Array.isArray(r.nodes) ? r : null;
}

/** Most recent runs first — the renderer only ever shows a short tail. */
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

  const parsed = await Promise.all(
    names
      .filter((n) => n.endsWith('.json'))
      .map((n) => readJson<FlowRun>(path.join(runsDir(projectPath), n))),
  );
  return parsed
    .filter((r): r is FlowRun => !!r && typeof r.id === 'string' && Array.isArray(r.nodes))
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
    .slice(0, limit);
}
