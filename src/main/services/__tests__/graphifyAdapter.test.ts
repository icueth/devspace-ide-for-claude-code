import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { adaptFunctionGraph, type GraphifyGraph } from '../graphifyAdapter';

// Real graph.json produced by the bundled binary on src/main/utils.
const fixture = JSON.parse(
  fs.readFileSync(
    path.resolve('tests/fixtures/graphify-graph/src-main-utils.graph.json'),
    'utf8',
  ),
) as GraphifyGraph;

describe('adaptFunctionGraph (real graphify output)', () => {
  const out = adaptFunctionGraph(fixture, 5);

  it('produces nodes with the codeflow id convention + parsed line + layer', () => {
    expect(out.nodes.length).toBeGreaterThan(0);
    for (const n of out.nodes) {
      expect(n.id).toBe(`${n.file}::${n.name}:${n.line}`);
      expect(n.file.includes('\\')).toBe(false); // forward slashes only
      expect(Number.isInteger(n.line)).toBe(true);
      expect(n.layer).toBeTruthy();
      expect(n.kind).toBe('function');
    }
  });

  it('drops external stubs (graphify nodes without a source_file)', () => {
    const withSource = fixture.nodes.filter((n) => n.source_file).length;
    // node count never exceeds the symbols that carry a source_file
    expect(out.nodes.length).toBeLessThanOrEqual(withSource);
  });

  it('keeps only call-like edges, remapped onto existing node ids', () => {
    const ids = new Set(out.nodes.map((n) => n.id));
    for (const e of out.edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
      expect(e.source).not.toBe(e.target);
      expect(e.count).toBeGreaterThanOrEqual(1);
      expect(['high', 'low']).toContain(e.confidence);
    }
  });

  it('degree equals the number of incident edge endpoints', () => {
    const deg = new Map<string, number>();
    for (const e of out.edges) {
      deg.set(e.source, (deg.get(e.source) ?? 0) + 1);
      deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
    }
    for (const n of out.nodes) {
      expect(n.degree).toBe(deg.get(n.id) ?? 0);
    }
  });

  it('reports internally consistent stats', () => {
    expect(out.stats.totalFunctions).toBe(out.nodes.length);
    expect(out.stats.totalEdges).toBe(out.edges.length);
    expect(out.stats.callsResolved).toBeLessThanOrEqual(out.stats.callsSeen);
    expect(out.stats.confidence.high + out.stats.confidence.low).toBe(out.edges.length);
  });

  it('handles the "links" key as an alias for "edges"', () => {
    const viaLinks = adaptFunctionGraph({ nodes: fixture.nodes, links: fixture.edges });
    expect(viaLinks.stats.totalEdges).toBe(out.stats.totalEdges);
  });
});
