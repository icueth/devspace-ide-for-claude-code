import { describe, expect, it } from 'vitest';

import { groupByDate } from '@renderer/components/Editor/DevlogView';
import type { DevlogEntry } from '@shared/types';

// `groupByDate` powers the Devlog timeline's date headers. Buckets are
// anchored to the user's local midnight so "Today" matches the wall clock.
// We pin a fixed `now` so the test is deterministic regardless of when
// it runs.

function entry(id: string, createdAt: number, overrides: Partial<DevlogEntry> = {}): DevlogEntry {
  return {
    id,
    type: 'log',
    projectPath: '/tmp/proj',
    filename: `${id}.md`,
    title: id,
    createdAt,
    updatedAt: createdAt,
    preview: '',
    links: [],
    ...overrides,
  };
}

describe('groupByDate — Today / Yesterday / Last 7 days / Older bucketing', () => {
  // Anchor: 2026-05-18 12:00 local time. Midnight = 2026-05-18 00:00.
  const NOW = new Date(2026, 4, 18, 12, 0, 0, 0).getTime();
  const DAY = 24 * 60 * 60 * 1000;
  const todayMidnight = new Date(2026, 4, 18, 0, 0, 0, 0).getTime();
  const yesterdayMidnight = todayMidnight - DAY;
  const sevenAgoMidnight = todayMidnight - 7 * DAY;

  it('places entries from today (after local midnight) in the Today bucket', () => {
    const e1 = entry('a', todayMidnight + 1000);
    const e2 = entry('b', NOW - 60_000);
    const buckets = groupByDate([e1, e2], NOW);
    const today = buckets.find((b) => b.key === 'today');
    expect(today).toBeDefined();
    expect(today!.entries.map((e) => e.id).sort()).toEqual(['a', 'b']);
  });

  it('places entries from yesterday (midnight-to-midnight before today) in the Yesterday bucket', () => {
    const e = entry('y', yesterdayMidnight + 60_000);
    const buckets = groupByDate([e], NOW);
    const yesterday = buckets.find((b) => b.key === 'yesterday');
    expect(yesterday).toBeDefined();
    expect(yesterday!.entries[0]?.id).toBe('y');
  });

  it('places entries from 2-7 days ago in the Last 7 days bucket', () => {
    const three = entry('three', todayMidnight - 3 * DAY);
    const six = entry('six', todayMidnight - 6 * DAY);
    const buckets = groupByDate([three, six], NOW);
    const last7 = buckets.find((b) => b.key === 'last7');
    expect(last7).toBeDefined();
    expect(last7!.entries.map((e) => e.id).sort()).toEqual(['six', 'three']);
  });

  it('places entries older than 7 days in the Older bucket', () => {
    const old1 = entry('old1', todayMidnight - 30 * DAY);
    const old2 = entry('old2', sevenAgoMidnight - 1000);
    const buckets = groupByDate([old1, old2], NOW);
    const older = buckets.find((b) => b.key === 'older');
    expect(older).toBeDefined();
    expect(older!.entries.map((e) => e.id).sort()).toEqual(['old1', 'old2']);
  });

  it('sorts entries inside each bucket newest-first', () => {
    const a = entry('a', NOW - 30 * 60_000); // 30m ago
    const b = entry('b', NOW - 5 * 60_000); // 5m ago — newer
    const buckets = groupByDate([a, b], NOW);
    const today = buckets.find((b) => b.key === 'today');
    expect(today!.entries[0]!.id).toBe('b');
    expect(today!.entries[1]!.id).toBe('a');
  });

  it('omits empty buckets and emits buckets in newest-first order', () => {
    // Only Today + Older — no Yesterday, no Last 7d.
    const t = entry('t', NOW - 60_000);
    const old = entry('o', todayMidnight - 100 * DAY);
    const buckets = groupByDate([t, old], NOW);
    expect(buckets.map((b) => b.key)).toEqual(['today', 'older']);
  });

  it('returns an empty array when no entries are provided', () => {
    expect(groupByDate([], NOW)).toEqual([]);
  });
});
