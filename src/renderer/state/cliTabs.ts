import { create } from 'zustand';

import { api } from '@renderer/lib/api';
import {
  attachExternalTabState,
  makeExternalTab,
  type AttachExternalTabOpts,
} from '@renderer/state/cliTabsAttach';
import {
  addColumnState,
  arraysEqualUnordered,
  claudeCliSessionId,
  cliSessionId,
  computeAllSessionIds,
  computePinnedSessionIds,
  pinForActiveSelection,
  removeColumnState,
  removeTabState,
  sanitizePersistedColumns,
  setColumnPinState,
  splitForTabState,
  undockProjectState,
} from '@renderer/state/cliTabsPins';
import type {
  CliId,
  CliTab,
  DockColumn,
  DockedProjectMeta,
} from '@shared/types';

// Re-exported so existing importers (ClaudeCliPane, CodeflowView, …) keep
// working — the implementation moved to cliTabsPins.ts with the other pure
// helpers when this file hit the 500-line cap.
export { claudeCliSessionId, computePinnedSessionIds };

const LS_KEY = 'devspace:cliTabs:v1';

const MAX_COLUMNS = 3;

function cliKind(cliId?: CliId): `${CliId}-cli` {
  return `${cliId ?? 'claude'}-cli`;
}

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
    // sanitize: older builds could persist the same (project, tab) in two
    // columns, which renders one of them permanently blank (last-wins pane
    // lookup). Keep the first occurrence, null the rest.
    const columns =
      parsed.columns && parsed.columns.length > 0
        ? sanitizePersistedColumns(parsed.columns)
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

interface CliTabsState extends PersistedShape {
  dockProject: (project: DockedProjectMeta) => CliTab;
  undockProject: (projectId: string) => void;
  setActiveDockedProject: (projectId: string | null) => void;
  // Collapse the dock to a single column pinned to (projectId, tabId). Used on
  // a cross-workspace switch (activation router) so split columns don't keep
  // showing panes from the workspace we just left.
  focusSingleProject: (projectId: string, tabId: string) => void;
  addTab: (
    projectId: string,
    opts?: { authProfileId?: string; cliId?: CliId; cliProfileId?: string },
  ) => CliTab | null;
  // Dock a session spawned OUTSIDE the dock (Agent Flow's interactive nodes).
  // Unlike addTab it takes `tabId` verbatim — that's what makes the pane
  // attach to the live tmux session instead of starting a second agent. See
  // cliTabsAttach.ts. Idempotent: re-attaching just focuses the tab.
  attachExternalTab: (
    project: DockedProjectMeta,
    opts: AttachExternalTabOpts,
  ) => CliTab;
  chooseTabCli: (
    projectId: string,
    tabId: string,
    cliId: CliId,
    cliProfileId?: string,
  ) => void;
  removeTab: (projectId: string, tabId: string) => void;
  setActiveTab: (projectId: string, tabId: string) => void;
  renameTab: (projectId: string, tabId: string, label: string) => void;
  reloadTab: (projectId: string, tabId: string) => Promise<void>;
  // Multi-column dock layout. addColumn seeds the new slot with a tab not
  // yet visible in any column (cloning the active pin would duplicate it
  // and blank the original column); the user can then click another chip
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
        existing && existing.length > 0
          ? existing[0]!
          : { ...makeTab(project.id, 'Choose agent'), awaitingCliChoice: true };
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
      // Kill the FULL session tree (attach client + backing tmux session)
      // for every tab plus the legacy per-project shell — a detach-only
      // kill leaks claude + MCP children in detached tmux sessions.
      for (const tab of tabs) {
        if (tab.awaitingCliChoice) continue;
        void api.pty
          .killSessionTree(projectId, tab.id, cliKind(tab.cliId))
          .catch(() => undefined);
      }
      void api.pty
        .killSessionTree(projectId, 'default', 'shell')
        .catch(() => undefined);

