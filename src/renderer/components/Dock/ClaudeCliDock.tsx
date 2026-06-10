import { Plus, X } from 'lucide-react';
import { lazy, memo, Suspense, useEffect, useRef, useState } from 'react';

import { CliTabBar, MAX_COLUMNS } from '@renderer/components/Dock/CliTabBar';
import { cn } from '@renderer/lib/utils';
import { useRenderTrace } from '@renderer/lib/renderTrace';
import { useCliTabsStore } from '@renderer/state/cliTabs';
import { pickAutoPinTab } from '@renderer/state/cliTabsPins';
import { useWorkspaceStore } from '@renderer/state/workspace';
import type { DockedProjectMeta } from '@shared/types';

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
  const activateProject = useWorkspaceStore((s) => s.activateProject);

  const projectsById = useCliTabsStore((s) => s.projectsById);
  const dockedOrder = useCliTabsStore((s) => s.dockedOrder);
  const tabsByProject = useCliTabsStore((s) => s.tabsByProject);
  const activeDockedProjectId = useCliTabsStore((s) => s.activeDockedProjectId);
  const columns = useCliTabsStore((s) => s.columns);
  const activeColumnId = useCliTabsStore((s) => s.activeColumnId);
  const dockProject = useCliTabsStore((s) => s.dockProject);
  const setActiveDockedProject = useCliTabsStore((s) => s.setActiveDockedProject);
  const setActiveColumn = useCliTabsStore((s) => s.setActiveColumn);
  const removeColumn = useCliTabsStore((s) => s.removeColumn);
  const setColumnPin = useCliTabsStore((s) => s.setColumnPin);
  const splitForTab = useCliTabsStore((s) => s.splitForTab);

  // Toggled by TabChip's drag handlers so the drop zones only appear while
  // the user is mid-drag. Bare CSS dnd would over-invalidate too aggressively
  // and steal space from the panes when nothing is happening.
  const [isDragActive, setIsDragActive] = useState(false);

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
    // Prefer the workspace's ACTIVE project over dockedProjects[0]. The
    // auto-pin fires from background events too (idle pty auto-close →
    // undockProject nulls the pin) — pinning the first docked project would
    // make the dock→sidebar follow effect switch the user's project with
    // zero user action.
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
                  'bg-[rgba(76,141,255,0.025)]',
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
                    onClick={() => setActiveColumn(col.id)}
                    title={`Focus column ${idx + 1}`}
                    className={cn(
                      'flex h-[18px] w-[18px] items-center justify-center rounded-full border text-[9px] font-bold transition',
                      col.id === activeColumnId
                        ? 'border-[rgba(76,141,255,0.55)] bg-[rgba(76,141,255,0.18)] text-[#bcd1ff] shadow-[0_0_8px_rgba(76,141,255,0.35)]'
                        : 'border-border bg-surface-2/85 text-text-muted hover:bg-surface-3 hover:text-text',
                    )}
                  >
                    {idx + 1}
                  </button>
                  <button
                    type="button"
                    onClick={() => removeColumn(col.id)}
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
                    setActiveColumn(col.id);
                    // Dropping a tab on a column is user intent — activate
                    // explicitly (the follow effect deliberately ignores
                    // none→pinned transitions to stay deaf to the auto-pin).
                    if (projects.some((p) => p.id === pin.projectId)) {
                      activateProject(pin.projectId);
                    }
                  } catch {
                    /* ignore malformed payload */
                  }
                  setIsDragActive(false);
                }}
                className={cn(
                  'pointer-events-auto flex flex-1 items-center justify-center rounded-[10px]',
                  'border-2 border-dashed border-[rgba(76,141,255,0.45)] bg-[rgba(76,141,255,0.06)] text-[11px] text-[#bcd1ff]',
                  'transition hover:border-[rgba(76,141,255,0.85)] hover:bg-[rgba(76,141,255,0.16)]',
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
                    // Same user-intent rule as the column drop above.
                    if (projects.some((p) => p.id === pin.projectId)) {
                      activateProject(pin.projectId);
                    }
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
                  if (visible && columns[colIdx])
                    setActiveColumn(columns[colIdx]!.id);
                }}
                className={baseClass}
                style={baseStyle}
              >
                <Suspense fallback={null}>
                  <ClaudeCliPane
                    projectId={p.id}
                    projectPath={p.path}
                    tabId={tab.id}
                    isActive={isActiveColumn}
                  />
                </Suspense>
              </div>
            );
          });
        })}
      </div>
    </div>
  );
});
