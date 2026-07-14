import { create } from 'zustand';

import { useFlowsStore } from '@renderer/state/flows';
import type { FlowGraph, FlowRun } from '@shared/flowTypes';

/**
 * Run events — the timeline the chat panel shows as centered chips and the run
 * log strip shows as `[tag]` lines.
 *
 * Main pushes a whole FlowRun SNAPSHOT on every transition (FLOW_CHANGED), not
 * a delta — so "researcher finished" exists nowhere on the wire. We reconstruct
 * it here by diffing each snapshot against the last one we saw and accumulating
 * the transitions. That keeps main's contract dumb (one idempotent payload) and
 * lets a reload rebuild the timeline from the run journal alone.
 *
 * Dedup is by a content-addressed event id, so re-pushing the same snapshot
 * (echo, reconnect, resubscribe) can never double a chip.
 */

export type FlowEventKind =
  | 'run-started'
  | 'node-started'
  | 'node-done'
  | 'node-failed'
  | 'node-retry'
  | 'gate-pass'
  | 'gate-fail'
  | 'run-done'
  | 'run-failed'
  | 'run-stopped';

export interface FlowRunEvent {
  id: string; // content-addressed — the dedup key
  runId: string;
  flowId: string;
  flowName: string;
  kind: FlowEventKind;
  nodeId?: string;
  text: string; // English copy; the lead answers in the user's language
  at: number;
  // ≈ tokens of the node's captured output. Character-count / 4 — a rough
  // industry rule of thumb, labelled "≈" everywhere it surfaces so nobody
  // mistakes it for a billing number.
  tokens?: number;
}

const MAX_EVENTS = 300;

/** ~tokens for a captured output blob. Deliberately crude — see FlowRunEvent. */
export function approxTokens(output: string | undefined): number | undefined {
  if (!output) return undefined;
  return Math.round(output.length / 4);
}

/** Human label for a node: its role from the graph, else the raw id. */
export function labelsFor(flows: FlowGraph[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of flows) {
    for (const n of f.nodes) out[`${f.id}:${n.id}`] = n.role || n.id;
  }
  return out;
}

/**
 * Diff one run snapshot against the previous one. Pure — `now` is injected so
 * the derivation is deterministic under test.
 */
export function diffRun(
  prev: FlowRun | undefined,
  next: FlowRun,
  labels: Record<string, string>,
  now: number,
): FlowRunEvent[] {
  const out: FlowRunEvent[] = [];
  const label = (nodeId: string): string =>
    labels[`${next.flowId}:${nodeId}`] ?? nodeId;
  const base = (kind: FlowEventKind, id: string, text: string, at: number) => ({
    id: `${next.id}:${id}`,
    runId: next.id,
    flowId: next.flowId,
    flowName: next.flowName,
    kind,
    text,
    at,
  });

  if (!prev) {
    out.push(
      base('run-started', 'run:started', `▶ run started · ${next.flowName}`, next.startedAt),
    );
  }

  const before = new Map(prev?.nodes.map((n) => [n.nodeId, n]) ?? []);
  for (const n of next.nodes) {
    const was = before.get(n.nodeId);
    const name = label(n.nodeId);
    const attempt = n.attempts ?? 1;
    // Attempts are part of the id: a node re-queued by a gate's fail branch
    // legitimately runs → done a SECOND time, and that is a new event, not an
    // echo of the first.
    const key = (k: string): string => `${n.nodeId}:${k}:${attempt}`;

    // A gate's fail branch re-queued this node — announce the retry before the
    // relaunch, so the chip order reads as cause → effect.
    if (was && attempt > (was.attempts ?? 1)) {
      out.push({
        ...base('node-retry', key('retry'), `↻ ${name} · retry ×${attempt}`, n.startedAt ?? now),
        nodeId: n.nodeId,
      });
    }
    if (n.status === was?.status) continue;

    if (n.status === 'running') {
      out.push({
        ...base('node-started', key('running'), `${name} ⚙ running…`, n.startedAt ?? now),
        nodeId: n.nodeId,
      });
    } else if (n.status === 'done') {
      const at = n.endedAt ?? now;
      const tokens = approxTokens(n.output);
      if (n.verdict) {
        // Gates report a verdict, agents don't — that's how we tell them apart
        // without threading the graph in here.
        const pass = n.verdict === 'pass';
        out.push({
          ...base(
            pass ? 'gate-pass' : 'gate-fail',
            key(`verdict-${n.verdict}`),
            `◇ ${name} · ${pass ? 'PASS ✓' : 'FAIL ✗'}`,
            at,
          ),
          nodeId: n.nodeId,
        });
      } else {
        out.push({
          ...base('node-done', key('done'), `${name} ✓ done`, at),
          nodeId: n.nodeId,
          tokens,
        });
      }
    } else if (n.status === 'failed') {
      out.push({
        ...base(
          'node-failed',
          key('failed'),
          `${name} ✗ failed${n.error ? ` · ${n.error}` : ''}`,
          n.endedAt ?? now,
        ),
        nodeId: n.nodeId,
      });
    }
  }

  if (next.status !== prev?.status && next.status !== 'running') {
    const at = next.endedAt ?? now;
    if (next.status === 'done') {
      out.push(base('run-done', 'run:done', `■ run complete · ${next.flowName}`, at));
    } else if (next.status === 'failed') {
      out.push(
        base(
          'run-failed',
          'run:failed',
          `■ run failed${next.error ? ` · ${next.error}` : ''}`,
          at,
        ),
      );
    } else if (next.status === 'stopped') {
      out.push(base('run-stopped', 'run:stopped', `■ run stopped · ${next.flowName}`, at));
    }
  }

  return out.sort((a, b) => a.at - b.at);
}

