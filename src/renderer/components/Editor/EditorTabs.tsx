import * as ContextMenu from '@radix-ui/react-context-menu';
import { X } from 'lucide-react';

import { addFileToClaudeCli } from '@renderer/lib/claudeCli';
import { cn } from '@renderer/lib/utils';
import { useEditorStore, type PaneId } from '@renderer/state/editor';
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
    <div
      className="flex h-9 items-stretch overflow-x-auto border-b border-border"
      style={{
        background:
          'linear-gradient(180deg, var(--color-surface-2), var(--color-surface))',
      }}
    >
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
                onClick={() => setActive(tab.path, pane)}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    close(tab.path, pane);
                  }
                }}
                className={cn(
                  'group relative flex shrink-0 items-center gap-2 border-r border-border-subtle px-3.5 text-[12px] transition',
                  isActive
                    ? 'bg-surface text-text'
                    : 'text-text-muted hover:bg-white/[0.02] hover:text-text-secondary',
                )}
              >
                {isActive && (
                  <span
                    className="absolute inset-x-0 top-0 h-[2px] rounded-b-sm"
                    style={{
                      background:
                        'linear-gradient(90deg, var(--color-accent), #a855f7)',
                    }}
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
                      background:
                        'linear-gradient(135deg, var(--color-accent), #a855f7)',
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
