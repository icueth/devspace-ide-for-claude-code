import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * cliTabs store tests (dock column pins).
 *
 * The store unconditionally hits `localStorage` and `window`, neither of
 * which exist in vitest's `node` environment. We polyfill a minimal
 * localStorage and stub the `@renderer/lib/api` module so the cliTabs
 * module can load without a real preload bridge.
 */

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(k: string): string | null {
    return this.store.has(k) ? (this.store.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.store.set(k, v);
  }
  removeItem(k: string): void {
    this.store.delete(k);
  }
  clear(): void {
    this.store.clear();
  }
}

// Stub the renderer api module — we never want a real IPC bridge in unit
// tests, and the store hooks `onAutoClosed`/`setPinned` need callable stubs.
// NB: vi.resetModules() re-runs this factory, so grab the mock fns via
// `await import('@renderer/lib/api')` INSIDE each test, after the store
// import, to assert against the instances the store actually calls.
vi.mock('@renderer/lib/api', () => ({
  api: {
    pty: {
      kill: vi.fn(async () => undefined),
      killSessionTree: vi.fn(async () => undefined),
      restartClaude: vi.fn(async () => undefined),
      onAutoClosed: () => () => undefined,
      setPinned: () => undefined,
    },
    // Phase 3: setTabFlow persists the pin AND pushes it to main, which holds
    // the live lookup an MCP `run_flow` reads.
    flows: {
      list: vi.fn(async () => []),
      select: vi.fn(async () => undefined),
    },
  },
}));

// Shared per-test reset: fresh localStorage + clean module cache so each
// test boots the store from EMPTY persisted state.
function installFreshStorage(): void {
  (globalThis as unknown as { localStorage: MemoryStorage }).localStorage =
    new MemoryStorage();
  vi.resetModules();
}

function meta(id: string) {
  return { id, name: id, path: `/tmp/${id}`, workspaceId: 'ws-1' };
}

