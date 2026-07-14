import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, FolderOpen, FolderPlus, RefreshCw } from 'lucide-react';

import { cn } from '@renderer/lib/utils';
import { useWorkspaceStore } from '@renderer/state/workspace';

/** Compact workspace context control for the workbench sidebar. */
export function WorkspacePicker() {
  const active = useWorkspaceStore((s) => s.active);
  const known = useWorkspaceStore((s) => s.known);
  const projects = useWorkspaceStore((s) => s.projects);
  const pickFolder = useWorkspaceStore((s) => s.pickFolder);
  const setActive = useWorkspaceStore((s) => s.setActive);
  const rescan = useWorkspaceStore((s) => s.rescan);

  const otherWorkspaces = known.filter((w) => w.id !== active?.id);
  const projectCount = active ? projects.length : 0;
  const initials = workspaceInitials(active?.name);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className={cn(
            'no-drag group flex h-9 w-full items-center gap-2 overflow-hidden rounded-[6px] border border-border bg-surface-3 px-2 text-left',
            'transition hover:border-border-hi hover:bg-surface-4 focus:border-accent focus:outline-none',
          )}
        >
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] border border-accent/25 bg-accent/10 text-[9px] font-bold text-accent">
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-0.5 text-[11px] font-semibold text-text">
              <span className="truncate">{active ? shortenPath(active.path) : 'Select workspace…'}</span>
            </div>
            <div className="flex items-center gap-1 text-[9px] text-text-muted">
              {active ? (
                <>
                  <span>{projectCount} projects</span>
                  <span className="text-semantic-success">synced</span>
                </>
              ) : (
                <span>tap to choose</span>
              )}
            </div>
          </div>
          <ChevronDown size={11} className="shrink-0 text-text-muted" />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            'z-[1000] w-[300px] max-w-[calc(100vw-24px)] overflow-hidden rounded-[10px] border border-border-emphasis p-1 text-xs',
            'animate-in fade-in-0 zoom-in-95',
          )}
          style={{
            background: 'var(--color-surface-raised)',
            boxShadow:
              '0 20px 40px rgba(0,0,0,0.55), 0 4px 12px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.04)',
          }}
        >
          {active && (
            <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-text-muted">
              Current
            </div>
          )}
          {active && (
            <DropdownMenu.Item
              className="flex items-center gap-2 rounded-[6px] px-2 py-1.5 outline-none hover:bg-surface-overlay"
              onSelect={() => setActive(active.id)}
            >
              <FolderOpen size={13} className="shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate">{active.path}</span>
            </DropdownMenu.Item>
          )}
          {active && (
            <DropdownMenu.Item
              className="flex items-center gap-2 rounded-[6px] px-2 py-1.5 outline-none hover:bg-surface-overlay"
              onSelect={() => void rescan()}
            >
              <RefreshCw size={13} className="shrink-0 text-text-secondary" />
              {/* Re-selecting the current workspace is a no-op by design
                  (setActive same-id guard) — this is the explicit way to
                  pick up newly created sibling project folders. */}
              <span>Rescan projects</span>
            </DropdownMenu.Item>
          )}

          {otherWorkspaces.length > 0 && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-border-subtle" />
              <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-text-muted">
                Recent
              </div>
              {otherWorkspaces.slice(0, 10).map((ws) => (
                <DropdownMenu.Item
                  key={ws.id}
                  className="flex items-center gap-2 rounded-[6px] px-2 py-1.5 outline-none hover:bg-surface-overlay"
                  onSelect={() => setActive(ws.id)}
                >
                  <FolderOpen size={13} className="shrink-0 text-text-secondary" />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{ws.name}</span>
                    <span className="truncate text-[10px] text-text-muted">{ws.path}</span>
                  </div>
                </DropdownMenu.Item>
              ))}
            </>
          )}

          <DropdownMenu.Separator className="my-1 h-px bg-border-subtle" />
          <DropdownMenu.Item
            className="flex items-center gap-2 rounded-[6px] px-2 py-1.5 outline-none hover:bg-surface-overlay"
            onSelect={() => pickFolder()}
          >
            <FolderPlus size={13} className="shrink-0 text-accent" />
            <span>Open folder…</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function workspaceInitials(name: string | undefined): string {
  if (!name) return '?';
  const parts = name.split(/[\s/_\-.]+/).filter(Boolean);
  if (parts.length === 0) return name.slice(0, 2).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function shortenPath(full: string): string {
  // Collapse home prefix for display — keeps card compact.
  const home = /^\/Users\/[^/]+/;
  const short = full.replace(home, '');
  if (short.length <= 28) return short;
  return short.slice(0, 26) + '…';
}
