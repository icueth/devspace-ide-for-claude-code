import { create } from 'zustand';

import { api } from '@renderer/lib/api';
import { useCliTabsStore } from '@renderer/state/cliTabs';
import type { Project, Workspace } from '@shared/types';

const LS_KEY = 'devspace:workspace:v1';

// Free PTY sessions tied to a project so closing / evicting releases memory
// and the claude/shell processes don't linger in the background. undockProject
// walks every Claude CLI tab the project has spawned plus the per-project
// shell PTY, kills them, and clears the dock chip + persisted metadata.
function killProjectPtys(projectId: string): void {
  useCliTabsStore.getState().undockProject(projectId);
}

interface PersistedWorkspaceState {
  // Keyed by workspace id so each workspace remembers its own open projects
  // + active project across app restarts.
  perWorkspace: Record<
    string,
    {
      openedProjectIds: string[];
      activeProjectId: string | null;
      allExpanded?: boolean;
    }
  >;
}

function readPersist(): PersistedWorkspaceState {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedWorkspaceState>;
      if (parsed.perWorkspace && typeof parsed.perWorkspace === 'object') {
        return { perWorkspace: parsed.perWorkspace };
      }
    }
  } catch {
    /* ignore */
  }
  return { perWorkspace: {} };
}

function writePersist(state: PersistedWorkspaceState): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

interface WorkspaceState {
  active: Workspace | null;
  known: Workspace[];
  projects: Project[];
  activeProjectId: string | null;
  // Projects the user has activated in this session — kept so their Claude
  // CLI panes remain mounted in the background across project switches.
  openedProjectIds: string[];
  // User preference: whether the "All" projects list is expanded below the
  // "Open" section. Collapsed by default once anything is open.
  allExpanded: boolean;
  scanning: boolean;
  error: string | null;

  load: () => Promise<void>;
  pickFolder: () => Promise<void>;
  openPath: (path: string) => Promise<void>;
  setActive: (id: string) => Promise<void>;
  setActiveProject: (id: string | null) => void;
  closeProject: (id: string) => void;
  setAllExpanded: (v: boolean) => void;
}

function persistSnapshot(state: {
  active: Workspace | null;
  openedProjectIds: string[];
  activeProjectId: string | null;
  allExpanded: boolean;
}): void {
  if (!state.active) return;
  const existing = readPersist();
  existing.perWorkspace[state.active.id] = {
    openedProjectIds: state.openedProjectIds,
    activeProjectId: state.activeProjectId,
    allExpanded: state.allExpanded,
  };
  writePersist(existing);
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  active: null,
  known: [],
  projects: [],
  activeProjectId: null,
  openedProjectIds: [],
  allExpanded: false,
  scanning: false,
  error: null,

  async load() {
    try {
      const { active, workspaces } = await api.workspace.list();
      set({ active, known: workspaces, error: null });
      if (active) await get().setActive(active.id);
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async pickFolder() {
    set({ error: null });
    const ws = await api.workspace.pickFolder();
    if (!ws) return;
    set({ active: ws, known: [...get().known.filter((w) => w.id !== ws.id), ws] });
    await get().setActive(ws.id);
  },

  async openPath(path: string) {
    set({ error: null });
    const ws = await api.workspace.open(path);
    set({ active: ws, known: [...get().known.filter((w) => w.id !== ws.id), ws] });
    await get().setActive(ws.id);
  },

  async setActive(id: string) {
    const ws =
      get().known.find((w) => w.id === id) ?? (await api.workspace.setActive(id));
    if (!ws) return;
    set({
      active: ws,
      scanning: true,
      activeProjectId: null,
      projects: [],
      openedProjectIds: [],
      allExpanded: false,
    });
    try {
      const projects = await api.workspace.scan(ws.id, ws.path);
      // Restore persisted opened-project state for this workspace. Filter out
      // project IDs that no longer exist (e.g. folder was deleted).
      const saved = readPersist().perWorkspace[ws.id];
      const validProjectIds = new Set(projects.map((p) => p.id));
      let openedProjectIds = (saved?.openedProjectIds ?? []).filter((x) =>
        validProjectIds.has(x),
      );
      let activeProjectId: string | null =
        saved?.activeProjectId && validProjectIds.has(saved.activeProjectId)
          ? saved.activeProjectId
          : (openedProjectIds[openedProjectIds.length - 1] ?? null);

      // First visit to this workspace (no persisted state): auto-activate the
      // workspace root project if one was detected — a monorepo user expects
      // the CLI to open at the root, not stare at an empty pane.
      if (!saved && openedProjectIds.length === 0) {
        const rootProject = projects.find((p) => p.isWorkspaceRoot);
        if (rootProject) {
          activeProjectId = rootProject.id;
          openedProjectIds = [rootProject.id];
        }
      }

      set({
        projects,
        scanning: false,
        openedProjectIds,
        activeProjectId,
        allExpanded: saved?.allExpanded ?? false,
      });
    } catch (err) {
      set({ scanning: false, error: (err as Error).message });
    }
  },

  setActiveProject(id) {
    if (!id) {
      set({ activeProjectId: null });
      persistSnapshot(get());
      return;
    }
    const evicted: string[] = [];
    set((s) => {
      if (s.openedProjectIds.includes(id)) {
        return { activeProjectId: id };
      }
      const MAX_OPEN = 8;
      const next = [...s.openedProjectIds, id];
      while (next.length > MAX_OPEN) {
        const gone = next.shift();
        if (gone) evicted.push(gone);
      }
      return { activeProjectId: id, openedProjectIds: next };
    });
    // Always (re-)dock the project AND pin the active column. dockProject
    // is idempotent for already-docked projects; setActiveDockedProject
    // pins the active column so the chip's pane is visible. Together this
    // restores chips that had been closed via right-click → "Close project"
    // — that flow clears cliTabsStore but leaves workspaceStore alone, so
    // re-clicking the sidebar must explicitly bring the chip back.
    const project = get().projects.find((p) => p.id === id);
    if (project) {
      const cli = useCliTabsStore.getState();
      cli.dockProject({
        id: project.id,
        name: project.name,
        path: project.path,
        workspaceId: project.workspaceId,
      });
      cli.setActiveDockedProject(id);
    }
    evicted.forEach(killProjectPtys);
    persistSnapshot(get());
  },

  closeProject(id) {
    set((s) => {
      const next = s.openedProjectIds.filter((x) => x !== id);
      const nextActive =
        s.activeProjectId === id ? (next[next.length - 1] ?? null) : s.activeProjectId;
      return { openedProjectIds: next, activeProjectId: nextActive };
    });
    killProjectPtys(id);
    persistSnapshot(get());
  },

  setAllExpanded(v) {
    set({ allExpanded: v });
    persistSnapshot(get());
  },
}));