      // undockProjectState picks ONE fallback for the selection AND the
      // column re-target (see its doc) — no workspace-store calls here, so this
      // background repair stays a pure dock operation (the dock→sidebar mirror
      // that used to react to it is gone; selection flows via activation.ts).
      set((prev) => {
        const next = undockProjectState(prev, projectId);
        persist(next);
        return next;
      });
    },

    focusSingleProject(projectId, tabId) {
      set((prev) => {
        const next: PersistedShape = {
          ...prev,
          columns: [{ id: prev.activeColumnId, pin: { projectId, tabId } }],
          activeColumnId: prev.activeColumnId,
          activeDockedProjectId: projectId,
          activeTabIdByProject: {
            ...prev.activeTabIdByProject,
            [projectId]: tabId,
          },
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

    addTab(projectId, opts) {
      const s = get();
      if (!s.projectsById[projectId]) {
        // Refuse to add a tab to an undocked project — the dock has no chip
        // to anchor it. Caller should dockProject first.
        return null;
      }
      const existing = s.tabsByProject[projectId] ?? [];
      const cliLabel =
        opts?.cliId === 'opencode'
          ? 'OpenCode'
          : opts?.cliId === 'codex'
            ? 'Codex'
            : opts?.cliId === 'gemini'
              ? 'Gemini'
              : 'Claude';
      const label = `${cliLabel} ${existing.length + 1}`;
      const tab: CliTab = {
        ...makeTab(projectId, label),
        authProfileId: opts?.authProfileId,
        cliId: opts?.cliId,
        cliProfileId: opts?.cliProfileId,
      };
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

    attachExternalTab(project, opts) {
      // dockProject first: a tab can only live under a docked project (addTab
      // enforces the same rule), and this may be the dock's first sight of it.
      get().dockProject(project);
      const existing = (get().tabsByProject[project.id] ?? []).find(
        (t) => t.id === opts.tabId,
      );
      const tab = existing ?? makeExternalTab(project.id, opts);
      set((prev) => {
        const next = attachExternalTabState(prev, project.id, tab);
        persist(next);
        return next;
      });
      return tab;
    },

    chooseTabCli(projectId, tabId, cliId, cliProfileId) {
      set((prev) => {
        const tabs = prev.tabsByProject[projectId] ?? [];
        if (!tabs.some((tab) => tab.id === tabId && tab.awaitingCliChoice)) {
          return prev;
        }
        const cliLabel =
          cliId === 'opencode'
            ? 'OpenCode'
            : cliId === 'codex'
              ? 'Codex'
              : cliId === 'gemini'
                ? 'Gemini'
                : cliId === 'antigravity'
                  ? 'Antigravity'
                  : 'Claude';
        const next: PersistedShape = {
          ...prev,
          tabsByProject: {
            ...prev.tabsByProject,
            [projectId]: tabs.map((tab) =>
              tab.id === tabId
                ? {
                    ...tab,
                    label: `${cliLabel} 1`,
                    cliId: cliId === 'claude' ? undefined : cliId,
                    cliProfileId,
                    awaitingCliChoice: undefined,
                  }
                : tab,
            ),
          },
        };
        persist(next);
        return next;
      });
    },

    removeTab(projectId, tabId) {
      const s = get();
      const removed = s.tabsByProject[projectId]?.find((t) => t.id === tabId);
      const kind = cliKind(removed?.cliId);
      const tabs = (s.tabsByProject[projectId] ?? []).filter((t) => t.id !== tabId);
      // Closing the last tab undocks the project entirely — matches the
      // user's mental model: "ปิดทิ้ง" should remove the chip, not respawn.
      // Re-opening the project from the sidebar gives a fresh Claude 1.
      // killSessionTree (not kill): the close-tab confirm dialog promises
      // "ends the tmux session" — a detach-only kill leaves claude running
      // headless in a detached session.
      if (tabs.length === 0) {
        void api.pty
          .killSessionTree(projectId, tabId, kind)
          .catch(() => undefined);
        get().undockProject(projectId);
        return;
      }
      void api.pty
        .killSessionTree(projectId, tabId, kind)
        .catch(() => undefined);
      set((prev) => {
        const next = removeTabState(prev, projectId, tabId);
        if (!next) return prev; // raced: tab already gone
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
        const next = addColumnState(prev, `col-${shortId()}`);
        persist(next);
        return next;
      });
    },

    splitForTab(pin) {
      set((prev) => {
        if (prev.columns.length >= MAX_COLUMNS) return prev;
        const next = splitForTabState(prev, `col-${shortId()}`, pin);
        persist(next);
        return next;
      });
    },

    removeColumn(columnId) {
      set((prev) => {
        const next = removeColumnState(prev, columnId);
        if (!next) return prev; // last column / unknown id
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
        // SWAP semantics + selection sync — see setColumnPinState.
        const next = setColumnPinState(prev, columnId, pin);
        if (!next) return prev; // unknown column id
        persist(next);
        return next;
      });
    },

    async reloadTab(projectId, tabId) {
      // restartClaude kills the PTY pool entry AND the backing tmux session
      // before the pane remounts. The pane keys on (projectId, tabId,
      // reloadGen), so the gen bump unmounts/remounts it and its spawn-once
      // effect's `new-session -A` creates a FRESH claude — picking up new
      // .mcp.json/env is the whole point of "Reload tab". A plain kill only
      // detached, so the remount silently reattached to the old claude.
      const tab = get().tabsByProject[projectId]?.find((t) => t.id === tabId);
      if (!tab || tab.awaitingCliChoice) return;
      try {
        if ((tab.cliId ?? 'claude') === 'claude') {
          await api.pty.restartClaude(projectId, tabId);
        } else {
          await api.pty.killSessionTree(projectId, tabId, cliKind(tab.cliId));
        }
      } catch {
        /* best-effort — still bump reloadGen so the pane remounts */
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
      return tab && !tab.awaitingCliChoice
        ? cliSessionId(tab.cliId ?? 'claude', projectId, tab.id)
        : null;
    },
  };
});

const CLI_ID_RE = /^(.+):(?:claude|opencode|codex|gemini|antigravity)-cli:([^:]+)$/;
if (typeof window !== 'undefined' && api?.pty?.onAutoClosed) {
  api.pty.onAutoClosed(({ ids }) => {
    const store = useCliTabsStore.getState();
    for (const id of ids) {
      const m = CLI_ID_RE.exec(id);
      if (!m) continue;
      store.removeTab(m[1]!, m[2]!);
    }
  });
}

// v0.36.1: push the renderer's pinned-session set to main on every change
// to `columns` (and `tabsByProject`, since a column's pin → session-id
// resolution depends on the referenced tab still existing). Source of
// truth is the renderer — main has no way to know which (project, tab)
// pair is currently visible in some dock column. computePinnedSessionIds /
// arraysEqualUnordered live in cliTabsPins.ts.
if (typeof window !== 'undefined' && api?.pty?.setPinned) {
  let prevIds = computePinnedSessionIds(useCliTabsStore.getState());
  try {
    api.pty.setPinned(prevIds);
  } catch {
    /* preload not yet wired — non-fatal */
  }
  useCliTabsStore.subscribe((state, prevState) => {
    if (
      state.columns === prevState.columns &&
      state.tabsByProject === prevState.tabsByProject
    ) {
      return;
    }
    const next = computePinnedSessionIds(state);
    if (arraysEqualUnordered(prevIds, next)) return;
    prevIds = next;
    try {
      api.pty.setPinned(next);
    } catch {
      /* preload bridge unavailable — non-fatal */
    }
  });
}

// beta.25: push the FULL open-tab session set (every project's every tab, not
// just the column-visible/pinned subset) so main's boot reconcile can prune
// sessions that no open tab or live task backs — i.e. clean up what's actually
// been closed, instead of letting sessions pile up across runs.
if (typeof window !== 'undefined' && api?.pty?.setLiveSessions) {
  let prevLive = computeAllSessionIds(useCliTabsStore.getState());
  try {
    api.pty.setLiveSessions(prevLive);
  } catch {
    /* preload not yet wired — non-fatal */
  }
  useCliTabsStore.subscribe((state, prevState) => {
    if (state.tabsByProject === prevState.tabsByProject) return;
    const next = computeAllSessionIds(state);
    if (arraysEqualUnordered(prevLive, next)) return;
    prevLive = next;
    try {
      api.pty.setLiveSessions(next);
    } catch {
      /* preload bridge unavailable — non-fatal */
    }
  });
}
