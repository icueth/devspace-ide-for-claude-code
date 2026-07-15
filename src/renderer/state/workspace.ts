import { create } from 'zustand';

import { api } from '@renderer/lib/api';
import { useCliTabsStore } from '@renderer/state/cliTabs';
import { useEditorStore } from '@renderer/state/editor';
import type { Project, Workspace } from '@shared/types';

const LS_KEY = 'devspace:workspace:v1';

// v0.30.5 — derive the project a tab belongs to. Returns the project id, or
// null if the tab can't be attributed (e.g. settings page open, no tab, or a
// file outside every known project root).
//
// Tab path conventions handled:
//   • Synthetic `<kind>:<projectPath>` for codeflow/live-preview
//   • `diff:<absPath>` for git diff tabs
//   • Plain absolute file paths for text/image/pdf tabs
//
// Synthetic-kind matching takes precedence — exact equality is safest because
// some users nest workspaces inside one another (project A's path is a
// prefix of project B's path). For file/diff tabs we use longest-prefix
// match so the deepest enclosing project wins.
export function deriveProjectIdFromTab(
  tabPath: string | null | undefined,
  projects: ReadonlyArray<Pick<Project, 'id' | 'path'>>,
): string | null {
  if (!tabPath) return null;
  // Synthetic kinds: <kind>:<projectPath>
  const SYNTHETIC_KINDS = ['codeflow', 'live-preview'];
  for (const kind of SYNTHETIC_KINDS) {
    const prefix = `${kind}:`;
    if (tabPath.startsWith(prefix)) {
      const projectPath = tabPath.slice(prefix.length);
      const p = projects.find((x) => x.path === projectPath);
      return p?.id ?? null;
    }
  }
  // git diff: diff:<absPath>
  let pathForMatch = tabPath;
  if (tabPath.startsWith('diff:')) {
    pathForMatch = tabPath.slice('diff:'.length);
  } else if (tabPath.startsWith('html-preview:')) {
    // html-preview:<absolute html path> — the embedded path is the FILE
    // (under <project>/.devspace/preview/), so longest-prefix matching below
    // resolves the owning project just like a plain file tab.
    pathForMatch = tabPath.slice('html-preview:'.length);
  }
  // Longest-prefix match wins (nested workspace safety).
  let best: { id: string; pathLen: number } | null = null;
  for (const p of projects) {
    const isInside =
      pathForMatch === p.path || pathForMatch.startsWith(`${p.path}/`);
    if (isInside && (!best || p.path.length > best.pathLen)) {
      best = { id: p.id, pathLen: p.path.length };
    }
  }
  return best?.id ?? null;
}

// v0.38 — per-project most-recently-used editor tab. Lets activateProject
// restore the tab the user was last on in that project, so sidebar / dock /
// editor all agree after a project switch. Session-only by design: editor
// tabs themselves don't persist across restarts, so persisting this map
// would only point at tabs that no longer exist.
const mruTabByProject = new Map<string, string>();

// v0.38 — session-only activation recency for MAX_OPEN eviction. A monotonic
// counter (not Date.now()) so tests are deterministic. openedProjectIds
// itself stays in stable insertion order — it drives the sidebar "Open"
// section, and reordering it would make rows jump on every project switch —
// so recency has to live outside the array.
let activationSeq = 0;
const lastActivated = new Map<string, number>();

// v0.38.x — the path most recently opened by a FileTree click. The FileTree is
// always rooted at the ACTIVE project (App renders a single
// <FileTree rootPath={activeProject.path}>), so every file clicked there lives
// inside the active project's own subtree. followTab must therefore NOT
// switch/dock the project for such a click — even when longest-prefix
// attribution maps the file to a NESTED detected sub-project — because that
// silently spawns a CLI dock chip the user never asked for (the reported bug:
// "clicking a file/folder in a project opens a CLI tab"). This is a
// GESTURE-ORIGIN signal, not a path-topology guess: editor-tab clicks / Quick
// Open / Spotlight don't tag the path, so genuine cross-project navigation
// still follows. Cleared on any real project switch (setActiveProject) so
// returning to the file from another project later follows normally.
let lastTreeOpenPath: string | null = null;

