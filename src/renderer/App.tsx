import {
  BookOpen,
  Eye,
  EyeOff,
  GitBranch,
  Globe,
  Maximize2,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Search,
  Terminal as TerminalIcon,
  Users,
  Workflow,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { AgentsRail } from '@renderer/components/Agents/AgentsRail';
import { BottomPanel } from '@renderer/components/Bottom/BottomPanel';
import { RouteErrorBoundary } from '@renderer/components/Layout/RouteErrorBoundary';
import { GoToLineDialog } from '@renderer/components/CommandPalette/GoToLineDialog';
import { PromptDialog } from '@renderer/components/CommandPalette/PromptDialog';
import { QuickOpenDialog } from '@renderer/components/CommandPalette/QuickOpenDialog';
import { SpotlightDialog } from '@renderer/components/CommandPalette/SpotlightDialog';
import type { SpotlightCommand } from '@renderer/components/CommandPalette/spotlightProviders';
import { ClaudeCliDock } from '@renderer/components/Dock/ClaudeCliDock';
import { EditorArea } from '@renderer/components/Editor/EditorArea';
import { Resizer } from '@renderer/components/Layout/Resizer';
import { DockSection, SidebarSection } from '@renderer/components/Layout/ResizablePanels';
import { SettingsPage } from '@renderer/components/Settings/SettingsPage';
import { SetupBanner } from '@renderer/components/Settings/SetupBanner';
import { FileTree } from '@renderer/components/Sidebar/FileTree';
import { ProjectList } from '@renderer/components/Sidebar/ProjectList';
import { SidebarFooter } from '@renderer/components/Sidebar/SidebarFooter';
import { WorkspacePicker } from '@renderer/components/Sidebar/WorkspacePicker';
import { ResourceToastHost } from '@renderer/components/Toast/ResourceToast';
import { UpdateBadge } from '@renderer/components/UpdateBadge';
import { Welcome } from '@renderer/components/Welcome/Welcome';
import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import { useRenderTrace } from '@renderer/lib/renderTrace';
import { pickLatestPreview } from '@renderer/components/Editor/HtmlPreviewView';
import { useEditorStore } from '@renderer/state/editor';
import { useCliTabsStore } from '@renderer/state/cliTabs';
import { useEditorViewStore } from '@renderer/state/editorView';
import { useGitStore } from '@renderer/state/git';
import { useLayoutStore } from '@renderer/state/layout';
import { usePromptStore } from '@renderer/state/prompt';
import { useSidebarStore } from '@renderer/state/sidebar';
import {
  deriveProjectIdFromDockColumn,
  deriveProjectIdFromTab,
  useWorkspaceStore,
} from '@renderer/state/workspace';

export default function App() {
  return (
    <RouteErrorBoundary label="DevSpace">
      <AppInner />
    </RouteErrorBoundary>
  );
}

function AppInner() {
  useRenderTrace('AppInner');
  const [version, setVersion] = useState<string>('');
  const load = useWorkspaceStore((s) => s.load);
  const projects = useWorkspaceStore((s) => s.projects);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const openedProjectIds = useWorkspaceStore((s) => s.openedProjectIds);
  const openFile = useEditorStore((s) => s.open);
  const openCodeflow = useEditorStore((s) => s.openCodeflow);
  const openLivePreview = useEditorStore((s) => s.openLivePreview);
  const openDevlog = useEditorStore((s) => s.openDevlog);
  const openHtmlPreview = useEditorStore((s) => s.openHtmlPreview);
  // Stable identity so the memoized <FileTree> isn't re-rendered every shell
  // render by a fresh inline arrow. `open` is a stable store action.
  const handleOpenFile = useCallback((path: string) => void openFile(path), [openFile]);

  // Width values are intentionally NOT read here — they live in the
  // SidebarSection / DockSection leaf wrappers so a resize tick re-renders
  // only that one panel, not the whole AppInner shell. See ResizablePanels.tsx.
  const bottomHeight = useLayoutStore((s) => s.bottomHeight);
  const bottomOpen = useLayoutStore((s) => s.bottomOpen);
  // v0.14: sidebar collapse state (left = project/file tree; right = CLI dock).
  // Persisted to localStorage by the store itself — we just read/toggle here.
  const leftCollapsed = useSidebarStore((s) => s.leftCollapsed);
  const rightCollapsed = useSidebarStore((s) => s.rightCollapsed);
  const toggleLeftSidebar = useSidebarStore((s) => s.toggleLeft);
  const toggleRightSidebar = useSidebarStore((s) => s.toggleRight);
  // v0.30.5 — switching to a tab anchored to a different project should
  // move the sidebar (FileTree + ProjectList highlight + git store + chat
  // dock) to that project. One-way (tab → sidebar) — clicking the sidebar
  // never moves any tab, so this can't loop. Uses the pure helper from the
  // workspace store so the routing rules are testable in isolation.
  const activeTabPathRaw = useEditorStore((s) => s.activeTabPath);
  useEffect(() => {
    if (!activeTabPathRaw) return;
    const derived = deriveProjectIdFromTab(activeTabPathRaw, projects);
    if (derived && derived !== activeProjectId) {
      useWorkspaceStore.getState().setActiveProject(derived);
    }
  }, [activeTabPathRaw, projects, activeProjectId]);
  // v0.30.6 — parallel rule for the chat dock. Clicking the chat tab chip
  // already calls setActiveProject explicitly (ClaudeCliDock.handleSelect),
  // but other paths that change the active column don't:
  //   • Pane mousedown — only sets activeColumnId
  //   • addColumn / removeColumn / persisted-state restore
  // This effect derives the project from the active column's pin and syncs
  // sidebar. One-way (dock → sidebar). The reverse mirror lives in
  // ClaudeCliDock as `lastMirroredActiveRef`, which guards against firing
  // again when this effect just set activeProjectId — so no ping-pong loop.
  const dockColumns = useCliTabsStore((s) => s.columns);
  const dockActiveColumnId = useCliTabsStore((s) => s.activeColumnId);
  useEffect(() => {
    const derived = deriveProjectIdFromDockColumn(
      dockColumns,
      dockActiveColumnId,
      projects,
    );
    if (derived && derived !== activeProjectId) {
      useWorkspaceStore.getState().setActiveProject(derived);
    }
  }, [dockColumns, dockActiveColumnId, projects, activeProjectId]);
  const [bottomInitialTab, setBottomInitialTab] = useState<'terminal' | 'git' | 'search'>(
    'terminal',
  );
  const [quickOpen, setQuickOpen] = useState(false);
  const [spotlightOpen, setSpotlightOpen] = useState(false);
  const [goToLine, setGoToLine] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<
    | 'setup'
    | 'account'
    | 'files'
    | 'tmux'
    | 'llm'
    | 'agents'
    | 'mcp'
    | 'memory'
    | 'skills'
    | 'teams'
  >('account');

  useEffect(() => {
    // Defense-in-depth: validate the tab value against an allowlist before
    // routing — guards against arbitrary `setSettingsInitialTab` if XSS
    // ever surfaces in a renderer module and dispatches a forged event.
    const ALLOWED_TABS = new Set([
      'setup',
      'account',
      'files',
      'tmux',
      'llm',
      'agents',
      'mcp',
      'memory',
      'skills',
      'teams',
    ] as const);
    type AllowedTab = typeof ALLOWED_TABS extends Set<infer T> ? T : never;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ tab?: string }>).detail;
      if (detail?.tab && (ALLOWED_TABS as Set<string>).has(detail.tab)) {
        setSettingsInitialTab(detail.tab as AllowedTab);
      }
      setSettingsOpen(true);
    };
    window.addEventListener('devspace:open-settings', handler);
    return () => window.removeEventListener('devspace:open-settings', handler);
  }, []);
  const dockFull = useLayoutStore((s) => s.dockFull);
  const toggleDockFull = useLayoutStore((s) => s.toggleDockFull);
  const adjustSidebarWidth = useLayoutStore((s) => s.adjustSidebarWidth);
  const adjustDockWidth = useLayoutStore((s) => s.adjustDockWidth);
  const adjustBottomHeight = useLayoutStore((s) => s.adjustBottomHeight);
  const toggleBottom = useLayoutStore((s) => s.toggleBottom);
  const persistLayout = useLayoutStore((s) => s.persist);
  const teamMode = useLayoutStore((s) => s.teamMode);

  useEffect(() => {
    api.app
      .getVersion()
      .then(setVersion)
      .catch(() => setVersion('?'));
    void load();
    // Reapply persisted whole-app zoom on every boot. webFrame resets to 0
    // each window load, so without this the user's saved level would be
    // forgotten across restarts.
    useLayoutStore.getState().applyUiZoomLevel();
  }, [load]);

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );

  // Union of (active project) ∪ (docked projects) — one BottomPanel mounts
  // per id so each project's terminal tabs (and the dev servers running in
  // them) stay alive across project switches. Only the active panel is
  // visible; the rest sit at z-index 0 with pointer-events disabled.
  const dockedProjectsById = useCliTabsStore((s) => s.projectsById);
  const dockedOrder = useCliTabsStore((s) => s.dockedOrder);
  const bottomPanelProjects = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ id: string; path: string }> = [];
    if (activeProject) {
      seen.add(activeProject.id);
      out.push({ id: activeProject.id, path: activeProject.path });
    }
    for (const id of dockedOrder) {
      if (seen.has(id)) continue;
      const meta = dockedProjectsById[id];
      if (!meta) continue;
      seen.add(id);
      out.push({ id: meta.id, path: meta.path });
    }
    return out;
  }, [activeProject, dockedOrder, dockedProjectsById]);

  // Keep git status fresh for the active project — indicators in the file tree
  // and bottom panel should always reflect real state.
  const refreshGit = useGitStore((s) => s.refresh);
  useEffect(() => {
    if (!activeProject) return;
    void refreshGit(activeProject.id, activeProject.path);
    const id = window.setInterval(() => {
      void refreshGit(activeProject.id, activeProject.path);
    }, 15_000);
    const onFocus = () => void refreshGit(activeProject.id, activeProject.path);
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [activeProject, refreshGit]);

  // v0.31 — HTML preview auto-open / auto-refresh. For the ACTIVE project we
  // watch `<project>/.devspace/preview/` and react to PREVIEW_CHANGED events:
  //   • add    → open a fresh html-preview tab (the "magic" auto-open).
  //   • change → if a tab for that file is already open, reopen it (bumps
  //              reloadKey → iframe re-reads). If NOT open, do nothing — we
  //              never steal focus on a write the user isn't watching.
  //   • unlink → leave any open tab in place so it shows the "no longer
  //              exists" error on its next manual refresh. Simpler + non-
  //              destructive (we don't yank the user out of a tab they may
  //              still be reading), and avoids a close() call racing the
  //              watcher when the file is rewritten quickly.
  // Cleanup mirrors the git-refresh effect: the onChanged unsubscribe handle
  // is torn down whenever the active project changes or the app unmounts, so
  // we never carry a stale listener (and never double-subscribe a project).
  useEffect(() => {
    if (!activeProject) return;
    const projectPath = activeProject.path;
    let disposed = false;
    let off: (() => void) | undefined;

    void api.preview.subscribe(projectPath).catch(() => undefined);
    off = api.preview.onChanged(projectPath, (event) => {
      if (disposed) return;
      // Defensive: the channel is per-project, but guard against any
      // cross-project leakage before mutating editor state.
      if (event.projectPath !== projectPath) return;
      const { file, kind } = event;
      if (kind === 'add') {
        openHtmlPreview(projectPath, file.path, file.name);
      } else if (kind === 'change') {
        const tabKey = `html-preview:${file.path}`;
        const isOpen = useEditorStore
          .getState()
          .tabs.some((t) => t.path === tabKey);
        if (isOpen) openHtmlPreview(projectPath, file.path, file.name);
      }
      // kind === 'unlink' → intentionally no-op (see comment above).
    });

    return () => {
      disposed = true;
      off?.();
    };
  }, [activeProject, openHtmlPreview]);

  // Global shortcuts: Cmd+Shift+F = search, Cmd+P = quick open, Cmd+G = go-to-line,
  // Cmd+N = new file, Cmd+Shift+L = send editor selection to active Claude CLI pane.
  const setBottomOpen = useLayoutStore((s) => s.setBottomOpen);
  const askPrompt = usePromptStore((s) => s.ask);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (e.shiftKey && k === 'f') {
        e.preventDefault();
        setBottomInitialTab('search');
        setBottomOpen(true);
        return;
      }
      if (!e.shiftKey && !e.altKey && k === 'p') {
        e.preventDefault();
        setQuickOpen(true);
        return;
      }
      // v0.30.8 — Spotlight (Cmd+K). Multi-source (files + recent + commands
      // + settings routes) with prefix routing. Cmd+P remains as the
      // file-only fast path for users who learned it.
      if (!e.shiftKey && !e.altKey && k === 'k') {
        e.preventDefault();
        setSpotlightOpen(true);
        return;
      }
      // Cmd+N — create a new file in the active project, then open it as a
      // tab. Cmd+Shift+N is reserved for the "New Window" menu role, so we
      // only catch the plain Cmd+N here.
      if (!e.shiftKey && !e.altKey && k === 'n') {
        e.preventDefault();
        const project = useWorkspaceStore.getState().projects.find(
          (p) => p.id === useWorkspaceStore.getState().activeProjectId,
        );
        if (!project) return;
        askPrompt({
          title: 'New file',
          placeholder: 'filename.ext (or path/to/file.ext)',
          confirmLabel: 'Create',
          onConfirm: async (name) => {
            const trimmed = name.trim();
            if (!trimmed) return;
            const fullPath = `${project.path}/${trimmed}`;
            try {
              await api.fs.create(fullPath, 'file');
              await useEditorStore.getState().open(fullPath);
            } catch (err) {
              console.error('create file failed:', err);
            }
          },
        });
        return;
      }
      if (!e.shiftKey && !e.altKey && k === 'g') {
        e.preventDefault();
        setGoToLine(true);
        return;
      }
      if (e.shiftKey && k === 'l') {
        e.preventDefault();
        const sel = useEditorViewStore.getState().getSelection();
        if (!sel) return;
        const pid = useWorkspaceStore.getState().activeProjectId;
        if (!pid) return;
        const sessionId = useCliTabsStore.getState().getActiveSessionId(pid);
        if (!sessionId) return;
        void api.pty.write(sessionId, sel);
        return;
      }
      // Whole-app zoom: Cmd+= / Cmd+- / Cmd+0 — drives Electron's webFrame
      // so every pixel (chat, sidebar, editor, dialogs) scales together.
      // Editor-only font size remains adjustable via Settings.
      if (!e.shiftKey && !e.altKey && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        useLayoutStore.getState().adjustUiZoomLevel(1);
        useLayoutStore.getState().persist();
        return;
      }
      if (!e.shiftKey && !e.altKey && e.key === '-') {
        e.preventDefault();
        useLayoutStore.getState().adjustUiZoomLevel(-1);
        useLayoutStore.getState().persist();
        return;
      }
      if (!e.shiftKey && !e.altKey && e.key === '0') {
        e.preventDefault();
        useLayoutStore.getState().resetUiZoomLevel();
        useLayoutStore.getState().persist();
        return;
      }
      // Word wrap toggle: Cmd+Alt+Z
      if (e.altKey && !e.shiftKey && k === 'z') {
        e.preventDefault();
        useLayoutStore.getState().toggleWordWrap();
        useLayoutStore.getState().persist();
        return;
      }
      // v0.14: sidebar collapse shortcuts.
      //   Cmd+\        → toggle LEFT sidebar (project tree)
      //   Cmd+Shift+\  → toggle RIGHT sidebar (CLI dock)
      // Match by `e.key` (the resolved character) rather than `e.code`
      // so keyboard layouts that move `\` still work.
      if (e.key === '\\') {
        e.preventDefault();
        if (e.shiftKey) {
          useSidebarStore.getState().toggleRight();
        } else {
          useSidebarStore.getState().toggleLeft();
        }
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setBottomOpen, askPrompt]);

  // v0.30.8 — Command registry for Spotlight (Cmd+K). Built fresh per
  // active-project change so commands close over the right paths/IDs but
  // remain stable across re-renders within the same project (memo keys).
  // We dispatch `devspace:open-settings` for Settings routes — same event
  // the navbar uses — so there's a single code path for "open Settings → X".
  const spotlightCommands = useMemo<SpotlightCommand[]>(() => {
    const openSettings = (tab: string) =>
      window.dispatchEvent(
        new CustomEvent('devspace:open-settings', { detail: { tab } }),
      );
    const cmds: SpotlightCommand[] = [
      // Navigation (top of mind for most flows)
      {
        id: 'nav.codeflow',
        title: 'Open Codeflow',
        keywords: 'codebase visualization architecture',
        group: 'Navigate',
        requiresProject: true,
        run: () => {
          if (activeProject) openCodeflow(activeProject.path, activeProject.name);
        },
      },
      {
        id: 'nav.livepreview',
        title: 'Open Live Preview',
        keywords: 'dev server webview browser',
        group: 'Navigate',
        requiresProject: true,
        run: () => {
          if (activeProject) openLivePreview(activeProject.path, activeProject.name);
        },
      },
      {
        id: 'nav.devlog',
        title: 'Open Devlog',
        keywords: 'log plans results agents',
        group: 'Navigate',
        requiresProject: true,
        run: () => {
          if (activeProject) openDevlog(activeProject.path, activeProject.name);
        },
      },
      {
        // v0.31 — opens the most-recently-modified HTML preview Claude wrote
        // under `.devspace/preview/`. Scoped small per the brief: a single
        // "latest" entry point rather than a full file picker. Lists + picks
        // async on activation so the command list stays cheap to build.
        id: 'nav.htmlpreview',
        title: 'Open latest HTML preview',
        keywords: 'html preview design claude generated page',
        group: 'Navigate',
        requiresProject: true,
        run: () => {
          if (!activeProject) return;
          const projectPath = activeProject.path;
          void api.preview
            .list(projectPath)
            .then((files) => {
              const latest = pickLatestPreview(files);
              if (latest) openHtmlPreview(projectPath, latest.path, latest.name);
            })
            .catch(() => undefined);
        },
      },
      // Editor toggles
      {
        id: 'layout.bottom',
        title: 'Toggle bottom panel',
        keywords: 'terminal git search show hide',
        group: 'Editor',
        run: () => {
          useLayoutStore.getState().toggleBottom();
          useLayoutStore.getState().persist();
        },
      },
      {
        id: 'layout.wrap',
        title: 'Toggle word wrap',
        keywords: 'soft hard editor line break',
        shortcut: '⌘⌥Z',
        group: 'Editor',
        run: () => {
          useLayoutStore.getState().toggleWordWrap();
          useLayoutStore.getState().persist();
        },
      },
      {
        id: 'layout.left',
        title: 'Toggle left sidebar',
        keywords: 'project files panel collapse',
        shortcut: '⌘\\',
        group: 'Editor',
        run: () => useSidebarStore.getState().toggleLeft(),
      },
      {
        id: 'layout.right',
        title: 'Toggle right sidebar (CLI dock)',
        keywords: 'claude chat panel collapse',
        shortcut: '⌘⇧\\',
        group: 'Editor',
        run: () => useSidebarStore.getState().toggleRight(),
      },
      {
        id: 'layout.dockfull',
        title: 'Toggle full CLI width',
        keywords: 'expand maximize claude',
        group: 'Editor',
        run: () => {
          useLayoutStore.getState().toggleDockFull();
          useLayoutStore.getState().persist();
        },
      },
      {
        id: 'layout.hidden',
        title: 'Toggle hidden files',
        keywords: 'dotfiles show .git .env',
        group: 'Editor',
        run: () => {
          useLayoutStore.getState().toggleShowHidden();
          useLayoutStore.getState().persist();
        },
      },
      // Zoom
      {
        id: 'zoom.in',
        title: 'Zoom in',
        keywords: 'larger bigger increase ui',
        shortcut: '⌘=',
        group: 'Editor',
        run: () => {
          useLayoutStore.getState().adjustUiZoomLevel(1);
          useLayoutStore.getState().persist();
        },
      },
      {
        id: 'zoom.out',
        title: 'Zoom out',
        keywords: 'smaller decrease ui',
        shortcut: '⌘-',
        group: 'Editor',
        run: () => {
          useLayoutStore.getState().adjustUiZoomLevel(-1);
          useLayoutStore.getState().persist();
        },
      },
      {
        id: 'zoom.reset',
        title: 'Reset zoom',
        keywords: '100 default ui',
        shortcut: '⌘0',
        group: 'Editor',
        run: () => {
          useLayoutStore.getState().resetUiZoomLevel();
          useLayoutStore.getState().persist();
        },
      },
      // Settings routes — all use the existing devspace:open-settings event
      { id: 'settings.account', title: 'Open Account settings', keywords: 'profile login', group: 'Settings', run: () => openSettings('account') },
      { id: 'settings.setup', title: 'Open Setup checklist', keywords: 'onboarding install brew claude', group: 'Settings', run: () => openSettings('setup') },
      { id: 'settings.files', title: 'Open Files settings', keywords: 'workspace ignore patterns', group: 'Settings', run: () => openSettings('files') },
      { id: 'settings.tmux', title: 'Open tmux settings', keywords: 'sessions chat runner', group: 'Settings', run: () => openSettings('tmux') },
      { id: 'settings.llm', title: 'Open LLM settings', keywords: 'openai anthropic profiles api', group: 'Settings', run: () => openSettings('llm') },
      { id: 'settings.agents', title: 'Open Agents settings', keywords: 'subagent task team', group: 'Settings', run: () => openSettings('agents') },
      { id: 'settings.mcp', title: 'Open MCP settings', keywords: 'model context protocol server', group: 'Settings', run: () => openSettings('mcp') },
      { id: 'settings.memory', title: 'Open Memory settings', keywords: 'remember devlog notes', group: 'Settings', run: () => openSettings('memory') },
      { id: 'settings.skills', title: 'Open Skills settings', keywords: 'skill catalog forge', group: 'Settings', run: () => openSettings('skills') },
      { id: 'settings.teams', title: 'Open Teams settings', keywords: 'multi-agent team', group: 'Settings', run: () => openSettings('teams') },
    ];
    return cmds;
  }, [activeProject, openCodeflow, openLivePreview, openDevlog, openHtmlPreview]);

  const dockVisible = openedProjectIds.length > 0;
  const showBottom = bottomOpen && activeProject;

  return (
    <div className="flex h-full flex-col">
      <header
        className="drag-region flex h-10 shrink-0 items-center justify-between border-b border-border px-4"
        style={{
          background:
            'linear-gradient(180deg, var(--color-surface-2) 0%, var(--color-surface) 100%)',
        }}
      >
        <div className="flex items-center gap-3 pl-24">
          <div
            className="h-[18px] w-[18px] rounded-[5px]"
            style={{
              background: 'linear-gradient(135deg, var(--color-accent), #a855f7)',
              boxShadow: '0 0 12px var(--color-accent-glow)',
            }}
            aria-hidden
          />
          <span className="text-[12.5px] font-semibold text-text">devspace</span>
          <UpdateBadge fallbackVersion={version || '?'} />
          {activeProject && (
            <span
              className="ml-2 flex items-center gap-1.5 rounded-[7px] border border-border-subtle bg-surface-3 px-2.5 py-[3px] text-[11.5px] text-text-secondary"
              title={activeProject.path}
            >
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-semantic-success"
                style={{ boxShadow: '0 0 6px #22c55e' }}
              />
              <span className="truncate">{activeProject.name}</span>
            </span>
          )}
        </div>
        <div className="no-drag flex items-center gap-1.5">
          {/* v0.30.8 — Spotlight (Cmd+K) — visible affordance so users
              don't have to memorize the shortcut. Sits at the front of the
              right action group so it reads first ("search → then actions"). */}
          <button
            onClick={() => setSpotlightOpen(true)}
            className="inline-flex h-[26px] items-center gap-1.5 rounded-[7px] border border-border-subtle bg-surface-3 px-2.5 text-[11px] text-text-secondary transition hover:border-border-hi hover:bg-surface-4 hover:text-text"
            title="Search files, commands, settings… (⌘K)"
          >
            <Search size={11} />
            <span>Search</span>
            <kbd className="ml-1 rounded bg-surface-4/60 px-1 text-[9.5px] text-text-muted">⌘K</kbd>
          </button>
          <button
            onClick={() => {
              if (activeProject) openCodeflow(activeProject.path, activeProject.name);
            }}
            disabled={!activeProject}
            className={cn(
              'inline-flex h-[26px] items-center gap-1.5 rounded-[7px] border px-2.5 text-[11px] transition',
              !activeProject
                ? 'cursor-not-allowed border-border-subtle bg-surface-3 text-text-muted opacity-40'
                : 'border-border-subtle bg-surface-3 text-text-secondary hover:border-border-hi hover:bg-surface-4 hover:text-text',
            )}
            title="Codeflow — codebase visualization + Claude-generated architecture docs"
          >
            <Workflow size={11} />
            <span>Codeflow</span>
          </button>
          <button
            onClick={() => {
              if (activeProject) openLivePreview(activeProject.path, activeProject.name);
            }}
            disabled={!activeProject}
            className={cn(
              'inline-flex h-[26px] items-center gap-1.5 rounded-[7px] border px-2.5 text-[11px] transition',
              !activeProject
                ? 'cursor-not-allowed border-border-subtle bg-surface-3 text-text-muted opacity-40'
                : 'border-border-subtle bg-surface-3 text-text-secondary hover:border-border-hi hover:bg-surface-4 hover:text-text',
            )}
            title="Live Preview — auto-detect dev server and view the running app inline"
          >
            <Globe size={11} />
            <span>Live Preview</span>
          </button>
          <button
            onClick={() => {
              if (activeProject) openDevlog(activeProject.path, activeProject.name);
            }}
            disabled={!activeProject}
            className={cn(
              'inline-flex h-[26px] items-center gap-1.5 rounded-[7px] border px-2.5 text-[11px] transition',
              !activeProject
                ? 'cursor-not-allowed border-border-subtle bg-surface-3 text-text-muted opacity-40'
                : 'border-border-subtle bg-surface-3 text-text-secondary hover:border-border-hi hover:bg-surface-4 hover:text-text',
            )}
            title="Devlog — plans, agents, results, and daily log per project"
          >
            <BookOpen size={11} />
            <span>Devlog</span>
          </button>
          <button
            onClick={() => {
              // Teams now live in the new chat-based system at
              // Settings → Teams. Jump there directly so this button
              // doubles as both "create a team" and "manage teams".
              setSettingsInitialTab('teams');
              setSettingsOpen(true);
            }}
            disabled={!activeProject}
            className={cn(
              'inline-flex h-[26px] items-center gap-1.5 rounded-[7px] px-3 text-[11.5px] font-medium text-white transition',
              !activeProject
                ? 'cursor-not-allowed opacity-40'
                : 'hover:brightness-110',
            )}
            style={{
              background: 'linear-gradient(135deg, var(--color-accent), var(--color-accent-3))',
              boxShadow: '0 2px 8px var(--color-accent-glow)',
            }}
            title="Manage teams — Settings → Teams"
          >
            <Users size={11.5} strokeWidth={2.2} />
            <span>Create team</span>
          </button>
          {dockVisible && (
            <button
              onClick={() => {
                toggleDockFull();
                persistLayout();
              }}
              className={cn(
                'inline-flex h-[26px] items-center gap-1.5 rounded-[7px] border px-2.5 text-[11px] transition',
                dockFull
                  ? 'border-accent bg-surface-4 text-text'
                  : 'border-border-subtle bg-surface-3 text-text-secondary hover:border-border-hi hover:bg-surface-4 hover:text-text',
              )}
              title={
                dockFull
                  ? 'Collapse CLI to standard width (bring editor back)'
                  : 'Expand CLI to full width (hides editor until collapsed)'
              }
            >
              {dockFull ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
              <span>{dockFull ? 'Collapse' : 'Full CLI'}</span>
            </button>
          )}
          <button
            onClick={() => {
              toggleBottom();
              persistLayout();
            }}
            className={cn(
              'inline-flex h-[26px] items-center gap-1 rounded-[7px] border px-2.5 text-[11px] transition',
              bottomOpen
                ? 'border-accent bg-surface-4 text-text'
                : 'border-border-subtle bg-surface-3 text-text-secondary hover:border-border-hi hover:bg-surface-4 hover:text-text',
            )}
            title="Toggle bottom panel (terminal / git / search)"
          >
            <TerminalIcon size={11} />
            <GitBranch size={11} />
          </button>
        </div>
      </header>

      <SetupBanner
        onOpenSetup={() => {
          setSettingsInitialTab('setup');
          setSettingsOpen(true);
        }}
      />

      <main className="flex flex-1 overflow-hidden">
        {teamMode !== 'focus' && leftCollapsed && (
          // Collapsed rail — thin 36px column with just an expand button.
          // We keep the rail visible (not fully hidden) so users can
          // always find their way back. CSS transition smooths the
          // width change when the user toggles via the keyboard
          // shortcut or button.
          <aside
            aria-label="Sidebar (collapsed)"
            className="no-drag relative flex w-9 shrink-0 flex-col items-center border-r border-border bg-surface-sidebar transition-[width] duration-150"
          >
            <button
              type="button"
              onClick={toggleLeftSidebar}
              title="Expand sidebar (⌘\\)"
              className="mt-2 flex h-7 w-7 items-center justify-center rounded-[6px] text-text-muted transition hover:bg-surface-3 hover:text-text"
            >
              <PanelLeftOpen size={13} />
            </button>
          </aside>
        )}
        {teamMode !== 'focus' && !leftCollapsed && (
        <SidebarSection>
          {/* Subtle top sheen */}
          <div
            className="pointer-events-none absolute left-0 right-0 top-0 h-[100px]"
            style={{
              background: 'linear-gradient(180deg, rgba(76,141,255,0.04), transparent)',
            }}
          />

          <div
            className="relative z-[1] flex shrink-0 items-center gap-2 border-b border-border px-3 py-3"
            style={{
              background: 'linear-gradient(180deg, rgba(168,85,247,0.04), transparent)',
            }}
          >
            <div className="min-w-0 flex-1">
              <WorkspacePicker />
            </div>
            <button
              type="button"
              onClick={toggleLeftSidebar}
              title="Collapse sidebar (⌘\\)"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] text-text-muted transition hover:bg-surface-3 hover:text-text"
            >
              <PanelLeftClose size={12} />
            </button>
          </div>

          <div
            className="relative z-[1] flex shrink-0 flex-col border-b border-border-subtle py-2"
            style={{ maxHeight: '40vh' }}
          >
            <div className="min-h-0 flex-1 overflow-y-auto">
              <ProjectList />
            </div>
          </div>

          {activeProject && (
            <div className="relative z-[1] flex min-h-0 flex-1 flex-col overflow-y-auto">
              <div className="sticky top-0 z-[2] flex items-center justify-between border-b border-border-subtle bg-surface-sidebar/95 px-3 py-2.5 backdrop-blur">
                <span className="flex items-center gap-1.5 truncate text-[11px] font-semibold text-text">
                  <span
                    className="flex h-[14px] w-[14px] items-center justify-center rounded-[4px]"
                    style={{
                      background: 'linear-gradient(135deg, #fbbf24, #f59e0b)',
                      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.15)',
                    }}
                  >
                    <span className="text-[8px] text-white">▮</span>
                  </span>
                  <span className="truncate">{activeProject.name}</span>
                </span>
                <HiddenToggle />
              </div>
              <div className="flex-1 px-1 py-1">
                <FileTree
                  rootPath={activeProject.path}
                  onOpenFile={handleOpenFile}
                />
              </div>
            </div>
          )}

          {activeProject && (
            <SidebarFooter
              projectPath={activeProject.path}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          )}
        </SidebarSection>
        )}

        {teamMode !== 'focus' && !leftCollapsed && (
          <Resizer
            direction="horizontal"
            onResize={adjustSidebarWidth}
            onResizeEnd={persistLayout}
          />
        )}

        {settingsOpen ? (
          <SettingsPage
            initialTab={settingsInitialTab}
            onClose={() => setSettingsOpen(false)}
          />
        ) : (
          !dockFull && teamMode !== 'focus' && (
          <section className="flex min-w-0 flex-1 flex-col">
            {activeProject ? (
              <>
                <section className="flex min-h-0 flex-1 flex-col">
                  <EditorArea />
                </section>

                {showBottom && (
                  <>
                    <Resizer
                      direction="vertical"
                      onResize={(dy) => adjustBottomHeight(-dy)}
                      onResizeEnd={persistLayout}
                    />
                    <section
                      style={{ height: bottomHeight }}
                      className="relative shrink-0 border-t border-border bg-surface"
                    >
                      {bottomPanelProjects.map((p) => (
                        <div
                          key={p.id}
                          className="absolute inset-0"
                          style={{
                            visibility: p.id === activeProject.id ? 'visible' : 'hidden',
                            zIndex: p.id === activeProject.id ? 1 : 0,
                            pointerEvents: p.id === activeProject.id ? 'auto' : 'none',
                          }}
                        >
                          <BottomPanel
                            projectId={p.id}
                            projectPath={p.path}
                            initialTab={
                              p.id === activeProject.id ? bottomInitialTab : undefined
                            }
                            isVisible={p.id === activeProject.id}
                          />
                        </div>
                      ))}
                    </section>
                  </>
                )}
              </>
            ) : (
              <Welcome version={version} />
            )}
          </section>
          )
        )}

        {!settingsOpen && dockVisible && (
          <>
            {/*
              v0.14: when the right sidebar is collapsed AND we're not in
              an explicit full/focus mode, render a thin rail instead of
              the full ClaudeCliDock. The dockFull / teamMode==='focus'
              affordances WIN over collapse — they're explicit overrides
              the user set themselves, so we don't second-guess them.
            */}
            {rightCollapsed && !dockFull && teamMode !== 'focus' ? (
              <aside
                aria-label="CLI dock (collapsed)"
                className="no-drag relative flex w-9 shrink-0 flex-col items-center border-l border-border bg-surface transition-[width] duration-150"
              >
                <button
                  type="button"
                  onClick={toggleRightSidebar}
                  title="Expand CLI dock (⌘⇧\\)"
                  className="mt-2 flex h-7 w-7 items-center justify-center rounded-[6px] text-text-muted transition hover:bg-surface-3 hover:text-text"
                >
                  <PanelRightOpen size={13} />
                </button>
              </aside>
            ) : (
              <>
                {!dockFull && teamMode !== 'focus' && (
                  <Resizer
                    direction="horizontal"
                    onResize={(dx) => adjustDockWidth(-dx)}
                    onResizeEnd={persistLayout}
                  />
                )}
                <DockSection full={dockFull || teamMode === 'focus'}>
                  {/*
                    Collapse affordance — only shown when the user could
                    actually collapse. In dockFull / focus mode the dock
                    is the main work area, so collapsing it would hide
                    the user's entire workspace. We hide the button there.
                  */}
                  {!dockFull && teamMode !== 'focus' && (
                    <button
                      type="button"
                      onClick={toggleRightSidebar}
                      title="Collapse CLI dock (⌘⇧\\)"
                      className="absolute left-2 top-2 z-[3] flex h-6 w-6 items-center justify-center rounded-[5px] bg-surface-3/80 text-text-muted backdrop-blur transition hover:bg-surface-4 hover:text-text"
                    >
                      <PanelRightClose size={12} />
                    </button>
                  )}
                  <ClaudeCliDock />
                </DockSection>
              </>
            )}
          </>
        )}

        {/* Agents rail — tmux pane navigator for native Claude agent teams */}
        {!settingsOpen && dockVisible && teamMode !== 'off' && activeProject && (
          <AgentsRail slim={teamMode === 'focus'} />
        )}
      </main>

      <QuickOpenDialog
        open={quickOpen}
        onOpenChange={setQuickOpen}
        projectPath={activeProject?.path ?? null}
      />
      <SpotlightDialog
        open={spotlightOpen}
        onOpenChange={setSpotlightOpen}
        projectPath={activeProject?.path ?? null}
        workspaceId={activeProject?.workspaceId ?? null}
        commands={spotlightCommands}
      />
      <GoToLineDialog open={goToLine} onOpenChange={setGoToLine} />
      <PromptHost />
      {/* v0.36.0 — resource-management toast surface (idle-CLI auto-close,
          future cleanup events). App-root scoped so it sits above every
          panel and isn't bound to any one feature's mount lifecycle. */}
      <ResourceToastHost />
    </div>
  );
}

function PromptHost() {
  const request = usePromptStore((s) => s.request);
  const dismiss = usePromptStore((s) => s.dismiss);
  return <PromptDialog request={request} onClose={dismiss} />;
}

function HiddenToggle() {
  const showHidden = useLayoutStore((s) => s.showHiddenFiles);
  const toggle = useLayoutStore((s) => s.toggleShowHidden);
  const persist = useLayoutStore((s) => s.persist);
  return (
    <button
      onClick={() => {
        toggle();
        persist();
      }}
      title={showHidden ? 'Hide dotfiles' : 'Show hidden files'}
      className={cn(
        'flex h-4 w-4 items-center justify-center rounded transition',
        showHidden
          ? 'text-accent hover:bg-surface-overlay'
          : 'text-text-muted hover:bg-surface-overlay hover:text-text',
      )}
    >
      {showHidden ? <Eye size={11} /> : <EyeOff size={11} />}
    </button>
  );
}
