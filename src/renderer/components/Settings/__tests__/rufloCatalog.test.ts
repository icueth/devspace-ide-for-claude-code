import { describe, expect, it } from 'vitest';

import { RUFLO_CATALOG, type RufloCatalogCategory } from '@shared/ruflo';

/**
 * Catalog invariants. The Ruflo tab depends on this constant for its
 * recommended grid + full plugin list; changing it without a deliberate
 * intent should break this test. Phase 2 ships 15 entries with exactly
 * 4 flagged as recommended.
 */
describe('RUFLO_CATALOG', () => {
  it('has exactly 15 entries', () => {
    expect(RUFLO_CATALOG).toHaveLength(15);
  });

  it('flags exactly 4 entries as recommended', () => {
    const recommended = RUFLO_CATALOG.filter((e) => e.recommended);
    expect(recommended).toHaveLength(4);
  });

  it('includes the four recommended core/swarm/rag-memory/goals plugins', () => {
    const names = new Set(
      RUFLO_CATALOG.filter((e) => e.recommended).map((e) => e.name),
    );
    expect(names).toEqual(
      new Set([
        'ruflo-core',
        'ruflo-swarm',
        'ruflo-rag-memory',
        'ruflo-goals',
      ]),
    );
  });

  it('exposes name / label / description / category on every entry', () => {
    for (const entry of RUFLO_CATALOG) {
      expect(typeof entry.name).toBe('string');
      expect(entry.name.length).toBeGreaterThan(0);
      expect(typeof entry.label).toBe('string');
      expect(entry.label.length).toBeGreaterThan(0);
      expect(typeof entry.description).toBe('string');
      expect(entry.description.length).toBeGreaterThan(0);
      expect(typeof entry.category).toBe('string');
      expect(typeof entry.recommended).toBe('boolean');
    }
  });

  it('uses only the canonical category union', () => {
    const allowed: RufloCatalogCategory[] = [
      'core',
      'memory',
      'intelligence',
      'goals',
      'testing',
      'security',
      'devops',
    ];
    for (const entry of RUFLO_CATALOG) {
      expect(allowed).toContain(entry.category);
    }
  });

  it('keeps every plugin name unique', () => {
    const names = RUFLO_CATALOG.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('names every plugin with the ruflo- prefix so install commands work', () => {
    for (const entry of RUFLO_CATALOG) {
      // `claude plugin install <name>@ruflo` only resolves when the slug
      // matches the marketplace's published name — ruflo-* by convention.
      expect(entry.name.startsWith('ruflo-')).toBe(true);
    }
  });

  it('keeps every description under ~120 chars so cards stay compact', () => {
    for (const entry of RUFLO_CATALOG) {
      expect(entry.description.length).toBeLessThanOrEqual(120);
    }
  });
});
