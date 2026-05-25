import * as Dialog from '@radix-ui/react-dialog';
import { Clock, Command as CommandIcon, FileText, Hash, Search, Settings as SettingsIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import { useEditorStore } from '@renderer/state/editor';
import { useSpotlightRecentStore } from '@renderer/state/spotlightRecent';
import { getFileIcon } from '@renderer/utils/fileIcons';

import {
  composeSections,
  flattenSections,
  parseSpotlightQuery,
  type SpotlightCandidate,
  type SpotlightCommand,
} from './spotlightProviders';

interface SpotlightDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // For file source. null = no active project; dialog falls back to
  // commands-only and shows a hint.
  projectPath: string | null;
  // Used as the recents bucket key — typically the active workspace ID.
  workspaceId: string | null;
  // Built fresh in App.tsx — includes navigation, layout toggles, settings
  // routes. The dialog never mutates; it only reads + calls `cmd.run()`.
  commands: ReadonlyArray<SpotlightCommand>;
}

const PREFIX_HINTS: Array<{ prefix: string; label: string }> = [
  { prefix: '>', label: 'Commands' },
  { prefix: '/', label: 'Settings' },
  { prefix: '@', label: 'Symbols (preview)' },
  { prefix: '#', label: 'Notes (coming soon)' },
];

/**
 * v0.30.8 — Spotlight palette (Cmd+K).
 *
 * Multi-source search with prefix routing. The legacy Cmd+P QuickOpenDialog
 * remains wired separately (file-only fast path) for users who learned it.
 *
 * UX notes:
 *   - The dialog never blocks on file fetch; an empty file list just means
 *     no file-source results until the lazy fetch resolves.
 *   - Recents resolve against the live file pool — deleted files won't
 *     surface stale rows.
 *   - mousedown (not click) on rows so blur-on-pick doesn't lose the action
 *     to the auto-close ordering.
 */
