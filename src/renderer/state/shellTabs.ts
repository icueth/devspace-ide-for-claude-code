import { create } from 'zustand';

import { api } from '@renderer/lib/api';
import type { ShellTab } from '@shared/types';

const LS_KEY = 'devspace:shellTabs:v1';

// Backward-compat tab id matching the original PtyPool DEFAULT_TAB_ID. The
// first time a project's shell tab list is touched we seed this id so any
// already-running session keyed `${projectId}:shell:default` reattaches
// instead of orphaning. New tabs use random ids.
const LEGACY_TAB_ID = 'default';

export function shellSessionId(projectId: string, tabId: string): string {
  return `${projectId}:shell:${tabId}`;
}

interface PersistedShape {
  tabsByProject: Record<string, ShellTab[]>;
  activeTabIdByProject: Record<string, string>;
}

const EMPTY: PersistedShape = {
  tabsByProject: {},
  activeTabIdByProject: {},
};

function readPersist(): PersistedShape {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<PersistedShape>;
    return {
      tabsByProject: parsed.tabsByProject ?? {},
      activeTabIdByProject: parsed.activeTabIdByProject ?? {},
    };
  } catch {
    return EMPTY;
  }
}

function writePersist(state: PersistedShape): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch {
    /* localStorage full / unavailable — non-fatal */
  }
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}

function makeTab(projectId: string, label: string, id: string = shortId()): ShellTab {
  return { id, projectId, label, createdAt: Date.now() };
}

interface ShellTabsState extends PersistedShape {
  ensureTabsForProject: (projectId: string) => ShellTab[];
  addTab: (projectId: string) => ShellTab;
  removeTab: (projectId: string, tabId: string) => void;
  setActiveTab: (projectId: string, tabId: string) => void;
  renameTab: (projectId: string, tabId: string, label: string) => void;
  getActiveTab: (projectId: string) => ShellTab | null;
}

function persist(state: PersistedShape): void {
  writePersist({
    tabsByProject: state.tabsByProject,
    activeTabIdByProject: state.activeTabIdByProject,
  });
}

export const useShellTabsStore = create<ShellTabsState>((set, get) => ({
  ...readPersist(),

  ensureTabsForProject(projectId) {
    const s = get();
    const existing = s.tabsByProject[projectId];
    if (existing && existing.length > 0) return existing;

    // Seed the legacy 'default' tab id so a session keyed
    // `${projectId}:shell:default` (created by older builds or by code that
    // bypasses the store) reattaches to its existing PTY + buffer.
    const seed = makeTab(projectId, 'shell-1', LEGACY_TAB_ID);
    set((prev) => {
      const next: PersistedShape = {
        tabsByProject: { ...prev.tabsByProject, [projectId]: [seed] },
        activeTabIdByProject: { ...prev.activeTabIdByProject, [projectId]: seed.id },
      };
      persist(next);
      return next;
    });
    return [seed];
  },

  addTab(projectId) {
    const s = get();
    const existing = s.tabsByProject[projectId] ?? [];
    const tab = makeTab(projectId, `shell-${existing.length + 1}`);
    set((prev) => {
      const next: PersistedShape = {
        tabsByProject: {
          ...prev.tabsByProject,
          [projectId]: [...(prev.tabsByProject[projectId] ?? []), tab],
        },
        activeTabIdByProject: { ...prev.activeTabIdByProject, [projectId]: tab.id },
      };
      persist(next);
      return next;
    });
    return tab;
  },

  removeTab(projectId, tabId) {
    // Kill the FULL session tree (attach client + backing tmux session) so
    // dev servers running in this tab actually stop — a detach-only kill
    // leaves them running in a detached tmux session, leaking the process.
    void api.pty.killSessionTree(projectId, tabId, 'shell').catch(() => undefined);

    set((prev) => {
      const tabs = (prev.tabsByProject[projectId] ?? []).filter((t) => t.id !== tabId);
      // Closing the last tab seeds a fresh 'shell-1' so the panel never
      // shows an empty header — keeps the UX symmetric with first-open.
      const finalTabs =
        tabs.length === 0 ? [makeTab(projectId, 'shell-1')] : tabs;
      const activeTabIdByProject = { ...prev.activeTabIdByProject };
      if (activeTabIdByProject[projectId] === tabId) {
        activeTabIdByProject[projectId] = finalTabs[finalTabs.length - 1]!.id;
      }
      const next: PersistedShape = {
        tabsByProject: { ...prev.tabsByProject, [projectId]: finalTabs },
        activeTabIdByProject,
      };
      persist(next);
      return next;
    });
  },

  setActiveTab(projectId, tabId) {
    set((prev) => {
      if (prev.activeTabIdByProject[projectId] === tabId) return prev;
      const next: PersistedShape = {
        ...prev,
        activeTabIdByProject: { ...prev.activeTabIdByProject, [projectId]: tabId },
      };
      persist(next);
      return next;
    });
  },

  renameTab(projectId, tabId, label) {
    set((prev) => {
      const trimmed = label.trim();
      if (!trimmed) return prev;
      const tabs = (prev.tabsByProject[projectId] ?? []).map((t) =>
        t.id === tabId ? { ...t, label: trimmed } : t,
      );
      const next: PersistedShape = {
        ...prev,
        tabsByProject: { ...prev.tabsByProject, [projectId]: tabs },
      };
      persist(next);
      return next;
    });
  },

  getActiveTab(projectId) {
    const s = get();
    const tabs = s.tabsByProject[projectId];
    if (!tabs || tabs.length === 0) return null;
    const activeId = s.activeTabIdByProject[projectId];
    return tabs.find((t) => t.id === activeId) ?? tabs[0] ?? null;
  },
}));
