/**
 * blastHelpers.ts — pure BFS helpers for blast-radius interactive tracing.
 *
 * These run in the renderer (no d3, no React) and are unit-tested in node env.
 * They work on any CodeflowGraphEdge-compatible shape that has source/target
 * string fields, so they stay decoupled from the SimEdge d3 mutated type.
 */

export interface BlastEdge {
  source: string;
  target: string;
}

/**
 * Transitive dependents of `nodeId` — the set of nodes that (directly or
 * transitively) depend ON this file. Equivalently: follow INCOMING edges
 * breadth-first. If file A is changed, every node in this set is affected.
 *
 * Result excludes `nodeId` itself.
 * Terminates on cycles (visited set prevents infinite loops).
 */
export function transitiveDependents(nodeId: string, edges: BlastEdge[]): Set<string> {
  // Build reverse-adjacency: target → sources (who imports target)
  const reverseAdj = new Map<string, string[]>();
  for (const e of edges) {
    const { source, target } = e;
    let arr = reverseAdj.get(target);
    if (!arr) {
      arr = [];
      reverseAdj.set(target, arr);
    }
    arr.push(source);
  }
  return bfs(nodeId, reverseAdj);
}

/**
 * Transitive dependencies of `nodeId` — the set of nodes this file pulls in
 * (directly or transitively). Equivalently: follow OUTGOING edges BFS.
 *
 * Result excludes `nodeId` itself.
 * Terminates on cycles.
 */
export function transitiveDependencies(nodeId: string, edges: BlastEdge[]): Set<string> {
  // Build forward-adjacency: source → targets (what source imports)
  const forwardAdj = new Map<string, string[]>();
  for (const e of edges) {
    const { source, target } = e;
    let arr = forwardAdj.get(source);
    if (!arr) {
      arr = [];
      forwardAdj.set(source, arr);
    }
    arr.push(target);
  }
  return bfs(nodeId, forwardAdj);
}

/** Generic BFS that follows an adjacency map. Does NOT include `start`. */
function bfs(start: string, adj: Map<string, string[]>): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [];
  const neighbors = adj.get(start);
  if (neighbors) {
    for (const n of neighbors) {
      if (n !== start && !visited.has(n)) {
        visited.add(n);
        queue.push(n);
      }
    }
  }
  let i = 0;
  while (i < queue.length) {
    const cur = queue[i++];
    const nexts = adj.get(cur);
    if (!nexts) continue;
    for (const n of nexts) {
      if (!visited.has(n) && n !== start) {
        visited.add(n);
        queue.push(n);
      }
    }
  }
  return visited;
}

// ─── Blast color scale ────────────────────────────────────────────────────────
//
// Maps a blastIn value (0 .. maxBlast) to a CSS color string on a
// cool-to-hot sequential scale. Low blast = dim teal, high blast = vivid red.
// Returns the neutral color when value is undefined (blastSkipped or no data).

/** Neutral shade used when blast data is unavailable for a node. */
export const BLAST_NEUTRAL = '#4b5563'; // gray-600-ish

/**
 * Compute a blast-in fill color for a node.
 *
 * @param blastIn   The node's blastIn value (may be undefined).
 * @param maxBlast  The maximum blastIn across all nodes in the graph
 *                  (used to normalize the scale). If 0 every node is neutral.
 * @returns A CSS color string.
 */
export function blastColor(blastIn: number | undefined, maxBlast: number): string {
  if (blastIn === undefined || maxBlast === 0) return BLAST_NEUTRAL;
  // Clamp t to [0, 1]
  const t = Math.max(0, Math.min(1, blastIn / maxBlast));
  return interpolateBlast(t);
}

/**
 * Interpolate along a 4-stop sequential color ramp:
 *   0.0 → #1e3a5f  (deep navy — minimal blast)
 *   0.33 → #2d9e6b (teal-green)
 *   0.66 → #f59e0b (amber)
 *   1.0  → #ef4444  (red — maximum blast)
 *
 * Pure numeric lerp; no d3 dependency.
 */
export function interpolateBlast(t: number): string {
  const stops: [number, [number, number, number]][] = [
    [0.0,  [30,  58,  95]],
    [0.33, [45, 158, 107]],
    [0.66, [245, 158, 11]],
    [1.0,  [239,  68,  68]],
  ];
  // Find bracketing stops
  let lo = stops[0];
  let hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) {
      lo = stops[i];
      hi = stops[i + 1];
      break;
    }
  }
  const span = hi[0] - lo[0];
  const localT = span === 0 ? 0 : (t - lo[0]) / span;
  const r = Math.round(lo[1][0] + (hi[1][0] - lo[1][0]) * localT);
  const g = Math.round(lo[1][1] + (hi[1][1] - lo[1][1]) * localT);
  const b = Math.round(lo[1][2] + (hi[1][2] - lo[1][2]) * localT);
  return `rgb(${r},${g},${b})`;
}
