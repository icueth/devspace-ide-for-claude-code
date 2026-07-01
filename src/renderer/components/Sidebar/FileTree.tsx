import * as ContextMenu from '@radix-ui/react-context-menu';
import { FilePlus, FolderPlus, RefreshCw } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/lib/api';
import { useRenderTrace } from '@renderer/lib/renderTrace';
import { addFileToClaudeCli } from '@renderer/lib/claudeCli';
import { useEditorStore } from '@renderer/state/editor';
import {
  fileTreeCache,
  restoreRootOnly,
  type FileTreeSnapshot,
} from '@renderer/state/fileTreeCache';
import { useGitStore } from '@renderer/state/git';
import { useLayoutStore } from '@renderer/state/layout';
import { usePromptStore } from '@renderer/state/prompt';
import { markTreeOpen, useWorkspaceStore } from '@renderer/state/workspace';
import {
  aggregateFolderChanges,
  type FolderChangeStats,
} from '@renderer/utils/gitFolderAggregate';
import type { DirEntry, GitChangeType } from '@shared/types';

import {
  type FileTreeRowCallbacks,
  MemoFileTreeRow,
} from './FileTreeRow';

function dirname(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(0, idx) : p;
}

function basename(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(idx + 1) : p;
}

interface NodeState {
  entries: DirEntry[] | null;
  loading: boolean;
  expanded: boolean;
  error?: string;
}

// Index-wise listing equality. Valid because main sorts deterministically
// (directories first, then localeCompare on name — see ipc/fs.ts), so equal
// content always arrives in equal order. `path` is derived from (dir, name)
// and needs no separate check. The optional booleans (isSymlink, truncated)
// are coerced so an omitted flag and an explicit `false` compare equal.
function sameEntries(a: DirEntry[] | null | undefined, b: DirEntry[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.name !== y.name ||
      x.isDirectory !== y.isDirectory ||
      !!x.isSymlink !== !!y.isSymlink ||
      !!x.truncated !== !!y.truncated
    ) {
      return false;
    }
  }
  return true;
}

interface FileTreeProps {
  rootPath: string;
  onOpenFile?: (path: string) => void;
}

const EMPTY_ENTRIES: DirEntry[] = [];

