// Agent Flow — pure graph logic (no fs, no electron, no PTY). Everything the
// engine needs to decide *what runs next* lives here so it stays unit-testable
// and the stateful parts of FlowService can be read as plumbing only.
//
// Phase 2 adds two non-agent node kinds:
//   gate  an LLM judge (`claude -p`) that answers PASS / FAIL on the node's
//         `condition`. Pass-branch edges proceed; fail-branch edges re-queue
//         their target — that IS the retry loop, so a fail edge is exempt from
//         the cycle check and from readiness entirely.
//   note  a canvas annotation. Never executed, may not carry edges.

import type {
  FlowEdge,
  FlowGraph,
  FlowNode,
  FlowNodeKind,
  FlowNodeStatus,
} from '@shared/flowTypes';

export type StatusById = Record<string, FlowNodeStatus>;
export type Verdict = 'pass' | 'fail';
export type VerdictById = Record<string, Verdict | undefined>;

/** A gate's fail branch may re-queue its target this many times by default. */
export const DEFAULT_MAX_RETRIES = 3;

/** Phase-1 files carry no `kind` — an absent kind IS an agent (contract). */
export function kindOf(n: FlowNode): FlowNodeKind {
  return n.kind ?? 'agent';
}

export function maxRetriesOf(n: FlowNode): number {
  const m = n.maxRetries;
  return typeof m === 'number' && Number.isFinite(m) && m > 0
    ? Math.floor(m)
    : DEFAULT_MAX_RETRIES;
}

const isFail = (e: FlowEdge): boolean => e.branch === 'fail';

/**
 * Structural validation of a user-drawn graph. Returns human-readable errors
 * (empty = valid) — the control socket relays them verbatim to the chat agent,
 * so they are phrased for a reader, not a parser.
 *
 * Rejects anything the engine could not schedule: no nodes, duplicate ids,
 * edges pointing at nothing, cycles (Kahn — over the non-fail edges only, since
 * a backward fail edge is a legal retry loop), headless nodes on a non-claude
 * CLI (only `claude -p` gives us captured stdout + a deterministic exit), a gate
 * with nothing to judge, a branch on a non-gate edge, a fail edge that points at
 * something that cannot re-run, and any edge touching a note.
 */
export function validateGraph(g: FlowGraph): string[] {
  const errors: string[] = [];
  const nodes = g.nodes ?? [];
  const edges = g.edges ?? [];

  if (nodes.length === 0) return ['flow has no nodes'];

  const ids = new Set<string>();
  const byId = new Map<string, FlowNode>();
  for (const n of nodes) {
    if (!n.id) {
      errors.push('a node has an empty id');
      continue;
    }
    if (ids.has(n.id)) errors.push(`duplicate node id: ${n.id}`);
    ids.add(n.id);
    byId.set(n.id, n);

    const kind = kindOf(n);
    // The headless⇒claude rule is about the node's OWN agent process. A gate has
    // no agent (the engine runs the judge itself) and a note never runs, so the
    // rule — and the whole cliId/mode pair — is meaningless for them.
    if (kind === 'agent' && n.mode === 'headless' && n.cliId !== 'claude') {
      errors.push(
        `node "${n.role || n.id}" is headless but uses ${n.cliId} — headless nodes must use claude (only \`claude -p\` returns captured output)`,
      );
    }
    if (kind === 'gate' && !(n.condition ?? '').trim()) {
      errors.push(
        `gate "${n.role || n.id}" has no condition — a gate must say what it judges`,
      );
    }
  }

  for (const e of edges) {
    if (!ids.has(e.from)) errors.push(`edge from unknown node: ${e.from}`);
    if (!ids.has(e.to)) errors.push(`edge to unknown node: ${e.to}`);

    const from = byId.get(e.from);
    const to = byId.get(e.to);
    for (const n of [from, to]) {
      if (n && kindOf(n) === 'note') {
        errors.push(
          `note "${n.role || n.id}" may not carry edges — a note is an annotation, not a step`,
        );
      }
    }
    if (e.branch && from && kindOf(from) !== 'gate') {
      errors.push(
        `edge ${e.from} → ${e.to} is marked "${e.branch}" but ${e.from} is not a gate — only a gate's edges branch`,
      );
    }
    // A fail edge re-queues its target, so the target must be something that can
    // be re-run: an agent. Pointing it at a gate would re-judge without redoing
    // the work (an infinite loop); at a note, nothing at all.
    if (isFail(e) && to && kindOf(to) !== 'agent') {
      errors.push(
        `fail edge ${e.from} → ${e.to} must target an agent node — a retry re-runs work, and only agents do work`,
      );
    }
  }

  // Kahn over the well-formed, non-fail subset. Dangling edges are already
  // reported and would otherwise corrupt the indegree count into a phantom
  // "cycle"; fail edges are excluded because a backward fail edge is exactly
  // what a retry loop looks like — it is legal by construction.
  const clean = edges.filter(
    (e) => ids.has(e.from) && ids.has(e.to) && !isFail(e),
  );
  const indeg = new Map<string, number>();
  for (const id of ids) indeg.set(id, 0);
  for (const e of clean) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);

  const queue = [...ids].filter((id) => (indeg.get(id) ?? 0) === 0);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift() as string;
    visited++;
    for (const e of clean.filter((x) => x.from === id)) {
      const next = (indeg.get(e.to) ?? 0) - 1;
      indeg.set(e.to, next);
      if (next === 0) queue.push(e.to);
    }
  }
  if (visited < ids.size) errors.push('flow has a cycle — edges must form a DAG');

  return [...new Set(errors)]; // a note with two edges reports its rule once
}

