import { Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { cn } from '@renderer/lib/utils';
import { useShellTabsStore } from '@renderer/state/shellTabs';
import type { ShellTab } from '@shared/types';

interface TerminalTabsProps {
  projectId: string;
  tabs: ShellTab[];
  activeTabId: string | null;
}

export function TerminalTabs({ projectId, tabs, activeTabId }: TerminalTabsProps) {
  const addTab = useShellTabsStore((s) => s.addTab);
  const removeTab = useShellTabsStore((s) => s.removeTab);
  const setActiveTab = useShellTabsStore((s) => s.setActiveTab);
  const renameTab = useShellTabsStore((s) => s.renameTab);

  const [renamingId, setRenamingId] = useState<string | null>(null);

  return (
    <div
      className="flex h-7 shrink-0 items-stretch gap-px overflow-x-auto border-b border-border px-1 scrollbar-thin"
      style={{ background: 'var(--color-surface)' }}
    >
      {tabs.map((tab) => (
        <ShellTabChip
          key={tab.id}
          tab={tab}
          active={tab.id === activeTabId}
          isOnly={tabs.length === 1}
          isRenaming={renamingId === tab.id}
          onActivate={() => setActiveTab(projectId, tab.id)}
          onClose={() => removeTab(projectId, tab.id)}
          onStartRename={() => setRenamingId(tab.id)}
          onCommitRename={(label) => {
            renameTab(projectId, tab.id, label);
            setRenamingId(null);
          }}
          onCancelRename={() => setRenamingId(null)}
        />
      ))}
      <button
        onClick={() => addTab(projectId)}
        className="flex h-full w-7 items-center justify-center text-text-muted hover:bg-surface-raised hover:text-text"
        title="New terminal tab"
        aria-label="New terminal tab"
      >
        <Plus size={13} />
      </button>
    </div>
  );
}

interface ShellTabChipProps {
  tab: ShellTab;
  active: boolean;
  isOnly: boolean;
  isRenaming: boolean;
  onActivate: () => void;
  onClose: () => void;
  onStartRename: () => void;
  onCommitRename: (label: string) => void;
  onCancelRename: () => void;
}

function ShellTabChip({
  tab,
  active,
  isOnly,
  isRenaming,
  onActivate,
  onClose,
  onStartRename,
  onCommitRename,
  onCancelRename,
}: ShellTabChipProps) {
  const [draft, setDraft] = useState(tab.label);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming) {
      setDraft(tab.label);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [isRenaming, tab.label]);

  return (
    <div
      onClick={() => !isRenaming && onActivate()}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onStartRename();
      }}
      className={cn(
        'group flex h-full cursor-pointer items-center gap-1 border-r border-border/40 px-2 text-[11.5px] transition',
        active
          ? 'bg-surface-raised text-text'
          : 'text-text-muted hover:bg-surface-2 hover:text-text-secondary',
      )}
    >
      {isRenaming ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => onCommitRename(draft)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onCommitRename(draft);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onCancelRename();
            }
            e.stopPropagation();
          }}
          className="h-5 w-24 rounded border border-border bg-surface px-1 text-[11.5px] text-text outline-none focus:border-accent"
        />
      ) : (
        <span className="select-none whitespace-nowrap">{tab.label}</span>
      )}
      {!isOnly && !isRenaming && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="ml-1 flex h-4 w-4 items-center justify-center rounded text-text-muted opacity-0 transition group-hover:opacity-100 hover:bg-surface hover:text-text"
          title="Close tab"
          aria-label={`Close ${tab.label}`}
        >
          <X size={10} />
        </button>
      )}
    </div>
  );
}
