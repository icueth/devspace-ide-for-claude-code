// Agent Flow — the in-flight state of one run, and the small accessors the
// engine uses to read and mutate it.
//
// Deliberately NOT persisted: a run does not survive an app restart (phase 1) —
// the journal on disk is the record, the live handles here are the process.
// Split out of FlowService so the engine file reads as scheduling + plumbing,
// and so flowGates can be handed exactly these accessors (GateHooks) instead of
// the whole service.

import type { FlowExecHandle } from '@main/services/flowExec';
import {
  kindOf,
  upstreamOf,
  type StatusById,
  type VerdictById,
} from '@main/services/flowScheduler';
import type { FlowGraph, FlowNodeRun, FlowRun } from '@shared/flowTypes';

export interface LiveRun {
  run: FlowRun;
  graph: FlowGraph;
  timer: ReturnType<typeof setInterval>;
  execs: Map<string, FlowExecHandle>; // headless children + gate judges, for stopRun
  watchers: Map<string, () => void>; // interactive PTY unsubscribes
  firstActivityAt: Map<string, number>; // interactive: when the agent first spoke
  starting: Set<string>; // launch in progress — guards a double-launch across ticks
  // gateId → how many FAIL verdicts THIS gate has returned. The retry budget is
  // spent by a gate's own rejections, not by its launches: an inner gate that a
  // surrounding loop re-ran (and that PASSED every time) has spent nothing, but
  // its FlowNodeRun.attempts counter — which is a *launch* counter, and stays
  // that way for the card badge — has been climbing all along. Reading attempts
  // as the budget (the phase-2 bug) hands a nested gate a budget that shrinks
  // for reasons that have nothing to do with it.
  gateFails: Map<string, number>;
}

export const nodeRun = (lr: LiveRun, nodeId: string): FlowNodeRun | undefined =>
  lr.run.nodes.find((n) => n.nodeId === nodeId);

export const statusMap = (lr: LiveRun): StatusById =>
  Object.fromEntries(lr.run.nodes.map((n) => [n.nodeId, n.status]));

// Gate verdicts — readyNodes needs them: an edge leaving a gate only releases
// its target when that gate is done AND passed.
export const verdictMap = (lr: LiveRun): VerdictById =>
  Object.fromEntries(lr.run.nodes.map((n) => [n.nodeId, n.verdict]));

export const applyStatuses = (lr: LiveRun, statuses: StatusById): void => {
  for (const n of lr.run.nodes) {
    const next = statuses[n.nodeId];
    if (next && next !== n.status) n.status = next;
  }
};

export const setNode = (
  lr: LiveRun,
  nodeId: string,
  patch: Partial<FlowNodeRun>,
): void => {
  const n = nodeRun(lr, nodeId);
  if (!n) return;
  Object.assign(n, patch);
};

/**
 * Context handed to a node: each upstream node's captured output. Nodes only
 * ever see their own upstream — that is what an edge means. A gate that
 * fail-edges into the node counts as upstream too, so a retried node reads the
 * verdict that rejected its last attempt.
 */
export const upstreamOutputs = (
  lr: LiveRun,
  nodeId: string,
): Array<{ role: string; output: string }> =>
  upstreamOf(lr.graph, nodeId).map((upId) => ({
    role: lr.graph.nodes.find((n) => n.id === upId)?.role ?? upId,
    output: nodeRun(lr, upId)?.output ?? '',
  }));

export const gateFails = (lr: LiveRun, gateId: string): number =>
  lr.gateFails.get(gateId) ?? 0;

export const setGateFails = (lr: LiveRun, gateId: string, n: number): void => {
  lr.gateFails.set(gateId, n);
};

/**
 * Undo a node's launch bookkeeping so the scheduler may launch it AGAIN — the
 * gate retry path is the only caller. `starting` in particular is a launch-once
 * guard that is never cleared on success, so without this a re-queued node would
 * be skipped by every subsequent tick and the run would hang instead of retrying.
 *
 * A re-queued GATE also gets a fresh retry budget: an outer loop that resets the
 * body is starting that body's work over, and an inner gate judging it is judging
 * new work. (The gate driving the reset re-asserts its OWN count right after —
 * flowGates — so it does not hand itself an infinite budget by reopening itself.)
 */
export const reopen = (lr: LiveRun, nodeIds: string[]): void => {
  for (const id of nodeIds) {
    lr.starting.delete(id);
    lr.execs.delete(id);
    lr.firstActivityAt.delete(id);
    const node = lr.graph.nodes.find((n) => n.id === id);
    if (node && kindOf(node) === 'gate') lr.gateFails.delete(id);
    const un = lr.watchers.get(id);
    if (un) {
      un();
      lr.watchers.delete(id);
    }
  }
};

export const teardown = (lr: LiveRun): void => {
  clearInterval(lr.timer);
  for (const un of lr.watchers.values()) un();
  lr.watchers.clear();
};
