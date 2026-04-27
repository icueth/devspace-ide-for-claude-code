import * as ContextMenu from '@radix-ui/react-context-menu';
import { ChevronDown, ChevronRight, Eye, EyeOff, Folder } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/lib/api';
import { addFileToClaudeCli } from '@renderer/lib/claudeCli';
import { cn } from '@renderer/lib/utils';
import { useEditorStore } from '@renderer/state/editor';
import { useGitStore } from '@renderer/state/git';
import { useLayoutStore } from '@renderer/state/layout';
import { usePromptStore } from '@renderer/state/prompt';
import { useWorkspaceStore } from '@renderer/state/workspace';
import { getFileIcon } from '@renderer/utils/fileIcons';
import type { DirEntry, GitChangeType } from '@shared/types';

function dirname(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(0, idx) : p;
}

function basename(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(idx + 1) : p;
}

const GIT_CLASS: Record<GitChangeType, string> = {
  modified: 'text-semantic-warning',
  added: 'text-semantic-success',
  deleted: 'text-semantic-error line-through',
  renamed: 'text-semantic-info',
  untracked: 'text-semantic-success/60',
  conflict: 'text-semantic-error',
};

const GIT_BADGE: Record<GitChangeType, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflict: '!',
};

interface NodeState {
  entries: DirEntry[] | null;
  loading: boolean;
  expanded: boolean;
  error?: string;
}

interface FileTreeProps {
  rootPath: string;
  onOpenFile?: (path: string) => void;
}

