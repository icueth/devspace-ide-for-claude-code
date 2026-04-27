import { create } from 'zustand';

import { api } from '@renderer/lib/api';
import type { CliTab, DockColumn, DockedProjectMeta } from '@shared/types';

const LS_KEY = 'devspace:cliTabs:v1';

const MAX_COLUMNS = 3;

interface PersistedShape {
  tabsByProject: Record<string, CliTab[]>;
  activeTabIdByProject: Record<string, string>;
  // Snapshot of every project the user has docked at least once. Persisted
  // so chips survive workspace switches — the workspace's projects[] only
  // includes folders inside the active workspace, but the dock should keep
  // showing chats started elsewhere until the user closes them explicitly.
  projectsById: Record<string, DockedProjectMeta>;
  dockedOrder: string[];
  activeDockedProjectId: string | null;
  columns: DockColumn[];
  activeColumnId: string;
}

function makeDefaultColumn(): DockColumn {
  return { id: 'col-0', pin: null };
}

const EMPTY: PersistedShape = {
  tabsByProject: {},
  activeTabIdByProject: {},
  projectsById: {},
  dockedOrder: [],
  activeDockedProjectId: null,
  columns: [makeDefaultColumn()],
  activeColumnId: 'col-0',
};

function readPersist(): PersistedShape {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...EMPTY, columns: [makeDefaultColumn()] };
    const parsed = JSON.parse(raw) as Partial<PersistedShape>;
    const columns =
      parsed.columns && parsed.columns.length > 0
        ? parsed.columns
        : [makeDefaultColumn()];
    const activeColumnId =
      parsed.activeColumnId && columns.some((c) => c.id === parsed.activeColumnId)
        ? parsed.activeColumnId
        : columns[0]!.id;
    return {
      tabsByProject: parsed.tabsByProject ?? {},
      activeTabIdByProject: parsed.activeTabIdByProject ?? {},
      projectsById: parsed.projectsById ?? {},
      dockedOrder: parsed.dockedOrder ?? [],
      activeDockedProjectId: parsed.activeDockedProjectId ?? null,
      columns,
      activeColumnId,
    };
  } catch {
    return { ...EMPTY, columns: [makeDefaultColumn()] };
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
  // 6-char base36 — collision-free in practice for tabs that share a project.
  return Math.random().toString(36).slice(2, 8);
}

export function claudeCliSessionId(projectId: string, tabId: string): string {
  return `${projectId}:claude-cli:${tabId}`;
}

interface CliTabsState extends PersistedShape {
  dockProject: (project: DockedProjectMeta) => CliTab;
  undockProject: (projectId: string) => void;
  setActiveDockedProject: (projectId: string | null) => void;
  addTab: (projectId: string) => CliTab | null;
  removeTab: (projectId: string, tabId: string) => void;
  setActiveTab: (projectId: string, tabId: string) => void;
  renameTab: (projectId: string, tabId: string, label: string) => void;
  reloadTab: (projectId: string, tabId: string) => Promise<void>;
  // Multi-column dock layout. addColumn duplicates the active column's pin
  // so the new slot starts populated; the user can then click another chip
  // to retarget it. splitForTab creates a column pre-pinned to a specific
  // (project, tab) — used by the drag-from-tab-bar gesture.
  addColumn: () => void;
  splitForTab: (pin: { projectId: string; tabId: string }) => void;
  removeColumn: (columnId: string) => void;
  setActiveColumn: (columnId: string) => void;
  setColumnPin: (
    columnId: string,
    pin: { projectId: string; tabId: string } | null,
  ) => void;
  getActiveTab: (projectId: string) => CliTab | null;
  getActiveSessionId: (projectId: string) => string | null;
}

function persist(state: PersistedShape): void {
  writePersist({
    tabsByProject: state.tabsByProject,
    activeTabIdByProject: state.activeTabIdByProject,
    projectsById: state.projectsById,
    dockedOrder: state.dockedOrder,
    activeDockedProjectId: state.activeDockedProjectId,
    columns: state.columns,
    activeColumnId: state.activeColumnId,
  });
}

function pinForActiveSelection(
  prev: PersistedShape,
  projectId: string,
  tabId: string,
): DockColumn[] {
  // Update the active column's pin so it tracks the user's last chip click.
  // Falls back to the first column if the active id has been removed.
  const activeId =
    prev.columns.some((c) => c.id === prev.activeColumnId)
      ? prev.activeColumnId
      : prev.columns[0]?.id;
  if (!activeId) return prev.columns;
  return prev.columns.map((c) =>
    c.id === activeId ? { ...c, pin: { projectId, tabId } } : c,
  );
}

function makeTab(projectId: string, label: string): CliTab {
  return {
    id: shortId(),
    projectId,
    label,
    createdAt: Date.now(),
  };
}