export const FileTree = memo(function FileTree({ rootPath, onOpenFile }: FileTreeProps) {
  useRenderTrace('FileTree');
  const [tree, setTree] = useState<Record<string, NodeState>>({});
  const askPrompt = usePromptStore((s) => s.ask);
  const editorClose = useEditorStore((s) => s.close);
  const openHtmlPreview = useEditorStore((s) => s.openHtmlPreview);
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

  // Folder-level rollup so an unexpanded folder still shows a dot/count
  // for changes inside it. Recomputed only when the git snapshot changes.
  const folderStats = useMemo(
    () => aggregateFolderChanges(gitSnapshot?.files ?? [], rootPath),
    [gitSnapshot, rootPath],
  );

  // Identity token that flips whenever the git snapshot changes. Folder rows
  // compare it (see areRowPropsEqual) so ANY git change re-renders folders,
  // which then re-derive their children's gitType. Without this, two files in
  // one folder swapping status (A modified→clean while B clean→modified) nets
  // to an identical folderStat aggregate, the folder row bails, and the child
  // badges go stale. Leaf rows ignore the token — their own gitType prop is the
  // precise signal — so a git tick still only re-renders rows that changed.
  const gitToken = useMemo(() => ({}), [gitSnapshot]);

  // Identity token that flips on every file-tree state change (expand / collapse
  // / load). Folder rows compare it so a NESTED expand actually re-renders the
  // memoized ancestor chain — otherwise the new children never mount until an
  // unrelated git tick cascades through (a multi-second "stuck" expand). Leaf
  // rows ignore it, so the bulk file rows still skip re-render on tree changes.
  const structureToken = useMemo(() => ({}), [tree]);

  // Identity token that flips whenever the active editor file changes. Folder
  // rows compare it so switching the active tab (Spotlight / Quick Open / tab
  // strip / go-to-line) — which mutates neither the tree nor git state —
  // re-renders the memoized ancestor chain, letting nested leaves receive the
  // updated isActiveFile. Without it the highlight stays on the old file until
  // the next git tick happens to flip gitToken and cascade through. Leaf rows
  // ignore the token — their own isActiveFile prop is the precise signal — so
  // only the two leaves whose active-state actually changed re-render.
  const activeFileToken = useMemo(() => ({}), [activeEditorPath]);

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

  // Track the active root path the component is rendering. Used to guard
  // background loads so that in-flight fetches from an outgoing project
  // don't poison the incoming project's cache (the A→B→A race).
  const activeRootRef = useRef(rootPath);
  activeRootRef.current = rootPath;

  const load = useCallback(async (path: string) => {
    // Snapshot the current root so we can detect a swap mid-flight.
    const rootAtStart = activeRootRef.current;
    setTree((s) => ({
      ...s,
      [path]: { ...(s[path] ?? { expanded: true }), loading: true },
    }));
    try {
      const entries = await api.fs.readDir(path);
      // CR-M1-fixed (v0.30.7): if root flipped while readDir was in flight,
      // discard the result — committing it would persist this dir under the
      // NEW project's cached snapshot, slowly leaking memory across switches.
      if (activeRootRef.current !== rootAtStart) return;
      setTree((s) => ({
        ...s,
        [path]: { entries, loading: false, expanded: true },
      }));
    } catch (err) {
      if (activeRootRef.current !== rootAtStart) return;
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

  // Batch refresh for the switch-back cache-hit path ONLY. load() per dir
  // would cost a loading:true pre-write plus one commit per completion —
  // ~N+1 commits, each flipping structureToken (re-rendering every folder
  // row), with the root's loading:true painting a 'Loading…' row over the
  // already-restored tree. Instead: fetch all dirs in parallel, then commit
  // every difference in ONE functional setTree. When nothing changed (the
  // common switch-back) we return the SAME state object so React bails out
  // entirely — zero re-renders, zero flash. First-expand / manual refresh /
  // watch-event paths keep using load(), whose eager loading state is
  // genuinely useful there.
  const refreshCachedDirs = useCallback(async (dirs: string[]) => {
    // Same A→B→A poisoning guard as load(): snapshot the active root and
    // drop the batch if the project flipped while readDirs were in flight.
    const rootAtStart = activeRootRef.current;
    const results = await Promise.all(
      dirs.map((d) =>
        api.fs.readDir(d).then(
          (entries) => ({ d, entries }),
          (err: unknown) => ({ d, error: (err as Error).message }),
        ),
      ),
    );
    if (activeRootRef.current !== rootAtStart) return;
    setTree((s) => {
      let next: Record<string, NodeState> | null = null;
      for (const r of results) {
        const prev = s[r.d];
        if ('entries' in r) {
          // Unchanged listing → untouched node (reference equality keeps the
          // row memos quiet). Skipping is only safe when the node is settled:
          // a lingering loading/error flag must still be cleared below.
          if (prev && !prev.loading && !prev.error && sameEntries(prev.entries, r.entries)) {
            continue;
          }
          next ??= { ...s };
          // Spread preserves the CURRENT expanded flag — unlike load(), which
          // stomps expanded:true and would re-expand folders the user
          // collapsed while the refresh was in flight.
          next[r.d] = {
            ...(prev ?? { expanded: true }),
            entries: r.entries,
            loading: false,
            error: undefined,
          };
        } else {
          // Mirror load()'s catch shape, minus the expanded:true stomp.
          next ??= { ...s };
          next[r.d] = {
            ...(prev ?? { expanded: true }),
            entries: [],
            loading: false,
            error: r.error,
          };
        }
      }
      return next ?? s;
    });
  }, []);

  // Track the previous rootPath so we can persist its tree to the cache
  // before swapping to a new project's snapshot.
  const prevRootPathRef = useRef<string | null>(null);
  // Track the latest tree without baking it into the swap effect's deps —
  // otherwise every keystroke that changes `tree` would rerun this effect.
  const treeForCacheRef = useRef(tree);
  treeForCacheRef.current = tree;

  // Perf R3 (v0.30.7): per-project tree cache.
  //
  // Old behaviour: every rootPath flip blew away `tree` and re-fetched the
  // root via IPC, forgetting every expanded directory. Coming back to a
  // 5-deep-expanded project re-walked the filesystem.
  //
  // New behaviour:
  //   1. Persist the outgoing project's tree to the LRU.
  //   2. If the new project has a cached ROOT listing → restore just the root
  //      level instantly, then refresh the root in the background so
  //      externally-changed files surface immediately.
  //   3. Cache miss → fall back to the old behaviour (empty + load root).
  //
  // v0.38 — a project always opens at its ROOT. We used to restore every
  // subfolder the user had expanded in a prior visit, which made re-opening a
  // project pop open a deep tree the user didn't ask for. Now subfolders
  // start collapsed and load on demand; only the cached root entries are
  // reused (for an instant, flash-free top level). See restoreRootOnly.
  useEffect(() => {
    const prev = prevRootPathRef.current;
    // Persist the outgoing snapshot if it had any content. Empty snapshots
    // are skipped so a project that never loaded doesn't evict a useful one.
    if (prev && prev !== rootPath) {
      const snap = treeForCacheRef.current;
      if (Object.keys(snap).length > 0) {
        fileTreeCache.set(prev, snap as unknown as FileTreeSnapshot);
      }
    }
    prevRootPathRef.current = rootPath;

    const cached = fileTreeCache.get(rootPath);
    const rootOnly = cached ? restoreRootOnly(cached, rootPath) : null;
    if (rootOnly) {
      setTree(rootOnly as unknown as Record<string, NodeState>);
      // Refresh the root so external changes that happened while away surface
      // immediately (also covers events missed while the project's watcher was
      // force-closed during eviction). NOT awaited — the UI already shows the
      // cached root — and batched through refreshCachedDirs so a
      // nothing-changed switch-back commits nothing (no 'Loading…' flash).
      void refreshCachedDirs([rootPath]);
      return;
    }

    setTree({});
    void load(rootPath);
  }, [rootPath, load, refreshCachedDirs]);

  // Persist the current snapshot on unmount so an app-level navigation away
  // from FileTree (rare but possible) doesn't lose state.
  useEffect(() => {
    return () => {
      const path = prevRootPathRef.current;
      const snap = treeForCacheRef.current;
      if (path && Object.keys(snap).length > 0) {
        fileTreeCache.set(path, snap as unknown as FileTreeSnapshot);
      }
    };
  }, []);

  // React to external file changes by refreshing only the directories that
  // changed. Expanded + loaded directories get re-listed; folded ones are
  // ignored so we don't re-fetch content the user hasn't opened.
  //
  // Listener-only on purpose — FileTree must NEVER call api.fs.watch.
  // Watcher lifecycle belongs to useProjectWatchers (mounted once in
  // AppInner, one subscription per OPEN project). When FileTree owned the
  // subscription, every project switch closed + recreated the chokidar
  // watcher (a fresh depth-8 recursive sweep per switch, even A→B→A) and
  // left background projects event-blind. Main broadcasts ev.root as
  // path.resolve(root) and project paths are already absolute, so strict
  // equality is the correct filter.
  useEffect(() => {
    return api.fs.onWatchEvent((ev) => {
      if (ev.root !== rootPath) return;
      setTree((current) => {
        const next: Record<string, NodeState> = current;
        for (const dir of ev.dirs) {
          // Only refresh directories we've already loaded at least once.
          if (current[dir]) {
            void load(dir);
          }
        }
        return next;
      });
    });
  }, [rootPath, load]);

  const refreshDir = useCallback(
    (dir: string) => {
      // Force a reload — preserves expanded flag for nodes still visible.
      void load(dir);
    },
    [load],
  );

  // toggle reads the node from inside the functional updater so it does NOT
  // depend on `tree`. That keeps its identity stable, which (via the stable
  // callbacks bundle below) keeps React.memo on the rows effective.
  const toggle = useCallback(
    (path: string) => {
      let needsLoad = false;
      setTree((s) => {
        const current = s[path];
        if (!current) {
          // Never loaded — kick off a load (handled after the updater) and
          // leave state untouched here; load() will set expanded: true.
          needsLoad = true;
          return s;
        }
        if (!current.entries && !current.loading) needsLoad = true;
        return { ...s, [path]: { ...current, expanded: !current.expanded } };
      });
      if (needsLoad) void load(path);
    },
    [load],
  );

  const handleNewFile = useCallback(
    (parentDir: string) => {
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
    },
    [askPrompt, refreshDir],
  );

  const handleNewFolder = useCallback(
    (parentDir: string) => {
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
    },
    [askPrompt, refreshDir],
  );

  const handleRename = useCallback(
    (absPath: string) => {
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
    },
    [askPrompt, editorClose, refreshDir],
  );

  const handleDelete = useCallback(
    async (absPath: string) => {
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
    },
    [editorClose, refreshDir],
  );

  const handleDuplicate = useCallback(
    async (absPath: string) => {
      try {
        await api.fs.duplicate(absPath);
        refreshDir(dirname(absPath));
      } catch (err) {
        console.error('duplicate failed', err);
      }
    },
    [refreshDir],
  );

  const handleReveal = useCallback((absPath: string) => {
    void api.fs.reveal(absPath);
  }, []);

  const handleCopyPath = useCallback((absPath: string) => {
    void navigator.clipboard.writeText(absPath).catch(() => undefined);
  }, []);

  // Apply the visibility filter client-side so toggling is instant and we
  // don't re-hit the filesystem. Main always returns everything except .git
  // and .DS_Store.
  //
  // Cached by (entries array reference, showHidden) so the SAME NodeState.entries
  // always yields the SAME filtered array reference. Stable identity is what
  // lets the row's `childEntries === childEntries` memo check short-circuit.
  const filterCacheRef = useRef(new WeakMap<DirEntry[], DirEntry[]>());
  const filterCacheHiddenRef = useRef(showHidden);
  if (filterCacheHiddenRef.current !== showHidden) {
    // showHidden flip invalidates every cached filtered array.
    filterCacheHiddenRef.current = showHidden;
    filterCacheRef.current = new WeakMap<DirEntry[], DirEntry[]>();
  }
  const filterVisible = useCallback(
    (entries: DirEntry[] | null | undefined): DirEntry[] => {
      if (!entries) return EMPTY_ENTRIES;
      if (showHidden) return entries;
      const cached = filterCacheRef.current.get(entries);
      if (cached) return cached;
      const filtered = entries.filter((e) => !e.name.startsWith('.'));
      filterCacheRef.current.set(entries, filtered);
      return filtered;
    },
    [showHidden],
  );

  // ── Stable accessors for per-row data ──────────────────────────────────
  // Rows derive their OWN git status / folder stat / etc. through these. We
  // keep the live maps in refs so the accessor identities never change (memo
  // stays effective) while the values they return are always current.
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const gitByPathRef = useRef(gitByPath);
  gitByPathRef.current = gitByPath;
  const folderStatsRef = useRef(folderStats);
  folderStatsRef.current = folderStats;
  const activeEditorPathRef = useRef(activeEditorPath);
  activeEditorPathRef.current = activeEditorPath;
  const isIgnoredPathRef = useRef(isIgnoredPath);
  isIgnoredPathRef.current = isIgnoredPath;
  const filterVisibleRef = useRef(filterVisible);
  filterVisibleRef.current = filterVisible;
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;

  // Single stable bundle handed to every row. Built once; all entries read
  // through refs/stable callbacks so identities never change across renders.
  const callbacks = useMemo<FileTreeRowCallbacks>(
    () => ({
      onActivate: (entry) => {
        if (entry.isDirectory) {
          const node = treeRef.current[entry.path];
          if (!node) void load(entry.path);
          else toggle(entry.path);
        } else {
          onOpenFileRef.current?.(entry.path);
        }
      },
      onDragStart: (entry, e) => {
        e.dataTransfer.setData(
          'application/x-devspace-path',
          JSON.stringify([entry.path]),
        );
        e.dataTransfer.effectAllowed = 'copy';
      },
      onAddToClaudeCli: (path) => addFileToClaudeCli(path),
      onNewFile: (parentDir) => handleNewFile(parentDir),
      onNewFolder: (parentDir) => handleNewFolder(parentDir),
      onRename: (absPath) => handleRename(absPath),
      onDuplicate: (absPath) => void handleDuplicate(absPath),
      onDelete: (absPath) => void handleDelete(absPath),
      onReveal: (absPath) => handleReveal(absPath),
      onCopyPath: (absPath) => handleCopyPath(absPath),
      onPreview: (absPath) => {
        // Tag this as an in-tree gesture so the editor→sidebar follow effect
        // opens the preview WITHOUT docking a CLI for the project. The tab key
        // is the synthetic `html-preview:<path>`, so markTreeOpen must match it
        // exactly (followTab compares the tab path, not the file path).
        markTreeOpen(`html-preview:${absPath}`);
        openHtmlPreview(rootPath, absPath);
      },
      isExpanded: (path) => treeRef.current[path]?.expanded ?? false,
      hasLoadedEntries: (path) => !!treeRef.current[path]?.entries,
      isLoading: (path) => !!treeRef.current[path]?.loading,
      getLoadError: (path) => treeRef.current[path]?.error,
      getGitType: (entry) =>
        entry.isDirectory ? undefined : gitByPathRef.current.get(entry.path),
      getFolderStat: (entry) =>
        entry.isDirectory ? folderStatsRef.current.get(entry.path) : undefined,
      isActiveFile: (entry) =>
        !entry.isDirectory && entry.path === activeEditorPathRef.current,
      // Tracked changes (modified/added/etc.) win over the dim "ignored" state.
      // Otherwise an untracked file in an ignored directory would lose its
      // change badge — gitignore only fires for files git is actually
      // ignoring, so this is a rare collision but worth handling anyway.
      isIgnored: (entry, gitType) =>
        !gitType && isIgnoredPathRef.current(entry.path),
      getChildEntries: (path) =>
        filterVisibleRef.current(treeRef.current[path]?.entries),
    }),
    // load/toggle/handlers are all stable (useCallback). Bundle is built once.
    [
      load,
      toggle,
      handleNewFile,
      handleNewFolder,
      handleRename,
      handleDuplicate,
      handleDelete,
      handleReveal,
      handleCopyPath,
      openHtmlPreview,
      rootPath,
    ],
  );

  const root = tree[rootPath];
  const rootEntries = filterVisible(root?.entries);
  const isEmpty = !root?.loading && !root?.error && rootEntries.length === 0;

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        {/* h-full makes the empty space below the last file part of the right-click hit area.
            min-h-[120px] guarantees a target on tiny/empty projects. */}
        <div className="flex h-full min-h-[120px] flex-col gap-0.5">
          <div className="flex items-center gap-0.5 px-1.5 pb-1 pt-0.5">
            <button
              type="button"
              onClick={() => handleNewFile(rootPath)}
              title="New file at root"
              className="flex h-5 w-5 items-center justify-center rounded text-text-muted transition hover:bg-surface-overlay hover:text-text"
            >
              <FilePlus size={12} />
            </button>
            <button
              type="button"
              onClick={() => handleNewFolder(rootPath)}
              title="New folder at root"
              className="flex h-5 w-5 items-center justify-center rounded text-text-muted transition hover:bg-surface-overlay hover:text-text"
            >
              <FolderPlus size={12} />
            </button>
            <button
              type="button"
              onClick={() => refreshDir(rootPath)}
              title="Refresh"
              className="flex h-5 w-5 items-center justify-center rounded text-text-muted transition hover:bg-surface-overlay hover:text-text"
            >
              <RefreshCw size={11} />
            </button>
          </div>
          {root?.loading && (
            <div className="px-2 py-1 text-[10px] text-text-muted">Loading…</div>
          )}
          {root?.error && (
            <div className="px-2 py-1 text-[10px] text-semantic-error">{root.error}</div>
          )}
          {rootEntries.map((entry) => {
            const gitType = callbacks.getGitType(entry);
            return (
              <MemoFileTreeRow
                key={entry.path}
                entry={entry}
                depth={0}
                expanded={callbacks.isExpanded(entry.path)}
                hasEntries={callbacks.hasLoadedEntries(entry.path)}
                loading={callbacks.isLoading(entry.path)}
                loadError={callbacks.getLoadError(entry.path)}
                gitType={gitType}
                gitToken={gitToken}
                structureToken={structureToken}
                activeFileToken={activeFileToken}
                folderStat={callbacks.getFolderStat(entry)}
                isActiveFile={callbacks.isActiveFile(entry)}
                isIgnored={callbacks.isIgnored(entry, gitType)}
                childEntries={callbacks.getChildEntries(entry.path)}
                callbacks={callbacks}
              />
            );
          })}
          {isEmpty && (
            <div className="px-2 py-3 text-[10px] text-text-muted">
              Empty folder. Right-click to create a file.
            </div>
          )}
          {/* Spacer fills remaining vertical space so right-click below files hits the root trigger. */}
          <div className="flex-1" />
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="z-50 min-w-[180px] rounded-md border border-border-emphasis bg-surface-raised p-1 text-xs shadow-lg animate-in fade-in-0 zoom-in-95"
          style={{ backgroundColor: 'var(--color-surface-raised)' }}
        >
          <RootMenuItem onSelect={() => handleNewFile(rootPath)}>New File…</RootMenuItem>
          <RootMenuItem onSelect={() => handleNewFolder(rootPath)}>New Folder…</RootMenuItem>
          <ContextMenu.Separator className="my-1 h-px bg-border-subtle" />
          <RootMenuItem onSelect={() => refreshDir(rootPath)}>Refresh</RootMenuItem>
          <RootMenuItem onSelect={() => handleReveal(rootPath)}>Reveal in Finder</RootMenuItem>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
});

interface RootMenuItemProps {
  onSelect: () => void;
  children: React.ReactNode;
}

function RootMenuItem({ onSelect, children }: RootMenuItemProps) {
  return (
    <ContextMenu.Item
      onSelect={onSelect}
      className="flex items-center rounded px-2 py-1.5 outline-none hover:bg-surface-overlay"
    >
      {children}
    </ContextMenu.Item>
  );
}
