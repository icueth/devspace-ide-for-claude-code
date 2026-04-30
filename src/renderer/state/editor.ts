import { create } from 'zustand';

import { api } from '@renderer/lib/api';
import { useGitStore } from '@renderer/state/git';
import { useWorkspaceStore } from '@renderer/state/workspace';

export type EditorTabKind = 'text' | 'image' | 'diff' | 'pdf' | 'codeflow';

export interface EditorTab {
  path: string;
  name: string;
  kind: EditorTabKind;
  content: string;
  savedContent: string;
  loading: boolean;
  error?: string;
  // Populated when kind === 'image' — base64 data URL ready for <img src>.
  dataUrl?: string;
  size?: number;
  // Pending cursor move requested by Quick Open / search / go-to-line.
  // Consumed by CodeMirrorPane, then cleared.
  pendingNav?: { line: number; column?: number };
  // Populated when kind === 'diff' — git HEAD vs working-tree contents.
  diffOld?: string;
  diffNew?: string;
  diffCwd?: string;
  diffRelPath?: string;
  // Populated when kind === 'codeflow' — points the view at the project the
  // analysis should run against. Stored separately from `path` because `path`
  // is the synthetic "codeflow:<projectPath>" key used for tab dedup.
  codeflowProjectPath?: string;
}

export interface OpenOptions {
  line?: number;
  column?: number;
}

const IMAGE_EXTS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
  'ico',
  'avif',
  'heic',
  'tif',
  'tiff',
]);

function detectKind(path: string): EditorTabKind {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'pdf') return 'pdf';
  if (IMAGE_EXTS.has(ext)) return 'image';
  return 'text';
}

export type PaneId = 'left' | 'right';

interface EditorState {
  tabs: EditorTab[];
  activeTabPath: string | null;
  // Right pane (split view). Empty = no split.
  splitTabs: EditorTab[];
  splitActivePath: string | null;

  open: (path: string, opts?: OpenOptions) => Promise<void>;
  openDiff: (cwd: string, relPath: string, absPath: string) => Promise<void>;
  openCodeflow: (projectPath: string, projectName: string) => void;
  close: (path: string, pane?: PaneId) => void;
  closeOthers: (path: string, pane?: PaneId) => void;
  closeToRight: (path: string, pane?: PaneId) => void;
  closeAll: (pane?: PaneId) => void;
  setActive: (path: string, pane?: PaneId) => void;
  updateContent: (path: string, content: string) => void;
  save: (path: string) => Promise<void>;
  isDirty: (path: string) => boolean;
  clearPendingNav: (path: string) => void;

  splitOpen: (path: string) => void;
  unsplit: () => void;
  moveToSplit: (path: string) => void;
  moveToMain: (path: string) => void;
}

function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

export const useEditorStore = create<
  EditorState & { focusedPane: PaneId; setFocusedPane: (p: PaneId) => void }
