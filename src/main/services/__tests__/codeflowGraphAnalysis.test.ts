/**
 * Unit tests for the four pure static-analysis helpers exported by
 * CodeflowGraphAnalyzer (Phase 1 / v0.33).
 *
 * All tests use small hand-built node/edge fixtures and run in the vitest
 * node environment (no jsdom, no Electron).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  computeBlast,
  computeCycles,
  computeReachability,
  detectEntryPoints,
} from '@main/services/CodeflowGraphAnalyzer';

// ─── helpers ─────────────────────────────────────────────────────────────────

type Edge = { source: string; target: string };

function edge(source: string, target: string): Edge {
  return { source, target };
}

// ─── computeCycles ───────────────────────────────────────────────────────────

describe('computeCycles', () => {
  it('returns empty for an empty graph', () => {
    expect(computeCycles([], [])).toEqual([]);
  });

  it('returns empty for a simple chain with no cycles', () => {
    const nodes = ['a', 'b', 'c'];
    const edges = [edge('a', 'b'), edge('b', 'c')];
    expect(computeCycles(nodes, edges)).toEqual([]);
  });

  it('detects a 2-node cycle', () => {
    const nodes = ['a', 'b'];
    const edges = [edge('a', 'b'), edge('b', 'a')];
    const cycles = computeCycles(nodes, edges);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.sort()).toEqual(['a', 'b']);
  });

  it('detects a 3-node SCC', () => {
    const nodes = ['a', 'b', 'c'];
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')];
    const cycles = computeCycles(nodes, edges);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.sort()).toEqual(['a', 'b', 'c']);
  });

  it('detects a self-loop', () => {
    const nodes = ['a', 'b'];
    const edges = [edge('a', 'a')];
    const cycles = computeCycles(nodes, edges);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toEqual(['a']);
  });

  it('handles disconnected nodes (no edges)', () => {
    const nodes = ['x', 'y', 'z'];
    const cycles = computeCycles(nodes, []);
    expect(cycles).toEqual([]);
  });

  it('handles a graph with both a cycle and acyclic nodes', () => {
    const nodes = ['a', 'b', 'c', 'd'];
    // a→b→a is a cycle; c→d is not
    const edges = [edge('a', 'b'), edge('b', 'a'), edge('c', 'd')];
    const cycles = computeCycles(nodes, edges);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.sort()).toEqual(['a', 'b']);
  });

  it('does not include an SCC of size 1 (no cycle)', () => {
    const nodes = ['a', 'b', 'c'];
    const edges = [edge('a', 'b'), edge('a', 'c')];
    const cycles = computeCycles(nodes, edges);
    expect(cycles).toEqual([]);
  });
});

// ─── detectEntryPoints ───────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspace-graph-live-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('detectEntryPoints', () => {
  it('returns empty for an empty graph', async () => {
    const result = await detectEntryPoints([], [], tmpDir);
    expect(result).toEqual([]);
  });

  it('returns nodes with zero incoming edges', async () => {
    const nodes = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
    const edges = [edge('src/a.ts', 'src/b.ts')];
    const result = await detectEntryPoints(nodes, edges, tmpDir);
    // a and c have zero in-edges; c also is an isolated node
    expect(result).toContain('src/a.ts');
    expect(result).toContain('src/c.ts');
  });

  it('includes convention-based root entry files', async () => {
    const nodes = ['src/index.ts', 'src/utils.ts'];
    const edges = [edge('src/index.ts', 'src/utils.ts')];
    const result = await detectEntryPoints(nodes, edges, tmpDir);
    // src/index.ts matches the convention regex AND has zero in-edges
    expect(result).toContain('src/index.ts');
  });

  it('includes package.json main field if it matches a node', async () => {
    const nodes = ['src/main.ts', 'src/helper.ts'];
    const edges = [edge('src/main.ts', 'src/helper.ts')];
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ main: './src/main.ts' }),
    );
    const result = await detectEntryPoints(nodes, edges, tmpDir);
    expect(result).toContain('src/main.ts');
  });

  it('does not throw if package.json is absent', async () => {
    const nodes = ['a.ts'];
    const result = await detectEntryPoints(nodes, [], tmpDir);
    expect(result).toContain('a.ts');
  });

  it('handles all nodes having incoming edges (none zero-degree)', async () => {
    const nodes = ['a.ts', 'b.ts'];
    const edges = [edge('a.ts', 'b.ts'), edge('b.ts', 'a.ts')];
    // Cycle — no zero-in-degree node; only convention matches could add any
    const result = await detectEntryPoints(nodes, edges, tmpDir);
    // Neither matches the convention regex or package.json — could be empty
    // (just verifies no throw)
    expect(Array.isArray(result)).toBe(true);
  });
});

// ─── computeReachability ─────────────────────────────────────────────────────

describe('computeReachability', () => {
  it('returns empty set for empty graph', () => {
    const reached = computeReachability([], [], []);
    expect(reached.size).toBe(0);
  });

  it('marks all nodes reachable in a linear chain from entry', () => {
    const nodes = ['a', 'b', 'c'];
    const edges = [edge('a', 'b'), edge('b', 'c')];
    const reached = computeReachability(nodes, edges, ['a']);
    expect(reached.has('a')).toBe(true);
    expect(reached.has('b')).toBe(true);
    expect(reached.has('c')).toBe(true);
  });

  it('marks disconnected node as NOT reachable', () => {
    const nodes = ['a', 'b', 'dead'];
    const edges = [edge('a', 'b')];
    const reached = computeReachability(nodes, edges, ['a']);
    expect(reached.has('dead')).toBe(false);
  });

  it('handles cycles without infinite loop', () => {
    const nodes = ['a', 'b', 'c'];
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')];
    const reached = computeReachability(nodes, edges, ['a']);
    expect(reached.size).toBe(3);
  });

  it('returns empty when entry points list is empty', () => {
    const nodes = ['a', 'b'];
    const edges = [edge('a', 'b')];
    const reached = computeReachability(nodes, edges, []);
    expect(reached.size).toBe(0);
  });

  it('handles self-loops without infinite loop', () => {
    const nodes = ['a', 'b'];
    const edges = [edge('a', 'a'), edge('a', 'b')];
    const reached = computeReachability(nodes, edges, ['a']);
    expect(reached.has('a')).toBe(true);
    expect(reached.has('b')).toBe(true);
  });
});

// ─── computeBlast ─────────────────────────────────────────────────────────────

describe('computeBlast', () => {
  it('returns empty maps for empty graph', () => {
    const result = computeBlast([], []);
    expect(result.skipped).toBe(false);
    expect(result.blastIn.size).toBe(0);
    expect(result.blastOut.size).toBe(0);
  });

  it('computes blastOut and blastIn for a simple chain a→b→c', () => {
    const nodes = ['a', 'b', 'c'];
    const edges = [edge('a', 'b'), edge('b', 'c')];
    const result = computeBlast(nodes, edges);
    expect(result.skipped).toBe(false);
    // a can reach b and c → blastOut=2
    expect(result.blastOut.get('a')).toBe(2);
    // b can reach c → blastOut=1
    expect(result.blastOut.get('b')).toBe(1);
    // c reaches nobody → blastOut=0
    expect(result.blastOut.get('c')).toBe(0);
    // c is depended on by a and b → blastIn=2
    expect(result.blastIn.get('c')).toBe(2);
    // b is depended on by a → blastIn=1
    expect(result.blastIn.get('b')).toBe(1);
    // a has no dependents → blastIn=0
    expect(result.blastIn.get('a')).toBe(0);
  });

  it('handles a 2-node cycle', () => {
    const nodes = ['a', 'b'];
    const edges = [edge('a', 'b'), edge('b', 'a')];
    const result = computeBlast(nodes, edges);
    expect(result.skipped).toBe(false);
    // Both are in the same SCC; each can reach the other → blastOut=1, blastIn=1
    expect(result.blastOut.get('a')).toBe(1);
    expect(result.blastOut.get('b')).toBe(1);
    expect(result.blastIn.get('a')).toBe(1);
    expect(result.blastIn.get('b')).toBe(1);
  });

  it('handles disconnected nodes (blastOut=0, blastIn=0)', () => {
    const nodes = ['x', 'y'];
    const result = computeBlast(nodes, []);
    expect(result.skipped).toBe(false);
    expect(result.blastOut.get('x')).toBe(0);
    expect(result.blastIn.get('x')).toBe(0);
    expect(result.blastOut.get('y')).toBe(0);
    expect(result.blastIn.get('y')).toBe(0);
  });

  it('returns skipped=true when nodeIds.length > 1500 (blast cap)', () => {
    // Build a list just over the cap — no need for real edges.
    const nodes = Array.from({ length: 1501 }, (_, i) => `node_${i}`);
    const result = computeBlast(nodes, []);
    expect(result.skipped).toBe(true);
    expect(result.blastIn.size).toBe(0);
    expect(result.blastOut.size).toBe(0);
  });

  it('returns skipped=false when nodeIds.length === 1500 (exactly at cap)', () => {
    const nodes = Array.from({ length: 1500 }, (_, i) => `node_${i}`);
    const result = computeBlast(nodes, []);
    expect(result.skipped).toBe(false);
  });

  it('handles a 3-node SCC with a tail: a→b→c→b', () => {
    const nodes = ['a', 'b', 'c'];
    // a→b, b→c, c→b (b and c form a cycle; a is a predecessor)
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'b')];
    const result = computeBlast(nodes, edges);
    expect(result.skipped).toBe(false);
    // a reaches b and c → blastOut=2
    expect(result.blastOut.get('a')).toBe(2);
    // b and c are in an SCC; each reaches the other → blastOut=1
    expect(result.blastOut.get('b')).toBe(1);
    expect(result.blastOut.get('c')).toBe(1);
    // b and c are dependents of a → blastIn includes a, plus each other
    // a → blastIn=0 (nobody depends on a)
    expect(result.blastIn.get('a')).toBe(0);
  });

  it('handles self-loops (same SCC as the node itself)', () => {
    const nodes = ['a'];
    const edges = [edge('a', 'a')];
    const result = computeBlast(nodes, edges);
    expect(result.skipped).toBe(false);
    // Self-loop: SCC of size 1 (self-edges excluded from adj).
    // No outgoing to other nodes → blastOut=0, blastIn=0.
    expect(result.blastOut.get('a')).toBe(0);
    expect(result.blastIn.get('a')).toBe(0);
  });
});