// Tag the next file-open as originating from the FileTree (see lastTreeOpenPath).
// Call immediately before opening the editor tab.
export function markTreeOpen(path: string): void {
  lastTreeOpenPath = path;
}

// Cap on simultaneously-open projects; setActiveProject evicts beyond it.
// Module-scoped (not inline in the updater) so the eviction toast can name
// the limit in its message without drifting from the actual cap.
const MAX_OPEN = 8;

// Eviction is the ONLY teardown path without a confirm dialog (every
// explicit close gesture asks first, because teardown kills tmux sessions).
// A silent disappearance looks like data loss, so surface a non-modal toast
// naming what was closed. Dispatched as a window CustomEvent — the consumer
// is ResourceToastHost (components/Toast/ResourceToast.tsx); the store must
// never import React components. Guarded: tests stub `window` as a bare
// object, and the toast is best-effort anyway.
function announceEviction(names: string[]): void {
  if (names.length === 0) return;
  try {
    window.dispatchEvent(
      new CustomEvent('devspace:resource-toast', {
        detail: {
          message: `Closed ${names.join(', ')} — project limit (${MAX_OPEN}) reached`,
        },
      }),
    );
  } catch {
    /* no DOM window (tests) — skip */
  }
}

export function __resetProjectMruForTests(): void {
  mruTabByProject.clear();
  lastActivated.clear();
  activationSeq = 0;
  lastTreeOpenPath = null;
}

// Pure tab-picking rule (exported for tests): prefer the project's MRU tab,
// but only if it is still open AND still attributed to this project —
// longest-prefix attribution can shift to a deeper project after a rescan
// (nested workspaces), and activating a re-attributed tab would bounce the
// sidebar to the wrong project. Fallback: the most recently OPENED tab the
// project still owns. None → null (caller leaves the editor alone).
export function pickEditorTabForProject(
  projectId: string,
  mru: ReadonlyMap<string, string>,
  openTabs: ReadonlyArray<{ path: string }>,
  projects: ReadonlyArray<Pick<Project, 'id' | 'path'>>,
): string | null {
  const owned = (path: string): boolean =>
    deriveProjectIdFromTab(path, projects) === projectId;
  const mruPath = mru.get(projectId);
  if (mruPath && openTabs.some((t) => t.path === mruPath) && owned(mruPath)) {
    return mruPath;
  }
  for (let i = openTabs.length - 1; i >= 0; i--) {
    if (owned(openTabs[i]!.path)) return openTabs[i]!.path;
  }
  return null;
}

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
  // Explicit re-walk of the active workspace (WorkspacePicker → "Rescan").
  // Needed because setActive's same-id guard removed the implicit
  // click-the-current-workspace rescan — the app's only project-list refresh.
  rescan: () => Promise<void>;
  // setActiveProject is the plain mirror used by programmatic followers
  // (auto-follow effects, boot restore) — it must NEVER move the editor.
  setActiveProject: (id: string | null) => void;
  // activateProject = user intent (sidebar row, Welcome card, dock chip):
  // setActiveProject + restore the project's last-used editor tab.
  activateProject: (id: string | null) => void;
  // followTab = a tab became active (click or programmatic open): record it
  // as the project's MRU tab and move the sidebar to the owning project.
  followTab: (tabPath: string) => void;
  closeProject: (id: string) => void;
  setAllExpanded: (v: boolean) => void;
}

/**
 * Open-folder policy: the location's root owns the initial dock focus. Reuse
 * an existing tab/column when possible; only a genuinely new root should get
 * a new launcher tab. Kept separate from normal workspace switching, which
 * restores that workspace's last active project instead.
 */