export function SpotlightDialog({
  open,
  onOpenChange,
  projectPath,
  workspaceId,
  commands,
}: SpotlightDialogProps) {
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  const openFile = useEditorStore((s) => s.open);
  const recordFile = useSpotlightRecentStore((s) => s.recordFile);
  const recordCommand = useSpotlightRecentStore((s) => s.recordCommand);
  const recents = useSpotlightRecentStore((s) =>
    workspaceId ? (s.byWorkspace[workspaceId] ?? []) : [],
  );
  const listRef = useRef<HTMLDivElement | null>(null);

  // Fetch on open. Reset query + selection. We deliberately re-fetch each
  // open to pick up files created since the last open (cheap — already
  // cached in main + skips heavy dirs).
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelected(0);
    if (!projectPath) {
      setFiles([]);
      return;
    }
    let cancelled = false;
    void api.fs
      .listFiles(projectPath)
      .then((list) => {
        if (!cancelled) setFiles(list);
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectPath]);

  const parsed = useMemo(() => parseSpotlightQuery(query), [query]);
  const sections = useMemo(
    () => composeSections({ parsed, files, commands, recents }),
    [parsed, files, commands, recents],
  );
  const flat = useMemo(() => flattenSections(sections), [sections]);

  // Clamp selected when results shrink — otherwise pressing Enter after a
  // query restricts to nothing would activate the wrong item next time
  // results return.
  useEffect(() => {
    if (selected >= flat.length) setSelected(Math.max(0, flat.length - 1));
  }, [flat.length, selected]);

  const activate = useCallback(
    (idx: number) => {
      const item = flat[idx];
      if (!item || !workspaceId) {
        onOpenChange(false);
        return;
      }
      // Close FIRST so animations + state cleanup happen before the side
      // effect (which often triggers navigation that rebuilds the tree).
      onOpenChange(false);
      if (item.source === 'file') {
        if (!projectPath) return;
        recordFile(workspaceId, item.relPath);
        void openFile(`${projectPath}/${item.relPath}`);
      } else if (item.source === 'recent' && item.kind === 'file') {
        if (!projectPath) return;
        recordFile(workspaceId, item.relPath);
        void openFile(`${projectPath}/${item.relPath}`);
      } else if (item.source === 'command') {
        recordCommand(workspaceId, item.command.id);
        item.command.run();
      } else if (item.source === 'recent' && item.kind === 'command') {
        recordCommand(workspaceId, item.command.id);
        item.command.run();
      }
    },
    [flat, projectPath, workspaceId, openFile, onOpenChange, recordFile, recordCommand],
  );

  const onKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelected((i) => Math.min(flat.length - 1, i + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        activate(selected);
      }
    },
    [flat.length, selected, activate],
  );

  // Keep selected row in view.
  useEffect(() => {
    const host = listRef.current;
    if (!host) return;
    const el = host.querySelector<HTMLElement>(`[data-idx="${selected}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected, flat]);

  // Walk sections and assign a flat positional index to each item so the
  // map() below can highlight + activate the right row.
  const renderRows = (): React.ReactNode => {
    if (sections.length === 0) {
      return (
        <div className="px-4 py-6 text-center text-[12px] text-text-muted">
          {parsed.mode === 'notes' ? (
            <>
              <Hash size={14} className="mx-auto mb-2 opacity-50" />
              <div>Notes &amp; devlog search coming in a follow-up release.</div>
              <div className="mt-1 text-[11px]">For now, open Devlog from the navbar.</div>
            </>
          ) : !projectPath && parsed.mode === 'mixed' ? (
            <>
              <Search size={14} className="mx-auto mb-2 opacity-50" />
              <div>Open a project to search files.</div>
              <div className="mt-1 text-[11px]">Type <code>&gt;</code> for commands.</div>
            </>
          ) : (
            <>No matches.</>
          )}
        </div>
      );
    }

    let globalIdx = 0;
    return sections.map((section) => (
      <div key={section.label}>
        <div className="sticky top-0 z-[1] bg-surface-sidebar/95 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-text-muted backdrop-blur">
          {section.label}
        </div>
        {section.items.map((item) => {
          const idx = globalIdx++;
          const isSelected = idx === selected;
          return (
            <button
              key={`${section.label}-${idx}-${getKey(item)}`}
              data-idx={idx}
              type="button"
              onMouseEnter={() => setSelected(idx)}
              onMouseDown={(e) => {
                e.preventDefault();
                activate(idx);
              }}
              className={cn(
                'flex w-full items-center gap-2 px-4 py-1.5 text-left text-[12px]',
                isSelected
                  ? 'bg-surface-overlay text-text'
                  : 'text-text-secondary hover:bg-surface-raised',
              )}
            >
              <Row item={item} />
            </button>
          );
        })}
      </div>
    ));
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[1px]" />
        <Dialog.Content
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="fixed left-1/2 top-24 z-50 w-[min(720px,92vw)] -translate-x-1/2 overflow-hidden rounded-lg border border-border-emphasis bg-surface-raised shadow-2xl"
        >
          <Dialog.Title className="sr-only">Spotlight search</Dialog.Title>
          <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-2.5">
            <Search size={14} className="shrink-0 text-text-muted" />
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelected(0);
              }}
              onKeyDown={onKey}
              placeholder="Search files, commands, settings…"
              className="w-full bg-transparent text-[13px] text-text placeholder:text-text-muted focus:outline-none"
            />
            <ModeChip mode={parsed.mode} />
          </div>
          <div ref={listRef} className="max-h-[60vh] overflow-y-auto py-1">
            {renderRows()}
          </div>
          <div className="flex items-center gap-3 border-t border-border-subtle bg-surface-sidebar px-3 py-1.5 text-[10px] text-text-muted">
            <span>↑↓ navigate</span>
            <span>↵ open</span>
            <span>esc close</span>
            <span className="ml-auto flex items-center gap-2">
              {PREFIX_HINTS.map((h) => (
                <span key={h.prefix}>
                  <code className="rounded bg-surface-3 px-1 text-text-secondary">{h.prefix}</code>{' '}
                  {h.label}
                </span>
              ))}
            </span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function getKey(item: SpotlightCandidate): string {
  if (item.source === 'file') return `file:${item.relPath}`;
  if (item.source === 'command') return `cmd:${item.command.id}`;
  if (item.source === 'recent' && item.kind === 'file') return `r-file:${item.relPath}`;
  return `r-cmd:${item.command.id}`;
}

function ModeChip({ mode }: { mode: ReturnType<typeof parseSpotlightQuery>['mode'] }) {
  if (mode === 'mixed') return null;
  const label =
    mode === 'commands'
      ? 'Commands'
      : mode === 'settings'
        ? 'Settings'
        : mode === 'symbols'
          ? 'Files'
          : 'Notes';
  return (
    <span className="shrink-0 rounded bg-surface-3 px-2 py-[2px] text-[10px] font-medium text-text-secondary">
      {label}
    </span>
  );
}

function Row({ item }: { item: SpotlightCandidate }) {
  if (item.source === 'file') {
    const spec = getFileIcon(item.fileName);
    const Icon = spec.Icon;
    const dir = item.relPath.slice(0, item.relPath.length - item.fileName.length - 1);
    return (
      <>
        <Icon size={12} className="shrink-0" style={{ color: spec.color }} />
        <span className="truncate font-medium">{item.fileName}</span>
        {dir && <span className="truncate text-[11px] text-text-muted">{dir}</span>}
      </>
    );
  }
  if (item.source === 'recent' && item.kind === 'file') {
    const spec = getFileIcon(item.fileName);
    const Icon = spec.Icon;
    const dir = item.relPath.slice(0, item.relPath.length - item.fileName.length - 1);
    return (
      <>
        <Clock size={12} className="shrink-0 text-text-muted" />
        <Icon size={12} className="shrink-0" style={{ color: spec.color }} />
        <span className="truncate font-medium">{item.fileName}</span>
        {dir && <span className="truncate text-[11px] text-text-muted">{dir}</span>}
      </>
    );
  }
  if (item.source === 'command') {
    const Icon = item.command.group === 'Settings' ? SettingsIcon : CommandIcon;
    return (
      <>
        <Icon size={12} className="shrink-0 text-accent" />
        <span className="truncate font-medium">{item.command.title}</span>
        <span className="ml-auto flex items-center gap-2 text-[10.5px] text-text-muted">
          {item.command.shortcut && (
            <kbd className="rounded bg-surface-3 px-1.5 py-[1px]">{item.command.shortcut}</kbd>
          )}
          <span>{item.command.group}</span>
        </span>
      </>
    );
  }
  // recent + command
  const Icon = item.command.group === 'Settings' ? SettingsIcon : CommandIcon;
  return (
    <>
      <Clock size={12} className="shrink-0 text-text-muted" />
      <Icon size={12} className="shrink-0 text-accent" />
      <span className="truncate font-medium">{item.command.title}</span>
      <span className="ml-auto flex items-center gap-2 text-[10.5px] text-text-muted">
        {item.command.shortcut && (
          <kbd className="rounded bg-surface-3 px-1.5 py-[1px]">{item.command.shortcut}</kbd>
        )}
        <span>{item.command.group}</span>
      </span>
    </>
  );
}

// Re-export for caller convenience.
export type { SpotlightCommand };

// FileText is imported but only referenced through getFileIcon. Mark it as
// intentionally available so a tree-shaker doesn't optimize it out and we
// don't get unused-import warnings.
void FileText;
