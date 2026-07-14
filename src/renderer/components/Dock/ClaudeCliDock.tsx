import { Plus, SquareTerminal, X } from 'lucide-react';
import { lazy, memo, Suspense, useEffect, useRef, useState } from 'react';

import { CliTabBar, MAX_COLUMNS } from '@renderer/components/Dock/CliTabBar';
import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import { useRenderTrace } from '@renderer/lib/renderTrace';
import { activate } from '@renderer/state/activation';
import { useCliTabsStore } from '@renderer/state/cliTabs';
import { pickAutoPinTab } from '@renderer/state/cliTabsPins';
import { useWorkspaceStore } from '@renderer/state/workspace';
import type { CliProfile, DockedProjectMeta } from '@shared/types';

// xterm is ~200KB and only matters once the first project is opened.
const ClaudeCliPane = lazy(() =>
  import('@renderer/components/Dock/ClaudeCliPane').then((m) => ({
    default: m.ClaudeCliPane,
  })),
);

/**
 * Mounts a ClaudeCliPane for every (project, tab) currently docked. The
 * dock supports up to MAX_COLUMNS side-by-side columns; each column "pins"
 * one (project, tab) pair, and a chip click retargets the pin of the
 * currently-active column. Panes stay mounted across pin changes so PTY
 * output keeps streaming and xterm scrollback survives.
 */
