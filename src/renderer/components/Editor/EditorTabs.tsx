import * as ContextMenu from '@radix-ui/react-context-menu';
import { X } from 'lucide-react';

import { addFileToClaudeCli } from '@renderer/lib/claudeCli';
import { cn } from '@renderer/lib/utils';
import { useEditorStore, type PaneId } from '@renderer/state/editor';
import { useWorkspaceStore } from '@renderer/state/workspace';
import { getFileIcon } from '@renderer/utils/fileIcons';

interface EditorTabsProps {
  pane: PaneId;
}

export function EditorTabs({ pane }: EditorTabsProps) {
  const mainTabs = useEditorStore((s) => s.tabs);
  const mainActive = useEditorStore((s) => s.activeTabPath);
  const splitTabs = useEditorStore((s) => s.splitTabs);
  const splitActive = useEditorStore((s) => s.splitActivePath);
  const tabs = pane === 'right' ? splitTabs : mainTabs;
  const activeTabPath = pane === 'right' ? splitActive : mainActive;

  const setActive = useEditorStore((s) => s.setActive);
  const followTab = useWorkspaceStore((s) => s.followTab);
  const close = useEditorStore((s) => s.close);
  const closeOthers = useEditorStore((s) => s.closeOthers);
  const closeToRight = useEditorStore((s) => s.closeToRight);
  const closeAll = useEditorStore((s) => s.closeAll);
  const splitOpen = useEditorStore((s) => s.splitOpen);
  const moveToSplit = useEditorStore((s) => s.moveToSplit);
  const moveToMain = useEditorStore((s) => s.moveToMain);
  const unsplit = useEditorStore((s) => s.unsplit);

  if (tabs.length === 0) return null;

  return (
    <div className="flex h-10 items-center gap-1 overflow-x-auto border-b border-border bg-surface-2 px-1.5">
      {tabs.map((tab, idx) => {
        const isActive = tab.path === activeTabPath;
        const isDirty = tab.kind === 'text' && tab.content !== tab.savedContent;
        const hasRight = idx < tabs.length - 1;
        const spec = getFileIcon(tab.name);
        const Icon = spec.Icon;
        return (
          <ContextMenu.Root key={tab.path}>
            <ContextMenu.Trigger asChild>
              <button
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-devspace-tab', tab.path);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onClick={() => {
                  setActive(tab.path, pane);
                  // Explicit follow on click — BOTH panes: clicking any tab
                  // moves the sidebar to that tab's project. Covers
                  // re-clicking the already-active tab, where the store value
                  // doesn't change and the App auto-follow effect therefore
                  // can't fire. Safe for the split pane: followTab only
                  // records MRU + switches the sidebar, never the editor, and
                  // activateProject short-circuits when the MRU tab is
                  // already visible in the split pane — so a right-pane click
                  // won't yank the left pane.
                  followTab(tab.path);
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    close(tab.path, pane);
                  }
                }}
                className={cn(
                  'group relative flex h-8 shrink-0 items-center gap-2 rounded-[6px] border px-2.5 text-[11.5px] transition',
                  isActive
                    ? 'border-border-emphasis bg-surface-4 text-text shadow-sm'
                    : 'border-transparent text-text-muted hover:border-border-subtle hover:bg-surface-3 hover:text-text-secondary',
                )}
              >
                {isActive && (
                  <span
                    className="absolute inset-x-2 bottom-0 h-0.5 rounded-t bg-accent"
                  />
                )}
                <span
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px]"
                  style={{
                    background: `color-mix(in srgb, ${spec.color} 85%, black)`,
                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.1)',
                  }}
                >
                  <Icon size={10} className="text-white" strokeWidth={2.5} />
                </span>
                <span className="truncate">{tab.name}</span>
                {isDirty && !tab.loading && (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{
                    background: 'var(--color-accent)',
                    }}
                    aria-label="unsaved"
                  />
                )}
                <span
                  role="button"
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    close(tab.path, pane);
                  }}
                  className={cn(
                    'flex h-5 w-5 items-center justify-center rounded-[4px] opacity-0 transition',
                    'group-hover:opacity-100 hover:bg-surface-4',
                    isActive && 'opacity-70',
                  )}
                >
                  <X size={11} />
                </span>
              </button>
            </ContextMenu.Trigger>

            <ContextMenu.Portal>
              <ContextMenu.Content
                className={cn(
                  'min-w-[200px] rounded-md border border-border-emphasis bg-surface-raised p-1 text-xs shadow-lg',
                  'animate-in fade-in-0 zoom-in-95',
                )}
              >
                {tab.kind !== 'diff' && tab.kind !== 'codeflow' && (
                  <>
                    <Item onSelect={() => addFileToClaudeCli(tab.path)}>
                      Add to Claude CLI
                    </Item>
                    <ContextMenu.Separator className="my-1 h-px bg-border-subtle" />
                  </>
                )}
                <Item onSelect={() => close(tab.path, pane)} shortcut="⌘W">
                  Close
                </Item>
                <Item
                  onSelect={() => closeOthers(tab.path, pane)}
                  disabled={tabs.length < 2}
                >
                  Close Others
                </Item>
                <Item
                  onSelect={() => closeToRight(tab.path, pane)}
                  disabled={!hasRight}
                >
                  Close to the Right
                </Item>
                <Item onSelect={() => closeAll(pane)}>Close All</Item>
                <ContextMenu.Separator className="my-1 h-px bg-border-subtle" />
                {pane === 'left' ? (
                  <Item onSelect={() => splitOpen(tab.path)}>Split Right</Item>
                ) : (
                  <>
                    <Item onSelect={() => moveToMain(tab.path)}>Move to Main</Item>
                    <Item onSelect={() => unsplit()}>Close Split Pane</Item>
                  </>
                )}
                {pane === 'left' && (
                  <Item onSelect={() => moveToSplit(tab.path)}>Move to Split</Item>
                )}
              </ContextMenu.Content>
            </ContextMenu.Portal>
          </ContextMenu.Root>
        );
      })}
    </div>
  );
}

interface ItemProps {
  onSelect: () => void;
  children: React.ReactNode;
  shortcut?: string;
  disabled?: boolean;
}

function Item({ onSelect, children, shortcut, disabled }: ItemProps) {
  return (
    <ContextMenu.Item
      onSelect={onSelect}
      disabled={disabled}
      className={cn(
        'flex items-center justify-between gap-4 rounded px-2 py-1.5 outline-none',
        'hover:bg-surface-overlay data-[disabled]:pointer-events-none data-[disabled]:opacity-40',
      )}
    >
      <span>{children}</span>
      {shortcut && <span className="text-text-muted">{shortcut}</span>}
    </ContextMenu.Item>
  );
}
