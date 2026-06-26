import * as Dialog from '@radix-ui/react-dialog';
import { Columns2, KeyRound, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import { activate } from '@renderer/state/activation';
import { useCliTabsStore } from '@renderer/state/cliTabs';
import { findColumnIdPinning } from '@renderer/state/cliTabsPins';
import { useWorkspaceStore } from '@renderer/state/workspace';
import type { ClaudeAuthProfile, CliTab, DockedProjectMeta } from '@shared/types';

// Shared with ClaudeCliDock's drop-zone overlay ("+ Split" only renders
// while columns.length < MAX_COLUMNS) — keep the two in lockstep.
export const MAX_COLUMNS = 3;

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

export function CliTabBar({
  dockedProjects,
  activeDockedProjectId,
  onTabDragStart,
  onTabDragEnd,
}: CliTabBarProps) {
  const tabsByProject = useCliTabsStore((s) => s.tabsByProject);
  const columns = useCliTabsStore((s) => s.columns);
  const activeColumnId = useCliTabsStore((s) => s.activeColumnId);
  const addTab = useCliTabsStore((s) => s.addTab);
  const removeTab = useCliTabsStore((s) => s.removeTab);
  const undockProject = useCliTabsStore((s) => s.undockProject);
  const reloadTab = useCliTabsStore((s) => s.reloadTab);
  const addColumn = useCliTabsStore((s) => s.addColumn);
  // Per-tab auth: the + button opens a profile picker; "Manage…" opens a dialog.
  const [authMenu, setAuthMenu] = useState<{ x: number; y: number } | null>(null);
  const [manageAuthOpen, setManageAuthOpen] = useState(false);
  const [authProfiles, setAuthProfiles] = useState<ClaudeAuthProfile[]>([]);
  const refreshAuthProfiles = useCallback(() => {
    void api.claudeAuth.list().then(setAuthProfiles).catch(() => undefined);
  }, []);
  // D2 — chips for projects NOT in the current workspace get a small workspace
  // label so multiple workspaces' chats are distinguishable in one bar. Plan C:
  // clicking such a chip switches the whole workspace (handleSelect → router).
  const activeWsId = useWorkspaceStore((s) => s.active?.id);
  const knownWorkspaces = useWorkspaceStore((s) => s.known);
  const labelForWorkspace = (wsId: string): string | undefined =>
    wsId === activeWsId
      ? undefined
      : (knownWorkspaces.find((w) => w.id === wsId)?.name ?? '⋯');

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // Promise-based confirm. Closing a chat tab kills its tmux session
  // (the only place the scrollback + claude state live), so we always
  // ask first. Re-entrancy guard: if a prior dialog is open, the new
  // request resolves it as cancelled first to avoid stacking.
  const [confirmRequest, setConfirmRequest] = useState<{
    title: string;
    body: string;
    confirmLabel: string;
    resolve: (ok: boolean) => void;
  } | null>(null);
  const requestConfirm = useCallback(
    (opts: { title: string; body: string; confirmLabel: string }): Promise<boolean> => {
      return new Promise((resolve) => {
        setConfirmRequest((prev) => {
          if (prev) prev.resolve(false);
          return { ...opts, resolve };
        });
      });
    },
    [],
  );

  const handleSelect = (projectId: string, tabId: string): void => {
    // Single imperative path (Plan C): the router focuses the owning column,
    // selects the tab, switches workspace if the chip is cross-workspace, and
    // moves the sidebar — no reactive dock→sidebar effect required.
    const owner = findColumnIdPinning(columns, projectId, tabId);
    void activate({
      source: 'dock-chip',
      projectId,
      tabId,
      columnId: owner ?? undefined,
    });
  };

  const handleClose = async (projectId: string, tabId: string): Promise<void> => {
    const project = dockedProjects.find((p) => p.id === projectId);
    const tab = tabsByProject[projectId]?.find((t) => t.id === tabId);
    const label = tab?.label ?? 'this chat';
    const projectName = project?.name ?? 'project';
    const ok = await requestConfirm({
      title: 'Close chat tab?',
      body: `Closing "${label}" in ${projectName} ends the tmux session and discards its scrollback. There's no undo — a new tab will start fresh.`,
      confirmLabel: 'Close & end session',
    });
    if (!ok) return;
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

  const handleCloseProject = async (): Promise<void> => {
    if (!contextMenu) return;
    const project = dockedProjects.find((p) => p.id === contextMenu.projectId);
    const tabCount = tabsByProject[contextMenu.projectId]?.length ?? 0;
    closeContextMenu();
    const ok = await requestConfirm({
      title: 'Close project?',
      body: `Closing "${project?.name ?? 'this project'}" will end ${tabCount} tmux session${
        tabCount === 1 ? '' : 's'
      } and discard their scrollback. There's no undo.`,
      confirmLabel: 'Close all tabs',
    });
    if (!ok) return;
    undockProject(contextMenu.projectId);
  };

  // Build a flat row of (project, tab) chips. A chip is "active" when it
  // matches the ACTIVE COLUMN's pin — what the user is actually looking at
  // on screen. activeDockedProjectId can lag the pin (undock fallback,
  // removeColumn, drag-drops) so it must not drive the highlight; it still
  // anchors handleAdd, which the pin-sync invariants keep converged.
  const activeCol = columns.find((c) => c.id === activeColumnId) ?? columns[0];
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
    for (const tab of tabs) {
      const isActive =
        !!activeCol?.pin &&
        activeCol.pin.projectId === project.id &&
        activeCol.pin.tabId === tab.id;
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
            workspaceLabel={labelForWorkspace(project.workspaceId)}
            onSelect={() => handleSelect(project.id, tab.id)}
            onClose={() => handleClose(project.id, tab.id)}
            onContextMenu={(e) => handleContextMenu(e, project.id, tab.id)}
            onDragStart={onTabDragStart}
            onDragEnd={onTabDragEnd}
          />
        ))}
        <button
          type="button"
          onClick={(e) => {
            if (!activeDockedProjectId) return;
            refreshAuthProfiles();
            const r = e.currentTarget.getBoundingClientRect();
            setAuthMenu({ x: r.left, y: r.bottom + 4 });
          }}
          title="New chat — pick auth (subscription / API)"
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
          onClick={() => {
            addColumn();
            // Keep the sidebar in lock-step with the new active column — there
            // is no reactive dock→sidebar effect any more (activation router).
            const s = useCliTabsStore.getState();
            const col = s.columns.find((c) => c.id === s.activeColumnId);
            if (col?.pin) {
              void activate({
                source: 'dock-pane',
                projectId: col.pin.projectId,
                columnId: col.id,
              });
            }
          }}
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
      <ConfirmDialog
        open={!!confirmRequest}
        title={confirmRequest?.title ?? ''}
        body={confirmRequest?.body ?? ''}
        confirmLabel={confirmRequest?.confirmLabel ?? 'Confirm'}
        onConfirm={() => {
          confirmRequest?.resolve(true);
          setConfirmRequest(null);
        }}
        onCancel={() => {
          confirmRequest?.resolve(false);
          setConfirmRequest(null);
        }}
      />
      {authMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setAuthMenu(null)} />
          <div
            className="fixed z-50 min-w-[210px] rounded-[8px] border border-border bg-surface-2 p-1 shadow-[0_8px_28px_rgba(0,0,0,0.45)]"
            style={{ left: authMenu.x, top: authMenu.y }}
          >
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
              New chat — auth
            </div>
            {authProfiles.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  if (activeDockedProjectId)
                    addTab(
                      activeDockedProjectId,
                      p.id === 'subscription' ? undefined : p.id,
                    );
                  setAuthMenu(null);
                }}
                className="flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-left text-[12px] text-text-secondary transition hover:bg-surface-3 hover:text-text"
              >
                <span
                  className={cn(
                    'h-[6px] w-[6px] shrink-0 rounded-full',
                    p.kind === 'subscription' ? 'bg-accent' : 'bg-semantic-success',
                  )}
                />
                <span className="flex-1 truncate">{p.name}</span>
                {p.kind === 'api' && (
                  <span className="text-[9px] text-text-dim">API</span>
                )}
              </button>
            ))}
            <div className="my-1 h-px bg-border-subtle" />
            <button
              type="button"
              onClick={() => {
                setManageAuthOpen(true);
                setAuthMenu(null);
              }}
              className="flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-left text-[11px] text-text-muted transition hover:bg-surface-3 hover:text-text"
            >
              <KeyRound size={11} /> Manage auth profiles…
            </button>
          </div>
        </>
      )}
      <ManageAuthDialog
        open={manageAuthOpen}
        onClose={() => {
          setManageAuthOpen(false);
          refreshAuthProfiles();
        }}
      />
    </>
  );
}

function ManageAuthDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [profiles, setProfiles] = useState<ClaudeAuthProfile[]>([]);
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    void api.claudeAuth.list().then(setProfiles).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (open) reload();
  }, [open, reload]);

  const add = async (): Promise<void> => {
    if (!name.trim() || !apiKey.trim() || busy) return;
    setBusy(true);
    try {
      await api.claudeAuth.save({
        name: name.trim(),
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim() || undefined,
        model: model.trim() || undefined,
      });
      setName('');
      setApiKey('');
      setBaseUrl('');
      setModel('');
      reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-24 z-50 w-[min(520px,90vw)] overflow-hidden rounded-lg border border-border-emphasis bg-surface-raised shadow-2xl">
          <Dialog.Title className="border-b border-border-subtle bg-surface-sidebar px-4 py-2 text-[12px] font-medium text-text">
            Claude auth profiles
          </Dialog.Title>
          <div className="flex flex-col gap-3 px-4 py-3">
            <p className="text-[11px] leading-relaxed text-text-muted">
              Each chat tab can launch on a different auth. Subscription uses your
              claude login; an API profile injects ANTHROPIC_API_KEY (+ optional
              base URL) for that tab only — so you can run both at once.
            </p>
            <div className="flex flex-col gap-1.5">
              {profiles.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-2 rounded-[6px] border border-border bg-surface-2 px-2.5 py-1.5 text-[12px]"
                >
                  <span
                    className={cn(
                      'h-[6px] w-[6px] shrink-0 rounded-full',
                      p.kind === 'subscription'
                        ? 'bg-accent'
                        : 'bg-semantic-success',
                    )}
                  />
                  <span className="truncate text-text">{p.name}</span>
                  {p.baseUrl && (
                    <span className="truncate font-mono text-[9.5px] text-text-dim">
                      {p.baseUrl}
                    </span>
                  )}
                  {p.model && (
                    <span className="truncate font-mono text-[9.5px] text-text-dim">
                      {p.model}
                    </span>
                  )}
                  <span className="flex-1" />
                  {p.kind === 'api' ? (
                    <button
                      type="button"
                      onClick={() => void api.claudeAuth.delete(p.id).then(reload)}
                      title="Delete profile"
                      className="text-text-muted transition hover:text-semantic-error"
                    >
                      <Trash2 size={12} />
                    </button>
                  ) : (
                    <span className="text-[9px] text-text-dim">built-in</span>
                  )}
                </div>
              ))}
            </div>
            <div className="mt-1 flex flex-col gap-2 rounded-[7px] border border-border-subtle bg-surface-2 p-2.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                Add API profile
              </span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name (e.g. Work API)"
                className="rounded-[6px] border border-border bg-surface-3 px-2 py-1.5 text-[12px] text-text outline-none focus:border-accent"
              />
              <input
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                type="password"
                placeholder="ANTHROPIC_API_KEY (sk-ant-…)"
                className="rounded-[6px] border border-border bg-surface-3 px-2 py-1.5 font-mono text-[12px] text-text outline-none focus:border-accent"
              />
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="Base URL (optional — gateway/proxy)"
                className="rounded-[6px] border border-border bg-surface-3 px-2 py-1.5 font-mono text-[11px] text-text outline-none focus:border-accent"
              />
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="Model (optional — e.g. claude-opus-4-8, or gateway model id)"
                className="rounded-[6px] border border-border bg-surface-3 px-2 py-1.5 font-mono text-[11px] text-text outline-none focus:border-accent"
              />
              <button
                type="button"
                onClick={() => void add()}
                disabled={busy || !name.trim() || !apiKey.trim()}
                className="self-end rounded-[6px] bg-accent px-3 py-1 text-[11px] font-medium text-white transition hover:opacity-90 disabled:opacity-40"
              >
                {busy ? 'Saving…' : 'Add profile'}
              </button>
            </div>
          </div>
          <div className="flex justify-end border-t border-border-subtle bg-surface-sidebar px-3 py-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded px-3 py-1 text-[11px] text-text-secondary transition hover:bg-surface-overlay hover:text-text"
            >
              Done
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-24 z-50 w-[min(420px,85vw)] -translate-x-1/2 overflow-hidden rounded-lg border border-border-emphasis bg-surface-raised shadow-2xl">
          <Dialog.Title className="border-b border-border-subtle bg-surface-sidebar px-4 py-2 text-[12px] font-medium text-text">
            {title}
          </Dialog.Title>
          <Dialog.Description className="px-4 py-3 text-[12px] text-text-secondary">
            {body}
          </Dialog.Description>
          <div className="flex justify-end gap-2 border-t border-border-subtle bg-surface-sidebar px-3 py-2 text-[11px]">
            <button
              type="button"
              onClick={onCancel}
              className="rounded px-2 py-1 text-text-secondary hover:bg-surface-overlay hover:text-text"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              autoFocus
              className="rounded bg-red-600 px-3 py-1 text-white transition hover:bg-red-700"
            >
              {confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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
  // Set only when the chip belongs to a workspace other than the active one
  // (D2). Rendered as a small label so cross-workspace chats are recognisable.
  workspaceLabel?: string;
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
  workspaceLabel,
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
        title={`${workspaceLabel ? `[${workspaceLabel}] ` : ''}${project.name} · ${tab.label}\nRight-click for Reload / Close · Drag to split`}
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
          {workspaceLabel && (
            <span
              className="max-w-full truncate text-[8.5px] font-medium uppercase tracking-wide text-accent-2/70"
              title={`Workspace: ${workspaceLabel}`}
            >
              {workspaceLabel}
            </span>
          )}
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