>((set, get) => ({
  tabs: [],
  activeTabPath: null,
  splitTabs: [],
  splitActivePath: null,
  focusedPane: 'left',
  setFocusedPane: (p) => set({ focusedPane: p }),

  async open(path, opts) {
    const nav = opts?.line
      ? { line: opts.line, column: opts.column }
      : undefined;
    const existing = get().tabs.find((t) => t.path === path);
    if (existing) {
      set((s) => ({
        activeTabPath: path,
        tabs: nav
          ? s.tabs.map((t) => (t.path === path ? { ...t, pendingNav: nav } : t))
          : s.tabs,
      }));
      return;
    }

    const kind = detectKind(path);
    const placeholder: EditorTab = {
      path,
      name: basename(path),
      kind,
      content: '',
      savedContent: '',
      loading: true,
      pendingNav: nav,
    };
    set((s) => ({ tabs: [...s.tabs, placeholder], activeTabPath: path }));

    try {
      if (kind === 'image' || kind === 'pdf') {
        const { mime, base64, size } = await api.fs.readBinary(path);
        const dataUrl = `data:${mime};base64,${base64}`;
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.path === path ? { ...t, dataUrl, size, loading: false } : t,
          ),
        }));
      } else {
        const content = await api.fs.readFile(path);
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.path === path
              ? { ...t, content, savedContent: content, loading: false }
              : t,
          ),
        }));
      }
    } catch (err) {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.path === path
            ? { ...t, loading: false, error: (err as Error).message }
            : t,
        ),
      }));
    }
  },

  close(path, pane = 'left') {
    const s = get();
    const tabsKey = pane === 'right' ? 'splitTabs' : 'tabs';
    const activeKey = pane === 'right' ? 'splitActivePath' : 'activeTabPath';
    const tabs = s[tabsKey];
    const activeTabPath = s[activeKey];
    const idx = tabs.findIndex((t) => t.path === path);
    if (idx < 0) return;
    const next = tabs.filter((t) => t.path !== path);
    let nextActive = activeTabPath;
    if (activeTabPath === path) {
      nextActive = next[idx]?.path ?? next[idx - 1]?.path ?? null;
    }
    set({ [tabsKey]: next, [activeKey]: nextActive } as Partial<EditorState>);
  },

  async openDiff(cwd, relPath, absPath) {
    const diffKey = `diff:${absPath}`;
    const existing = get().tabs.find((t) => t.path === diffKey);
    if (existing) {
      set({ activeTabPath: diffKey });
      return;
    }
    const placeholder: EditorTab = {
      path: diffKey,
      name: `${basename(absPath)} (diff)`,
      kind: 'diff',
      content: '',
      savedContent: '',
      loading: true,
      diffCwd: cwd,
      diffRelPath: relPath,
    };
    set((s) => ({ tabs: [...s.tabs, placeholder], activeTabPath: diffKey }));
    try {
      const { oldContent, newContent } = await api.git.diff(cwd, relPath);
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.path === diffKey
            ? { ...t, diffOld: oldContent, diffNew: newContent, loading: false }
            : t,
        ),
      }));
    } catch (err) {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.path === diffKey
            ? { ...t, loading: false, error: (err as Error).message }
            : t,
        ),
      }));
    }
  },

  openCodeflow(projectPath, projectName) {
    const tabPath = `codeflow:${projectPath}`;
    const existing = get().tabs.find((t) => t.path === tabPath);
    if (existing) {
      set({ activeTabPath: tabPath });
      return;
    }
    const tab: EditorTab = {
      path: tabPath,
      name: `${projectName} · Codeflow`,
      kind: 'codeflow',
      content: '',
      savedContent: '',
      loading: false,
      codeflowProjectPath: projectPath,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeTabPath: tabPath }));
  },

  closeOthers(path, pane = 'left') {
    const s = get();
    const tabsKey = pane === 'right' ? 'splitTabs' : 'tabs';
    const activeKey = pane === 'right' ? 'splitActivePath' : 'activeTabPath';
    const keep = s[tabsKey].find((t) => t.path === path);
    if (!keep) return;
    set({ [tabsKey]: [keep], [activeKey]: path } as Partial<EditorState>);
  },

  closeToRight(path, pane = 'left') {
    const s = get();
    const tabsKey = pane === 'right' ? 'splitTabs' : 'tabs';
    const activeKey = pane === 'right' ? 'splitActivePath' : 'activeTabPath';
    const tabs = s[tabsKey];
    const activeTabPath = s[activeKey];
    const idx = tabs.findIndex((t) => t.path === path);
    if (idx < 0) return;
    const next = tabs.slice(0, idx + 1);
    const nextActive = next.some((t) => t.path === activeTabPath) ? activeTabPath : path;
    set({ [tabsKey]: next, [activeKey]: nextActive } as Partial<EditorState>);
  },

  closeAll(pane = 'left') {
    const tabsKey = pane === 'right' ? 'splitTabs' : 'tabs';
    const activeKey = pane === 'right' ? 'splitActivePath' : 'activeTabPath';
    set({ [tabsKey]: [], [activeKey]: null } as Partial<EditorState>);
  },

  setActive(path, pane = 'left') {
    if (pane === 'right') set({ splitActivePath: path });
    else set({ activeTabPath: path });
  },

  updateContent(path, content) {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.path === path ? { ...t, content } : t)),
    }));
  },

  async save(path) {
    const tab = get().tabs.find((t) => t.path === path);
    if (!tab) return;
    try {
      await api.fs.writeFile(path, tab.content);
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.path === path ? { ...t, savedContent: t.content, error: undefined } : t,
        ),
      }));
      // Nudge git to repaint file-tree indicators immediately after save.
      const ws = useWorkspaceStore.getState();
      const project = ws.projects.find(
        (p) => path === p.path || path.startsWith(`${p.path}/`),
      );
      if (project) void useGitStore.getState().refresh(project.id, project.path);
    } catch (err) {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.path === path ? { ...t, error: (err as Error).message } : t,
        ),
      }));
    }
  },

  isDirty(path) {
    const tab = get().tabs.find((t) => t.path === path);
    return !!tab && tab.content !== tab.savedContent;
  },

  clearPendingNav(path) {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.path === path && t.pendingNav ? { ...t, pendingNav: undefined } : t,
      ),
      splitTabs: s.splitTabs.map((t) =>
        t.path === path && t.pendingNav ? { ...t, pendingNav: undefined } : t,
      ),
    }));
  },

  splitOpen(path) {
    // Clone the main tab into the right pane so both panes can scroll /
    // edit independently. Save target stays shared via path.
    const src = get().tabs.find((t) => t.path === path);
    if (!src) return;
    const existing = get().splitTabs.find((t) => t.path === path);
    if (existing) {
      set({ splitActivePath: path });
      return;
    }
    set((s) => ({
      splitTabs: [...s.splitTabs, { ...src }],
      splitActivePath: path,
    }));
  },

  unsplit() {
    set({ splitTabs: [], splitActivePath: null });
  },

  moveToSplit(path) {
    const s = get();
    const src = s.tabs.find((t) => t.path === path);
    if (!src) return;
    const mainTabs = s.tabs.filter((t) => t.path !== path);
    const nextMainActive =
      s.activeTabPath === path
        ? (mainTabs[mainTabs.length - 1]?.path ?? null)
        : s.activeTabPath;
    const splitExisting = s.splitTabs.find((t) => t.path === path);
    const splitTabs = splitExisting ? s.splitTabs : [...s.splitTabs, { ...src }];
    set({
      tabs: mainTabs,
      activeTabPath: nextMainActive,
      splitTabs,
      splitActivePath: path,
    });
  },

  moveToMain(path) {
    const s = get();
    const src = s.splitTabs.find((t) => t.path === path);
    if (!src) return;
    const splitTabs = s.splitTabs.filter((t) => t.path !== path);
    const nextSplitActive =
      s.splitActivePath === path
        ? (splitTabs[splitTabs.length - 1]?.path ?? null)
        : s.splitActivePath;
    const mainExisting = s.tabs.find((t) => t.path === path);
    const tabs = mainExisting ? s.tabs : [...s.tabs, { ...src }];
    set({
      tabs,
      activeTabPath: path,
      splitTabs,
      splitActivePath: nextSplitActive,
    });
  },
}));
