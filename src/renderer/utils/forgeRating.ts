import type { ForgeStats } from '@shared/types';

// v0.25: derive a 1-5 star rating from forge stats counters. Returns null
// when there's not enough signal to be meaningful (<2 signals total).
// useful = thanks-class, harmful = correction-class, ignored = neutral-light.
// Imported by both SkillsSettings + AgentsSettings rows + the standalone
// test. Lives in utils/ so importing the helper doesn't drag the entire
// SkillsSettings/CodeMirror module graph along.
export function computeForgeRating(stats: ForgeStats | null): number | null {
  if (!stats) return null;
  const pos = stats.useful ?? 0;
  const neg = stats.harmful ?? 0;
  const neu = stats.ignored ?? 0;
  const total = pos + neg + neu;
  if (total < 2) return null;
  // 5 = all useful, 1 = all harmful, ignored drags toward 2.5 (neutral).
  const score = (pos * 5 + neu * 2.5 + neg * 1) / total;
  return Math.max(1, Math.min(5, score));
}
