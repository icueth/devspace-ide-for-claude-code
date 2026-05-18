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
  ThreadSummary,
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
  MemPalaceDrawer,
  MemPalaceListDrawersInput,
  MemPalaceListTriplesInput,
  MemPalaceOverview,
  MemPalaceRoom,
  MemPalaceTriple,
  MemPalaceWing,
} from '@shared/mempalaceData';
import type {
  SetupClaudeRunResult,
  SetupInstallResult,
  SetupProgressEvent,
  SetupStatus,
  SetupToolId,
} from '@shared/setup';
import type {
  ApprovePlanInput,
  CreateDesignInput,
  DesignAdapterDetectResult,
  DesignAppPlan,
  DesignEvent,
  DesignFollowUpInput,
  DesignMessage,
  DesignSaveEditsInput,
  DesignScreen,
  DesignSkill,
  DesignSystem,
  DesignWriteBackInput,
  DesignWriteBackResult,
  DevServerEvent,
  DevServerInfo,
  DevServerInstallInput,
  DevServerInstallResult,
  DevServerStartInput,
  ExtractProjectTokensInput,
  PlanAppInput,
  ProjectDesignProfile,
  ProjectDesignTokens,
  RegenerateDesignInput,
  SetProjectTokensInput,
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
    // v0.10: follow-up turn on an existing screen. Resolves once the
    // generation has been queued — the actual streaming + final
    // assistant message arrive via DesignEvent ('message_appended',
    // 'message_updated', 'message_finalized', 'generation_complete').
    followUp: (input: DesignFollowUpInput) => Promise<DesignScreen>;
    // Eager read of the transcript for a screen. Backward-compat: when
    // the persisted screen has no messages, returns the synthetic
    // `[{role:'user', content: brief}]` seed so the UI can render
    // without special-casing legacy screens.
    listMessages: (projectPath: string, screenId: string) => Promise<DesignMessage[]>;
    // v0.10: read the cached project profile. Returns null when no
    // package.json is present. Lazily builds on first call.
    getProfile: (projectPath: string) => Promise<ProjectDesignProfile | null>;
    // Force-refresh the cached profile (user clicked "Refresh project
    // context" in DesignSettings, or just edited package.json and wants
    // the next generation to pick it up immediately).
    rebuildProfile: (projectPath: string) => Promise<ProjectDesignProfile | null>;
    subscribe: (projectPath: string) => Promise<void>;
    onEvent: (
      projectPath: string,
      cb: (event: DesignEvent) => void,
    ) => () => void;
    // ── v0.15: Multi-screen app planning ────────────────────────────
    planApp: (input: PlanAppInput) => Promise<DesignAppPlan>;
    listApps: (projectPath: string) => Promise<DesignAppPlan[]>;
    getApp: (projectPath: string, appId: string) => Promise<DesignAppPlan | null>;
    updatePlan: (input: ApprovePlanInput) => Promise<DesignAppPlan>;
    approvePlan: (input: ApprovePlanInput) => Promise<DesignAppPlan>;
    deleteApp: (projectPath: string, appId: string) => Promise<void>;
    runBatch: (projectPath: string, appId: string) => Promise<void>;
    // ── v0.15: Project-wide design tokens ───────────────────────────
    getTokens: (projectPath: string) => Promise<ProjectDesignTokens | null>;
    setTokens: (input: SetProjectTokensInput) => Promise<ProjectDesignTokens | null>;
    extractTokens: (input: ExtractProjectTokensInput) => Promise<ProjectDesignTokens>;
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
  // Phase 0.8 write-back. The renderer captures user edits in the Live
  // Preview Edit panel, calls `detect(projectPath)` on mount to learn
  // which style adapter to default to, then `writeBack` with `dryRun:
  // true` to preview the diff and `dryRun: false` to commit. The main
  // process resolves each edit through the matching `StyleAdapter`
  // (Tailwind in 0.8; vanilla CSS / styled-components / CSS Modules in
  // 0.9). Mirrors the `devServer` namespace shape — detect + a single
  // write call.
  styleAdapter: {
    detect: (projectPath: string) => Promise<DesignAdapterDetectResult>;
    writeBack: (input: DesignWriteBackInput) => Promise<DesignWriteBackResult>;
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
    listThreads: (projectPath: string) => Promise<ThreadSummary[]>;
    getThread: (threadId: string) => Promise<ThreadSummary | null>;
    summarizeThread: (input: {
      projectPath: string;
      threadId: string;
    }) => Promise<ThreadSummary>;
    buildRecallContext: (input: {
      query: string;
      projectPath?: string;
      limit?: number;
    }) => Promise<string>;
    buildInjectPreamble: (projectPath: string) => Promise<string>;
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
  mempalaceData: {
    getOverview: () => Promise<MemPalaceOverview>;
    listWings: () => Promise<MemPalaceWing[]>;
    listRooms: (wing: string) => Promise<MemPalaceRoom[]>;
    listDrawers: (input?: MemPalaceListDrawersInput) => Promise<MemPalaceDrawer[]>;
    listTriples: (input?: MemPalaceListTriplesInput) => Promise<MemPalaceTriple[]>;
    invalidate: () => Promise<void>;
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
      followUp: notWired('design.followUp'),
      listMessages: () => Promise.resolve([]),
      getProfile: () => Promise.resolve(null),
      rebuildProfile: () => Promise.resolve(null),
      subscribe: notWired('design.subscribe'),
      onEvent: () => () => undefined,
      planApp: notWired('design.planApp'),
      listApps: () => Promise.resolve([]),
      getApp: () => Promise.resolve(null),
      updatePlan: notWired('design.updatePlan'),
      approvePlan: notWired('design.approvePlan'),
      deleteApp: notWired('design.deleteApp'),
      runBatch: notWired('design.runBatch'),
      getTokens: () => Promise.resolve(null),
      setTokens: notWired('design.setTokens'),
      extractTokens: notWired('design.extractTokens'),
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
    styleAdapter: {
      // Permissive idle stub so the EditPanel can render before the
      // backend agent finishes wiring the preload binding. Returns an
      // "unknown" adapter shape so the UI shows the "not yet detected"
      // empty state instead of throwing.
      detect: () =>
        Promise.resolve({
          preferred: 'unknown',
          available: [],
          evidence: [],
        } as DesignAdapterDetectResult),
      writeBack: notWired('styleAdapter.writeBack'),
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
          totalThreads: 0,
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
      listThreads: () => Promise.resolve([]),
      getThread: () => Promise.resolve(null),
      summarizeThread: notWired('memory.summarizeThread'),
      buildRecallContext: () => Promise.resolve(''),
      buildInjectPreamble: () => Promise.resolve(''),
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
    mempalaceData: {
      getOverview: () =>
        Promise.resolve({
          vault: { palaceDir: '', available: false, reason: 'Not running inside devspace' },
          drawerCount: 0,
          closetCount: 0,
          wingCount: 0,
          roomCount: 0,
          entityCount: 0,
          tripleCount: 0,
          newestFiledAt: null,
        } as MemPalaceOverview),
      listWings: () => Promise.resolve([] as MemPalaceWing[]),
      listRooms: () => Promise.resolve([] as MemPalaceRoom[]),
      listDrawers: () => Promise.resolve([] as MemPalaceDrawer[]),
      listTriples: () => Promise.resolve([] as MemPalaceTriple[]),
      invalidate: () => Promise.resolve(),
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