export const useCliTabsStore = create<CliTabsState>((set, get) => {
  const initial = readPersist();

  return {
    ...initial,

    dockProject(project) {
      const s = get();
      const existing = s.tabsByProject[project.id];
      const alreadyDocked = !!s.projectsById[project.id];
      const inOrder = s.dockedOrder.includes(project.id);

      // Fast path: project is already docked AND has at least one tab AND
      // its metadata hasn't drifted (path/name same).
      const meta = s.projectsById[project.id];
      const metaUnchanged =
        alreadyDocked &&
        meta &&
        meta.name === project.name &&
        meta.path === project.path &&
        meta.workspaceId === project.workspaceId;

      if (metaUnchanged && inOrder && existing && existing.length > 0) {
        const activeId = s.activeTabIdByProject[project.id] ?? existing[0]!.id;
        return existing.find((t) => t.id === activeId) ?? existing[0]!;
      }

      const seedTab =
        existing && existing.length > 0 ? existing[0]! : makeTab(project.id, 'Chat 1');
      const tabs = existing && existing.length > 0 ? existing : [seedTab];

      set((prev) => {
        const next: PersistedShape = {
          ...prev,
          tabsByProject: { ...prev.tabsByProject, [project.id]: tabs },
          activeTabIdByProject: {
            ...prev.activeTabIdByProject,
            [project.id]: prev.activeTabIdByProject[project.id] ?? seedTab.id,
          },
          projectsById: { ...prev.projectsById, [project.id]: { ...project } },
          dockedOrder: prev.dockedOrder.includes(project.id)
            ? prev.dockedOrder
            : [...prev.dockedOrder, project.id],
          activeDockedProjectId: prev.activeDockedProjectId ?? project.id,
        };
        persist(next);
        return next;
      });
      return seedTab;
    },

    undockProject(projectId) {
      const s = get();
      const tabs = s.tabsByProject[projectId] ?? [];
      // Kill PTYs for every tab plus the legacy per-project shell.
      for (const tab of tabs) {
        void api.pty
          .kill(claudeCliSessionId(projectId, tab.id))
          .catch(() => undefined);
      }
      void api.pty.kill(`${projectId}:shell:default`).catch(() => undefined);

      set((prev) => {
        const tabsByProject = { ...prev.tabsByProject };
        delete tabsByProject[projectId];
        const activeTabIdByProject = { ...prev.activeTabIdByProject };
        delete activeTabIdByProject[projectId];
        const projectsById = { ...prev.projectsById };
        delete projectsById[projectId];
        const dockedOrder = prev.dockedOrder.filter((id) => id !== projectId);
        const activeDockedProjectId =
          prev.activeDockedProjectId === projectId
            ? (dockedOrder[dockedOrder.length - 1] ?? null)
            : prev.activeDockedProjectId;
        // Any column pinned to this project loses its pin so it doesn't
        // dangle pointing at a non-existent tab.
        const columns = prev.columns.map((c) =>
          c.pin?.projectId === projectId ? { ...c, pin: null } : c,
        );
        const next: PersistedShape = {
          tabsByProject,
          activeTabIdByProject,
          projectsById,
          dockedOrder,
          activeDockedProjectId,
          columns,
          activeColumnId: prev.activeColumnId,
        };
        persist(next);
        return next;
      });
    },

    setActiveDockedProject(projectId) {
      set((prev) => {
        // Also point the active column at this project's active tab if it
        // doesn't already show this project — otherwise newly-opened projects
        // would activate in the sidebar but stay invisible in the dock.
        let columns = prev.columns;
        if (projectId) {
          const activeTab = prev.activeTabIdByProject[projectId];
          if (activeTab) {
            const activeCol = prev.columns.find(
              (c) => c.id === prev.activeColumnId,
            );
            const needsPin =
              !activeCol?.pin || activeCol.pin.projectId !== projectId;
            if (needsPin) {
              columns = pinForActiveSelection(prev, projectId, activeTab);
            }
          }
        }
        if (
          prev.activeDockedProjectId === projectId &&
          columns === prev.columns
        ) {
          return prev;
        }
        const next: PersistedShape = {
          ...prev,
          activeDockedProjectId: projectId,
          columns,
        };
        persist(next);
        return next;
      });
    },

    addTab(projectId) {
      const s = get();
      if (!s.projectsById[projectId]) {
        // Refuse to add a tab to an undocked project — the dock has no chip
        // to anchor it. Caller should dockProject first.
        return null;
      }
      const existing = s.tabsByProject[projectId] ?? [];
      const tab = makeTab(projectId, `Chat ${existing.length + 1}`);
      set((prev) => {
        const next: PersistedShape = {
          ...prev,
          tabsByProject: {
            ...prev.tabsByProject,
            [projectId]: [...(prev.tabsByProject[projectId] ?? []), tab],
          },
          activeTabIdByProject: {
            ...prev.activeTabIdByProject,
            [projectId]: tab.id,
          },
          activeDockedProjectId: projectId,
          columns: pinForActiveSelection(prev, projectId, tab.id),
        };
        persist(next);
        return next;
      });
      return tab;
    },

    removeTab(projectId, tabId) {
      const s = get();
      const tabs = (s.tabsByProject[projectId] ?? []).filter((t) => t.id !== tabId);
      // Closing the last tab undocks the project entirely — matches the
      // user's mental model: "ปิดทิ้ง" should remove the chip, not respawn.
      // Re-opening the project from the sidebar gives a fresh Chat 1.
      if (tabs.length === 0) {
        void api.pty.kill(claudeCliSessionId(projectId, tabId)).catch(() => undefined);
        get().undockProject(projectId);
        return;
      }
      void api.pty.kill(claudeCliSessionId(projectId, tabId)).catch(() => undefined);
      set((prev) => {
        const tabsByProject = { ...prev.tabsByProject, [projectId]: tabs };
        const activeTabIdByProject = { ...prev.activeTabIdByProject };
        const fallbackTabId = tabs[tabs.length - 1]!.id;
        if (activeTabIdByProject[projectId] === tabId) {
          activeTabIdByProject[projectId] = fallbackTabId;
        }
        // Re-target any column pinned to the removed tab.
        const columns = prev.columns.map((c) =>
          c.pin?.projectId === projectId && c.pin.tabId === tabId
            ? { ...c, pin: { projectId, tabId: fallbackTabId } }
            : c,
        );
        const next: PersistedShape = {
          ...prev,
          tabsByProject,
          activeTabIdByProject,
          columns,
        };
        persist(next);
        return next;
      });
    },

    setActiveTab(projectId, tabId) {
      set((prev) => {
        const next: PersistedShape = {
          ...prev,
          activeTabIdByProject: { ...prev.activeTabIdByProject, [projectId]: tabId },
          activeDockedProjectId: projectId,
          columns: pinForActiveSelection(prev, projectId, tabId),
        };
        persist(next);
        return next;
      });
    },

    renameTab(projectId, tabId, label) {
      set((prev) => {
        const tabs = (prev.tabsByProject[projectId] ?? []).map((t) =>
          t.id === tabId ? { ...t, label } : t,
        );
        const next: PersistedShape = {
          ...prev,
          tabsByProject: { ...prev.tabsByProject, [projectId]: tabs },
        };
        persist(next);
        return next;
      });
    },

    addColumn() {
      set((prev) => {
        if (prev.columns.length >= MAX_COLUMNS) return prev;
        const active = prev.columns.find((c) => c.id === prev.activeColumnId);
        const newId = `col-${Math.random().toString(36).slice(2, 8)}`;
        const newColumn: DockColumn = {
          id: newId,
          // Clone the active column's pin so the new slot starts populated;
          // empty splits are jarring. The user can retarget by clicking a
          // different chip.
          pin: active?.pin ? { ...active.pin } : null,
        };
        const next: PersistedShape = {
          ...prev,
          columns: [...prev.columns, newColumn],
          activeColumnId: newId,
        };
        persist(next);
        return next;
      });
    },

    splitForTab(pin) {
      set((prev) => {
        if (prev.columns.length >= MAX_COLUMNS) return prev;
        const newId = `col-${Math.random().toString(36).slice(2, 8)}`;
        const newColumn: DockColumn = { id: newId, pin: { ...pin } };
        const next: PersistedShape = {
          ...prev,
          columns: [...prev.columns, newColumn],
          activeColumnId: newId,
        };
        persist(next);
        return next;
      });
    },

    removeColumn(columnId) {
      set((prev) => {
        if (prev.columns.length <= 1) return prev;
        const idx = prev.columns.findIndex((c) => c.id === columnId);
        if (idx < 0) return prev;
        const columns = prev.columns.filter((c) => c.id !== columnId);
        const activeColumnId =
          prev.activeColumnId === columnId
            ? (columns[Math.max(0, idx - 1)]?.id ?? columns[0]!.id)
            : prev.activeColumnId;
        const next: PersistedShape = {
          ...prev,
          columns,
          activeColumnId,
        };
        persist(next);
        return next;
      });
    },

    setActiveColumn(columnId) {
      set((prev) => {
        if (prev.activeColumnId === columnId) return prev;
        if (!prev.columns.some((c) => c.id === columnId)) return prev;
        const next: PersistedShape = { ...prev, activeColumnId: columnId };
        persist(next);
        return next;
      });
    },

    setColumnPin(columnId, pin) {
      set((prev) => {
        const columns = prev.columns.map((c) =>
          c.id === columnId ? { ...c, pin } : c,
        );
        const next: PersistedShape = { ...prev, columns };
        persist(next);
        return next;
      });
    },

    async reloadTab(projectId, tabId) {
      // Kill the PTY first so the pool entry is gone before the pane
      // remounts. The pane keys on (projectId, tabId, reloadGen), so the
      // gen bump triggers React to unmount and remount — at which point the
      // pane's spawn-once effect runs again and creates a fresh PTY.
      try {
        await api.pty.kill(claudeCliSessionId(projectId, tabId));
      } catch {
        /* ignore — PTY may already be gone */
      }
      set((prev) => {
        const tabs = (prev.tabsByProject[projectId] ?? []).map((t) =>
          t.id === tabId ? { ...t, reloadGen: (t.reloadGen ?? 0) + 1 } : t,
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

    getActiveSessionId(projectId) {
      const tab = get().getActiveTab(projectId);
      return tab ? claudeCliSessionId(projectId, tab.id) : null;
    },
  };
});