export function FileTree({ rootPath, onOpenFile }: FileTreeProps) {
  const [tree, setTree] = useState<Record<string, NodeState>>({});
  const askPrompt = usePromptStore((s) => s.ask);
  const editorClose = useEditorStore((s) => s.close);
  const showHidden = useLayoutStore((s) => s.showHiddenFiles);

  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const activeEditorPath = useEditorStore((s) => s.activeTabPath);
  const gitSnapshot = useGitStore((s) =>
    activeProjectId ? s.byProject[activeProjectId] : undefined,
  );
  const gitByPath = useMemo(() => {
    const m = new Map<string, GitChangeType>();
    gitSnapshot?.files.forEach((f) => m.set(f.absolutePath, f.type));
    return m;
  }, [gitSnapshot]);

  // Build absolute paths for everything git's `ls-files --ignored --directory`
  // reported. We split into two lists: exact-match files and directory
  // prefixes. A child of an ignored directory inherits the gray styling
  // without us having to expand the directory tree.
  const ignoredDirs = useMemo(() => {
    const dirs: string[] = [];
    for (const rel of gitSnapshot?.ignoredPaths ?? []) {
      if (rel.endsWith('/')) {
        dirs.push(`${rootPath}/${rel.slice(0, -1)}`);
      }
    }
    return dirs;
  }, [gitSnapshot, rootPath]);

  const ignoredFiles = useMemo(() => {
    const set = new Set<string>();
    for (const rel of gitSnapshot?.ignoredPaths ?? []) {
      if (!rel.endsWith('/')) set.add(`${rootPath}/${rel}`);
    }
    return set;
  }, [gitSnapshot, rootPath]);

  const isIgnoredPath = useCallback(
    (absPath: string): boolean => {
      if (ignoredFiles.has(absPath)) return true;
      for (const dir of ignoredDirs) {
        if (absPath === dir || absPath.startsWith(`${dir}/`)) return true;
      }
      return false;
    },
    [ignoredDirs, ignoredFiles],
  );

  const load = useCallback(async (path: string) => {
    setTree((s) => ({
      ...s,
      [path]: { ...(s[path] ?? { expanded: true }), loading: true },
    }));
    try {
      const entries = await api.fs.readDir(path);
      setTree((s) => ({
        ...s,
        [path]: { entries, loading: false, expanded: true },
      }));
    } catch (err) {
      setTree((s) => ({
        ...s,
        [path]: {
          entries: [],
          loading: false,
          expanded: true,
          error: (err as Error).message,
        },
      }));
    }
  }, []);

  useEffect(() => {
    setTree({});
    void load(rootPath);
  }, [rootPath, load]);

  // Watch the project for external file changes and refresh only the directories
  // that changed. Expanded + loaded directories get re-listed; folded ones are
  // ignored so we don't re-fetch content the user hasn't opened.
  useEffect(() => {
    const unsubscribe = api.fs.watch(rootPath, (dirs) => {
      setTree((current) => {
        const next: Record<string, NodeState> = current;
        for (const dir of dirs) {
          // Only refresh directories we've already loaded at least once.
          if (current[dir]) {
            void load(dir);
          }
        }
        return next;
      });
    });
    return unsubscribe;
  }, [rootPath, load]);

  const refreshDir = useCallback(
    (dir: string) => {
      // Force a reload — preserves expanded flag for nodes still visible.
      void load(dir);
    },
    [load],
  );

  const handleNewFile = (parentDir: string) => {
    askPrompt({
      title: 'New file',
      placeholder: 'filename.ext',
      confirmLabel: 'Create',
      onConfirm: async (name) => {
        try {
          await api.fs.create(`${parentDir}/${name}`, 'file');
          refreshDir(parentDir);
        } catch (err) {
          console.error('create file failed', err);
        }
      },
    });
  };

  const handleNewFolder = (parentDir: string) => {
    askPrompt({
      title: 'New folder',
      placeholder: 'folder-name',
      confirmLabel: 'Create',
      onConfirm: async (name) => {
        try {
          await api.fs.create(`${parentDir}/${name}`, 'folder');
          refreshDir(parentDir);
        } catch (err) {
          console.error('create folder failed', err);
        }
      },
    });
  };

  const handleRename = (absPath: string) => {
    const current = basename(absPath);
    askPrompt({
      title: 'Rename',
      initialValue: current,
      confirmLabel: 'Rename',
      onConfirm: async (newName) => {
        if (newName === current) return;
        try {
          const dest = `${dirname(absPath)}/${newName}`;
          await api.fs.rename(absPath, dest);
          editorClose(absPath);
          refreshDir(dirname(absPath));
        } catch (err) {
          console.error('rename failed', err);
        }
      },
    });
  };

  const handleDelete = async (absPath: string) => {
    const ok = window.confirm(
      `Move "${basename(absPath)}" to Trash? This cannot be undone from inside the app.`,
    );
    if (!ok) return;
    try {
      await api.fs.delete(absPath);
      editorClose(absPath);
      refreshDir(dirname(absPath));
    } catch (err) {
      console.error('delete failed', err);
    }
  };

  const handleDuplicate = async (absPath: string) => {
    try {
      await api.fs.duplicate(absPath);
      refreshDir(dirname(absPath));
    } catch (err) {
      console.error('duplicate failed', err);
    }
  };

  const handleReveal = (absPath: string) => {
    void api.fs.reveal(absPath);
  };

  const handleCopyPath = (absPath: string) => {
    void navigator.clipboard.writeText(absPath).catch(() => undefined);
  };

  const toggle = useCallback(
    (path: string) => {
      setTree((s) => {
        const current = s[path];
        if (!current) return s;
        return { ...s, [path]: { ...current, expanded: !current.expanded } };
      });
      const node = tree[path];
      if (node && !node.entries && !node.loading) void load(path);
    },
    [tree, load],
  );

  const renderEntry = (entry: DirEntry, depth: number) => {
    const node = tree[entry.path];
    const expanded = node?.expanded ?? false;
    const gitType = !entry.isDirectory ? gitByPath.get(entry.path) : undefined;
    const isActiveFile = !entry.isDirectory && entry.path === activeEditorPath;
    // Tracked changes (modified/added/etc.) win over the dim "ignored" state.
    // Otherwise an untracked file in an ignored directory would lose its
    // change badge — gitignore only fires for files git is actually
    // ignoring, so this is a rare collision but worth handling anyway.
    const isIgnored = !gitType && isIgnoredPath(entry.path);

    return (
      <div key={entry.path}>
        <ContextMenu.Root>
          <ContextMenu.Trigger asChild>
            <button
              onClick={() => {
                if (entry.isDirectory) {
                  if (!node) void load(entry.path);
                  else toggle(entry.path);
                } else {
                  onOpenFile?.(entry.path);
                }
              }}
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
            </button>
          </ContextMenu.Trigger>
          <ContextMenu.Portal>
            <ContextMenu.Content
              className="z-50 min-w-[200px] rounded-md border border-border-emphasis bg-surface-raised p-1 text-xs shadow-lg animate-in fade-in-0 zoom-in-95"
              style={{ backgroundColor: 'var(--color-surface-raised)' }}
            >
              <MenuItem onSelect={() => addFileToClaudeCli(entry.path)}>
                Add to Claude CLI
              </MenuItem>
              <ContextMenu.Separator className="my-1 h-px bg-border-subtle" />
              {entry.isDirectory && (
                <>
                  <MenuItem onSelect={() => handleNewFile(entry.path)}>New File…</MenuItem>
                  <MenuItem onSelect={() => handleNewFolder(entry.path)}>
                    New Folder…
                  </MenuItem>
                  <ContextMenu.Separator className="my-1 h-px bg-border-subtle" />
                </>
              )}
              <MenuItem onSelect={() => handleRename(entry.path)}>Rename…</MenuItem>
              <MenuItem onSelect={() => handleDuplicate(entry.path)}>Duplicate</MenuItem>
              <MenuItem onSelect={() => handleDelete(entry.path)}>
                Delete (Move to Trash)
              </MenuItem>
              <ContextMenu.Separator className="my-1 h-px bg-border-subtle" />
              <MenuItem onSelect={() => handleReveal(entry.path)}>Reveal in Finder</MenuItem>
              <MenuItem onSelect={() => handleCopyPath(entry.path)}>Copy Path</MenuItem>
            </ContextMenu.Content>
          </ContextMenu.Portal>
        </ContextMenu.Root>
        {entry.isDirectory && expanded && node?.entries && (
          <div>
            {filterVisible(node.entries).map((child) => renderEntry(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  // Apply the visibility filter client-side so toggling is instant and we
  // don't re-hit the filesystem. Main always returns everything except .git
  // and .DS_Store.
  const filterVisible = useCallback(
    (entries: DirEntry[] | null | undefined): DirEntry[] => {
      if (!entries) return [];
      if (showHidden) return entries;
      return entries.filter((e) => !e.name.startsWith('.'));
    },
    [showHidden],
  );

  const root = tree[rootPath];
  const rootEntries = filterVisible(root?.entries);
  const isEmpty = !root?.loading && !root?.error && rootEntries.length === 0;

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        {/* min-h-[120px] keeps the pane right-clickable even when the project
            is empty — otherwise there's no hit area for "New File". */}
        <div className="flex min-h-[120px] flex-col gap-0.5">
          {root?.loading && (
            <div className="px-2 py-1 text-[10px] text-text-muted">Loading…</div>
          )}
          {root?.error && (
            <div className="px-2 py-1 text-[10px] text-semantic-error">{root.error}</div>
          )}
          {rootEntries.map((entry) => renderEntry(entry, 0))}
          {isEmpty && (
            <div className="px-2 py-3 text-[10px] text-text-muted">
              Empty folder. Right-click to create a file.
            </div>
          )}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="z-50 min-w-[180px] rounded-md border border-border-emphasis bg-surface-raised p-1 text-xs shadow-lg animate-in fade-in-0 zoom-in-95"
          style={{ backgroundColor: 'var(--color-surface-raised)' }}
        >
          <MenuItem onSelect={() => handleNewFile(rootPath)}>New File…</MenuItem>
          <MenuItem onSelect={() => handleNewFolder(rootPath)}>New Folder…</MenuItem>
          <ContextMenu.Separator className="my-1 h-px bg-border-subtle" />
          <MenuItem onSelect={() => refreshDir(rootPath)}>Refresh</MenuItem>
          <MenuItem onSelect={() => handleReveal(rootPath)}>Reveal in Finder</MenuItem>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

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