export function activateOpenedLocationRoot(): void {
  const ws = useWorkspaceStore.getState();
  const root =
    ws.projects.find((project) => project.isWorkspaceRoot) ??
    ws.projects.find((project) => project.path === ws.active?.path);
  if (!root) return;

  const cli = useCliTabsStore.getState();
  const tabs = cli.tabsByProject[root.id] ?? [];
  if (tabs.length > 0) {
    const tabId =
      cli.activeTabIdByProject[root.id] &&
      tabs.some((tab) => tab.id === cli.activeTabIdByProject[root.id])
        ? cli.activeTabIdByProject[root.id]!
        : tabs[0]!.id;
    const owner = cli.columns.find(
      (column) =>
        column.pin?.projectId === root.id && column.pin.tabId === tabId,
    );
    if (owner) cli.setActiveColumn(owner.id);
    cli.setActiveTab(root.id, tabId);
    ws.setActiveProject(root.id);
    return;
  }

  // setActiveProject docks the root idempotently and creates its launcher
  // only when no persisted tab exists.
  ws.setActiveProject(root.id);
}

type WorkspaceSet = (
  partial:
    | Partial<WorkspaceState>
    | ((s: WorkspaceState) => Partial<WorkspaceState>),
) => void;

// Shared by setActive (workspace switch) and rescan (explicit re-walk of the
// current workspace): wipe per-workspace state, scan, then restore the
// persisted opened/active projects for this workspace.
async function scanWorkspaceIntoStore(
  set: WorkspaceSet,
  get: () => WorkspaceState,
  ws: Workspace,
): Promise<void> {
  set({
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
    // Register in `known` only — setActive() flips `active` itself. Pre-setting
    // `active` here tripped setActive's same-id guard against the PREVIOUS
    // workspace's loaded projects, skipping the scan entirely: the new
    // workspace showed stale projects until a manual "Rescan projects".
    set({ known: [...get().known.filter((w) => w.id !== ws.id), ws] });
    await get().setActive(ws.id);
    activateOpenedLocationRoot();
  },

  async openPath(path: string) {
    set({ error: null });
    const ws = await api.workspace.open(path);
    if (!ws) return;
    // Same rule as pickFolder: never pre-claim `active` before setActive().
    set({ known: [...get().known.filter((w) => w.id !== ws.id), ws] });
    await get().setActive(ws.id);
    activateOpenedLocationRoot();
  },

  async setActive(id: string) {
    const s = get();
    // Same-id no-op guard: re-selecting the already-active workspace must not
    // wipe state and rescan — WorkspacePicker wires the current row to this
    // action, and an unguarded click unmounts FileTree (tearing down its
    // watcher), flashes "Scanning…", and blanks the editor for nothing.
    // `scanning` short-circuits duplicate in-flight scans; `projects.length`
    // keeps the boot path (load() → setActive with an empty store) and the
    // failed-scan retry path working.
    if (id === s.active?.id && (s.scanning || s.projects.length > 0)) return;
    // Persist the active workspace in main (workspaces.json `activeId`) on EVERY
    // switch. The old code called api.workspace.setActive() only as a `??`
    // fallback (when the ws was missing from `known`), so a normal switch — ws
    // already known — updated the UI but NEVER persisted activeId. Boot then
    // restored the stale workspace (e.g. opened linehook after the user had
    // switched to devspace). Always persist; fall back to the known entry only
    // if main returns null.
    const ws = (await api.workspace.setActive(id)) ?? s.known.find((w) => w.id === id);
    if (!ws) return;
    // Snapshot the outgoing workspace's opened projects BEFORE the wipe —
    // after the scan we suspend their main-side per-project state
    // (dev server, graphify, codeflow-live). Without this, switching
    // workspaces leaks running dev servers with no UI handle until the
    // user happens to switch back. Claude/shell PTYs are deliberately NOT
    // touched: dock chips persist cross-workspace by design.
    const outgoing = s.openedProjectIds
      .map((pid) => s.projects.find((p) => p.id === pid))
      .filter((p): p is Project => !!p);
    set({ active: ws });
    await scanWorkspaceIntoStore(set, get, ws);
    // Suspend only after the incoming scan resolved, and skip any path the
    // new workspace also contains — nested workspaces share project paths,
    // and main keys this state by resolved path, so suspending earlier
    // could kill a dev server belonging to the workspace being entered.
    // On scan failure skip entirely: the user likely retries, and killing
    // dev servers on a failed switch helps nobody.
    if (get().error) return;
    const incomingPaths = new Set(get().projects.map((p) => p.path));
    for (const p of outgoing) {
      if (!incomingPaths.has(p.path)) {
        void api.workspace.suspend(p.id, p.path).catch(() => undefined);
      }
    }
  },

  async rescan() {
    const ws = get().active;
    // Dedup: a rescan during an in-flight scan would double-walk the
    // workspace and race the restore; setActive's same-id guard doesn't
    // cover this entry point.
    if (!ws || get().scanning) return;
    await scanWorkspaceIntoStore(set, get, ws);
  },

  setActiveProject(id) {
    // Any real project switch ends an in-tree browse context (see
    // lastTreeOpenPath): after this, returning to a tree-opened file from a
    // different project must follow normally.
    lastTreeOpenPath = null;
    if (!id) {
      set({ activeProjectId: null });
      persistSnapshot(get());
      return;
    }
    const evicted: string[] = [];
    lastActivated.set(id, ++activationSeq);
    set((s) => {
      if (s.openedProjectIds.includes(id)) {
        return { activeProjectId: id };
      }
      let next = [...s.openedProjectIds, id];
      // Evict by activation recency, not insertion order (the old shift()
      // always removed the FIRST-EVER opened project, even one in active
      // use). Projects pinned in a dock column are exempt — every explicit
      // close gesture demands a confirm precisely because teardown kills the
      // tmux session, so silently reaping a session the user keeps visible
      // is not acceptable.
      const pinnedProjects = new Set(
        useCliTabsStore
          .getState()
          .columns.map((c) => c.pin?.projectId)
          .filter((x): x is string => !!x),
      );
      while (next.length > MAX_OPEN) {
        const candidates = next.filter((x) => x !== id && !pinnedProjects.has(x));
        if (candidates.length === 0) {
          // Everything else is pinned — accept exceeding the cap. With
          // MAX_COLUMNS=3 at most 3 projects can be pinned, so this is a
          // near-unreachable safety net, not a leak.
          break;
        }
        let victim = candidates[0]!;
        for (const c of candidates) {
          // Strict < keeps the earliest-index candidate on ties; a missing
          // recency entry (never activated this session) counts as oldest.
          if ((lastActivated.get(c) ?? 0) < (lastActivated.get(victim) ?? 0)) {
            victim = c;
          }
        }
        evicted.push(victim);
        next = next.filter((x) => x !== victim);
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
    evicted.forEach((x) => lastActivated.delete(x));
    if (evicted.length > 0) {
      // get().projects is the full scanned list (eviction only edits
      // openedProjectIds), so evicted names are still resolvable here.
      const projectsById = new Map(get().projects.map((p) => [p.id, p]));
      announceEviction(
        evicted.map((x) => projectsById.get(x)?.name ?? x),
      );
      // v0.26.0 perf: eviction must run the SAME main-side teardown as an
      // explicit closeProject. Previously the silent MAX_OPEN=8 eviction only
      // killed PTYs — leaving the evicted project's file watcher, dev-server,
      // and per-project main-process state (loaded threads/screens, active
      // runs, codeflow child) leaked until app quit. workspace.close is
      // idempotent; re-opening just re-hydrates.
      for (const evictedId of evicted) {
        const evictedPath = projectsById.get(evictedId)?.path;
        if (evictedPath) {
          void window.devspace?.workspace
            ?.close?.(evictedId, evictedPath)
            .catch(() => undefined);
        }
      }
    }
    persistSnapshot(get());
  },

  activateProject(id) {
    get().setActiveProject(id);
    if (!id) return;
    // Editor mirror — only for explicit user gestures. Background mirrors
    // (auto-follow effects, pty auto-close fallout) call setActiveProject
    // directly and must not yank the tab the user is working in.
    const editor = useEditorStore.getState();
    const projects = get().projects;
    // MRU tab already visible in the split pane → nothing to restore;
    // activating the left-pane fallback would cover the tab the user can
    // already see with an older one.
    const mruPath = mruTabByProject.get(id);
    if (
      mruPath &&
      editor.splitTabs.some((t) => t.path === mruPath) &&
      deriveProjectIdFromTab(mruPath, projects) === id
    ) {
      return;
    }
    const target = pickEditorTabForProject(
      id,
      mruTabByProject,
      editor.tabs,
      projects,
    );
    if (target && editor.activeTabPath !== target) {
      editor.setActive(target);
    }
  },

  followTab(tabPath) {
    const derived = deriveProjectIdFromTab(tabPath, get().projects);
    if (!derived) return;
    // Record BEFORE switching so activateProject's MRU pick resolves to the
    // tab the user just clicked (no-op) instead of stealing focus to an
    // older tab of the same project.
    mruTabByProject.set(derived, tabPath);
    // A preview tab (`html-preview:<file>`) is a read-only view — record its MRU
    // but NEVER switch/dock a project for it. Previewing a file in a nested
    // folder (e.g. docs/) must not spawn a CLI dock chip for that folder. This
    // is timing-independent (unlike the markTreeOpen gesture guard below).
    if (tabPath.startsWith('html-preview:')) return;
    // A FileTree click (markTreeOpen tagged this exact path) opens a file inside
    // the active project's own tree — record its MRU but NEVER switch/dock the
    // project, even when longest-prefix attribution maps it to a nested detected
    // sub-project. Without this, browsing a parent project's files would spawn a
    // CLI dock chip for the sub-project. Genuine cross-project gestures
    // (editor-tab click, Quick Open, Spotlight) don't tag the path, so they
    // still follow.
    if (tabPath === lastTreeOpenPath) return;
    // Any non-tree tab gesture ends the browse context (so returning to the
    // tree-opened file from another project later follows normally).
    lastTreeOpenPath = null;
    if (derived !== get().activeProjectId) {
      get().setActiveProject(derived);
    }
  },

  closeProject(id) {
    mruTabByProject.delete(id);
    lastActivated.delete(id);
    const root = get().projects.find((p) => p.id === id)?.path ?? null;
    set((s) => {
      const next = s.openedProjectIds.filter((x) => x !== id);
      const nextActive =
        s.activeProjectId === id ? (next[next.length - 1] ?? null) : s.activeProjectId;
      return { openedProjectIds: next, activeProjectId: nextActive };
    });
    killProjectPtys(id);
    // Close any editor tabs anchored to this project so they don't keep
    // firing IPC subscriptions against a workspace the user said goodbye to.
    // Ownership uses deriveProjectIdFromTab — the same attribution the
    // follow effect uses. The previous inline predicate missed
    // `diff:<root>/…` and `html-preview:<root>/…` keys; a surviving tab of
    // either kind would get promoted by editor.close()'s neighbor fallback,
    // fire followTab, and silently re-dock the project the user just closed.
    // Bonus: tabs attributed to a NESTED project (longest-prefix) now
    // survive closing the enclosing project, since that project stays open.
    if (root) {
      try {
        const editor = useEditorStore.getState();
        const projects = get().projects;
        const all = [...editor.tabs, ...editor.splitTabs];
        for (const t of all) {
          if (deriveProjectIdFromTab(t.path, projects) === id) {
            editor.close(t.path, 'left');
            editor.close(t.path, 'right');
          }
        }
      } catch {
        /* editor store unavailable in tests */
      }
    }
    // Tell main to release PTYs / dev-server / file watcher for this project.
    if (root) {
      void window.devspace?.workspace?.close?.(id, root).catch(() => undefined);
    }
    persistSnapshot(get());
  },

  setAllExpanded(v) {
    set({ allExpanded: v });
    persistSnapshot(get());
  },
}));
