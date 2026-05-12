import type {
  AgentDef,
  AgentScope,
  ChatConfig,
  ChatEvent,
  ChatSendRequest,
  ChatThread,
  CodeflowDoc,
  CodeflowFunctionEdge,
  CodeflowFunctionGraph,
  CodeflowGraph,
  CodeflowGraphEdge,
  CodeflowStatus,
  DirEntry,
  LlmCompleteRequest,
  LlmCompleteResponse,
  LlmConfig,
  LlmEditRequest,
  LlmEditResponse,
  LlmTestResult,
  UpdateInfo,
  GitBranches,
  GitDiff,
  GitLogEntry,
  GitSnapshot,
  McpScope,
  McpServer,
  McpServerEntry,
  Project,
  PtyCreateOptions,
  PtySession,
  SearchOptions,
  SearchResult,
  SettingsCategory,
  SkillDef,
  TeamDef,
  TeamScope,
  TmuxConfig,
  TmuxPane,
  TmuxSession,
  Workspace,
} from '@shared/types';
import type {
  CreateDesignInput,
  DesignEvent,
  DesignSaveEditsInput,
  DesignScreen,
  DesignSkill,
  DesignSystem,
  DevServerEvent,
  DevServerInfo,
  DevServerStartInput,
  RegenerateDesignInput,
} from '@shared/design';

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
  files: {
    // Returns the absolute disk path of a File object. Electron 32+
    // removed `File.path`; this is the supported replacement that
    // bridges from preload's webUtils. Returns '' when the file has no
    // path (synthesized File, paste-from-buffer, etc.).
    getPathForFile: (file: File) => string;
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
  llm: {
    getConfig: () => Promise<LlmConfig>;
    setConfig: (cfg: LlmConfig) => Promise<LlmConfig>;
    test: (cfg: LlmConfig) => Promise<LlmTestResult>;
    complete: (req: LlmCompleteRequest) => Promise<LlmCompleteResponse>;
    edit: (req: LlmEditRequest) => Promise<LlmEditResponse>;
  };
  chat: {
    listThreads: (projectPath: string) => Promise<ChatThread[]>;
    createThread: (projectPath: string, title?: string) => Promise<ChatThread>;
    deleteThread: (projectPath: string, threadId: string) => Promise<void>;
    send: (req: ChatSendRequest) => Promise<{ messageId: string }>;
    cancel: (projectPath: string) => Promise<void>;
    subscribe: (projectPath: string) => Promise<void>;
    getConfig: (projectPath: string) => Promise<ChatConfig>;
    setConfig: (projectPath: string, cfg: ChatConfig) => Promise<ChatConfig>;
    updateThreadConfig: (
      projectPath: string,
      threadId: string,
      cfg: ChatConfig | null,
    ) => Promise<ChatThread>;
    onEvent: (
      projectPath: string,
      cb: (threadId: string, event: ChatEvent) => void,
    ) => () => void;
  };
  agents: {
    list: (projectPath: string | null) => Promise<AgentDef[]>;
    read: (filePath: string) => Promise<AgentDef>;
    save: (agent: AgentDef) => Promise<AgentDef>;
    create: (
      scope: AgentScope,
      projectPath: string | null,
      slug: string,
    ) => Promise<AgentDef>;
    delete: (filePath: string) => Promise<void>;
  };
  teams: {
    list: (projectPath: string | null) => Promise<TeamDef[]>;
    get: (
      projectPath: string | null,
      teamId: string,
    ) => Promise<TeamDef | null>;
    save: (
      scope: TeamScope,
      projectPath: string | null,
      team: TeamDef,
    ) => Promise<TeamDef>;
    delete: (
      scope: TeamScope,
      projectPath: string | null,
      teamId: string,
    ) => Promise<void>;
  };
  skills: {
    list: (
      projectPath: string | null,
      includePlugins?: boolean,
    ) => Promise<SkillDef[]>;
    read: (filePath: string) => Promise<SkillDef>;
    save: (skill: SkillDef) => Promise<SkillDef>;
    create: (
      scope: 'global' | 'project',
      projectPath: string | null,
      slug: string,
    ) => Promise<SkillDef>;
    delete: (filePath: string) => Promise<void>;
  };
  mcp: {
    list: (projectPath: string | null) => Promise<McpServerEntry[]>;
    save: (entry: McpServerEntry) => Promise<McpServerEntry>;
    rename: (
      scope: McpScope,
      filePath: string,
      oldName: string,
      newName: string,
    ) => Promise<void>;
    delete: (
      scope: McpScope,
      filePath: string,
      name: string,
    ) => Promise<void>;
    create: (
      scope: McpScope,
      projectPath: string | null,
      name: string,
      server: McpServer,
    ) => Promise<McpServerEntry>;
  };
  design: {
    list: (projectPath: string) => Promise<DesignScreen[]>;
    get: (projectPath: string, screenId: string) => Promise<DesignScreen | null>;
    create: (input: CreateDesignInput) => Promise<DesignScreen>;
    regenerate: (input: RegenerateDesignInput) => Promise<DesignScreen>;
    saveEdits: (input: DesignSaveEditsInput) => Promise<DesignScreen>;
    delete: (projectPath: string, screenId: string) => Promise<void>;
    cancel: (projectPath: string, screenId: string) => Promise<void>;
    listSkills: (projectPath: string | null) => Promise<DesignSkill[]>;
    listSystems: (projectPath: string | null) => Promise<DesignSystem[]>;
    readHtml: (projectPath: string, screenId: string, versionId?: string) => Promise<string>;
    subscribe: (projectPath: string) => Promise<void>;
    onEvent: (
      projectPath: string,
      cb: (event: DesignEvent) => void,
    ) => () => void;
  };
  devServer: {
    // Detect framework + script + package manager without starting anything.
    // Backend reads package.json + lockfiles; renderer uses the result to
    // decide which "Start <framework>" button to render. Idempotent.
    detect: (projectPath: string) => Promise<DevServerInfo>;
    // Spawn the dev script through PtyPool. Resolves once the spawn has
    // been queued — the renderer must rely on `onEvent` to learn when the
    // URL is parsed out of stdout (status_changed → 'running' + url_resolved).
    start: (input: DevServerStartInput) => Promise<DevServerInfo>;
    // Kill the spawned process and clean up the PTY id. Safe to call
    // when no server is running (no-op).
    stop: (projectPath: string) => Promise<DevServerInfo>;
    // Current snapshot of detection + lifecycle state. Returned eagerly
    // on mount so the UI can paint without waiting for the first event.
    status: (projectPath: string) => Promise<DevServerInfo>;
    // Bind the main-process event stream to this project. Must be called
    // before `onEvent` callbacks fire — symmetric with design.subscribe.
    subscribe: (projectPath: string) => Promise<void>;
    // Symmetric tear-down. Called by the renderer on tab unmount so dead
    // tabs don't keep receiving events.
    unsubscribe: (projectPath: string) => Promise<void>;
    // Streamed lifecycle + log events for a single project. Returns an
    // unsubscribe handle; calling it tears down the IPC listener.
    onEvent: (
      projectPath: string,
      cb: (event: DevServerEvent) => void,
    ) => () => void;
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
    files: { getPathForFile: () => '' },
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
    llm: {
      getConfig: notWired('llm.getConfig'),
      setConfig: notWired('llm.setConfig'),
      test: notWired('llm.test'),
      complete: () => Promise.resolve({ text: '', latencyMs: 0 }),
      edit: () => Promise.resolve({ text: '', latencyMs: 0 }),
    },
    chat: {
      listThreads: () => Promise.resolve([]),
      createThread: notWired('chat.createThread'),
      deleteThread: notWired('chat.deleteThread'),
      send: notWired('chat.send'),
      cancel: notWired('chat.cancel'),
      subscribe: notWired('chat.subscribe'),
      getConfig: () => Promise.resolve({}),
      setConfig: notWired('chat.setConfig'),
      updateThreadConfig: notWired('chat.updateThreadConfig'),
      onEvent: () => () => undefined,
    },
    agents: {
      list: () => Promise.resolve([]),
      read: notWired('agents.read'),
      save: notWired('agents.save'),
      create: notWired('agents.create'),
      delete: notWired('agents.delete'),
    },
    mcp: {
      list: () => Promise.resolve([]),
      save: notWired('mcp.save'),
      rename: notWired('mcp.rename'),
      delete: notWired('mcp.delete'),
      create: notWired('mcp.create'),
    },
    skills: {
      list: () => Promise.resolve([]),
      read: notWired('skills.read'),
      save: notWired('skills.save'),
      create: notWired('skills.create'),
      delete: notWired('skills.delete'),
    },
    teams: {
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(null),
      save: notWired('teams.save'),
      delete: notWired('teams.delete'),
    },
    design: {
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(null),
      create: notWired('design.create'),
      regenerate: notWired('design.regenerate'),
      saveEdits: notWired('design.saveEdits'),
      delete: notWired('design.delete'),
      cancel: notWired('design.cancel'),
      listSkills: () => Promise.resolve([]),
      listSystems: () => Promise.resolve([]),
      readHtml: notWired('design.readHtml'),
      subscribe: notWired('design.subscribe'),
      onEvent: () => () => undefined,
    },
    devServer: {
      // Permissive idle stub so the LivePreview pane doesn't blow up
      // before the backend agent wires the preload binding.
      detect: () =>
        Promise.resolve({
          kind: 'unknown',
          scriptName: '',
          url: null,
          status: 'idle',
          logTail: [],
        } as DevServerInfo),
      start: notWired('devServer.start'),
      stop: notWired('devServer.stop'),
      status: () =>
        Promise.resolve({
          kind: 'unknown',
          scriptName: '',
          url: null,
          status: 'idle',
          logTail: [],
        } as DevServerInfo),
      subscribe: () => Promise.resolve(),
      unsubscribe: () => Promise.resolve(),
      onEvent: () => () => undefined,
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
