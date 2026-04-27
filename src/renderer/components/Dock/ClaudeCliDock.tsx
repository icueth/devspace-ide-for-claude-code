import { Columns2, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';

import { cn } from '@renderer/lib/utils';
import { useCliTabsStore } from '@renderer/state/cliTabs';
import { useWorkspaceStore } from '@renderer/state/workspace';
import type { CliTab, DockColumn, DockedProjectMeta } from '@shared/types';

const MAX_COLUMNS = 3;

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
export function ClaudeCliDock() {
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
  useEffect(() => {
    if (activeProjectId) {
      if (lastMirroredActiveRef.current !== activeProjectId) {
        lastMirroredActiveRef.current = activeProjectId;
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
  // pin it to the first available (project, tab) so the user always sees
  // SOMETHING in the dock instead of a black gap. Without this, a stale
  // pin from a previous session leaves the pane hidden forever.
  const activeCol = columns.find((c) => c.id === activeColumnId);
  const pinIsValid =
    activeCol?.pin &&
    tabsByProject[activeCol.pin.projectId]?.some((t) => t.id === activeCol.pin!.tabId);
  if (!pinIsValid && dockedProjects.length > 0 && activeCol) {
    const firstProject = dockedProjects[0]!;
    const firstTab = tabsByProject[firstProject.id]?.[0];
    if (firstTab) {
      // Schedule for next tick so we don't update store during render.
      queueMicrotask(() => {
        useCliTabsStore.getState().setColumnPin(activeCol.id, {
          projectId: firstProject.id,
          tabId: firstTab.id,
        });
      });
    }
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
}

interface CliTabBarProps {
  dockedProjects: DockedProjectMeta[];
  activeDockedProjectId: string | null;
  onTabDragStart: () => void;
  onTabDragEnd: () => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  projectId: string;
  tabId: string;
}

function CliTabBar({
  dockedProjects,
  activeDockedProjectId,
  onTabDragStart,
  onTabDragEnd,
}: CliTabBarProps) {
  const tabsByProject = useCliTabsStore((s) => s.tabsByProject);
  const activeTabIdByProject = useCliTabsStore((s) => s.activeTabIdByProject);
  const columns = useCliTabsStore((s) => s.columns);
  const addTab = useCliTabsStore((s) => s.addTab);
  const removeTab = useCliTabsStore((s) => s.removeTab);
  const setActiveTab = useCliTabsStore((s) => s.setActiveTab);
  const undockProject = useCliTabsStore((s) => s.undockProject);
  const reloadTab = useCliTabsStore((s) => s.reloadTab);
  const addColumn = useCliTabsStore((s) => s.addColumn);
  const setActiveProject = useWorkspaceStore((s) => s.setActiveProject);
  const projects = useWorkspaceStore((s) => s.projects);

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const handleSelect = (projectId: string, tabId: string): void => {
    // setActiveTab pins the active column AND mirrors selection into the
    // legacy single-pane state.
    setActiveTab(projectId, tabId);
    if (projects.some((p) => p.id === projectId)) {
      setActiveProject(projectId);
    }
  };

  const handleAdd = (): void => {
    if (!activeDockedProjectId) return;
    addTab(activeDockedProjectId);
  };

  const handleClose = (projectId: string, tabId: string): void => {
    removeTab(projectId, tabId);
  };

  const handleContextMenu = (
    e: React.MouseEvent,
    projectId: string,
    tabId: string,
  ): void => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, projectId, tabId });
  };

  const closeContextMenu = (): void => setContextMenu(null);

  const handleReload = (): void => {
    if (!contextMenu) return;
    void reloadTab(contextMenu.projectId, contextMenu.tabId);
    closeContextMenu();
  };

  const handleCloseProject = (): void => {
    if (!contextMenu) return;
    undockProject(contextMenu.projectId);
    closeContextMenu();
  };

  // Build a flat row of (project, tab) chips. A chip is "active" when it
  // matches the active column's pin — which is what the user is currently
  // looking at on screen.
  const pinSet = new Set<string>();
  for (const col of columns) {
    if (col.pin) pinSet.add(`${col.pin.projectId}:${col.pin.tabId}`);
  }
  const chips: Array<{
    project: DockedProjectMeta;
    tab: CliTab;
    isActive: boolean;
    pinnedElsewhere: boolean;
  }> = [];
  for (const project of dockedProjects) {
    const tabs = tabsByProject[project.id] ?? [];
    const activeTabId = activeTabIdByProject[project.id];
    for (const tab of tabs) {
      const isActive =
        project.id === activeDockedProjectId && tab.id === activeTabId;
      const pinnedElsewhere =
        !isActive && pinSet.has(`${project.id}:${tab.id}`);
      chips.push({ project, tab, isActive, pinnedElsewhere });
    }
  }

  const canSplit = columns.length < MAX_COLUMNS;

  return (
    <>
      <div
        className="flex h-[44px] shrink-0 items-stretch gap-1 overflow-x-auto border-b border-border px-2 py-1"
        style={{ background: 'var(--color-surface-2)' }}
      >
        {chips.map(({ project, tab, isActive, pinnedElsewhere }) => (
          <TabChip
            key={`${project.id}:${tab.id}`}
            project={project}
            tab={tab}
            isActive={isActive}
            pinnedElsewhere={pinnedElsewhere}
            onSelect={() => handleSelect(project.id, tab.id)}
            onClose={() => handleClose(project.id, tab.id)}
            onContextMenu={(e) => handleContextMenu(e, project.id, tab.id)}
            onDragStart={onTabDragStart}
            onDragEnd={onTabDragEnd}
          />
        ))}
        <button
          type="button"
          onClick={handleAdd}
          title="New chat in active project"
          disabled={!activeDockedProjectId}
          className={cn(
            'flex h-full w-[28px] shrink-0 items-center justify-center self-center rounded-[6px]',
            'border border-border text-text-muted transition',
            'hover:border-border-hi hover:bg-surface-3 hover:text-text',
            !activeDockedProjectId && 'pointer-events-none opacity-40',
          )}
        >
          <Plus size={13} />
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={addColumn}
          title={
            canSplit
              ? `Split column (${columns.length} → ${columns.length + 1} of ${MAX_COLUMNS})`
              : `Maximum ${MAX_COLUMNS} columns`
          }
          disabled={!canSplit}
          className={cn(
            'flex h-full shrink-0 items-center gap-1 self-center rounded-[6px] px-2 text-[10.5px]',
            'border border-border text-text-muted transition',
            'hover:border-border-hi hover:bg-surface-3 hover:text-text',
            !canSplit && 'pointer-events-none opacity-40',
          )}
        >
          <Columns2 size={12} />
          Split
        </button>
      </div>
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={closeContextMenu}
          onReload={handleReload}
          onCloseProject={handleCloseProject}
        />
      )}
    </>
  );
}

interface ContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  onReload: () => void;
  onCloseProject: () => void;
}

