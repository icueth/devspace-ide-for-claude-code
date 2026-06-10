import { describe, expect, it } from 'vitest';

import {
  assignPin,
  assignPinWithSwap,
  computePinnedSessionIds,
  claudeCliSessionId,
  pickAutoPinTab,
  pinForActiveSelection,
  retargetColumnsForRemovedProject,
  retargetColumnsForRemovedTab,
  sanitizePersistedColumns,
  seedPinForNewColumn,
  syncActiveFromPin,
  undockProjectState,
} from '@renderer/state/cliTabsPins';
import type { CliTab, DockColumn } from '@shared/types';

/**
 * Pure pin-helper tests — no zustand store, no api mock needed. The store
 * behavior built on these is covered in cliTabs.test.ts.
 */

function tab(projectId: string, id: string): CliTab {
  return { id, projectId, label: id, createdAt: 0 };
}

function col(
  id: string,
  pin: { projectId: string; tabId: string } | null,
): DockColumn {
  return { id, pin };
}

const P1A = { projectId: 'p1', tabId: 'a' };
const P1B = { projectId: 'p1', tabId: 'b' };
const P2C = { projectId: 'p2', tabId: 'c' };

describe('assignPin', () => {
  it('gives the target the pin and strips the identical pin from other columns', () => {
    const next = assignPin(
      [col('c0', P1A), col('c1', P2C)],
      'c1',
      P1A,
    );
    expect(next).toEqual([col('c0', null), col('c1', P1A)]);
  });

  it('leaves unrelated pins untouched', () => {
    const next = assignPin([col('c0', P2C), col('c1', null)], 'c1', P1A);
    expect(next).toEqual([col('c0', P2C), col('c1', P1A)]);
  });

  it('null pin clears only the target', () => {
    const next = assignPin([col('c0', P1A), col('c1', P2C)], 'c0', null);
    expect(next).toEqual([col('c0', null), col('c1', P2C)]);
  });

  it('unknown target id is a no-op (same reference)', () => {
    const columns = [col('c0', P1A)];
    expect(assignPin(columns, 'nope', P1B)).toBe(columns);
  });
});

describe('assignPinWithSwap', () => {
  it('donor column receives the target old pin instead of going blank', () => {
    const next = assignPinWithSwap(
      [col('c0', P1A), col('c1', P1B)],
      'c1',
      P1A,
    );
    // c1 takes P1A; c0 (the donor) gets c1's old pin P1B — no blank column.
    expect(next).toEqual([col('c0', P1B), col('c1', P1A)]);
  });

  it('donor goes null when the target had no old pin', () => {
    const next = assignPinWithSwap(
      [col('c0', P1A), col('c1', null)],
      'c1',
      P1A,
    );
    expect(next).toEqual([col('c0', null), col('c1', P1A)]);
  });

  it('unknown target id is a no-op (same reference)', () => {
    const columns = [col('c0', P1A)];
    expect(assignPinWithSwap(columns, 'nope', P1B)).toBe(columns);
  });
});

describe('sanitizePersistedColumns', () => {
  it('keeps the first occurrence of a duplicated pin and nulls later ones', () => {
    const next = sanitizePersistedColumns([
      col('c0', P1A),
      col('c1', P1A),
      col('c2', P1A),
    ]);
    expect(next).toEqual([col('c0', P1A), col('c1', null), col('c2', null)]);
  });

  it('leaves distinct pins and nulls alone', () => {
    const columns = [col('c0', P1A), col('c1', null), col('c2', P2C)];
    expect(sanitizePersistedColumns(columns)).toEqual(columns);
  });
});

describe('seedPinForNewColumn', () => {
  it("picks the active project's first tab not pinned in any column", () => {
    const pin = seedPinForNewColumn({
      tabsByProject: { p1: [tab('p1', 'a'), tab('p1', 'b')] },
      activeTabIdByProject: { p1: 'a' },
      dockedOrder: ['p1'],
      activeDockedProjectId: 'p1',
      columns: [col('c0', P1A)],
    });
    expect(pin).toEqual(P1B);
  });

  it("falls back to another docked project's unpinned active tab", () => {
    const pin = seedPinForNewColumn({
      tabsByProject: { p1: [tab('p1', 'a')], p2: [tab('p2', 'c')] },
      activeTabIdByProject: { p1: 'a', p2: 'c' },
      dockedOrder: ['p1', 'p2'],
      activeDockedProjectId: 'p1',
      columns: [col('c0', P1A)],
    });
    expect(pin).toEqual(P2C);
  });

  it('returns null when every tab is already visible somewhere', () => {
    const pin = seedPinForNewColumn({
      tabsByProject: { p1: [tab('p1', 'a')] },
      activeTabIdByProject: { p1: 'a' },
      dockedOrder: ['p1'],
      activeDockedProjectId: 'p1',
      columns: [col('c0', P1A)],
    });
    expect(pin).toBeNull();
  });
});

describe('retargetColumnsForRemovedTab', () => {
  it('re-targets at most ONE column to the fallback and nulls the rest', () => {
    const next = retargetColumnsForRemovedTab(
      [col('c0', P1A), col('c1', P1A), col('c2', P2C)],
      'p1',
      'a',
      'b',
    );
    expect(next).toEqual([col('c0', P1B), col('c1', null), col('c2', P2C)]);
  });

  it('nulls instead of duplicating when another column already pins the fallback', () => {
    const next = retargetColumnsForRemovedTab(
      [col('c0', P1A), col('c1', P1B)],
      'p1',
      'a',
      'b',
    );
    expect(next).toEqual([col('c0', null), col('c1', P1B)]);
  });
});