/**
 * Direct upstream node ids of `nodeId` (its edge sources) — INCLUDING a gate
 * that fail-edges into it. That is deliberate: on a retry the re-queued node
 * receives the gate's verdict text as handoff context, so it knows what it is
 * being asked to fix. Readiness deliberately does NOT use this (see readyNodes).
 */
export function upstreamOf(g: FlowGraph, nodeId: string): string[] {
  return (g.edges ?? []).filter((e) => e.to === nodeId).map((e) => e.from);
}

/**
 * Nodes that may start *now*: still queued, and every gating upstream is done.
 * Fan-in falls out of the "every" — a node with two parents waits for both.
 *
 * Two phase-2 rules:
 *   • A fail edge NEVER gates readiness. It is a retry trigger, not a
 *     dependency — if it counted, the loop body could never start (its gate has
 *     not run yet) and the graph would deadlock on its own retry path.
 *   • An edge leaving a gate (branch 'pass' or undefined) additionally requires
 *     the gate's verdict to be 'pass'. A gate that judged FAIL is done-but-not-
 *     passed; its downstream must not proceed.
 *
 * Notes are never scheduled.
 */
export function readyNodes(
  g: FlowGraph,
  statusById: StatusById,
  verdictById: VerdictById = {},
): string[] {
  const byId = new Map((g.nodes ?? []).map((n) => [n.id, n]));
  const satisfied = (e: FlowEdge): boolean => {
    if (statusById[e.from] !== 'done') return false;
    const from = byId.get(e.from);
    if (from && kindOf(from) === 'gate') return verdictById[e.from] === 'pass';
    return true;
  };

  return (g.nodes ?? [])
    .filter((n) => kindOf(n) !== 'note')
    .filter((n) => statusById[n.id] === 'queued')
    .filter((n) =>
      (g.edges ?? [])
        .filter((e) => e.to === n.id && !isFail(e))
        .every(satisfied),
    )
    .map((n) => n.id);
}

/** The nodes a gate's fail branch re-queues (its fail-edge targets). */
export function retryTargets(g: FlowGraph, gateId: string): string[] {
  return (g.edges ?? [])
    .filter((e) => e.from === gateId && isFail(e))
    .map((e) => e.to);
}

/**
 * The status map after a gate's FAIL verdict: every node in the loop body goes
 * back to 'queued' so the tick re-launches it.
 *
 * The body is found by BFS from each fail-edge target, walking forward along
 * non-fail edges — i.e. everything downstream of the retry entry point that fed
 * the gate its (rejected) evidence. The walk never crosses the gate itself: the
 * gate re-evaluates on its own (FlowService re-queues it), and anything past the
 * gate's pass branch was never reached anyway.
 *
 * Only done/failed nodes flip. A node still 'running' (a slow fan-out sibling)
 * is left alone — it is already producing the next attempt's evidence.
 */
