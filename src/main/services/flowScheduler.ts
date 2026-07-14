// Agent Flow — pure graph logic (no fs, no electron, no PTY). Everything the
// engine needs to decide *what runs next* lives here so it stays unit-testable
// and the stateful parts of FlowService can be read as plumbing only.

import type { FlowGraph, FlowNode, FlowNodeStatus } from '@shared/flowTypes';

export type StatusById = Record<string, FlowNodeStatus>;

/**
 * Structural validation of a user-drawn graph. Returns human-readable errors
 * (empty = valid) — the control socket relays them verbatim to the chat agent,
 * so they are phrased for a reader, not a parser.
 *
 * Rejects anything the engine could not schedule: no nodes, duplicate ids,
 * edges pointing at nothing, cycles (Kahn), and headless nodes on a non-claude
 * CLI (only `claude -p` gives us captured stdout + a deterministic exit).
 */
export function validateGraph(g: FlowGraph): string[] {
  const errors: string[] = [];
  const nodes = g.nodes ?? [];
  const edges = g.edges ?? [];

  if (nodes.length === 0) return ['flow has no nodes'];

  const ids = new Set<string>();
  for (const n of nodes) {
    if (!n.id) {
      errors.push('a node has an empty id');
      continue;
    }
    if (ids.has(n.id)) errors.push(`duplicate node id: ${n.id}`);
    ids.add(n.id);
    if (n.mode === 'headless' && n.cliId !== 'claude') {
      errors.push(
        `node "${n.role || n.id}" is headless but uses ${n.cliId} — headless nodes must use claude (only \`claude -p\` returns captured output)`,
      );
    }
  }

  for (const e of edges) {
    if (!ids.has(e.from)) errors.push(`edge from unknown node: ${e.from}`);
    if (!ids.has(e.to)) errors.push(`edge to unknown node: ${e.to}`);
  }

  // Kahn over the well-formed subset — dangling edges are already reported and
  // would otherwise corrupt the indegree count into a phantom "cycle".
  const clean = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
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

  return errors;
}

/** Direct upstream node ids of `nodeId` (its edge sources). */
export function upstreamOf(g: FlowGraph, nodeId: string): string[] {
  return (g.edges ?? []).filter((e) => e.to === nodeId).map((e) => e.from);
}

/**
 * Nodes that may start *now*: still queued, and every upstream node is done.
 * Fan-in falls out of the "every" — a node with two parents waits for both.
 * Callers launch the whole returned batch concurrently.
 */
export function readyNodes(g: FlowGraph, statusById: StatusById): string[] {
  return (g.nodes ?? [])
    .filter((n) => statusById[n.id] === 'queued')
    .filter((n) => upstreamOf(g, n.id).every((up) => statusById[up] === 'done'))
    .map((n) => n.id);
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
