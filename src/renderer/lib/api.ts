import type {
  DirEntry,
  GitBranches,
  GitDiff,
  GitLogEntry,
  GitSnapshot,
  Project,
  PtyCreateOptions,
  PtySession,
  SearchOptions,
  SearchResult,
  SettingsCategory,
  TmuxPane,
  Workspace,
} from '@shared/types';

export interface DevspaceApi {
  app: {
    getVersion: () => Promise<string>;
    getHome: () => Promise<string>;
  };
  appEvents: {
    onCloseTab: (cb: () => void) => () => void;
  };
  workspace: {
    list: () => Promise<{ active: Workspace | null; workspaces: Workspace[] }>;
    pickFolder: () => Promise<Workspace | null>;
    open: (path: string) => Promise<Workspace>;
    scan: (id: string, path: string) => Promise<Project[]>;
    setActive: (id: string) => Promise<Workspace | null>;
  };
  fs: {
    readDir: (path: string) => Promise<DirEntry[]>;
    readFile: (path: string) => Promise<string>;
    readBinary: (path: string) => Promise<{ mime: string; base64: string; size: number }>;
    writeFile: (path: string, data: string) => Promise<boolean>;
    listFiles: (cwd: string) => Promise<string[]>;
    create: (path: string, kind: 'file' | 'folder') => Promise<string>;
    rename: (src: string, dest: string) => Promise<string>;
    delete: (path: string) => Promise<void>;
    duplicate: (path: string) => Promise<string>;
    reveal: (path: string) => Promise<void>;
    watch: (root: string, cb: (dirs: string[]) => void) => () => void;
  };
  git: {
    status: (cwd: string) => Promise<GitSnapshot>;
    diff: (cwd: string, file: string) => Promise<GitDiff>;
    stage: (cwd: string, paths: string[]) => Promise<void>;
    unstage: (cwd: string, paths: string[]) => Promise<void>;
    discard: (cwd: string, paths: string[]) => Promise<void>;
    commit: (cwd: string, message: string, opts?: { amend?: boolean }) => Promise<string>;
    branches: (cwd: string) => Promise<GitBranches>;
    checkout: (cwd: string, name: string) => Promise<void>;
    createBranch: (cwd: string, name: string, from?: string) => Promise<void>;
    log: (cwd: string, limit?: number) => Promise<GitLogEntry[]>;
    fetch: (cwd: string) => Promise<void>;
    push: (cwd: string) => Promise<void>;
    pull: (cwd: string) => Promise<void>;
  };
  search: {
    grep: (cwd: string, query: string, opts?: SearchOptions) => Promise<SearchResult>;
  };
  pty: {
    create: (opts: PtyCreateOptions) => Promise<PtySession>;
    write: (sessionId: string, data: string) => Promise<void>;
    resize: (sessionId: string, cols: number, rows: number) => Promise<void>;
    kill: (sessionId: string) => Promise<void>;
    onData: (sessionId: string, cb: (data: string) => void) => () => void;
    onExit: (sessionId: string, cb: (code: number | null) => void) => () => void;
  };
  tmux: {
    listPanes: (sessionName?: string) => Promise<TmuxPane[]>;
    capturePane: (paneId: string, lines?: number) => Promise<string>;
    selectPane: (paneId: string) => Promise<boolean>;
    sendKeys: (paneId: string, text: string, submit?: boolean) => Promise<boolean>;
  };
  settings: {
    list: (projectPath: string | null) => Promise<SettingsCategory[]>;
    read: (filePath: string) => Promise<string>;
    write: (filePath: string, content: string) => Promise<void>;
  };
}

declare global {
  interface Window {
    devspace: DevspaceApi;
  }
}

function makeStubApi(): DevspaceApi {
  const notWired = (name: string) => () => {
    const err = new Error(
      `devspace API unavailable (${name}) — preload did not expose window.devspace`,
    );
    console.error(err);
    return Promise.reject(err);
  };
  return {
    app: { getVersion: notWired('app.getVersion'), getHome: notWired('app.getHome') },
    appEvents: { onCloseTab: () => () => undefined },
    workspace: {
      list: notWired('workspace.list'),
      pickFolder: notWired('workspace.pickFolder'),
      open: notWired('workspace.open'),
      scan: notWired('workspace.scan'),
      setActive: notWired('workspace.setActive'),
    },
    fs: {
      readDir: notWired('fs.readDir'),
      readFile: notWired('fs.readFile'),
      readBinary: notWired('fs.readBinary'),
      writeFile: notWired('fs.writeFile'),
      listFiles: notWired('fs.listFiles'),
      create: notWired('fs.create'),
      rename: notWired('fs.rename'),
      delete: notWired('fs.delete'),
      duplicate: notWired('fs.duplicate'),
      reveal: notWired('fs.reveal'),
      watch: () => () => undefined,
    },
    git: {
      status: notWired('git.status'),
      diff: notWired('git.diff'),
      stage: notWired('git.stage'),
      unstage: notWired('git.unstage'),
      discard: notWired('git.discard'),
      commit: notWired('git.commit'),
      branches: notWired('git.branches'),
      checkout: notWired('git.checkout'),
      createBranch: notWired('git.createBranch'),
      log: () => Promise.resolve([]),
      fetch: notWired('git.fetch'),
      push: notWired('git.push'),
      pull: notWired('git.pull'),
    },
    search: {
      grep: notWired('search.grep'),
    },
    pty: {
      create: notWired('pty.create'),
      write: notWired('pty.write'),
      resize: notWired('pty.resize'),
      kill: notWired('pty.kill'),
      onData: () => () => undefined,
      onExit: () => () => undefined,
    },
    tmux: {
      listPanes: () => Promise.resolve([]),
      capturePane: () => Promise.resolve(''),
      selectPane: () => Promise.resolve(false),
      sendKeys: () => Promise.resolve(false),
    },
    settings: {
      list: () => Promise.resolve([]),
      read: notWired('settings.read'),
      write: notWired('settings.write'),
    },
  } as unknown as DevspaceApi;
}

export const api: DevspaceApi =
  typeof window !== 'undefined' && window.devspace ? window.devspace : makeStubApi();

if (typeof window !== 'undefined' && !window.devspace) {
  console.error(
    '[api] window.devspace is undefined — preload script did not expose bindings',
  );
}