export function resetForRetry(
  g: FlowGraph,
  gateId: string,
  statusById: StatusById,
): StatusById {
  const out: StatusById = { ...statusById };
  const seen = new Set<string>();
  const queue = retryTargets(g, gateId).filter((id) => id !== gateId);

  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (id === gateId || seen.has(id)) continue;
    seen.add(id);

    const s = out[id];
    if (s === 'done' || s === 'failed') out[id] = 'queued';

    for (const e of g.edges ?? []) {
      if (e.from !== id || isFail(e)) continue;
      if (e.to === gateId || seen.has(e.to)) continue;
      queue.push(e.to);
    }
  }
  return out;
}

/**
 * Final status map for a run that is terminating (a node failed, or the user
 * stopped it): every still-queued node becomes 'skipped' — it was never
 * reached and never will be. This covers the failed⇒downstream case (a failed
 * node's children can never satisfy readyNodes) and the sibling branch that
 * simply never got its turn; both are honestly "skipped", not "queued forever".
 * Running / terminal statuses are left untouched — the caller owns those.
 */
export function finishStatuses(g: FlowGraph, statusById: StatusById): StatusById {
  const out: StatusById = { ...statusById };
  for (const n of g.nodes ?? []) {
    if (out[n.id] === 'queued') out[n.id] = 'skipped';
  }
  return out;
}

/**
 * The brief handed to a node's agent: the run's kickoff task, the node's own
 * role brief, and every upstream node's captured output as context. Upstream
 * outputs are the only channel between nodes (edges = handoffs), so an empty
 * upstream list means this is an entry node working straight from the task.
 */
export function composeNodePrompt(
  task: string,
  node: FlowNode,
  upstreamOutputs: Array<{ role: string; output: string }>,
): string {
  const parts: string[] = [
    `You are the "${node.role}" step of a multi-agent flow.`,
    '',
    '## Overall task',
    task.trim(),
    '',
    '## Your role',
    (node.rolePrompt || `Act as the ${node.role}.`).trim(),
  ];

  const withOutput = upstreamOutputs.filter((u) => (u.output ?? '').trim().length > 0);
  if (withOutput.length > 0) {
    parts.push('', '## Handoff from upstream steps');
    for (const u of withOutput) {
      parts.push('', `### ${u.role}`, u.output.trim());
    }
  }

  parts.push(
    '',
    '## Output',
    'Do the work, then end with a concise summary of what you produced — the next step in the flow receives only that summary as context.',
  );

  return parts.join('\n');
}

/**
 * The brief handed to a gate's judge. The verdict has to be machine-readable —
 * the whole branch hangs off it — so the format demand is blunt and first-line
 * (see parseGateVerdict). The reason line is not decoration: on a FAIL it
 * becomes the retry brief handed to the re-queued nodes.
 */
export function composeGatePrompt(
  condition: string,
  upstreamOutputs: Array<{ role: string; output: string }>,
): string {
  const parts: string[] = [
    'You are a quality gate in a multi-agent flow. You do NOT do the work — you judge the work that was just done, strictly and literally.',
    '',
    '## Condition to judge',
    (condition || '').trim(),
    '',
    '## Evidence (output of the preceding steps)',
  ];

  const withOutput = upstreamOutputs.filter((u) => (u.output ?? '').trim().length > 0);
  if (withOutput.length === 0) {
    parts.push('', '(the preceding steps produced no output)');
  } else {
    for (const u of withOutput) {
      parts.push('', `### ${u.role}`, u.output.trim());
    }
  }

  parts.push(
    '',
    '## Answer format — this is parsed by a machine',
    'Your FIRST line must be exactly one word: PASS or FAIL.',
    'PASS only if the evidence clearly satisfies the condition. If it is unclear, unproven, or the evidence does not actually show it, answer FAIL.',
    'Then, on the following lines, state briefly WHY — and on a FAIL, exactly what must be fixed. That text is handed to the agents who will retry the work.',
  );

  return parts.join('\n');
}

/**
 * The judge's verdict, read from the first non-empty line of its output: the
 * first PASS/FAIL token wins. Anything else is `null` — an unparseable verdict
 * is NOT a silent pass or a silent retry, it fails the gate node (and so the
 * run), because we cannot know which branch the user's flow should take.
 */
export function parseGateVerdict(text: string): Verdict | null {
  const first = (text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first) return null;

  const m = /\b(PASS|FAIL)\b/i.exec(first);
  if (!m) return null;
  return m[1].toLowerCase() === 'pass' ? 'pass' : 'fail';
}