export const ClaudeCliDock = memo(function ClaudeCliDock() {
  useRenderTrace('ClaudeCliDock');
  const projects = useWorkspaceStore((s) => s.projects);
  const openedProjectIds = useWorkspaceStore((s) => s.openedProjectIds);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const projectsById = useCliTabsStore((s) => s.projectsById);
  const dockedOrder = useCliTabsStore((s) => s.dockedOrder);
  const tabsByProject = useCliTabsStore((s) => s.tabsByProject);
  const activeDockedProjectId = useCliTabsStore((s) => s.activeDockedProjectId);
  const columns = useCliTabsStore((s) => s.columns);
  const activeColumnId = useCliTabsStore((s) => s.activeColumnId);
  const dockProject = useCliTabsStore((s) => s.dockProject);
  const setActiveDockedProject = useCliTabsStore((s) => s.setActiveDockedProject);
  const removeColumn = useCliTabsStore((s) => s.removeColumn);
  const setColumnPin = useCliTabsStore((s) => s.setColumnPin);
  const splitForTab = useCliTabsStore((s) => s.splitForTab);
  const chooseTabCli = useCliTabsStore((s) => s.chooseTabCli);

  // Toggled by TabChip's drag handlers so the drop zones only appear while
  // the user is mid-drag. Bare CSS dnd would over-invalidate too aggressively
  // and steal space from the panes when nothing is happening.
  const [isDragActive, setIsDragActive] = useState(false);
  const [launcherProfiles, setLauncherProfiles] = useState<CliProfile[]>([]);

  useEffect(() => {
    void Promise.all([
      api.cli.listProfiles('opencode'),
      api.cli.listProfiles('codex'),
    ])
      .then(([opencode, codex]) => setLauncherProfiles([...opencode, ...codex]))
      .catch(() => setLauncherProfiles([]));
  }, []);

  // Initial restore: dock every project the workspace says is opened. The
  // re-open flow (sidebar click after Close project) is handled inside
  // workspaceStore.setActiveProject, which calls dockProject directly so
  // the chip reappears even when activeProjectId hadn't actually changed.
  useEffect(() => {
    for (const id of openedProjectIds) {
      const p = projects.find((proj) => proj.id === id);
      if (!p) continue;
      dockProject({
        id: p.id,
        name: p.name,
        path: p.path,
        workspaceId: p.workspaceId,
      });
    }
  }, [openedProjectIds, projects, dockProject]);

  // Mirror the sidebar's selection into the dock — but ONLY when the
  // workspace's active project actually changes. A naive
  // dep-on-activeDockedProjectId would re-fire after the user clicks a
  // cross-workspace chip (which updates activeDockedProjectId), snapping
  // the dock back to the workspace's selection and making the chip click
  // appear to do nothing.
  const lastMirroredActiveRef = useRef<string | null>(null);
  // One-shot boot guard: never reset, even when activeProjectId goes null —
  // a mid-session workspace switch passes through null→non-null, and
  // inferring "boot" from a null ref would wrongly skip the mirror there.
  const bootMirrorDoneRef = useRef(false);
  useEffect(() => {
    if (activeProjectId) {
      if (lastMirroredActiveRef.current !== activeProjectId) {
        lastMirroredActiveRef.current = activeProjectId;
        const isBootEdge = !bootMirrorDoneRef.current;
        bootMirrorDoneRef.current = true;
        if (isBootEdge) {
          // Boot restore: if the persisted active column already shows a live
          // (project, tab) — possibly a cross-workspace chat — keep it instead
          // of re-pinning to the workspace's restored project. getState() (not
          // subscriptions) so the effect deps stay [activeProjectId, ...].
          const s = useCliTabsStore.getState();
          const col = s.columns.find((c) => c.id === s.activeColumnId);
          const pinValid =
            !!col?.pin &&
            !!s.tabsByProject[col.pin.projectId]?.some(
              (t) => t.id === col.pin!.tabId,
            );
          if (pinValid) return;
        }
        setActiveDockedProject(activeProjectId);
      }
    } else {
      lastMirroredActiveRef.current = null;
    }
  }, [activeProjectId, setActiveDockedProject]);

  // A persisted active pin is the strongest signal of where the user was
  // working when the app closed. Restore its owning workspace/project once
  // boot hydration has supplied an active workspace, without moving tabs or
  // creating a new session.
  const bootActivationDoneRef = useRef(false);
  useEffect(() => {
    if (bootActivationDoneRef.current || !activeProjectId) return;
    const s = useCliTabsStore.getState();
    const col = s.columns.find((c) => c.id === s.activeColumnId);
    if (!col?.pin) return;
    const tabExists = s.tabsByProject[col.pin.projectId]?.some(
      (tab) => tab.id === col.pin!.tabId,
    );
    if (!tabExists) return;
    bootActivationDoneRef.current = true;
    void activate({
      source: 'boot',
      projectId: col.pin.projectId,
      tabId: col.pin.tabId,
      columnId: col.id,
    });
  }, [activeProjectId]);

  const dockedProjects = dockedOrder
    .map((id) => projectsById[id])
    .filter((p): p is DockedProjectMeta => !!p);

  if (dockedProjects.length === 0) return null;

  // Compute the column index each pane should render in (or undefined if
  // not pinned anywhere). With MAX_COLUMNS=3 the lookup table is tiny.
  const colIndexByPaneKey: Record<string, number> = {};
  columns.forEach((col, idx) => {
    if (col.pin) {
      colIndexByPaneKey[`${col.pin.projectId}:${col.pin.tabId}`] = idx;
    }
  });

  // Defensive auto-pin: if the active column has no valid pin (e.g. pin
  // points at a tab that was removed, or a fresh install with no pin yet),
  // pin it to an available (project, tab) so the user always sees
  // SOMETHING in the dock instead of a black gap. Without this, a stale
  // pin from a previous session leaves the pane hidden forever.
  const activeCol = columns.find((c) => c.id === activeColumnId);
  const pinIsValid =
    activeCol?.pin &&
    tabsByProject[activeCol.pin.projectId]?.some((t) => t.id === activeCol.pin!.tabId);
  if (!pinIsValid && dockedProjects.length > 0 && activeCol) {
    // Prefer the workspace's ACTIVE project over dockedProjects[0] so the
    // repaired pin matches the sidebar. The auto-pin fires from background
    // events too (idle pty auto-close → undockProject nulls the pin); it is a
    // pure visual repair and no longer feeds any dock→sidebar effect, so it
    // can't move the user's project on its own.
    const preferred = dockedProjects.find(
      (p) => p.id === activeProjectId && (tabsByProject[p.id]?.length ?? 0) > 0,
    );
    const target = preferred ?? dockedProjects[0]!;
    const colId = activeCol.id;
    // Schedule for next tick so we don't update store during render. Inside
    // the microtask re-read FRESH store state — render closures can be a
    // frame stale, and the old tabs[0]-unconditional pick both created
    // duplicate pins and (under setColumnPin's swap semantics) would steal
    // a pane that's visible in another column.
    queueMicrotask(() => {
      const s = useCliTabsStore.getState();
      const col = s.columns.find((c) => c.id === colId);
      const stillInvalid =
        !!col &&
        (!col.pin ||
          !s.tabsByProject[col.pin.projectId]?.some(
            (t) => t.id === col.pin!.tabId,
          ));
      if (!stillInvalid) return;
      // Prefer the project's active tab, then any tab not pinned in another
      // column (pickAutoPinTab) — never tabs[0] unconditionally.
      const tabId = pickAutoPinTab(s, colId, target.id);
      if (tabId) s.setColumnPin(colId, { projectId: target.id, tabId });
    });
  }

  const colCount = columns.length;
  const colWidthPct = 100 / colCount;

  if (typeof window !== 'undefined' && (window as unknown as { __dockDebug?: boolean }).__dockDebug) {
    console.log('[dock]', {
      docked: dockedOrder,
      columns,
      activeColumnId,
      tabs: Object.fromEntries(
        Object.entries(tabsByProject).map(([k, v]) => [k, v.map((t) => t.id)]),
      ),
      colIndexByPaneKey,
    });
  }

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-surface-2 pl-10 pr-3">
        <SquareTerminal size={13} className="text-accent" />
        <span className="text-[11px] font-semibold text-text">Agent sessions</span>
        <span className="rounded bg-surface-4 px-1.5 py-0.5 font-mono text-[9px] text-text-muted">
          {dockedProjects.length} projects · {colCount} columns
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-[9.5px] text-text-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-semantic-success" />
          persistent PTY
        </span>
      </div>
      <CliTabBar
        dockedProjects={dockedProjects}
        activeDockedProjectId={activeDockedProjectId}
        onTabDragStart={() => setIsDragActive(true)}
        onTabDragEnd={() => setIsDragActive(false)}
      />
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {/* Column-divider strip: thin vertical lines between columns to
            give the layout structure even before the panes finish loading. */}
        <div className="pointer-events-none absolute inset-0 flex">
          {columns.map((col, idx) => (
            <div
              key={col.id}
              className={cn(
                'flex-1',
                idx > 0 && 'border-l border-border',
                col.id === activeColumnId &&
                  colCount > 1 &&
                  'bg-accent/[0.025]',
              )}
            />
          ))}
        </div>
        {/* Per-column overlay badges (focus + close split). Only shown when
            we have more than one column — single-column needs no chrome.
            z-20 sits above the panes (z-1) so the close button stays
            clickable even after claude renders into the terminal. */}
        {colCount > 1 && (
          <div className="pointer-events-none absolute inset-0 z-20 flex">
            {columns.map((col, idx) => (
              <div key={col.id} className="relative flex-1">
                <div className="pointer-events-auto absolute right-2 top-2 flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() =>
                      void activate({
                        source: 'dock-pane',
                        projectId: col.pin?.projectId,
                        columnId: col.id,
                      })
                    }
                    title={`Focus column ${idx + 1}`}
                    className={cn(
                      'flex h-[18px] w-[18px] items-center justify-center rounded-full border text-[9px] font-bold transition',
                      col.id === activeColumnId
                        ? 'border-accent/55 bg-accent/15 text-accent-2 shadow-[0_0_8px_rgb(var(--color-accent-rgb)/0.25)]'
                        : 'border-border bg-surface-2/85 text-text-muted hover:bg-surface-3 hover:text-text',
                    )}
                  >
                    {idx + 1}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      removeColumn(col.id);
                      // Sync the sidebar to the surviving active column (no
                      // reactive dock→sidebar effect any more).
                      const s = useCliTabsStore.getState();
                      const c = s.columns.find((x) => x.id === s.activeColumnId);
                      if (c?.pin) {
                        void activate({
                          source: 'dock-pane',
                          projectId: c.pin.projectId,
                          columnId: c.id,
                        });
                      }
                    }}
                    title="Close split"
                    className="flex h-[18px] w-[18px] items-center justify-center rounded-full border border-border bg-surface-2/85 text-text-muted transition hover:bg-surface-3 hover:text-semantic-error"
                  >
                    <X size={9} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {/* Drop zones — visible only while a TabChip is being dragged.
            Each existing column accepts a drop to retarget its pin; the
            "+ Split" zone on the right creates a new column pinned to the
            dropped tab. z-30 so the dashed targets sit above panes (z-1)
            and the column-number badges (z-20). */}
        {isDragActive && (
          <div className="pointer-events-none absolute inset-0 z-30 flex p-1 gap-1">
            {columns.map((col, idx) => (
              <div
                key={col.id}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes('application/x-cli-tab')) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                  }
                }}
                onDrop={(e) => {
                  const raw = e.dataTransfer.getData('application/x-cli-tab');
                  if (!raw) return;
                  e.preventDefault();
                  try {
                    const pin = JSON.parse(raw) as {
                      projectId: string;
                      tabId: string;
                    };
                    setColumnPin(col.id, pin);
                    // Dropping a tab on a column is user intent — route through
                    // the activation router so the sidebar/workspace follow.
                    void activate({
                      source: 'dock-chip',
                      projectId: pin.projectId,
                      tabId: pin.tabId,
                      columnId: col.id,
                    });
                  } catch {
                    /* ignore malformed payload */
                  }
                  setIsDragActive(false);
                }}
                className={cn(
                  'pointer-events-auto flex flex-1 items-center justify-center rounded-[10px]',
                  'border-2 border-dashed border-accent/45 bg-accent/[0.06] text-[11px] text-accent-2',
                  'transition hover:border-accent/85 hover:bg-accent/15',
                )}
              >
                Drop here → column {idx + 1}
              </div>
            ))}
            {columns.length < MAX_COLUMNS && (
              <div
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes('application/x-cli-tab')) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'copy';
                  }
                }}
                onDrop={(e) => {
                  const raw = e.dataTransfer.getData('application/x-cli-tab');
                  if (!raw) return;
                  e.preventDefault();
                  try {
                    const pin = JSON.parse(raw) as {
                      projectId: string;
                      tabId: string;
                    };
                    splitForTab(pin);
                    // Same user-intent rule as the column drop above; the new
                    // split column is active, so omit columnId.
                    void activate({
                      source: 'dock-chip',
                      projectId: pin.projectId,
                      tabId: pin.tabId,
                    });
                  } catch {
                    /* ignore */
                  }
                  setIsDragActive(false);
                }}
                className={cn(
                  'pointer-events-auto flex w-[110px] shrink-0 flex-col items-center justify-center gap-1 rounded-[10px]',
                  'border-2 border-dashed border-[rgba(168,85,247,0.5)] bg-[rgba(168,85,247,0.07)] text-[11px] text-[#d8b4fe]',
                  'transition hover:border-[rgba(168,85,247,0.9)] hover:bg-[rgba(168,85,247,0.18)]',
                )}
              >
                <Plus size={14} />
                Split
              </div>
            )}
          </div>
        )}
        {/* Panes — every (project, tab) renders once, positioned by its
            current column. Stays mounted across pin changes so xterm
            preserves its scrollback. */}
        {dockedProjects.flatMap((p) => {
          const tabs = tabsByProject[p.id] ?? [];
          return tabs.map((tab) => {
            const key = `${p.id}:${tab.id}`;
            const colIdx = colIndexByPaneKey[key];
            const visible = colIdx !== undefined;
            const isActiveColumn =
              visible && columns[colIdx]?.id === activeColumnId;
            const paneKey = `${key}:${tab.reloadGen ?? 0}`;
            // Single column: use the proven inset-0 layout (full coverage,
            // hidden via visibility). Multi column: spatial split via inline
            // left/width. Avoids subtle h-100% flake when an absolute wrapper
            // has top:0 bottom:0 but no explicit height.
            const useFullCoverage = colCount === 1;
            const baseClass = useFullCoverage ? 'absolute inset-0' : 'absolute';
            const baseStyle: React.CSSProperties = useFullCoverage
              ? {
                  visibility: visible ? 'visible' : 'hidden',
                  pointerEvents: visible ? 'auto' : 'none',
                  zIndex: visible ? 1 : 0,
                }
              : {
                  top: 0,
                  bottom: 0,
                  left: visible ? `${colIdx * colWidthPct}%` : 0,
                  width: visible ? `${colWidthPct}%` : '100%',
                  visibility: visible ? 'visible' : 'hidden',
                  pointerEvents: visible ? 'auto' : 'none',
                  zIndex: visible ? 1 : 0,
                };
            return (
              <div
                key={paneKey}
                onMouseDown={() => {
                  if (visible && columns[colIdx]) {
                    void activate({
                      source: 'dock-pane',
                      projectId: columns[colIdx]!.pin?.projectId,
                      columnId: columns[colIdx]!.id,
                    });
                  }
                }}
                className={baseClass}
                style={baseStyle}
              >
                {tab.awaitingCliChoice ? (
                  <div className="flex h-full items-center justify-center bg-surface-1 p-6">
                    <div className="w-full max-w-[460px]">
                      <div className="mb-1 text-[13px] font-semibold text-text">Start an agent session</div>
                      <div className="mb-4 text-[11px] text-text-muted">Choose the CLI for {p.name}. No terminal starts until you choose.</div>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        {(['claude', 'codex', 'opencode', 'gemini', 'antigravity'] as const).map((cli) => (
                          <button
                            key={cli}
                            type="button"
                            onClick={() => chooseTabCli(p.id, tab.id, cli)}
                            className="flex h-10 items-center justify-center gap-2 rounded-[6px] border border-border bg-surface-2 px-3 text-[11px] font-medium capitalize text-text-secondary transition hover:border-accent/60 hover:bg-surface-3 hover:text-text"
                          >
                            <SquareTerminal size={13} />
                            {cli === 'opencode' ? 'OpenCode' : cli}
                          </button>
                        ))}
                        {launcherProfiles.map((profile) => (
                          <button
                            key={profile.id}
                            type="button"
                            onClick={() =>
                              chooseTabCli(p.id, tab.id, profile.cliId, profile.id)
                            }
                            className="flex h-10 min-w-0 items-center gap-2 rounded-[6px] border border-border bg-surface-2 px-3 text-left text-[11px] text-text-secondary transition hover:border-accent/60 hover:bg-surface-3 hover:text-text"
                            title={`${profile.name} (${profile.provider.model})`}
                          >
                            <SquareTerminal size={13} className="shrink-0" />
                            <span className="min-w-0 flex-1 truncate">{profile.name}</span>
                            <span className="shrink-0 text-[9px] uppercase text-text-dim">
                              {profile.cliId}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <Suspense fallback={null}>
                    <ClaudeCliPane
                    projectId={p.id}
                    projectPath={p.path}
                    tabId={tab.id}
                    isActive={isActiveColumn}
                    authProfileId={tab.authProfileId}
                    cliId={tab.cliId}
                    cliProfileId={tab.cliProfileId}
                    />
                  </Suspense>
                )}
              </div>
            );
          });
        })}
      </div>
    </div>
  );
});