describe('cliTabs dock column pins', () => {
  beforeEach(installFreshStorage);
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('restores a custom Codex launcher choice after a module restart', async () => {
    let module = await import('@renderer/state/cliTabs');
    module.useCliTabsStore.getState().dockProject(meta('p1'));
    const tab = module.useCliTabsStore.getState().tabsByProject['p1']![0]!;
    module.useCliTabsStore
      .getState()
      .chooseTabCli('p1', tab.id, 'codex', 'codex-profile-1');

    vi.resetModules();
    module = await import('@renderer/state/cliTabs');
    const restored = module.useCliTabsStore.getState();
    expect(restored.dockedOrder).toEqual(['p1']);
    expect(restored.tabsByProject['p1']![0]).toMatchObject({
      id: tab.id,
      cliId: 'codex',
      cliProfileId: 'codex-profile-1',
    });
    expect(restored.tabsByProject['p1']![0]!.awaitingCliChoice).toBeUndefined();
  });

  it('setColumnPin swaps with the donor column instead of blanking it', async () => {
    const { useCliTabsStore } = await import('@renderer/state/cliTabs');
    const store = useCliTabsStore.getState();
    store.dockProject(meta('p1'));
    const t1 = useCliTabsStore.getState().tabsByProject['p1']![0]!;
    const t2 = store.addTab('p1')!; // pins col-0 → (p1, t2)
    store.splitForTab({ projectId: 'p1', tabId: t1.id }); // col-1 → (p1, t1)
    const colNewId = useCliTabsStore.getState().columns[1]!.id;

    // Drag-drop the chip that col-0 currently shows onto the new column.
    store.setColumnPin(colNewId, { projectId: 'p1', tabId: t2.id });

    const s = useCliTabsStore.getState();
    expect(s.columns.find((c) => c.id === colNewId)!.pin).toEqual({
      projectId: 'p1',
      tabId: t2.id,
    });
    // The donor (col-0) received the target's old pin — no blank column.
    expect(s.columns[0]!.pin).toEqual({ projectId: 'p1', tabId: t1.id });
    expect(s.columns.every((c) => c.pin !== null)).toBe(true);
    // Non-null pin write also syncs the selection (FIX C).
    expect(s.activeDockedProjectId).toBe('p1');
    expect(s.activeTabIdByProject['p1']).toBe(t2.id);
  });

  it('splitForTab strips the pair from a column that already pinned it', async () => {
    const { useCliTabsStore } = await import('@renderer/state/cliTabs');
    const store = useCliTabsStore.getState();
    store.dockProject(meta('p1'));
    const t1 = useCliTabsStore.getState().tabsByProject['p1']![0]!;
    store.setActiveTab('p1', t1.id); // col-0 → (p1, t1)
    store.splitForTab({ projectId: 'p1', tabId: t1.id });

    const s = useCliTabsStore.getState();
    const holders = s.columns.filter(
      (c) => c.pin?.projectId === 'p1' && c.pin.tabId === t1.id,
    );
    expect(holders).toHaveLength(1);
    expect(holders[0]!.id).toBe(s.columns[1]!.id);
  });

  it('addColumn seeds a non-duplicate pin instead of cloning the active one', async () => {
    const { useCliTabsStore } = await import('@renderer/state/cliTabs');
    const store = useCliTabsStore.getState();
    store.dockProject(meta('p1'));
    const t1 = useCliTabsStore.getState().tabsByProject['p1']![0]!;
    store.addTab('p1'); // col-0 → (p1, t2)
    store.addColumn();

    const s = useCliTabsStore.getState();
    expect(s.columns).toHaveLength(2);
    // Seeded with p1's first tab that is NOT already pinned (t1, not t2).
    expect(s.columns[1]!.pin).toEqual({ projectId: 'p1', tabId: t1.id });
    const keys = s.columns
      .filter((c) => c.pin)
      .map((c) => `${c.pin!.projectId}:${c.pin!.tabId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('addColumn seeds null when every tab is already visible', async () => {
    const { useCliTabsStore } = await import('@renderer/state/cliTabs');
    const store = useCliTabsStore.getState();
    store.dockProject(meta('p1'));
    const t1 = useCliTabsStore.getState().tabsByProject['p1']![0]!;
    store.setActiveTab('p1', t1.id); // col-0 → (p1, t1) — the only tab
    store.addColumn();
    expect(useCliTabsStore.getState().columns[1]!.pin).toBeNull();
  });

  it('removeColumn syncs activeDockedProjectId from the surviving pin', async () => {
    const { useCliTabsStore } = await import('@renderer/state/cliTabs');
    const store = useCliTabsStore.getState();
    store.dockProject(meta('p1'));
    const a = useCliTabsStore.getState().tabsByProject['p1']![0]!;
    store.setActiveTab('p1', a.id); // col-0 → (p1, a)
    store.dockProject(meta('p2'));
    const b = useCliTabsStore.getState().tabsByProject['p2']![0]!;
    store.splitForTab({ projectId: 'p2', tabId: b.id }); // col-1 active, selection p2

    expect(useCliTabsStore.getState().activeDockedProjectId).toBe('p2');
    store.removeColumn(useCliTabsStore.getState().columns[1]!.id);

    const s = useCliTabsStore.getState();
    expect(s.activeColumnId).toBe(s.columns[0]!.id);
    // Selection followed the surviving column's pin, not stale p2.
    expect(s.activeDockedProjectId).toBe('p1');
    expect(s.activeTabIdByProject['p1']).toBe(a.id);
  });

  it('setColumnPin(null) leaves activeDockedProjectId alone', async () => {
    const { useCliTabsStore } = await import('@renderer/state/cliTabs');
    const store = useCliTabsStore.getState();
    store.dockProject(meta('p1'));
    const t1 = useCliTabsStore.getState().tabsByProject['p1']![0]!;
    store.setActiveTab('p1', t1.id);

    store.setColumnPin('col-0', null);

    const s = useCliTabsStore.getState();
    expect(s.columns[0]!.pin).toBeNull();
    // A null pin is a background repair — it must not clobber the selection.
    expect(s.activeDockedProjectId).toBe('p1');
    expect(s.activeTabIdByProject['p1']).toBe(t1.id);
  });

  it("undockProject re-targets exactly one column to the fallback's active tab and nulls the rest", async () => {
    const { useCliTabsStore } = await import('@renderer/state/cliTabs');
    const store = useCliTabsStore.getState();
    store.dockProject(meta('p1'));
    const a = useCliTabsStore.getState().tabsByProject['p1']![0]!;
    store.dockProject(meta('p2'));
    const b1 = useCliTabsStore.getState().tabsByProject['p2']![0]!;
    const b2 = store.addTab('p2')!; // col-0 → (p2, b2)
    store.splitForTab({ projectId: 'p2', tabId: b1.id }); // col-1 → (p2, b1)

    store.undockProject('p2');

    const s = useCliTabsStore.getState();
    // Selection fell back to the last surviving docked project…
    expect(s.activeDockedProjectId).toBe('p1');
    // …and exactly ONE of the two affected columns re-targeted to its
    // ACTIVE tab; the other went null instead of duplicating.
    expect(s.columns[0]!.pin).toEqual({ projectId: 'p1', tabId: a.id });
    expect(s.columns[1]!.pin).toBeNull();
    expect(b2.id).not.toBe(b1.id); // sanity: the two p2 tabs were distinct
  });

  it('undockProject nulls (not duplicates) when a survivor already pins the fallback pair', async () => {
    const { useCliTabsStore } = await import('@renderer/state/cliTabs');
    const store = useCliTabsStore.getState();
    store.dockProject(meta('p1'));
    const a = useCliTabsStore.getState().tabsByProject['p1']![0]!;
    store.setActiveTab('p1', a.id); // col-0 → (p1, a)
    store.dockProject(meta('p2'));
    const b = useCliTabsStore.getState().tabsByProject['p2']![0]!;
    store.splitForTab({ projectId: 'p2', tabId: b.id }); // col-1 → (p2, b)

    store.undockProject('p2');

    const s = useCliTabsStore.getState();
    expect(s.columns[0]!.pin).toEqual({ projectId: 'p1', tabId: a.id });
    expect(s.columns[1]!.pin).toBeNull();
    expect(s.activeDockedProjectId).toBe('p1');
  });

  it('readPersist sanitizes persisted duplicate pins from older builds', async () => {
    const ls = new MemoryStorage();
    ls.setItem(
      'devspace:cliTabs:v1',
      JSON.stringify({
        tabsByProject: {
          p1: [{ id: 'a', projectId: 'p1', label: 'Claude 1', createdAt: 0 }],
        },
        activeTabIdByProject: { p1: 'a' },
        projectsById: { p1: meta('p1') },
        dockedOrder: ['p1'],
        activeDockedProjectId: 'p1',
        columns: [
          { id: 'col-0', pin: { projectId: 'p1', tabId: 'a' } },
          { id: 'col-1', pin: { projectId: 'p1', tabId: 'a' } },
        ],
        activeColumnId: 'col-0',
      }),
    );
    (globalThis as unknown as { localStorage: MemoryStorage }).localStorage = ls;
    vi.resetModules();

    const { useCliTabsStore } = await import('@renderer/state/cliTabs');
    const s = useCliTabsStore.getState();
    expect(s.columns[0]!.pin).toEqual({ projectId: 'p1', tabId: 'a' });
    expect(s.columns[1]!.pin).toBeNull();
  });

  it('computePinnedSessionIds protects the active selection after pin mutations', async () => {
    const { useCliTabsStore } = await import('@renderer/state/cliTabs');
    const { computePinnedSessionIds, claudeCliSessionId } = await import(
      '@renderer/state/cliTabsPins'
    );
    const store = useCliTabsStore.getState();

    const activeSessionId = () => {
      const s = useCliTabsStore.getState();
      return claudeCliSessionId(
        s.activeDockedProjectId!,
        s.activeTabIdByProject[s.activeDockedProjectId!]!,
      );
    };

    store.dockProject(meta('p1'));
    const t1 = useCliTabsStore.getState().tabsByProject['p1']![0]!;
    store.chooseTabCli('p1', t1.id, 'claude');
    const t2 = store.addTab('p1')!;
    expect(computePinnedSessionIds(useCliTabsStore.getState())).toContain(
      activeSessionId(),
    );

    store.splitForTab({ projectId: 'p1', tabId: t1.id });
    expect(computePinnedSessionIds(useCliTabsStore.getState())).toContain(
      activeSessionId(),
    );

    const colNewId = useCliTabsStore.getState().columns[1]!.id;
    store.setColumnPin(colNewId, { projectId: 'p1', tabId: t2.id });
    expect(computePinnedSessionIds(useCliTabsStore.getState())).toContain(
      activeSessionId(),
    );

    store.removeColumn(colNewId);
    expect(computePinnedSessionIds(useCliTabsStore.getState())).toContain(
      activeSessionId(),
    );
  });
});

describe('cliTabs PTY teardown wiring', () => {
  beforeEach(installFreshStorage);
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('removeTab (normal branch) kills the full session tree', async () => {
    const { useCliTabsStore } = await import('@renderer/state/cliTabs');
    const { api } = await import('@renderer/lib/api');
    const killTree = vi.mocked(api.pty.killSessionTree);
    const store = useCliTabsStore.getState();
    store.dockProject(meta('p1'));
    const t2 = store.addTab('p1')!;
    killTree.mockClear();

    store.removeTab('p1', t2.id);

    expect(killTree).toHaveBeenCalledWith('p1', t2.id, 'claude-cli');
    // Project survives — only the tab's session tree died.
    expect(useCliTabsStore.getState().projectsById['p1']).toBeTruthy();
    expect(useCliTabsStore.getState().tabsByProject['p1']).toHaveLength(1);
  });

  it('removeTab (last-tab branch) kills the tree and undocks, including the project shell', async () => {
    const { useCliTabsStore } = await import('@renderer/state/cliTabs');
    const { api } = await import('@renderer/lib/api');
    const killTree = vi.mocked(api.pty.killSessionTree);
    const store = useCliTabsStore.getState();
    store.dockProject(meta('p1'));
    const t1 = useCliTabsStore.getState().tabsByProject['p1']![0]!;
    killTree.mockClear();

    store.removeTab('p1', t1.id);

    expect(killTree).toHaveBeenCalledWith('p1', t1.id, 'claude-cli');
    // undockProject path also tears down the legacy per-project shell.
    expect(killTree).toHaveBeenCalledWith('p1', 'default', 'shell');
    expect(useCliTabsStore.getState().projectsById['p1']).toBeUndefined();
  });

  it('reloadTab calls restartClaude and bumps reloadGen even on failure', async () => {
    const { useCliTabsStore } = await import('@renderer/state/cliTabs');
    const { api } = await import('@renderer/lib/api');
    const restart = vi.mocked(api.pty.restartClaude);
    const store = useCliTabsStore.getState();
    store.dockProject(meta('p1'));
    const t1 = useCliTabsStore.getState().tabsByProject['p1']![0]!;
    store.chooseTabCli('p1', t1.id, 'claude');

    await store.reloadTab('p1', t1.id);
    expect(restart).toHaveBeenCalledWith('p1', t1.id);
    expect(
      useCliTabsStore.getState().tabsByProject['p1']![0]!.reloadGen,
    ).toBe(1);

    // Best-effort: a failed restart must still remount the pane.
    restart.mockRejectedValueOnce(new Error('session gone'));
    await store.reloadTab('p1', t1.id);
    expect(
      useCliTabsStore.getState().tabsByProject['p1']![0]!.reloadGen,
    ).toBe(2);
  });

  // The pin has TWO consumers: the persisted tab (survives a reload, and is what
  // the boot re-push replays) and main's in-memory map (what run_flow reads). A
  // write that lands in only one of them is the bug this guards.
  it('setTabFlow persists the pin and pushes it to main', async () => {
    const { useCliTabsStore } = await import('@renderer/state/cliTabs');
    const { api } = await import('@renderer/lib/api');
    const select = vi.mocked(api.flows.select);
    const store = useCliTabsStore.getState();
    store.dockProject(meta('p1'));
    const t1 = useCliTabsStore.getState().tabsByProject['p1']![0]!;

    store.setTabFlow('p1', t1.id, 'flow-a');
    expect(
      useCliTabsStore.getState().tabsByProject['p1']![0]!.selectedFlowId,
    ).toBe('flow-a');
    expect(select).toHaveBeenCalledWith({
      projectId: 'p1',
      projectPath: '/tmp/p1',
      tabId: t1.id,
      flowId: 'flow-a',
    });
    // Persisted, not just in memory — a reload must still know the pin.
    const raw = JSON.parse(localStorage.getItem('devspace:cliTabs:v1') as string);
    expect(raw.tabsByProject.p1[0].selectedFlowId).toBe('flow-a');

    // Unpin: undefined on the tab (not null — `selectedFlowId?: string`), and
    // main is told, so the next run_flow stops resolving the old flow.
    store.setTabFlow('p1', t1.id, null);
    expect(
      useCliTabsStore.getState().tabsByProject['p1']![0]!.selectedFlowId,
    ).toBeUndefined();
    expect(select).toHaveBeenLastCalledWith(
      expect.objectContaining({ flowId: null }),
    );
  });
});