describe('retargetColumnsForRemovedProject', () => {
  it('re-targets exactly one column to the fallback pin and nulls the rest', () => {
    const next = retargetColumnsForRemovedProject(
      [col('c0', P2C), col('c1', { projectId: 'p2', tabId: 'd' })],
      'p2',
      P1A,
    );
    expect(next).toEqual([col('c0', P1A), col('c1', null)]);
  });

  it('nulls instead of duplicating when a surviving column already pins the fallback', () => {
    const next = retargetColumnsForRemovedProject(
      [col('c0', P1A), col('c1', P2C)],
      'p2',
      P1A,
    );
    expect(next).toEqual([col('c0', P1A), col('c1', null)]);
  });

  it('nulls everything when there is no fallback', () => {
    const next = retargetColumnsForRemovedProject(
      [col('c0', P2C), col('c1', { projectId: 'p2', tabId: 'd' })],
      'p2',
      null,
    );
    expect(next).toEqual([col('c0', null), col('c1', null)]);
  });
});

describe('undockProjectState', () => {
  it('keeps the previous selection when it survives and re-targets to ITS active tab', () => {
    const next = undockProjectState(
      {
        tabsByProject: {
          p1: [tab('p1', 'a'), tab('p1', 'b')],
          p2: [tab('p2', 'c')],
          p3: [tab('p3', 'e')],
        },
        activeTabIdByProject: { p1: 'b', p2: 'c', p3: 'e' },
        projectsById: {},
        dockedOrder: ['p1', 'p2', 'p3'],
        // p1 is the selection and survives — the old code would have
        // fallen back to LAST docked (p3) only when p2 was selected, but
        // the pin repair must use the same convention either way.
        activeDockedProjectId: 'p1',
        columns: [col('c0', P2C)],
        activeColumnId: 'c0',
      },
      'p2',
    );
    expect(next.activeDockedProjectId).toBe('p1');
    // Re-target uses the fallback's ACTIVE tab (b), not tabs[0].
    expect(next.columns).toEqual([col('c0', P1B)]);
    expect(next.dockedOrder).toEqual(['p1', 'p3']);
    expect(next.tabsByProject['p2']).toBeUndefined();
  });

  it('falls back to the last docked project when the selection is removed', () => {
    const next = undockProjectState(
      {
        tabsByProject: { p1: [tab('p1', 'a')], p2: [tab('p2', 'c')] },
        activeTabIdByProject: { p1: 'a', p2: 'c' },
        projectsById: {},
        dockedOrder: ['p1', 'p2'],
        activeDockedProjectId: 'p2',
        columns: [col('c0', P2C)],
        activeColumnId: 'c0',
      },
      'p2',
    );
    expect(next.activeDockedProjectId).toBe('p1');
    expect(next.columns).toEqual([col('c0', P1A)]);
  });
});

describe('syncActiveFromPin', () => {
  it('sets activeDockedProjectId and the per-project active tab', () => {
    const next = syncActiveFromPin(
      { activeDockedProjectId: 'p2', activeTabIdByProject: { p1: 'a' } },
      P1B,
    );
    expect(next.activeDockedProjectId).toBe('p1');
    expect(next.activeTabIdByProject).toEqual({ p1: 'b' });
  });
});

describe('pickAutoPinTab', () => {
  it("prefers the project's active tab when it is not pinned elsewhere", () => {
    const id = pickAutoPinTab(
      {
        columns: [col('c0', null)],
        tabsByProject: { p1: [tab('p1', 'a'), tab('p1', 'b')] },
        activeTabIdByProject: { p1: 'b' },
      },
      'c0',
      'p1',
    );
    expect(id).toBe('b');
  });

  it('skips tabs visible in OTHER columns (would steal a pane under swap)', () => {
    const id = pickAutoPinTab(
      {
        columns: [col('c0', null), col('c1', P1B)],
        tabsByProject: { p1: [tab('p1', 'a'), tab('p1', 'b')] },
        activeTabIdByProject: { p1: 'b' },
      },
      'c0',
      'p1',
    );
    expect(id).toBe('a');
  });

  it('returns null for a project with no tabs', () => {
    const id = pickAutoPinTab(
      { columns: [col('c0', null)], tabsByProject: {}, activeTabIdByProject: {} },
      'c0',
      'p1',
    );
    expect(id).toBeNull();
  });
});

describe('pinForActiveSelection', () => {
  it('pins the active column and strips the same pair from another column', () => {
    const next = pinForActiveSelection(
      { columns: [col('c0', P1A), col('c1', P2C)], activeColumnId: 'c1' },
      'p1',
      'a',
    );
    expect(next).toEqual([col('c0', null), col('c1', P1A)]);
  });

  it('falls back to the first column when the active id is gone', () => {
    const next = pinForActiveSelection(
      { columns: [col('c0', null)], activeColumnId: 'removed' },
      'p1',
      'a',
    );
    expect(next).toEqual([col('c0', P1A)]);
  });
});

describe('computePinnedSessionIds', () => {
  it('dedups duplicate pins and skips pins pointing at missing tabs', () => {
    const ids = computePinnedSessionIds({
      columns: [col('c0', P1A), col('c1', P1A), col('c2', P2C)],
      // p2 has no tabs → its pin is dangling and must not be protected.
      tabsByProject: { p1: [tab('p1', 'a')] },
    });
    expect(ids).toEqual([claudeCliSessionId('p1', 'a')]);
  });
});
