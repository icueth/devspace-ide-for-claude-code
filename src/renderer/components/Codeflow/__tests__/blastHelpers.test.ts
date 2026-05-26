/**
 * Unit tests for blastHelpers.ts — pure node-env BFS helpers.
 * Run via: npx vitest run src/renderer/components/Codeflow/__tests__/blastHelpers.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  transitiveDependents,
  transitiveDependencies,
  blastColor,
  interpolateBlast,
  BLAST_NEUTRAL,
  type BlastEdge,
} from '../blastHelpers';

// Helper to build a simple edge list
function edges(...pairs: [string, string][]): BlastEdge[] {
  return pairs.map(([source, target]) => ({ source, target }));
}

// ─── transitiveDependents ─────────────────────────────────────────────────────

describe('transitiveDependents', () => {
  it('returns empty set for a node with no incoming edges', () => {
    // A has no incoming edges — nothing imports A
    const e = edges(['A', 'B'], ['B', 'C']);
    expect(transitiveDependents('A', e).size).toBe(0);
  });

  it('returns direct dependents', () => {
    // B → A, C → A  (B and C import A)
    const e = edges(['B', 'A'], ['C', 'A']);
    const result = transitiveDependents('A', e);
    expect(result).toEqual(new Set(['B', 'C']));
  });

  it('follows transitive chain: D→C→B→A, changing A affects B, C, D', () => {
    const e = edges(['B', 'A'], ['C', 'B'], ['D', 'C']);
    const result = transitiveDependents('A', e);
    expect(result).toEqual(new Set(['B', 'C', 'D']));
  });

  it('terminates on cycle (does not infinite-loop)', () => {
    // A←B←C←A cycle, plus D←A
    const e = edges(['B', 'A'], ['C', 'B'], ['A', 'C'], ['D', 'A']);
    // Should not hang; result must include B, C, A (cycle), D
    const result = transitiveDependents('A', e);
    expect(result).toBeInstanceOf(Set);
    // D imports A, so D is a dependent
    expect(result.has('D')).toBe(true);
    // A itself must NOT be in the result (we exclude the start node)
    expect(result.has('A')).toBe(false);
  });

  it('terminates on self-loop', () => {
    const e = edges(['A', 'A'], ['B', 'A']);
    const result = transitiveDependents('A', e);
    // A does not include itself
    expect(result.has('A')).toBe(false);
    expect(result.has('B')).toBe(true);
  });

  it('disconnected node — other edges do not leak in', () => {
    const e = edges(['B', 'C'], ['D', 'E']);
    const result = transitiveDependents('X', e);
    expect(result.size).toBe(0);
  });

  it('returns empty for empty edge list', () => {
    expect(transitiveDependents('A', []).size).toBe(0);
  });
});

// ─── transitiveDependencies ───────────────────────────────────────────────────

describe('transitiveDependencies', () => {
  it('returns empty set for a leaf node (no outgoing edges)', () => {
    const e = edges(['B', 'A'], ['C', 'B']);
    // A has no outgoing edges
    expect(transitiveDependencies('A', e).size).toBe(0);
  });

  it('returns direct dependencies', () => {
    // A → B, A → C
    const e = edges(['A', 'B'], ['A', 'C']);
    const result = transitiveDependencies('A', e);
    expect(result).toEqual(new Set(['B', 'C']));
  });

  it('follows transitive chain: A→B→C→D, A pulls in B, C, D', () => {
    const e = edges(['A', 'B'], ['B', 'C'], ['C', 'D']);
    const result = transitiveDependencies('A', e);
    expect(result).toEqual(new Set(['B', 'C', 'D']));
  });

  it('terminates on cycle (does not infinite-loop)', () => {
    // A→B→C→A cycle
    const e = edges(['A', 'B'], ['B', 'C'], ['C', 'A']);
    const result = transitiveDependencies('A', e);
    expect(result).toBeInstanceOf(Set);
    expect(result.has('B')).toBe(true);
    expect(result.has('C')).toBe(true);
    // A must NOT include itself
    expect(result.has('A')).toBe(false);
  });

  it('terminates on self-loop', () => {
    const e = edges(['A', 'A'], ['A', 'B']);
    const result = transitiveDependencies('A', e);
    expect(result.has('A')).toBe(false);
    expect(result.has('B')).toBe(true);
  });

  it('disconnected node returns empty', () => {
    const e = edges(['B', 'C'], ['D', 'E']);
    expect(transitiveDependencies('X', e).size).toBe(0);
  });

  it('returns empty for empty edge list', () => {
    expect(transitiveDependencies('A', []).size).toBe(0);
  });

  it('two independent chains — only correct chain traversed', () => {
    // A→B→C  and  D→E→F
    const e = edges(['A', 'B'], ['B', 'C'], ['D', 'E'], ['E', 'F']);
    const result = transitiveDependencies('A', e);
    expect(result).toEqual(new Set(['B', 'C']));
    expect(result.has('D')).toBe(false);
    expect(result.has('E')).toBe(false);
    expect(result.has('F')).toBe(false);
  });
});

// ─── blastColor ───────────────────────────────────────────────────────────────

describe('blastColor', () => {
  it('returns BLAST_NEUTRAL when blastIn is undefined', () => {
    expect(blastColor(undefined, 100)).toBe(BLAST_NEUTRAL);
  });

  it('returns BLAST_NEUTRAL when maxBlast is 0', () => {
    expect(blastColor(0, 0)).toBe(BLAST_NEUTRAL);
    expect(blastColor(5, 0)).toBe(BLAST_NEUTRAL);
  });

  it('returns a non-neutral color for a defined blastIn with positive maxBlast', () => {
    const c = blastColor(50, 100);
    expect(c).not.toBe(BLAST_NEUTRAL);
    expect(c.startsWith('rgb(')).toBe(true);
  });

  it('color for blastIn=0 is different from blastIn=maxBlast', () => {
    const low = blastColor(0, 100);
    const high = blastColor(100, 100);
    expect(low).not.toBe(high);
  });

  it('clamps values above maxBlast', () => {
    const capped = blastColor(200, 100);
    const at100 = blastColor(100, 100);
    expect(capped).toBe(at100);
  });
});

// ─── interpolateBlast ─────────────────────────────────────────────────────────

describe('interpolateBlast', () => {
  it('returns a valid rgb string for t=0', () => {
    const c = interpolateBlast(0);
    expect(c).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
  });

  it('returns a valid rgb string for t=1', () => {
    const c = interpolateBlast(1);
    expect(c).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
  });

  it('mid-point t=0.5 produces a color between the endpoints', () => {
    const lo = interpolateBlast(0);
    const hi = interpolateBlast(1);
    const mid = interpolateBlast(0.5);
    // mid should differ from both endpoints
    expect(mid).not.toBe(lo);
    expect(mid).not.toBe(hi);
  });

  it('is monotonically warming — red channel increases with t', () => {
    const parse = (c: string) => c.match(/\d+/g)!.map(Number);
    const r0 = parse(interpolateBlast(0))[0];
    const r1 = parse(interpolateBlast(1))[0];
    // hot end should have more red
    expect(r1).toBeGreaterThan(r0);
  });
});