function ContextMenu({ x, y, onClose, onReload, onCloseProject }: ContextMenuProps) {
  return (
    <div
      onMouseDown={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="fixed inset-0 z-50"
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="absolute min-w-[180px] overflow-hidden rounded-[8px] border border-border bg-surface-2 shadow-[0_8px_28px_rgba(0,0,0,0.45)]"
        style={{ left: x, top: y, backgroundColor: 'var(--color-surface-2)' }}
      >
        <MenuItem icon={<RotateCcw size={12} />} onClick={onReload}>
          Reload tab
          <span className="ml-auto text-[10px] text-text-muted">respawn claude</span>
        </MenuItem>
        <div className="h-px bg-border" />
        <MenuItem
          icon={<Trash2 size={12} />}
          tone="danger"
          onClick={onCloseProject}
        >
          Close project
          <span className="ml-auto text-[10px] text-text-muted">all tabs</span>
        </MenuItem>
      </div>
    </div>
  );
}

interface MenuItemProps {
  icon?: React.ReactNode;
  children: React.ReactNode;
  tone?: 'default' | 'danger';
  onClick: () => void;
}

function MenuItem({ icon, children, tone = 'default', onClick }: MenuItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition',
        'hover:bg-surface-3',
        tone === 'danger' ? 'text-semantic-error' : 'text-text',
      )}
    >
      <span className="shrink-0">{icon}</span>
      {children}
    </button>
  );
}

interface TabChipProps {
  project: DockedProjectMeta;
  tab: CliTab;
  isActive: boolean;
  pinnedElsewhere: boolean;
  onSelect: () => void;
  onClose: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}

function TabChip({
  project,
  tab,
  isActive,
  pinnedElsewhere,
  onSelect,
  onClose,
  onContextMenu,
  onDragStart,
  onDragEnd,
}: TabChipProps) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        // Use a custom MIME type so unrelated drag sources (file paths,
        // text selections) don't accidentally land on our drop zones.
        e.dataTransfer.setData(
          'application/x-cli-tab',
          JSON.stringify({ projectId: project.id, tabId: tab.id }),
        );
        e.dataTransfer.effectAllowed = 'copyMove';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onContextMenu={onContextMenu}
      className={cn(
        'group flex h-full shrink-0 items-stretch rounded-[6px] border text-[11px] transition',
        isActive
          ? 'border-[rgba(76,141,255,0.4)] bg-surface-3 text-text'
          : pinnedElsewhere
            ? 'border-[rgba(76,141,255,0.2)] bg-surface-2 text-text-secondary hover:border-border-hi hover:bg-surface-3 hover:text-text'
            : 'border-border bg-surface-2 text-text-secondary hover:border-border-hi hover:bg-surface-3 hover:text-text',
      )}
      style={
        isActive
          ? {
              boxShadow: '0 0 0 1px rgba(76,141,255,0.15) inset',
            }
          : undefined
      }
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex max-w-[180px] items-center gap-2 px-2.5"
        title={`${project.name} · ${tab.label}\nRight-click for Reload / Close · Drag to split`}
      >
        <span
          className={cn(
            'h-[6px] w-[6px] shrink-0 rounded-full transition',
            isActive
              ? 'bg-[#4c8dff]'
              : pinnedElsewhere
                ? 'bg-[#4c8dff]/55'
                : 'bg-text-muted/40',
          )}
        />
        <span className="flex min-w-0 flex-col items-start leading-[1.15]">
          <span
            className={cn(
              'truncate text-[10.5px] font-semibold',
              isActive ? 'text-text' : 'text-text-secondary',
            )}
          >
            {project.name}
          </span>
          <span
            className={cn(
              'truncate text-[10px]',
              isActive ? 'text-text-secondary' : 'text-text-muted',
            )}
          >
            {tab.label}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        title="Close tab"
        className={cn(
          'flex w-[18px] shrink-0 items-center justify-center rounded-r-[5px]',
          'text-text-muted opacity-0 transition group-hover:opacity-100',
          'hover:bg-surface-4 hover:text-text',
          isActive && 'opacity-100',
        )}
      >
        <X size={10} />
      </button>
    </div>
  );
}
