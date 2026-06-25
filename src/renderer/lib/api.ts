import type {
  AgentDef,
  AgentScope,
  BackgroundRunMeta,
  BackgroundRunStatus,
  CliCapabilities,
  CliDetectionResult,
  CliId,
  CodeflowFunctionEdge,
  CodeflowFunctionGraph,
  CodeflowGraph,
  CodeflowGraphEdge,
  CodeflowGraphUpdate,
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
  DesignSeedingReseedResult,
  DesignSeedingStatus,
  SearchOptions,
  SearchResult,
  SettingsCategory,
  SkillDef,
  Task,
  TmuxConfig,
  TmuxPane,
  TmuxSession,
  Workspace,
} from '@shared/types';
import type {
  DiaryEntry,
  MemoryEntry,
  MemoryEvent,
  MemoryInboxItem,
  MemoryProject,
  MemoryScope,
  MemorySearchHit,
  MemorySettings,
  MemoryStats,
  MemoryType,
} from '@shared/types';
import type {
  DevlogEntry,
  DevlogEntryType,
  DevlogEvent,
  DevlogPlanStatus,
  DevlogSettings,
  DevlogVerdict,
  ForgeCatalogItem,
  ForgeDraft,
  ForgeEvent,
  ForgeKind,
  ForgeScope,
  ForgeSettings,
  ForgeSignal,
  ForgeStats,
  ForgeSuggestion,
  ForgeUseEvent,
} from '@shared/types';
import type {
  MemPalaceInstallInput,
  MemPalaceInstallResult,
  MemPalaceProgressEvent,
  MemPalaceStatus,
  MemPalaceUninstallInput,
} from '@shared/mempalace';
import type {
  SetupClaudeRunResult,
  SetupInstallResult,
  SetupProgressEvent,
  SetupStatus,
  SetupToolId,
} from '@shared/setup';
import type {
  DevServerEvent,
  DevServerInfo,
  DevServerInstallInput,
  DevServerInstallResult,
  DevServerStartInput,
} from '@shared/design';
import type { PreviewChangedEvent, PreviewFileInfo } from '@shared/preview';

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
  ui: {
    setZoomLevel: (level: number) => number;
    getZoomLevel: () => number;
  };
  workspace: {
    list: () => Promise<{ active: Workspace | null; workspaces: Workspace[] }>;
    pickFolder: () => Promise<Workspace | null>;
    open: (path: string) => Promise<Workspace>;
    scan: (id: string, path: string) => Promise<Project[]>;
    setActive: (id: string) => Promise<Workspace | null>;
    close: (id: string, path: string) => Promise<void>;
    // Lighter than close: frees per-project main-process state (dev-server,
    // graphify, codeflow-live) but keeps claude/shell PTYs (dock chips
    // persist cross-workspace) and fs watchers (FileTree's lifecycle) alive.
    suspend: (id: string, path: string) => Promise<void>;
  };
  tasks: {
    list: () => Promise<Task[]>;
    create: (opts: {
      title: string;
      sourceRepoPath: string;
      agent: string;
    }) => Promise<Task>;
    merge: (id: string) => Promise<void>;
    discard: (id: string) => Promise<void>;
    diffStat: (id: string) => Promise<{ files: number }>;
    createPr: (
      id: string,
    ) => Promise<{ ok: boolean; url?: string; error?: string }>;
    onChanged: (cb: (tasks: Task[]) => void) => () => void;
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
    // Listener-only tap on watch broadcasts — never toggles the main-process
    // subscription (see preload: FileWatcherService subscribers are a
    // Set<WebContents>, not refcounted, so only ONE owner may call watch()
    // per root). `ev.root` is path.resolve()'d by main; compare with strict
    // equality against absolute project paths.
    onWatchEvent: (cb: (ev: { root: string; dirs: string[] }) => void) => () => void;
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
    // Full session-tree kill: the PTY (tmux attach client) AND the backing
    // tmux session, so claude + MCP children don't leak detached. `kill`
    // stays detach-only — reloadTab / ClaudeSetupPane depend on that.
    killSessionTree: (
      projectId: string,
      tabId: string,
      kind: 'claude-cli' | 'shell',
    ) => Promise<void>;
    // Restart one claude-cli tab with a brand-new claude process (picks up
    // fresh .mcp.json / env). `kill` alone only detaches and the remounted
    // pane's `new-session -A` reattaches to the same claude.
    restartClaude: (projectId: string, tabId: string) => Promise<void>;
    // Pull the session's rolling output buffer for scrollback restore on
    // pane (re)mount. MUST be called after arming onData: the subscriber-
    // add + buffer snapshot are atomic in main, so everything after the
    // returned snapshot arrives as onData events. Resolves '' for unknown
    // sessions.
    subscribe: (sessionId: string) => Promise<string>;
    onData: (sessionId: string, cb: (data: string) => void) => () => void;
    onExit: (sessionId: string, cb: (code: number | null) => void) => () => void;
    // v0.36.0 — fires once per reaper tick that closed at least one
    // claude-cli session because it was idle longer than the configured
    // threshold. Renderer uses this to drop the tab from the dock store
    // and surface a resource-freed toast.
    onAutoClosed: (
      cb: (ev: { ids: string[]; thresholdMinutes: number }) => void,
    ) => () => void;
    // v0.36.1 — push the renderer's pinned claude-cli session-id set to
    // main. Fire-and-forget. Called from the cliTabs store on every
    // change to `columns` so the dual-tier reaper can distinguish visible
    // vs. background tabs.
    setPinned: (ids: string[]) => void;
    // Phase 4a — subscribe to the per-session tool-approval prompt event
    // emitted by main's ApprovalDetector. Returns an unsubscribe handle.
    onToolApproval: (
      sessionId: string,
      cb: (payload: {
        sessionId: string;
        request: {
          toolName: string | null;
          raw: string;
          matchedAt: number;
        };
      }) => void,
    ) => () => void;
  };
  tmux: {
    listPanes: (sessionName?: string) => Promise<TmuxPane[]>;
    capturePane: (paneId: string, lines?: number) => Promise<string>;
    capturePanes: (
      paneIds: string[],
      lines?: number,
    ) => Promise<Record<string, string>>;
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
    findStale: (maxAgeMs?: number) => Promise<Array<{ name: string; ageMs: number }>>;
    pruneStale: (maxAgeMs?: number) => Promise<string[]>;
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
  // CLI runtime detection — probes installed CLIs (currently just `claude`)
  // so the renderer can version-gate features on the detected CLI version.
  cli: {
    detect: () => Promise<CliDetectionResult[]>;
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
    // Copy a builtin (or any other) agent file into the user's
    // writable global/project scope. Source path is the builtin's
    // absolute path under <Resources>/builtin-packs/agents/; target is
    // either 'global' (~/.claude/agents/) or 'project' (<projectPath>/
    // .claude/agents/). Resolves to the freshly written AgentDef so the
    // renderer can select it after a list refresh.
    duplicate: (
      filePath: string,
      targetScope: 'global' | 'project',
      projectPath: string | null,
    ) => Promise<AgentDef>;
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
    // Copy a read-only skill (builtin or plugin) into the user's
    // writable global/project scope. Source is the skill's SKILL.md path.
    // The backend recursively copies the entire skill folder (SKILL.md
    // plus any helper assets) into the target scope.
    duplicate: (
      filePath: string,
      targetScope: 'global' | 'project',
      projectPath: string | null,
    ) => Promise<SkillDef>;
  };
  designSeeding: {
    status: () => Promise<DesignSeedingStatus>;
    setEnabled: (enabled: boolean) => Promise<void>;
    reseed: () => Promise<DesignSeedingReseedResult>;
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
    // v0.16: re-run detection only. Used by the toolbar Refresh button
    // when the user has added a config file or installed dependencies in
    // another terminal. For a running server the detection-derived fields
    // (kind, scriptName, candidateScripts, preflight) update in place;
    // status / url / logTail are preserved.
    refresh: (projectPath: string) => Promise<DevServerInfo>;
    // v0.16: run `<pm> install` in a managed PTY. Streams `install_progress`
    // events through the existing onEvent subscription. Resolves when the
    // underlying PTY exits.
    installDependencies: (input: DevServerInstallInput) => Promise<DevServerInstallResult>;
    // Streamed lifecycle + log events for a single project. Returns an
    // unsubscribe handle; calling it tears down the IPC listener.
    onEvent: (
      projectPath: string,
      cb: (event: DevServerEvent) => void,
    ) => () => void;
  };
  // v0.31: HTML preview files Claude writes under `<project>/.devspace/preview/`.
  preview: {
    // List existing .html preview files (path-contained to .devspace/preview).
    list: (projectPath: string) => Promise<PreviewFileInfo[]>;
    // Read one preview file's HTML for the renderer's sandboxed Blob URL.
    // Path-contained + symlink-guarded in the main process.
    readHtml: (projectPath: string, htmlPath: string) => Promise<string>;
    // Begin watching this project's preview dir (idempotent). Required
    // before onChanged fires.
    subscribe: (projectPath: string) => Promise<void>;
    // Stop watching for this window. Called from the active-project preview
    // effect's cleanup so only the active project keeps a chokidar watcher.
    unsubscribe: (projectPath: string) => Promise<void>;
    // Streamed add/change/unlink events for the project's preview dir.
    // Returns an unsubscribe handle.
    onChanged: (
      projectPath: string,
      cb: (event: PreviewChangedEvent) => void,
    ) => () => void;
  };
  codeflow: {
    buildGraph: (projectPath: string) => Promise<CodeflowGraph>;
    buildFunctionGraph: (projectPath: string) => Promise<CodeflowFunctionGraph>;
    // Queryable graph (graphify): one-shot query/path/explain → plain text.
    query: (
      projectPath: string,
      mode: 'query' | 'path' | 'explain',
      args: string[],
    ) => Promise<string>;
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
    // Live graph sync.
    subscribeGraph: (projectPath: string) => Promise<CodeflowGraph>;
    unsubscribeGraph: (projectPath: string) => Promise<void>;
    onGraphUpdated: (
      projectPath: string,
      cb: (update: CodeflowGraphUpdate) => void,
    ) => () => void;
  };
  memory: {
    listProjects: () => Promise<MemoryProject[]>;
    pruneGhostProjects: () => Promise<{ prunedHashes: string[]; keptGhosts: number }>;
    listEntries: (input: {
      scope: MemoryScope;
      projectPath?: string;
      type?: MemoryType;
      pinnedOnly?: boolean;
    }) => Promise<MemoryEntry[]>;
    getEntry: (id: string) => Promise<MemoryEntry | null>;
    createEntry: (input: {
      scope: MemoryScope;
      projectPath?: string;
      type: MemoryType;
      slug?: string;
      description: string;
      body: string;
      tags?: string[];
    }) => Promise<MemoryEntry>;
    updateEntry: (input: {
      id: string;
      description?: string;
      body?: string;
      tags?: string[];
    }) => Promise<MemoryEntry>;
    deleteEntry: (id: string) => Promise<void>;
    togglePin: (id: string) => Promise<MemoryEntry>;
    search: (input: {
      query: string;
      scope?: MemoryScope;
      projectPath?: string;
      types?: MemoryType[];
      tags?: string[];
      limit?: number;
    }) => Promise<MemorySearchHit[]>;
    getStats: () => Promise<MemoryStats>;
    listInbox: (projectPath?: string) => Promise<MemoryInboxItem[]>;
    resolveInbox: (input: {
      inboxId: string;
      type: MemoryType;
      slug?: string;
      description?: string;
      body?: string;
    }) => Promise<MemoryEntry>;
    dismissInbox: (inboxId: string) => Promise<void>;
    proposeFromTurn: (input: {
      projectPath: string;
      threadId: string;
      userMessage: string;
      assistantMessage: string;
    }) => Promise<MemoryInboxItem[]>;
    listDiary: (input: {
      scope: MemoryScope;
      projectPath?: string;
      from?: string;
      to?: string;
    }) => Promise<DiaryEntry[]>;
    getDiary: (date: string, projectPath?: string) => Promise<DiaryEntry | null>;
    writeDiary: (input: {
      date: string;
      scope: MemoryScope;
      projectPath?: string;
      body: string;
    }) => Promise<DiaryEntry>;
    buildRecallContext: (input: {
      query: string;
      projectPath?: string;
      limit?: number;
    }) => Promise<string>;
    buildInjectPreamble: (projectPath: string) => Promise<string>;
    // sub-project 3 (native learning): manual "Learn from recent work" trigger.
    // Returns a summary of how many learnings were created / inboxed / skipped.
    distill: (projectPath: string) => Promise<{
      status:
        | 'ok'
        | 'no-activity'
        | 'no-claude'
        | 'run-failed'
        | 'unparseable'
        | 'error';
      created: number;
      inboxed: number;
      skippedDup: number;
      message?: string;
    }>;
    getSettings: () => Promise<MemorySettings>;
    setSettings: (patch: Partial<MemorySettings>) => Promise<MemorySettings>;
    openDir: (scope: MemoryScope, projectPath?: string) => Promise<void>;
    onEvent: (cb: (event: MemoryEvent) => void) => () => void;
  };
  mempalace: {
    getStatus: () => Promise<MemPalaceStatus>;
    install: (input?: MemPalaceInstallInput) => Promise<MemPalaceInstallResult>;
    uninstall: (
      input?: MemPalaceUninstallInput,
    ) => Promise<MemPalaceInstallResult>;
    openVault: () => Promise<void>;
    onProgress: (cb: (ev: MemPalaceProgressEvent) => void) => () => void;
  };
  setup: {
    getStatus: () => Promise<SetupStatus>;
    installTool: (toolId: SetupToolId) => Promise<SetupInstallResult>;
    installAll: () => Promise<SetupInstallResult>;
    uninstallRtkHook: () => Promise<SetupInstallResult>;
    openClaudeDir: () => Promise<void>;
    runClaude: (
      opts?: { cols?: number; rows?: number },
    ) => Promise<SetupClaudeRunResult>;
    onProgress: (cb: (ev: SetupProgressEvent) => void) => () => void;
  };
  devlog: {
    list: (input: { projectPath: string; type?: DevlogEntryType }) => Promise<DevlogEntry[]>;
    get: (input: { projectPath: string; entryId: string }) => Promise<DevlogEntry | null>;
    create: (input: {
      projectPath: string;
      type: DevlogEntryType;
      title: string;
      body: string;
      status?: DevlogPlanStatus;
      verdict?: DevlogVerdict;
      subagentType?: string;
      version?: string;
      threadId?: string;
      toolUseId?: string;
    }) => Promise<DevlogEntry>;
    update: (input: {
      projectPath: string;
      entryId: string;
      title?: string;
      body?: string;
      status?: DevlogPlanStatus;
    }) => Promise<DevlogEntry>;
    delete: (input: { projectPath: string; entryId: string }) => Promise<void>;
    appendLog: (input: { projectPath: string; text: string }) => Promise<void>;
    buildInject: (projectPath: string) => Promise<string>;
    getSettings: () => Promise<DevlogSettings>;
    setSettings: (patch: Partial<DevlogSettings>) => Promise<DevlogSettings>;
    openDir: (projectPath: string) => Promise<void>;
    onEvent: (cb: (event: DevlogEvent) => void) => () => void;
  };
  // v0.37: background `claude --bg --exec` runs.
  bgClaude: {
    start: (command: string) => Promise<BackgroundRunMeta>;
    list: () => Promise<BackgroundRunMeta[]>;
    readLog: (
      runId: string,
      offset?: number,
    ) => Promise<{ text: string; bytes: number; status: BackgroundRunStatus }>;
    kill: (runId: string) => Promise<boolean>;
  };
  forge: {
    listDrafts: (projectPath: string) => Promise<ForgeDraft[]>;
    getDraft: (draftId: string) => Promise<ForgeDraft | null>;
    createDraft: (input: {
      projectPath: string;
      kind: ForgeKind;
      scope: ForgeScope;
      slug: string;
      brief: string;
    }) => Promise<ForgeDraft>;
    generateDraft: (input: { draftId: string }) => Promise<void>;
    updateDraft: (input: {
      draftId: string;
      slug?: string;
      body?: string;
      frontmatter?: Partial<ForgeDraft['frontmatter']>;
      userMessage?: string;
    }) => Promise<ForgeDraft>;
    saveDraft: (input: { draftId: string }) => Promise<{ path: string; key: string }>;
    deleteDraft: (draftId: string) => Promise<void>;
    cancelDraft: (draftId: string) => Promise<void>;
    listStats: (projectPath: string) => Promise<ForgeStats[]>;
    recordUse: (input: {
      projectPath: string;
      key: string;
      threadId: string;
      messageId: string;
    }) => Promise<void>;
    recordSignal: (input: {
      projectPath: string;
      key: string;
      messageId: string;
      signal: ForgeSignal;
      note?: string;
    }) => Promise<void>;
    listUses: (input: { projectPath: string; key: string; limit?: number }) => Promise<ForgeUseEvent[]>;
    listSuggestions: (projectPath: string) => Promise<ForgeSuggestion[]>;
    dismissSuggestion: (input: { projectPath: string; suggestionId: string }) => Promise<void>;
    listCatalog: () => Promise<ForgeCatalogItem[]>;
    discoverMatches: (projectPath: string) => Promise<ForgeCatalogItem[]>;
    getSettings: () => Promise<ForgeSettings>;
    setSettings: (patch: Partial<ForgeSettings>) => Promise<ForgeSettings>;
    onEvent: (cb: (event: ForgeEvent) => void) => () => void;
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
    ui: { setZoomLevel: () => 0, getZoomLevel: () => 0 },
    workspace: {
      list: notWired('workspace.list'),
      pickFolder: notWired('workspace.pickFolder'),
      open: notWired('workspace.open'),
      scan: notWired('workspace.scan'),
      setActive: notWired('workspace.setActive'),
      close: notWired('workspace.close'),
      suspend: notWired('workspace.suspend'),
    },
    tasks: {
      list: () => Promise.resolve([]),
      create: notWired('tasks.create'),
      merge: notWired('tasks.merge'),
      discard: notWired('tasks.discard'),
      diffStat: () => Promise.resolve({ files: 0 }),
      createPr: notWired('tasks.createPr'),
      onChanged: () => () => undefined,
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
      onWatchEvent: () => () => undefined,
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
      killSessionTree: notWired('pty.killSessionTree'),
      restartClaude: notWired('pty.restartClaude'),
      subscribe: () => Promise.resolve(''),
      onData: () => () => undefined,
      onExit: () => () => undefined,
      onAutoClosed: () => () => undefined,
      setPinned: () => undefined,
      onToolApproval: () => () => undefined,
    },
    tmux: {
      listPanes: () => Promise.resolve([]),
      capturePane: () => Promise.resolve(''),
      capturePanes: () => Promise.resolve({}),
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
      findStale: () => Promise.resolve([]),
      pruneStale: () => Promise.resolve([]),
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
    cli: {
      detect: () => Promise.resolve([]),
    },
    agents: {
      list: () => Promise.resolve([]),
      read: notWired('agents.read'),
      save: notWired('agents.save'),
      create: notWired('agents.create'),
      delete: notWired('agents.delete'),
      duplicate: notWired('agents.duplicate'),
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
      duplicate: notWired('skills.duplicate'),
    },
    designSeeding: {
      status: () =>
        Promise.resolve({
          enabled: true,
          packVersion: null,
          seededAt: null,
          skillCount: 0,
          systemCount: 0,
          agentCount: 0,
        }),
      setEnabled: notWired('designSeeding.setEnabled'),
      reseed: notWired('designSeeding.reseed'),
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
      refresh: () =>
        Promise.resolve({
          kind: 'unknown',
          scriptName: '',
          url: null,
          status: 'idle',
          logTail: [],
        } as DevServerInfo),
      installDependencies: notWired('devServer.installDependencies'),
      onEvent: () => () => undefined,
    },
    preview: {
      list: () => Promise.resolve([] as PreviewFileInfo[]),
      readHtml: notWired('preview.readHtml'),
      subscribe: () => Promise.resolve(),
      unsubscribe: () => Promise.resolve(),
      onChanged: () => () => undefined,
    },
    codeflow: {
      buildGraph: notWired('codeflow.buildGraph'),
      query: notWired('codeflow.query'),
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
      subscribeGraph: notWired('codeflow.subscribeGraph'),
      unsubscribeGraph: () => Promise.resolve(),
      onGraphUpdated: () => () => undefined,
    },
    memory: {
      listProjects: () => Promise.resolve([]),
      pruneGhostProjects: () =>
        Promise.resolve({ prunedHashes: [], keptGhosts: 0 }),
      listEntries: () => Promise.resolve([]),
      getEntry: () => Promise.resolve(null),
      createEntry: notWired('memory.createEntry'),
      updateEntry: notWired('memory.updateEntry'),
      deleteEntry: notWired('memory.deleteEntry'),
      togglePin: notWired('memory.togglePin'),
      search: () => Promise.resolve([]),
      getStats: () =>
        Promise.resolve({
          totalProjects: 0,
          totalMemories: 0,
          totalDiaryDays: 0,
          diaryStreak: 0,
          topTags: [],
        } satisfies MemoryStats),
      listInbox: () => Promise.resolve([]),
      resolveInbox: notWired('memory.resolveInbox'),
      dismissInbox: notWired('memory.dismissInbox'),
      proposeFromTurn: () => Promise.resolve([]),
      listDiary: () => Promise.resolve([]),
      getDiary: () => Promise.resolve(null),
      writeDiary: notWired('memory.writeDiary'),
      buildRecallContext: () => Promise.resolve(''),
      buildInjectPreamble: () => Promise.resolve(''),
      distill: () =>
        Promise.resolve({
          status: 'error' as const,
          created: 0,
          inboxed: 0,
          skippedDup: 0,
          message: 'not wired',
        }),
      getSettings: () =>
        Promise.resolve({
          enabled: true,
          autoCapture: 'smart',
          injectOnNewThread: true,
          maxInjectLines: 200,
          mempalaceSyncEnabled: false,
        } satisfies MemorySettings),
      setSettings: notWired('memory.setSettings'),
      openDir: notWired('memory.openDir'),
      onEvent: () => () => undefined,
    },
    mempalace: {
      getStatus: () =>
        Promise.resolve({
          installed: false,
          hostSupported: false,
          vaultPath: '',
          hooksDir: '',
          settingsFile: '',
          checks: {
            uv: 'unsupported',
            mempalacePackage: 'missing',
            vault: 'missing',
            hooks: 'missing',
            plugin: 'missing',
          },
        } as MemPalaceStatus),
      install: notWired('mempalace.install') as () => Promise<MemPalaceInstallResult>,
      uninstall: notWired(
        'mempalace.uninstall',
      ) as () => Promise<MemPalaceInstallResult>,
      openVault: notWired('mempalace.openVault') as () => Promise<void>,
      onProgress: () => () => undefined,
    },
    setup: {
      getStatus: () =>
        Promise.resolve({
          complete: false,
          platform: 'darwin',
          checks: [],
        } as SetupStatus),
      installTool: notWired('setup.installTool') as () => Promise<SetupInstallResult>,
      installAll: notWired('setup.installAll') as () => Promise<SetupInstallResult>,
      uninstallRtkHook: notWired(
        'setup.uninstallRtkHook',
      ) as () => Promise<SetupInstallResult>,
      openClaudeDir: notWired('setup.openClaudeDir') as () => Promise<void>,
      runClaude: notWired(
        'setup.runClaude',
      ) as () => Promise<SetupClaudeRunResult>,
      onProgress: () => () => undefined,
    },
    devlog: {
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(null),
      create: notWired('devlog.create'),
      update: notWired('devlog.update'),
      delete: notWired('devlog.delete'),
      appendLog: notWired('devlog.appendLog'),
      buildInject: () => Promise.resolve(''),
      getSettings: () =>
        Promise.resolve({
          enabled: true,
          autoCaptureAgents: true,
          autoCaptureReleases: false,
          injectOnNewThread: true,
          maxInjectEntries: 10,
          maxInjectLines: 150,
          commitToRepo: false,
          logRetentionDays: 90,
          agentRetentionDays: 60,
        } as DevlogSettings),
      setSettings: notWired('devlog.setSettings') as () => Promise<DevlogSettings>,
      openDir: notWired('devlog.openDir') as () => Promise<void>,
      onEvent: () => () => undefined,
    },
    bgClaude: {
      start: notWired('bgClaude.start'),
      list: () => Promise.resolve([]),
      readLog: () => Promise.resolve({ text: '', bytes: 0, status: 'pending' }),
      kill: () => Promise.resolve(false),
    },
    forge: {
      listDrafts: () => Promise.resolve([]),
      getDraft: () => Promise.resolve(null),
      createDraft: notWired('forge.createDraft'),
      generateDraft: notWired('forge.generateDraft'),
      updateDraft: notWired('forge.updateDraft'),
      saveDraft: notWired('forge.saveDraft'),
      deleteDraft: notWired('forge.deleteDraft'),
      cancelDraft: notWired('forge.cancelDraft'),
      listStats: () => Promise.resolve([]),
      recordUse: notWired('forge.recordUse'),
      recordSignal: notWired('forge.recordSignal'),
      listUses: () => Promise.resolve([]),
      listSuggestions: () => Promise.resolve([]),
      dismissSuggestion: notWired('forge.dismissSuggestion'),
      listCatalog: () => Promise.resolve([]),
      discoverMatches: () => Promise.resolve([]),
      getSettings: () =>
        Promise.resolve({
          enabled: true,
          autoSuggest: 'smart',
          implicitThanks: true,
          implicitCorrection: true,
          implicitAbandoned: true,
          showDiscoverBanner: true,
          maxSuggestionsPerDay: 3,
        } as ForgeSettings),
      setSettings: notWired('forge.setSettings') as () => Promise<ForgeSettings>,
      onEvent: () => () => undefined,
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
