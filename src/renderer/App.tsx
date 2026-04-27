import {
  Eye,
  EyeOff,
  GitBranch,
  Layers,
  Maximize2,
  Minimize2,
  Terminal as TerminalIcon,
  Users,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { AgentsRail } from '@renderer/components/Agents/AgentsRail';
import { BottomPanel } from '@renderer/components/Bottom/BottomPanel';
import { GoToLineDialog } from '@renderer/components/CommandPalette/GoToLineDialog';
import { PromptDialog } from '@renderer/components/CommandPalette/PromptDialog';
import { QuickOpenDialog } from '@renderer/components/CommandPalette/QuickOpenDialog';
import { ClaudeCliDock } from '@renderer/components/Dock/ClaudeCliDock';
import { EditorArea } from '@renderer/components/Editor/EditorArea';
import { Resizer } from '@renderer/components/Layout/Resizer';
import { SettingsPage } from '@renderer/components/Settings/SettingsPage';
import { CreateTeamDialog } from '@renderer/components/Team/CreateTeamDialog';
import { FileTree } from '@renderer/components/Sidebar/FileTree';
import { ProjectList } from '@renderer/components/Sidebar/ProjectList';
import { SidebarFooter } from '@renderer/components/Sidebar/SidebarFooter';
import { WorkspacePicker } from '@renderer/components/Sidebar/WorkspacePicker';
import { Welcome } from '@renderer/components/Welcome/Welcome';
import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import { useEditorStore } from '@renderer/state/editor';
import { useCliTabsStore } from '@renderer/state/cliTabs';
import { useEditorViewStore } from '@renderer/state/editorView';
import { useGitStore } from '@renderer/state/git';
import { useLayoutStore } from '@renderer/state/layout';
import { usePromptStore } from '@renderer/state/prompt';
import { useWorkspaceStore } from '@renderer/state/workspace';

export default function App() {
  const [version, setVersion] = useState<string>('');
  const load = useWorkspaceStore((s) => s.load);
  const projects = useWorkspaceStore((s) => s.projects);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const openedProjectIds = useWorkspaceStore((s) => s.openedProjectIds);
  const openFile = useEditorStore((s) => s.open);

  const sidebarWidth = useLayoutStore((s) => s.sidebarWidth);
  const dockWidth = useLayoutStore((s) => s.dockWidth);
  const bottomHeight = useLayoutStore((s) => s.bottomHeight);
  const bottomOpen = useLayoutStore((s) => s.bottomOpen);
  const [bottomInitialTab, setBottomInitialTab] = useState<'terminal' | 'git' | 'search'>(
    'terminal',
  );
  const [quickOpen, setQuickOpen] = useState(false);
  const [goToLine, setGoToLine] = useState(false);
  const [createTeamOpen, setCreateTeamOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const dockFull = useLayoutStore((s) => s.dockFull);
  const toggleDockFull = useLayoutStore((s) => s.toggleDockFull);
  const adjustSidebarWidth = useLayoutStore((s) => s.adjustSidebarWidth);
  const adjustDockWidth = useLayoutStore((s) => s.adjustDockWidth);
  const adjustBottomHeight = useLayoutStore((s) => s.adjustBottomHeight);
  const toggleBottom = useLayoutStore((s) => s.toggleBottom);
  const persistLayout = useLayoutStore((s) => s.persist);
  const teamMode = useLayoutStore((s) => s.teamMode);
  const cycleTeamMode = useLayoutStore((s) => s.cycleTeamMode);

  useEffect(() => {
    api.app
      .getVersion()
      .then(setVersion)
      .catch(() => setVersion('?'));
    void load();
  }, [load]);

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );

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

  // Global shortcuts: Cmd+Shift+F = search, Cmd+P = quick open, Cmd+G = go-to-line,
  // Cmd+Shift+L = send editor selection to active Claude CLI pane.
  const setBottomOpen = useLayoutStore((s) => s.setBottomOpen);
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
      // Editor zoom: Cmd+= / Cmd+- / Cmd+0
      if (!e.shiftKey && !e.altKey && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        useLayoutStore.getState().adjustEditorFontSize(1);
        useLayoutStore.getState().persist();
        return;
      }
      if (!e.shiftKey && !e.altKey && e.key === '-') {
        e.preventDefault();
        useLayoutStore.getState().adjustEditorFontSize(-1);
        useLayoutStore.getState().persist();
        return;
      }
      if (!e.shiftKey && !e.altKey && e.key === '0') {
        e.preventDefault();
        useLayoutStore.getState().resetEditorFontSize();
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
      // Team mode cycle: Cmd+Shift+T (off → team → focus → off)
      if (e.shiftKey && !e.altKey && k === 't') {
        e.preventDefault();
        useLayoutStore.getState().cycleTeamMode();
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setBottomOpen]);
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
          <span className="text-[10.5px] text-text-dim">v{version}</span>
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
          <button
            onClick={() => setCreateTeamOpen(true)}
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
            title="Create Claude agent team"
          >
            <Users size={11.5} strokeWidth={2.2} />
            <span>Create team</span>
          </button>
          {dockVisible && (
            <button
              onClick={() => cycleTeamMode()}
              className={cn(
                'inline-flex h-[26px] items-center gap-1.5 rounded-[7px] border px-2.5 text-[11px] transition',
                teamMode !== 'off'
                  ? 'border-[#a855f7] bg-surface-4 text-text'
                  : 'border-border-subtle bg-surface-3 text-text-secondary hover:border-border-hi hover:bg-surface-4 hover:text-text',
              )}
              title={`Team mode: ${teamMode} · ⌘⇧T to cycle (off → team → focus)`}
              style={
                teamMode !== 'off'
                  ? { boxShadow: '0 0 0 1px rgba(168,85,247,0.25), 0 2px 8px rgba(168,85,247,0.18)' }
                  : undefined
              }
            >
              <Layers size={11} />
              <span>{teamMode === 'off' ? 'Team' : teamMode === 'team' ? 'Team' : 'Focus'}</span>
            </button>
          )}
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

      <main className="flex flex-1 overflow-hidden">
        {teamMode !== 'focus' && (
        <aside
          style={{ width: sidebarWidth }}
          className="no-drag relative flex shrink-0 flex-col border-r border-border bg-surface-sidebar"
        >
          {/* Subtle top sheen */}
          <div
            className="pointer-events-none absolute left-0 right-0 top-0 h-[100px]"
            style={{
              background: 'linear-gradient(180deg, rgba(76,141,255,0.04), transparent)',
            }}
          />

          <div
            className="relative z-[1] shrink-0 border-b border-border px-3 py-3"
            style={{
              background: 'linear-gradient(180deg, rgba(168,85,247,0.04), transparent)',
            }}
          >
            <WorkspacePicker />
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
                  onOpenFile={(path) => void openFile(path)}
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
        </aside>
        )}

        {teamMode !== 'focus' && (
          <Resizer
            direction="horizontal"
            onResize={adjustSidebarWidth}
            onResizeEnd={persistLayout}
          />
        )}

        {settingsOpen ? (
          <SettingsPage onClose={() => setSettingsOpen(false)} />
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
                      className="shrink-0 border-t border-border bg-surface"
                    >
                      <BottomPanel
                        projectId={activeProject.id}
                        projectPath={activeProject.path}
                        initialTab={bottomInitialTab}
                      />
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
            {!dockFull && teamMode !== 'focus' && (
              <Resizer
                direction="horizontal"
                onResize={(dx) => adjustDockWidth(-dx)}
                onResizeEnd={persistLayout}
              />
            )}
            <section
              style={
                dockFull || teamMode === 'focus' ? undefined : { width: dockWidth }
              }
              className={cn(
                'no-drag flex flex-col border-l border-border bg-surface',
                dockFull || teamMode === 'focus' ? 'min-w-0 flex-1' : 'shrink-0',
              )}
            >
              <ClaudeCliDock />
            </section>
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
      <GoToLineDialog open={goToLine} onOpenChange={setGoToLine} />
      <PromptHost />
      <CreateTeamDialog
        open={createTeamOpen}
        onOpenChange={setCreateTeamOpen}
        projectId={activeProject?.id ?? null}
      />
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
