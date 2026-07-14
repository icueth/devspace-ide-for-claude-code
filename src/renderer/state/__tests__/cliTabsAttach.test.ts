import { describe, expect, it } from 'vitest';

import {
  attachExternalTabState,
  makeExternalTab,
} from '../cliTabsAttach';
import { cliSessionId, type DockStateSnapshot } from '../cliTabsPins';

const base = (): DockStateSnapshot => ({
  tabsByProject: {},
  activeTabIdByProject: {},
  projectsById: { p1: { id: 'p1', name: 'proj', path: '/p' } },
  dockedOrder: ['p1'],
  activeDockedProjectId: 'p1',
  columns: [{ id: 'col-0', pin: null }],
  activeColumnId: 'col-0',
});

describe('attachExternalTab (flow sessions)', () => {
  it('keeps the flow tabId verbatim so the session id matches main s PtyPool key', () => {
    // THE invariant: main spawned `p1:claude-cli:flow-r1-coder`. The dock only
    // attaches (rather than spawning a rival agent) if it reproduces that key.
    const tab = makeExternalTab('p1', { tabId: 'flow-r1-coder', cliId: 'claude' });
    expect(cliSessionId(tab.cliId ?? 'claude', 'p1', tab.id)).toBe(
      'p1:claude-cli:flow-r1-coder',
    );
  });

  it('normalizes claude to the store s implicit-default (undefined) cliId', () => {
    expect(makeExternalTab('p1', { tabId: 't', cliId: 'claude' }).cliId).toBeUndefined();
    expect(makeExternalTab('p1', { tabId: 't', cliId: 'codex' }).cliId).toBe('codex');
  });

  it('preserves a non-claude cliId in the resolved session id', () => {
    const tab = makeExternalTab('p1', { tabId: 'flow-r1-x', cliId: 'codex' });
    expect(cliSessionId(tab.cliId ?? 'claude', 'p1', tab.id)).toBe(
      'p1:codex-cli:flow-r1-x',
    );
  });

  it('adds the tab, selects it, and pins it into the active column', () => {
    const tab = makeExternalTab('p1', { tabId: 'flow-r1-coder', cliId: 'claude' });
    const next = attachExternalTabState(base(), 'p1', tab);

    expect(next.tabsByProject.p1).toHaveLength(1);
    expect(next.activeTabIdByProject.p1).toBe('flow-r1-coder');
    expect(next.activeDockedProjectId).toBe('p1');
    expect(next.columns[0]!.pin).toEqual({ projectId: 'p1', tabId: 'flow-r1-coder' });
  });

  it('is idempotent — re-attaching focuses the tab instead of duplicating it', () => {
    const tab = makeExternalTab('p1', { tabId: 'flow-r1-coder', cliId: 'claude' });
    const once = attachExternalTabState(base(), 'p1', tab);
    const twice = attachExternalTabState(once, 'p1', tab);

    expect(twice.tabsByProject.p1).toHaveLength(1);
    expect(twice.columns[0]!.pin?.tabId).toBe('flow-r1-coder');
  });

  it('appends alongside the project s existing tabs', () => {
    const prev = base();
    prev.tabsByProject.p1 = [
      { id: 'abc123', projectId: 'p1', label: 'Claude 1', createdAt: 1 },
    ];
    const next = attachExternalTabState(
      prev,
      'p1',
      makeExternalTab('p1', { tabId: 'flow-r1-coder', cliId: 'claude' }),
    );
    expect(next.tabsByProject.p1!.map((t) => t.id)).toEqual(['abc123', 'flow-r1-coder']);
  });
});
