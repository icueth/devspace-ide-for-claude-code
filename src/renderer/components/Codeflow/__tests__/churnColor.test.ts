/**
 * Unit tests for the churn heatmap helpers in blastHelpers.ts — pure,
 * node-env (no d3 / React). Mirrors the style of blastHelpers.test.ts.
 * Run via: npx vitest run src/renderer/components/Codeflow/__tests__/churnColor.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  churnColor,
  interpolateChurn,
  churnModeAvailable,
  CHURN_NEUTRAL,
} from '../blastHelpers';

// ─── churnColor ─────────────────────────────────────────────────────────────

describe('churnColor', () => {
  it('returns CHURN_NEUTRAL when churn is undefined', () => {
    expect(churnColor(undefined, 100)).toBe(CHURN_NEUTRAL);
  });

  it('returns CHURN_NEUTRAL when churn is 0 (cool / no activity)', () => {
    expect(churnColor(0, 100)).toBe(CHURN_NEUTRAL);
  });

  it('returns CHURN_NEUTRAL when maxChurn is 0', () => {
    expect(churnColor(0, 0)).toBe(CHURN_NEUTRAL);
    expect(churnColor(5, 0)).toBe(CHURN_NEUTRAL);
  });

  it('treats negative churn as neutral (defensive)', () => {
    expect(churnColor(-3, 100)).toBe(CHURN_NEUTRAL);
  });

  it('returns a non-neutral rgb color for a positive churn with positive max', () => {
    const c = churnColor(50, 100);
    expect(c).not.toBe(CHURN_NEUTRAL);
    expect(c.startsWith('rgb(')).toBe(true);
  });

  it('low churn differs from max churn (heatmap actually varies)', () => {
    const low = churnColor(1, 100);
    const high = churnColor(100, 100);
    expect(low).not.toBe(high);
  });

  it('the max-churn node is hot red', () => {
    expect(churnColor(100, 100)).toBe('rgb(239,68,68)');
  });

  it('the mid point is amber-ish (warming), distinct from both ends', () => {
    const mid = churnColor(50, 100);
    const low = churnColor(1, 100);
    const high = churnColor(100, 100);
    expect(mid).toBe('rgb(245,158,11)'); // 0.5 stop = amber
    expect(mid).not.toBe(low);
    expect(mid).not.toBe(high);
  });

  it('clamps churn above maxChurn to the hot end', () => {
    const capped = churnColor(500, 100);
    const atMax = churnColor(100, 100);
    expect(capped).toBe(atMax);
  });
});

// ─── interpolateChurn ─────────────────────────────────────────────────────────

describe('interpolateChurn', () => {
  it('returns a valid rgb string for t=0', () => {
    expect(interpolateChurn(0)).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
  });

  it('returns a valid rgb string for t=1', () => {
    expect(interpolateChurn(1)).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
  });

  it('t=0 is green (cool / stable end)', () => {
    expect(interpolateChurn(0)).toBe('rgb(34,197,94)');
  });

  it('t=1 is red (hot end)', () => {
    expect(interpolateChurn(1)).toBe('rgb(239,68,68)');
  });

  it('is monotonically warming — red channel increases from cool to hot', () => {
    const parse = (c: string) => c.match(/\d+/g)!.map(Number);
    const r0 = parse(interpolateChurn(0))[0];
    const r1 = parse(interpolateChurn(1))[0];
    expect(r1).toBeGreaterThan(r0);
  });

  it('is monotonically draining green — green channel decreases from cool to hot', () => {
    const parse = (c: string) => c.match(/\d+/g)!.map(Number);
    const g0 = parse(interpolateChurn(0))[1];
    const g1 = parse(interpolateChurn(1))[1];
    expect(g1).toBeLessThan(g0);
  });

  it('clamps t outside [0,1]', () => {
    expect(interpolateChurn(-1)).toBe(interpolateChurn(0));
    expect(interpolateChurn(2)).toBe(interpolateChurn(1));
  });
});

// ─── churnModeAvailable (pure mode-gating helper) ─────────────────────────────

describe('churnModeAvailable', () => {
  it('is available only when gitAnalyzed is strictly true', () => {
    expect(churnModeAvailable(true)).toBe(true);
  });

  it('is unavailable when gitAnalyzed is false', () => {
    expect(churnModeAvailable(false)).toBe(false);
  });

  it('is unavailable when gitAnalyzed is undefined (no git data)', () => {
    expect(churnModeAvailable(undefined)).toBe(false);
  });
});
