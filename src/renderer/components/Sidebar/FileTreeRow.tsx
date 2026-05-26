import * as ContextMenu from '@radix-ui/react-context-menu';
import { ChevronDown, ChevronRight, Folder } from 'lucide-react';
import { memo } from 'react';

import { cn } from '@renderer/lib/utils';
import { getFileIcon } from '@renderer/utils/fileIcons';
import type { FolderChangeStats } from '@renderer/utils/gitFolderAggregate';
import type { DirEntry, GitChangeType } from '@shared/types';

import {
  areRowPropsEqual,
  folderChangeTitle,
  GIT_BADGE,
  GIT_CLASS,
  shouldShowLoadingRow,
} from './fileTreeRowHelpers';

/**
 * Stable per-tree callback bundle. The identity of this object (and every
 * function on it) is fixed for the lifetime of a FileTree so React.memo on
 * the row is never defeated by fresh function identities each render.
 *
 * The accessor functions (getGitType, getFolderStat, …) read through refs in
 * the parent: stable identity, always-fresh values. They let a row derive its
 * children's per-row props during recursion without the parent passing whole
 * maps down into every node.
 */
export interface FileTreeRowCallbacks {
  // Click / interaction.
  onActivate: (entry: DirEntry) => void;
  onDragStart: (entry: DirEntry, e: React.DragEvent) => void;
  // Context menu actions.
  onAddToChat: (path: string) => void;
  onAddToClaudeCli: (path: string) => void;
  onNewFile: (parentDir: string) => void;
  onNewFolder: (parentDir: string) => void;
  onRename: (absPath: string) => void;
  onDuplicate: (absPath: string) => void;
  onDelete: (absPath: string) => void;
  onReveal: (absPath: string) => void;
  onCopyPath: (absPath: string) => void;
  // Per-row derived data accessors (stable identity, fresh values via refs).
  isExpanded: (path: string) => boolean;
  hasLoadedEntries: (path: string) => boolean;
  isLoading: (path: string) => boolean;
  getLoadError: (path: string) => string | undefined;
  getGitType: (entry: DirEntry) => GitChangeType | undefined;
  getFolderStat: (entry: DirEntry) => FolderChangeStats | undefined;
  isActiveFile: (entry: DirEntry) => boolean;
  isIgnored: (entry: DirEntry, gitType: GitChangeType | undefined) => boolean;
  getChildEntries: (path: string) => DirEntry[];
}

interface FileTreeRowProps {
  entry: DirEntry;
  depth: number;
  /** This row's own derived data — passed as primitives/small objects so a
   *  change to one file's git status never re-renders unrelated rows. */
  expanded: boolean;
  hasEntries: boolean;
  /** True while this folder's children are being fetched (first expand /
   *  refresh). Drives the inline "Loading…" affordance. */
  loading: boolean;
  /** Per-folder load error, shown inline (nested folders previously swallowed
   *  both their loading and error state — only the tree root surfaced them). */
  loadError: string | undefined;
  gitType: GitChangeType | undefined;
  /** Identity token that flips on any git-snapshot change. Folder rows
   *  compare it so they re-render (and re-derive child gitType) on every git
   *  change; leaf rows ignore it. See areRowPropsEqual. */
  gitToken: object;
  /** Identity token that flips on any file-tree state change (expand / collapse
   *  / load). Folder rows compare it so a nested expand actually propagates
   *  through memoized ancestors; leaf rows ignore it. See areRowPropsEqual. */
  structureToken: object;
  /** Identity token that flips whenever the active editor file changes. Folder
   *  rows compare it so an active-tab switch propagates through memoized
   *  ancestors to nested leaves; leaf rows ignore it (their own isActiveFile is
   *  the precise signal). See areRowPropsEqual. */
  activeFileToken: object;
  folderStat: FolderChangeStats | undefined;
  isActiveFile: boolean;
  isIgnored: boolean;
  /** Visible children of this folder (already filtered by the parent). Empty
   *  for files or collapsed/unloaded folders. */
  childEntries: DirEntry[];
  callbacks: FileTreeRowCallbacks;
}

