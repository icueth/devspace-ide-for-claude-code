// Agent Flow — gate nodes (phase 2).
//
// A gate is not a CLI agent: it is an LLM judge the engine runs itself. One
// `claude -p` turn receives the upstream outputs plus the gate's `condition` and
// must answer PASS or FAIL on its first line (composeGatePrompt/parseGateVerdict).
//
//   PASS  → the gate completes with verdict 'pass'; its pass-branch edges become
//           ready (readyNodes requires done AND verdict pass).
//   FAIL  → the fail-branch subgraph is re-queued and the work is redone, up to
//           the gate's retry budget (maxRetries, default 3). Budget spent ⇒ the
//           gate fails, which fails the run (phase-1 semantics: only a gate's
//           verdict routes; a failure is still a failure).
//
// DESIGN — why a failing gate goes back to 'queued' and not 'done':
// readyNodes only ever launches QUEUED nodes. A gate parked at 'done' would
// never be re-evaluated once its loop body re-ran, so the run would sit forever
// with a queued pass-branch that can never become ready — a hang, not a retry.
// Re-queuing the gate makes the second evaluation fall straight out of the
// ordinary scheduler: the re-queued body runs, the gate's upstream is 'done'
// again, and the gate is simply ready once more. The previous verdict stays on
// the node run (the canvas can show it) until the next evaluation overwrites it.
//
// The judge's FAIL text is not thrown away either — it is written to the gate's
// `output`, and upstreamOf() deliberately keeps fail edges, so every re-queued
// node receives "here is what the gate rejected and why" as handoff context.

import {
  startClaudePrintIn,
  type FlowExecHandle,
  type FlowExecResult,
} from '@main/services/flowExec';
import {
  composeGatePrompt,
  maxRetriesOf,
  parseGateVerdict,
  resetForRetry,
  retryTargets,
  type StatusById,
} from '@main/services/flowScheduler';
import { OUTPUT_CAP } from '@main/services/flowSessions';
import type { FlowGraph, FlowNode, FlowNodeRun } from '@shared/flowTypes';
import { createLogger } from '@shared/logger';

const logger = createLogger('FlowGates');

/** Run the judge for `node` in the project cwd. Same exec path as a headless node. */
export function startGateEval(
  cwd: string,
  node: FlowNode,
  upstreamOutputs: Array<{ role: string; output: string }>,
  envPairs: string[],
): Promise<FlowExecHandle> {
  return startClaudePrintIn(
    cwd,
    composeGatePrompt(node.condition ?? '', upstreamOutputs),
    envPairs,
    node.model,
  );
}

/**
 * The slice of the live run that a gate verdict may touch. FlowService owns the
 * state; this module owns the decision, so the retry semantics stay testable
 * without a PTY, a socket or a clock.
 */
export interface GateHooks {
  nodeRun(nodeId: string): FlowNodeRun | undefined;
  setNode(nodeId: string, patch: Partial<FlowNodeRun>): void;
  statusMap(): StatusById;
  applyStatuses(next: StatusById): void;
  /** Drop per-launch bookkeeping (starting-guard, exec handle, PTY watcher). */
  reopen(nodeIds: string[]): void;
  commit(): void;
  completeNode(nodeId: string, output: string): void;
  failNode(nodeId: string, error: string): void;
}

const firstLine = (s: string): string =>
  s.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';

/** The reason a FAIL gives, minus the verdict token itself. */
function failReason(text: string): string {
  const rest = text.split('\n').slice(1).join(' ').trim();
  const reason = rest || firstLine(text);
  return reason.slice(0, 200) || 'no reason given';
}

/**
 * Apply a finished gate evaluation to the run. Exactly one of complete / fail /
 * retry happens; `commit()` is called by whichever path ends here.
 */
export function applyGateResult(
  graph: FlowGraph,
  node: FlowNode,
  res: FlowExecResult,
  h: GateHooks,
): void {
  if (!res.ok) {
    h.failNode(node.id, res.error ?? 'gate evaluation failed');
    return;
  }

  const text = (res.text ?? '').trim();
  const verdict = parseGateVerdict(text);
  if (!verdict) {
    // Unparseable is NOT a silent pass and NOT a silent retry — we cannot know
    // which branch of the user's flow to take, so the gate fails loudly.
    h.failNode(
      node.id,
      `gate judge did not answer PASS or FAIL (got: ${firstLine(text).slice(0, 80) || 'empty output'})`,
    );
    return;
  }

  if (verdict === 'pass') {
    h.setNode(node.id, { verdict: 'pass' });
    h.completeNode(node.id, text);
    return;
  }

  // ── FAIL ────────────────────────────────────────────────────────────────
  // Record the verdict + the judge's reasoning first: it is the retry brief the
  // re-queued nodes read as upstream context.
  h.setNode(node.id, { verdict: 'fail', output: text.slice(-OUTPUT_CAP) });

  const targets = retryTargets(graph, node.id);
  if (targets.length === 0) {
    h.failNode(node.id, `condition failed: ${failReason(text)}`);
    return;
  }

  // attempts is bumped at launch, so it counts evaluations: the first FAIL has
  // attempts === 1 and has used zero retries.
  const max = maxRetriesOf(node);
  const used = (h.nodeRun(node.id)?.attempts ?? 1) - 1;
  if (used >= max) {
    h.failNode(
      node.id,
      `condition failed after ${max} ${max === 1 ? 'retry' : 'retries'}: ${failReason(text)}`,
    );
    return;
  }

  const before = h.statusMap();
  const next = resetForRetry(graph, node.id, before);
  const requeued = Object.keys(next).filter((id) => next[id] !== before[id]);

  // The gate itself re-evaluates once the body has re-run (see DESIGN above).
  next[node.id] = 'queued';
  h.applyStatuses(next);
  h.setNode(node.id, { status: 'queued', endedAt: undefined, error: undefined });

  // A re-queued node starts clean: its previous attempt's output must not leak
  // into the next node's handoff (or, for an interactive node, get appended to).
  // sessionKey is deliberately kept — an interactive node's tmux session is
  // still there, and the relaunch re-briefs it rather than spawning a twin.
  for (const id of requeued) {
    h.setNode(id, {
      output: undefined,
      error: undefined,
      endedAt: undefined,
      verdict: undefined,
    });
  }
  h.reopen([node.id, ...requeued]);

  logger.info(
    `gate "${node.role || node.id}" → FAIL (retry ${used + 1}/${max}) — re-queued: ${requeued.join(', ') || '(none)'}`,
  );
  h.commit();
}