interface FlowEventsState {
  projectPath: string | null;
  events: FlowRunEvent[];
  /** Fold a fresh runs array into the timeline. Idempotent. */
  ingest: (
    projectPath: string,
    runs: FlowRun[],
    flows: FlowGraph[],
    now?: number,
  ) => void;
  reset: (projectPath: string | null) => void;
}

// Snapshots of the last run state we diffed against, plus the ids we've already
// emitted. Outside the store: bookkeeping, not rendered state — and a re-render
// must never resurrect a chip we already showed.
let lastRuns = new Map<string, FlowRun>();
let seen = new Set<string>();

export const useFlowEventsStore = create<FlowEventsState>((set, get) => ({
  projectPath: null,
  events: [],

  ingest(projectPath, runs, flows, now = Date.now()) {
    // A project switch invalidates every snapshot — runs are project-scoped.
    if (get().projectPath !== projectPath) {
      lastRuns = new Map();
      seen = new Set();
      set({ projectPath, events: [] });
    }
    const labels = labelsFor(flows);
    const fresh: FlowRunEvent[] = [];
    for (const run of runs) {
      for (const e of diffRun(lastRuns.get(run.id), run, labels, now)) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        fresh.push(e);
      }
      lastRuns.set(run.id, run);
    }
    if (fresh.length === 0) return;
    const events = [...get().events, ...fresh].sort((a, b) => a.at - b.at);
    set({ events: events.slice(-MAX_EVENTS) });
  },

  reset(projectPath) {
    lastRuns = new Map();
    seen = new Set();
    set({ projectPath, events: [] });
  },
}));

/** Events belonging to one run — the log strip scopes to the selected flow. */
export function eventsForRun(events: FlowRunEvent[], runId: string | null): FlowRunEvent[] {
  if (!runId) return [];
  return events.filter((e) => e.runId === runId);
}

// Fold every runs push into the timeline. Subscribing to the flows store (not
// to IPC) keeps ONE ingestion point: a run that arrives via the initial
// flows.runs() load produces the same chips as one that arrives via a push.
useFlowsStore.subscribe((s, prev) => {
  if (!s.projectPath) return;
  if (s.runs === prev.runs && s.projectPath === prev.projectPath) return;
  useFlowEventsStore.getState().ingest(s.projectPath, s.runs, s.flows);
});
