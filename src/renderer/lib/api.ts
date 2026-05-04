import type {
  CodeflowDoc,
  CodeflowFunctionEdge,
  CodeflowFunctionGraph,
  CodeflowGraph,
  CodeflowGraphEdge,
  CodeflowStatus,
  DirEntry,
  UpdateInfo,
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
  TmuxConfig,
  TmuxPane,
  TmuxSession,
  Workspace,
} from '@shared/types';

export interface DevspaceApi {
  app: {
    getVersion: () => Promise<string>;
    getHome: () => Promise<string>;
    checkUpdate: (force?: boolean) => Promise<UpdateInfo>;
    openExternal: (url: string) => Promise<boolean>;
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
    listSessions: () => Promise<TmuxSession[]>;
    killSession: (name: string) => Promise<boolean>;
    renameSession: (oldName: string, newName: string) => Promise<boolean>;
    killServer: () => Promise<boolean>;
    getConfig: () => Promise<TmuxConfig>;
    setConfig: (cfg: TmuxConfig) => Promise<TmuxConfig>;
    renderConf: (cfg: TmuxConfig) => Promise<string>;
    resolveBinary: () => Promise<{ path: string | null; configured: string | null }>;
  };
  settings: {
    list: (projectPath: string | null) => Promise<SettingsCategory[]>;
    read: (filePath: string) => Promise<string>;
    write: (filePath: string, content: string) => Promise<void>;
  };
  codeflow: {
    getStatus: (projectPath: string) => Promise<CodeflowStatus>;
    analyze: (projectPath: string, opts?: { force?: boolean }) => Promise<void>;
    cancel: (projectPath: string) => Promise<void>;
    readDoc: (absPath: string) => Promise<string>;
    listDocs: (projectPath: string) => Promise<CodeflowDoc[]>;
    openDir: (projectPath: string) => Promise<void>;
    buildGraph: (projectPath: string) => Promise<CodeflowGraph>;
    buildFunctionGraph: (projectPath: string) => Promise<CodeflowFunctionGraph>;
    augmentGraph: (
      projectPath: string,
      graph: CodeflowGraph,
    ) => Promise<{ ok: true; softEdges: CodeflowGraphEdge[] } | { ok: false; error: string }>;
    augmentCancel: (projectPath: string) => Promise<void>;
    augmentLoad: (
      projectPath: string,
      fingerprint: string,
    ) => Promise<{ softEdges: CodeflowGraphEdge[]; savedAt: number } | null>;
    augmentClear: (projectPath: string) => Promise<void>;
    augmentFunctions: (
      projectPath: string,
      graph: CodeflowFunctionGraph,
    ) => Promise<{ ok: true; softEdges: CodeflowFunctionEdge[] } | { ok: false; error: string }>;
    augmentFunctionsCancel: (projectPath: string) => Promise<void>;
    augmentFunctionsLoad: (
      projectPath: string,
      fingerprint: string,
    ) => Promise<{ softEdges: CodeflowFunctionEdge[]; savedAt: number } | null>;
    onAugmentProgress: (projectPath: string, cb: (msg: string) => void) => () => void;
    onAugmentFunctionsProgress: (projectPath: string, cb: (msg: string) => void) => () => void;
    onProgress: (projectPath: string, cb: (status: CodeflowStatus) => void) => () => void;
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
    app: {
      getVersion: notWired('app.getVersion'),
      getHome: notWired('app.getHome'),
      checkUpdate: notWired('app.checkUpdate'),
      openExternal: () => Promise.resolve(false),
    },
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
      listSessions: () => Promise.resolve([]),
      killSession: () => Promise.resolve(false),
      renameSession: () => Promise.resolve(false),
      killServer: () => Promise.resolve(false),
      getConfig: notWired('tmux.getConfig'),
      setConfig: notWired('tmux.setConfig'),
      renderConf: notWired('tmux.renderConf'),
      resolveBinary: () => Promise.resolve({ path: null, configured: null }),
    },
    settings: {
      list: () => Promise.resolve([]),
      read: notWired('settings.read'),
      write: notWired('settings.write'),
    },
    codeflow: {
      getStatus: notWired('codeflow.getStatus'),
      analyze: notWired('codeflow.analyze'),
      cancel: notWired('codeflow.cancel'),
      readDoc: notWired('codeflow.readDoc'),
      listDocs: () => Promise.resolve([]),
      openDir: notWired('codeflow.openDir'),
      buildGraph: notWired('codeflow.buildGraph'),
      buildFunctionGraph: notWired('codeflow.buildFunctionGraph'),
      augmentGraph: notWired('codeflow.augmentGraph'),
      augmentCancel: notWired('codeflow.augmentCancel'),
      augmentLoad: () => Promise.resolve(null),
      augmentClear: notWired('codeflow.augmentClear'),
      augmentFunctions: notWired('codeflow.augmentFunctions'),
      augmentFunctionsCancel: notWired('codeflow.augmentFunctionsCancel'),
      augmentFunctionsLoad: () => Promise.resolve(null),
      onAugmentProgress: () => () => undefined,
      onAugmentFunctionsProgress: () => () => undefined,
      onProgress: () => () => undefined,
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
