import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 3 cliTabs.setTabOverlay tests.
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
vi.mock('@renderer/lib/api', () => ({
  api: {
    pty: {
      kill: vi.fn(async () => undefined),
      onAutoClosed: () => () => undefined,
      setPinned: () => undefined,
    },
  },
}));

describe('cliTabs.setTabOverlay', () => {
  beforeEach(() => {
    // Fresh localStorage + clean module cache each test so the store boots
    // from EMPTY persisted state.
    (globalThis as unknown as { localStorage: MemoryStorage }).localStorage =
      new MemoryStorage();
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('flips overlayOpen from undefined → true and persists to localStorage', async () => {
    const { useCliTabsStore } = await import('@renderer/state/cliTabs');
    const store = useCliTabsStore.getState();

    // Dock a project + grab the seed tab.
    const seed = store.dockProject({
      id: 'proj-1',
      name: 'Test Project',
      path: '/tmp/proj1',
      workspaceId: 'ws-1',
    });
    expect(seed.overlayOpen).toBeUndefined();

    store.setTabOverlay('proj-1', seed.id, true);
    const after = useCliTabsStore
      .getState()
      .tabsByProject['proj-1']!.find((t) => t.id === seed.id);
    expect(after?.overlayOpen).toBe(true);

    // Persisted under the v1 key.
    const raw = (
      globalThis as unknown as { localStorage: MemoryStorage }
    ).localStorage.getItem('devspace:cliTabs:v1');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.tabsByProject['proj-1'][0].overlayOpen).toBe(true);
  });

  it('toggling to the same value is a no-op (does not mutate state)', async () => {
    const { useCliTabsStore } = await import('@renderer/state/cliTabs');
    const store = useCliTabsStore.getState();
    const seed = store.dockProject({
      id: 'proj-2',
      name: 'P2',
      path: '/tmp/proj2',
      workspaceId: 'ws-1',
    });

    store.setTabOverlay('proj-2', seed.id, true);
    const tabsAfterFirst = useCliTabsStore.getState().tabsByProject['proj-2'];

    store.setTabOverlay('proj-2', seed.id, true);
    const tabsAfterSecond = useCliTabsStore.getState().tabsByProject['proj-2'];

    // Same array reference means setState short-circuited — confirms the
    // no-op fast path so subscribers don't re-render on redundant clicks.
    expect(tabsAfterSecond).toBe(tabsAfterFirst);
  });

  it('hydrates overlayOpen from a persisted state on next module load', async () => {
    const ls = new MemoryStorage();
    ls.setItem(
      'devspace:cliTabs:v1',
      JSON.stringify({
        tabsByProject: {
          'proj-3': [
            {
              id: 'tab-x',
              projectId: 'proj-3',
              label: 'Claude 1',
              createdAt: 0,
              overlayOpen: true,
            },
          ],
        },
        activeTabIdByProject: { 'proj-3': 'tab-x' },
        projectsById: {
          'proj-3': {
            id: 'proj-3',
            name: 'P3',
            path: '/tmp/proj3',
            workspaceId: 'ws-1',
          },
        },
        dockedOrder: ['proj-3'],
        activeDockedProjectId: 'proj-3',
        columns: [{ id: 'col-0', pin: null }],
        activeColumnId: 'col-0',
      }),
    );
    (globalThis as unknown as { localStorage: MemoryStorage }).localStorage = ls;
    vi.resetModules();

    const { useCliTabsStore } = await import('@renderer/state/cliTabs');
    const tab = useCliTabsStore.getState().tabsByProject['proj-3']!.find(
      (t) => t.id === 'tab-x',
    );
    expect(tab?.overlayOpen).toBe(true);
  });
});
