import { describe, expect, it } from 'vitest';

import { computeForgeRating } from '@renderer/utils/forgeRating';
import type { ForgeStats } from '@shared/types';

// v0.25: pure helper that turns implicit signal counters into a 1-5 star
// rating shown inline on Settings → Skills/Agents rows. Pure + small, but
// it powers visible UI on every reload so a regression would slip past
// integration coverage. These tests pin the expected scaling so future
// signal additions don't silently shift the average.

function stats(over: Partial<ForgeStats>): ForgeStats {
  return {
    key: 'project:skill:demo',
    scope: 'project',
    kind: 'skill',
    slug: 'demo',
    path: '/x/SKILL.md',
    uses: 0,
    lastUsedAt: null,
    useful: 0,
    ignored: 0,
    harmful: 0,
    explicit: { up: 0, down: 0 },
    removed: false,
    archivedAt: null,
    createdAt: 0,
    ...over,
  };
}

describe('computeForgeRating', () => {
  it('returns null when there are fewer than 2 signals', () => {
    expect(computeForgeRating(null)).toBeNull();
    expect(computeForgeRating(stats({}))).toBeNull();
    expect(computeForgeRating(stats({ useful: 1 }))).toBeNull();
  });

  it('returns 5 stars when every signal is positive', () => {
    expect(computeForgeRating(stats({ useful: 4 }))).toBe(5);
    expect(computeForgeRating(stats({ useful: 10 }))).toBe(5);
  });

  it('returns 1 star when every signal is corrective', () => {
    expect(computeForgeRating(stats({ harmful: 3 }))).toBe(1);
  });

  it('mixes positive + negative on a linear scale', () => {
    // 2 useful + 2 harmful = (10 + 2) / 4 = 3
    expect(computeForgeRating(stats({ useful: 2, harmful: 2 }))).toBe(3);
  });

  it('treats ignored as neutral-light (2.5 anchor)', () => {
    expect(computeForgeRating(stats({ ignored: 4 }))).toBe(2.5);
    // 1 useful + 3 ignored = (5 + 7.5) / 4 = 3.125
    expect(
      computeForgeRating(stats({ useful: 1, ignored: 3 })),
    ).toBeCloseTo(3.125);
  });

  it('clamps to [1, 5]', () => {
    // Even an absurd useful-only weight stays capped.
    expect(computeForgeRating(stats({ useful: 1000 }))).toBe(5);
    // No way to push below 1 with this scale, but stays well-defined.
    expect(computeForgeRating(stats({ harmful: 1000 }))).toBe(1);
  });
});