function FileTreeRowImpl({
  entry,
  depth,
  expanded,
  hasEntries,
  loading,
  loadError,
  gitType,
  gitToken,
  structureToken,
  activeFileToken,
  folderStat,
  isActiveFile,
  isIgnored,
  childEntries,
  callbacks,
}: FileTreeRowProps) {
  // Synthetic "… N more" row appended by the listing cap. Non-interactive —
  // the folder has too many children to render; use Reveal in Finder instead.
  if (entry.truncated) {
    return (
      <div
        className="truncate py-[3px] pr-2 text-[11px] italic text-text-dim"
        style={{ paddingLeft: depth * 12 + 22 }}
        title="This folder has too many items to list in the sidebar. Right-click the folder → Reveal in Finder to browse all of them."
      >
        {entry.name}
      </div>
    );
  }

  return (
    <div>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <button
            onClick={() => callbacks.onActivate(entry)}
            // Make every entry draggable into the chat textarea. We
            // serialize a JSON array (single path here) so the drop
            // handler can stay uniform — future "multi-select drag"
            // can extend this without changing the consumer.
            draggable
            onDragStart={(e) => callbacks.onDragStart(entry, e)}
            className={cn(
              'group relative flex w-full items-center gap-1.5 rounded-[6px] py-[3px] pr-2 text-left text-[12px] transition-colors',
              isActiveFile
                ? 'text-text'
                : isIgnored
                  ? 'text-text-dim hover:bg-white/[0.02] hover:text-text-muted'
                  : 'text-text-secondary hover:bg-white/[0.025] hover:text-text',
              isIgnored && 'opacity-60',
            )}
            style={{
              paddingLeft: depth * 12 + 4,
              ...(isActiveFile
                ? {
                    background:
                      'linear-gradient(90deg, rgba(76,141,255,0.22), rgba(76,141,255,0.03) 80%)',
                  }
                : {}),
            }}
          >
            {isActiveFile && (
              <span
                className="pointer-events-none absolute left-[-2px] top-[4px] bottom-[4px] w-[3px] rounded-sm"
                style={{
                  background:
                    'linear-gradient(180deg, var(--color-accent), #a855f7)',
                  boxShadow: '0 0 8px rgba(76,141,255,0.4)',
                }}
              />
            )}
            {/* Indent guides — vertical lines for each depth level > 0 */}
            {depth > 0 &&
              Array.from({ length: depth }, (_, i) => (
                <span
                  key={i}
                  className="pointer-events-none absolute top-0 bottom-0 w-px bg-border-subtle/80"
                  style={{ left: i * 12 + 9 }}
                  aria-hidden
                />
              ))}
            {entry.isDirectory ? (
              expanded ? (
                <ChevronDown size={9} className="relative z-[1] shrink-0 text-text-muted" />
              ) : (
                <ChevronRight size={9} className="relative z-[1] shrink-0 text-text-muted" />
              )
            ) : (
              <span className="inline-block w-[9px]" />
            )}
            {entry.isDirectory ? (
              <span
                className="relative z-[1] flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-[4px]"
                style={{
                  background: expanded
                    ? 'linear-gradient(135deg, #fbbf24, #f59e0b)'
                    : 'linear-gradient(135deg, #f59e0b, #d97706)',
                  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.12)',
                }}
              >
                <Folder size={10} className="text-white" strokeWidth={2.5} />
              </span>
            ) : (
              (() => {
                const spec = getFileIcon(entry.name);
                const Icon = spec.Icon;
                return (
                  <span
                    className="relative z-[1] flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-[4px]"
                    style={{
                      background: `color-mix(in srgb, ${spec.color} 85%, black)`,
                      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.1)',
                    }}
                  >
                    <Icon size={9.5} className="text-white" strokeWidth={2.5} />
                  </span>
                );
              })()
            )}
            <span className="relative z-[1] flex-1 truncate">
              {entry.name}
            </span>
            {gitType && (
              <span
                className={cn(
                  'relative z-[1] rounded-[3px] px-[5px] py-[1px] font-mono text-[9px] font-bold',
                  GIT_CLASS[gitType],
                )}
                style={{
                  background: `color-mix(in srgb, currentColor 14%, transparent)`,
                }}
              >
                {GIT_BADGE[gitType]}
              </span>
            )}
            {folderStat && (
              <span
                className={cn(
                  'relative z-[1] inline-flex items-center gap-[3px] rounded-[3px] px-[5px] py-[1px] font-mono text-[9px] font-semibold tabular-nums',
                  GIT_CLASS[folderStat.dominant],
                )}
                style={{
                  background: `color-mix(in srgb, currentColor 12%, transparent)`,
                }}
                title={folderChangeTitle(folderStat)}
                aria-label={folderChangeTitle(folderStat)}
              >
                <span
                  aria-hidden
                  className="h-[5px] w-[5px] rounded-full"
                  style={{ background: 'currentColor' }}
                />
                {folderStat.total}
              </span>
            )}
          </button>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content
            className="z-50 min-w-[200px] rounded-md border border-border-emphasis bg-surface-raised p-1 text-xs shadow-lg animate-in fade-in-0 zoom-in-95"
            style={{ backgroundColor: 'var(--color-surface-raised)' }}
          >
            <MenuItem onSelect={() => callbacks.onAddToChat(entry.path)}>
              Add to Chat
            </MenuItem>
            <MenuItem onSelect={() => callbacks.onAddToClaudeCli(entry.path)}>
              Add to Claude CLI
            </MenuItem>
            <ContextMenu.Separator className="my-1 h-px bg-border-subtle" />
            {entry.isDirectory && (
              <>
                <MenuItem onSelect={() => callbacks.onNewFile(entry.path)}>New File…</MenuItem>
                <MenuItem onSelect={() => callbacks.onNewFolder(entry.path)}>
                  New Folder…
                </MenuItem>
                <ContextMenu.Separator className="my-1 h-px bg-border-subtle" />
              </>
            )}
            <MenuItem onSelect={() => callbacks.onRename(entry.path)}>Rename…</MenuItem>
            <MenuItem onSelect={() => callbacks.onDuplicate(entry.path)}>Duplicate</MenuItem>
            <MenuItem onSelect={() => callbacks.onDelete(entry.path)}>
              Delete (Move to Trash)
            </MenuItem>
            <ContextMenu.Separator className="my-1 h-px bg-border-subtle" />
            <MenuItem onSelect={() => callbacks.onReveal(entry.path)}>Reveal in Finder</MenuItem>
            <MenuItem onSelect={() => callbacks.onCopyPath(entry.path)}>Copy Path</MenuItem>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {shouldShowLoadingRow(entry.isDirectory, expanded, hasEntries, !!loadError) &&
        loading && (
          <div
            className="truncate py-[3px] pr-2 text-[11px] italic text-text-dim"
            style={{ paddingLeft: (depth + 1) * 12 + 22 }}
          >
            Loading…
          </div>
        )}
      {entry.isDirectory && expanded && loadError && (
        <div
          className="truncate py-[3px] pr-2 text-[11px] text-semantic-error"
          style={{ paddingLeft: (depth + 1) * 12 + 22 }}
          title={loadError}
        >
          {loadError}
        </div>
      )}
      {entry.isDirectory && expanded && hasEntries && (
        <div>
          {childEntries.map((child) => {
            // Derive each child's own per-row props from the stable accessors.
            // Each child is itself memoized, so a parent re-render only forces
            // a child re-render when that child's own props changed.
            const childGitType = callbacks.getGitType(child);
            return (
              <MemoFileTreeRow
                key={child.path}
                entry={child}
                depth={depth + 1}
                expanded={callbacks.isExpanded(child.path)}
                hasEntries={callbacks.hasLoadedEntries(child.path)}
                loading={callbacks.isLoading(child.path)}
                loadError={callbacks.getLoadError(child.path)}
                gitType={childGitType}
                gitToken={gitToken}
                structureToken={structureToken}
                activeFileToken={activeFileToken}
                folderStat={callbacks.getFolderStat(child)}
                isActiveFile={callbacks.isActiveFile(child)}
                isIgnored={callbacks.isIgnored(child, childGitType)}
                childEntries={callbacks.getChildEntries(child.path)}
                callbacks={callbacks}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

export const MemoFileTreeRow = memo(FileTreeRowImpl, areRowPropsEqual);

interface MenuItemProps {
  onSelect: () => void;
  children: React.ReactNode;
}

function MenuItem({ onSelect, children }: MenuItemProps) {
  return (
    <ContextMenu.Item
      onSelect={onSelect}
      className="flex items-center rounded px-2 py-1.5 outline-none hover:bg-surface-overlay"
    >
      {children}
    </ContextMenu.Item>
  );
}
