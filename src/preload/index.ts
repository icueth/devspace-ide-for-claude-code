import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron';

import { IPC } from '@shared/ipc-channels';

console.log('[preload] running, contextIsolated=', process.contextIsolated);

const api = {
  app: {
    getVersion: (): Promise<string> => ipcRenderer.invoke(IPC.APP_GET_VERSION),
    getHome: (): Promise<string> => ipcRenderer.invoke(IPC.APP_GET_HOME),
    checkUpdate: (force?: boolean) => ipcRenderer.invoke(IPC.APP_CHECK_UPDATE, force),
    openExternal: (url: string) => ipcRenderer.invoke(IPC.APP_OPEN_EXTERNAL, url),
  },
  workspace: {
    list: () => ipcRenderer.invoke(IPC.WORKSPACE_LIST),
    pickFolder: () => ipcRenderer.invoke(IPC.WORKSPACE_PICK),
    open: (path: string) => ipcRenderer.invoke(IPC.WORKSPACE_OPEN, path),
    scan: (id: string, path: string) => ipcRenderer.invoke(IPC.WORKSPACE_SCAN, id, path),
    setActive: (id: string) => ipcRenderer.invoke(IPC.WORKSPACE_SET_ACTIVE, id),
    close: (id: string, path: string) =>
      ipcRenderer.invoke(IPC.WORKSPACE_CLOSE, id, path),
  },
  // Electron 32+ removed the non-standard `File.path` property from
  // renderer-side File objects when contextIsolation is on. The
  // replacement is `webUtils.getPathForFile()` which is only available
  // in the preload/main process. Expose it via the contextBridge so the
  // renderer can resolve drag-dropped / picked files back to absolute
  // paths for `@<path>` attachment tokens.
  files: {
    getPathForFile: (file: File): string => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        return '';
      }
    },
  },
  // Whole-app zoom via Electron webFrame. Used by Cmd+= / Cmd+- / Cmd+0
  // shortcuts in the renderer. Level range matches Chromium: each step is
  // ~20% scale; we clamp to [-3, 5] in the store. Returning level from
  // setter lets the renderer round-trip after clamp in chromium itself.
  ui: {
    setZoomLevel: (level: number): number => {
      try {
        webFrame.setZoomLevel(level);
        return webFrame.getZoomLevel();
      } catch {
        return 0;
      }
    },
    getZoomLevel: (): number => {
      try {
        return webFrame.getZoomLevel();
      } catch {
        return 0;
      }
    },
  },
  fs: {
    readDir: (path: string) => ipcRenderer.invoke(IPC.FS_READ_DIR, path),
    readFile: (path: string) => ipcRenderer.invoke(IPC.FS_READ_FILE, path),
    readBinary: (path: string) => ipcRenderer.invoke(IPC.FS_READ_BINARY, path),
    writeFile: (path: string, data: string) =>
      ipcRenderer.invoke(IPC.FS_WRITE_FILE, path, data),
    listFiles: (cwd: string) => ipcRenderer.invoke(IPC.FS_LIST_FILES, cwd),
    create: (path: string, kind: 'file' | 'folder') =>
      ipcRenderer.invoke(IPC.FS_CREATE, path, kind),
    rename: (src: string, dest: string) => ipcRenderer.invoke(IPC.FS_RENAME, src, dest),
    delete: (path: string) => ipcRenderer.invoke(IPC.FS_DELETE, path),
    duplicate: (path: string) => ipcRenderer.invoke(IPC.FS_DUPLICATE, path),
    reveal: (path: string) => ipcRenderer.invoke(IPC.FS_REVEAL, path),
    watch: (root: string, cb: (dirs: string[]) => void) => {
      const listener = (_e: unknown, ev: { root: string; dirs: string[] }) => {
        if (ev.root === root) cb(ev.dirs);
      };
      ipcRenderer.on(IPC.FS_WATCH_EVENT, listener);
      void ipcRenderer.invoke(IPC.FS_WATCH, root, true);
      return () => {
        ipcRenderer.off(IPC.FS_WATCH_EVENT, listener);
        void ipcRenderer.invoke(IPC.FS_WATCH, root, false);
      };
    },
  },
  git: {
    status: (path: string) => ipcRenderer.invoke(IPC.GIT_STATUS, path),
    diff: (path: string, file?: string) => ipcRenderer.invoke(IPC.GIT_DIFF, path, file),
    stage: (cwd: string, paths: string[]) => ipcRenderer.invoke(IPC.GIT_STAGE, cwd, paths),
    unstage: (cwd: string, paths: string[]) =>
      ipcRenderer.invoke(IPC.GIT_UNSTAGE, cwd, paths),
    discard: (cwd: string, paths: string[]) =>
      ipcRenderer.invoke(IPC.GIT_DISCARD, cwd, paths),
    commit: (cwd: string, message: string, opts?: { amend?: boolean }) =>
      ipcRenderer.invoke(IPC.GIT_COMMIT, cwd, message, opts),
    branches: (cwd: string) => ipcRenderer.invoke(IPC.GIT_BRANCHES, cwd),
    checkout: (cwd: string, name: string) =>
      ipcRenderer.invoke(IPC.GIT_CHECKOUT, cwd, name),
    createBranch: (cwd: string, name: string, from?: string) =>
      ipcRenderer.invoke(IPC.GIT_CREATE_BRANCH, cwd, name, from),
    log: (cwd: string, limit?: number) => ipcRenderer.invoke(IPC.GIT_LOG, cwd, limit),
    fetch: (cwd: string) => ipcRenderer.invoke(IPC.GIT_FETCH, cwd),
    push: (cwd: string) => ipcRenderer.invoke(IPC.GIT_PUSH, cwd),
    pull: (cwd: string) => ipcRenderer.invoke(IPC.GIT_PULL, cwd),
  },
  search: {
    grep: (cwd: string, query: string, opts?: unknown) =>
      ipcRenderer.invoke(IPC.SEARCH_GREP, cwd, query, opts),
  },
  pty: {
    create: (opts: unknown) => ipcRenderer.invoke(IPC.PTY_CREATE, opts),
    write: (sessionId: string, data: string) =>
      ipcRenderer.invoke(IPC.PTY_WRITE, sessionId, data),
    resize: (sessionId: string, cols: number, rows: number) =>
      ipcRenderer.invoke(IPC.PTY_RESIZE, sessionId, cols, rows),
    kill: (sessionId: string) => ipcRenderer.invoke(IPC.PTY_KILL, sessionId),
    onData: (sessionId: string, cb: (data: string) => void) => {
      const channel = `${IPC.PTY_DATA}:${sessionId}`;
      const listener = (_e: unknown, data: string) => cb(data);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.off(channel, listener);
    },
    onExit: (sessionId: string, cb: (code: number | null) => void) => {
      const channel = `${IPC.PTY_EXIT}:${sessionId}`;
      const listener = (_e: unknown, code: number | null) => cb(code);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.off(channel, listener);
    },
  },
  tmux: {
    listPanes: (sessionName?: string) =>
      ipcRenderer.invoke(IPC.TMUX_LIST_PANES, sessionName),
    capturePane: (paneId: string, lines?: number) =>
      ipcRenderer.invoke(IPC.TMUX_CAPTURE_PANE, paneId, lines),
    capturePanes: (paneIds: string[], lines?: number) =>
      ipcRenderer.invoke(IPC.TMUX_CAPTURE_PANES, paneIds, lines),
    selectPane: (paneId: string) => ipcRenderer.invoke(IPC.TMUX_SELECT_PANE, paneId),
    sendKeys: (paneId: string, text: string, submit?: boolean) =>
      ipcRenderer.invoke(IPC.TMUX_SEND_KEYS, paneId, text, submit),
    listSessions: () => ipcRenderer.invoke(IPC.TMUX_LIST_SESSIONS),
    killSession: (name: string) => ipcRenderer.invoke(IPC.TMUX_KILL_SESSION, name),
    renameSession: (oldName: string, newName: string) =>
      ipcRenderer.invoke(IPC.TMUX_RENAME_SESSION, oldName, newName),
    killServer: () => ipcRenderer.invoke(IPC.TMUX_KILL_SERVER),
    getConfig: () => ipcRenderer.invoke(IPC.TMUX_GET_CONFIG),
    setConfig: (cfg: unknown) => ipcRenderer.invoke(IPC.TMUX_SET_CONFIG, cfg),
    renderConf: (cfg: unknown) => ipcRenderer.invoke(IPC.TMUX_RENDER_CONF, cfg),
    resolveBinary: () => ipcRenderer.invoke(IPC.TMUX_RESOLVE_BINARY),
    findStale: (maxAgeMs?: number) =>
      ipcRenderer.invoke(IPC.TMUX_FIND_STALE, maxAgeMs),
    pruneStale: (maxAgeMs?: number) =>
      ipcRenderer.invoke(IPC.TMUX_PRUNE_STALE, maxAgeMs),
  },
  settings: {
    list: (projectPath: string | null) =>
      ipcRenderer.invoke(IPC.SETTINGS_LIST, projectPath),
    read: (filePath: string) => ipcRenderer.invoke(IPC.SETTINGS_READ, filePath),
    write: (filePath: string, content: string) =>
      ipcRenderer.invoke(IPC.SETTINGS_WRITE, filePath, content),
  },
  llm: {
    getConfig: () => ipcRenderer.invoke(IPC.LLM_GET_CONFIG),
    setConfig: (cfg: unknown) => ipcRenderer.invoke(IPC.LLM_SET_CONFIG, cfg),
    test: (cfg: unknown) => ipcRenderer.invoke(IPC.LLM_TEST, cfg),
    complete: (req: unknown) => ipcRenderer.invoke(IPC.LLM_COMPLETE, req),
    edit: (req: unknown) => ipcRenderer.invoke(IPC.LLM_EDIT, req),
    // v0.29 — chat profiles (separate store from autocomplete config).
    listChatProfiles: () => ipcRenderer.invoke(IPC.LLM_CHAT_PROFILES_LIST),
    upsertChatProfile: (profile: unknown) =>
      ipcRenderer.invoke(IPC.LLM_CHAT_PROFILES_UPSERT, profile),
    deleteChatProfile: (id: string) =>
      ipcRenderer.invoke(IPC.LLM_CHAT_PROFILES_DELETE, id),
  },
  // v0.30 — multi-CLI runtime profiles (OpenCode now; Codex/Gemini later).
  cli: {
    listProfiles: () => ipcRenderer.invoke(IPC.CLI_PROFILES_LIST),
    upsertProfile: (profile: unknown) =>
      ipcRenderer.invoke(IPC.CLI_PROFILES_UPSERT, profile),
    deleteProfile: (id: string) =>
      ipcRenderer.invoke(IPC.CLI_PROFILES_DELETE, id),
    detect: () => ipcRenderer.invoke(IPC.CLI_DETECT),
  },
  chat: {
    listThreads: (projectPath: string) =>
      ipcRenderer.invoke(IPC.CHAT_LIST_THREADS, projectPath),
    getThread: (projectPath: string, threadId: string) =>
      ipcRenderer.invoke(IPC.CHAT_GET_THREAD, projectPath, threadId),
    // SEC-MED-1: forward the 4th `cliProfileId` arg too so renderer
    // callers can actually create OpenCode-bound threads. Without this,
    // the v0.30 feature is unreachable from the typed preload API.
    createThread: (
      projectPath: string,
      title?: string,
      llmProfileId?: string,
      cliProfileId?: string,
    ) =>
      ipcRenderer.invoke(
        IPC.CHAT_CREATE_THREAD,
        projectPath,
        title,
        llmProfileId,
        cliProfileId,
      ),
    deleteThread: (projectPath: string, threadId: string) =>
      ipcRenderer.invoke(IPC.CHAT_DELETE_THREAD, projectPath, threadId),
    send: (req: unknown) => ipcRenderer.invoke(IPC.CHAT_SEND, req),
    cancel: (projectPath: string, threadId?: string) =>
      ipcRenderer.invoke(IPC.CHAT_CANCEL, projectPath, threadId),
    subscribe: (projectPath: string) =>
      ipcRenderer.invoke(IPC.CHAT_SUBSCRIBE, projectPath),
    getConfig: (projectPath: string) =>
      ipcRenderer.invoke(IPC.CHAT_GET_CONFIG, projectPath),
    setConfig: (projectPath: string, cfg: unknown) =>
      ipcRenderer.invoke(IPC.CHAT_SET_CONFIG, projectPath, cfg),
    updateThreadConfig: (
      projectPath: string,
      threadId: string,
      cfg: unknown,
    ) =>
      ipcRenderer.invoke(
        IPC.CHAT_UPDATE_THREAD_CONFIG,
        projectPath,
        threadId,
        cfg,
      ),
    onEvent: (
      projectPath: string,
      cb: (threadId: string, event: import('@shared/types').ChatEvent) => void,
    ) => {
      const listener = (
        _e: unknown,
        ev: {
          projectPath: string;
          threadId: string;
          event: import('@shared/types').ChatEvent;
        },
      ) => {
        if (ev.projectPath === projectPath) cb(ev.threadId, ev.event);
      };
      ipcRenderer.on(IPC.CHAT_EVENT, listener);
      return () => ipcRenderer.off(IPC.CHAT_EVENT, listener);
    },
  },
  agents: {
    list: (projectPath: string | null) =>
      ipcRenderer.invoke(IPC.AGENTS_LIST, projectPath),
    read: (filePath: string) => ipcRenderer.invoke(IPC.AGENTS_READ, filePath),
    save: (agent: unknown) => ipcRenderer.invoke(IPC.AGENTS_SAVE, agent),
    create: (
      scope: 'global' | 'project',
      projectPath: string | null,
      slug: string,
    ) => ipcRenderer.invoke(IPC.AGENTS_CREATE, scope, projectPath, slug),
    delete: (filePath: string) =>
      ipcRenderer.invoke(IPC.AGENTS_DELETE, filePath),
    duplicate: (
      filePath: string,
      targetScope: 'global' | 'project',
      projectPath: string | null,
    ) =>
      ipcRenderer.invoke(IPC.AGENTS_DUPLICATE, filePath, targetScope, projectPath),
  },
  teams: {
    list: (projectPath: string | null) =>
      ipcRenderer.invoke(IPC.TEAMS_LIST, projectPath),
    get: (projectPath: string | null, teamId: string) =>
      ipcRenderer.invoke(IPC.TEAMS_GET, projectPath, teamId),
    save: (
      scope: 'global' | 'project',
      projectPath: string | null,
      team: unknown,
    ) => ipcRenderer.invoke(IPC.TEAMS_SAVE, scope, projectPath, team),
    delete: (
      scope: 'global' | 'project',
      projectPath: string | null,
      teamId: string,
    ) => ipcRenderer.invoke(IPC.TEAMS_DELETE, scope, projectPath, teamId),
  },
  skills: {
    list: (projectPath: string | null, includePlugins?: boolean) =>
      ipcRenderer.invoke(IPC.SKILLS_LIST, projectPath, includePlugins),
    read: (filePath: string) => ipcRenderer.invoke(IPC.SKILLS_READ, filePath),
    save: (skill: unknown) => ipcRenderer.invoke(IPC.SKILLS_SAVE, skill),
    create: (
      scope: 'global' | 'project',
      projectPath: string | null,
      slug: string,
    ) => ipcRenderer.invoke(IPC.SKILLS_CREATE, scope, projectPath, slug),
    delete: (filePath: string) =>
      ipcRenderer.invoke(IPC.SKILLS_DELETE, filePath),
    duplicate: (
      filePath: string,
      targetScope: 'global' | 'project',
      projectPath: string | null,
    ) =>
      ipcRenderer.invoke(IPC.SKILLS_DUPLICATE, filePath, targetScope, projectPath),
  },
  mcp: {
    list: (projectPath: string | null) =>
      ipcRenderer.invoke(IPC.MCP_LIST, projectPath),
    save: (entry: unknown) => ipcRenderer.invoke(IPC.MCP_SAVE, entry),
    rename: (
      scope: 'global' | 'project',
      filePath: string,
      oldName: string,
      newName: string,
    ) =>
      ipcRenderer.invoke(IPC.MCP_RENAME, scope, filePath, oldName, newName),
    delete: (
      scope: 'global' | 'project',
      filePath: string,
      name: string,
    ) => ipcRenderer.invoke(IPC.MCP_DELETE, scope, filePath, name),
    create: (
      scope: 'global' | 'project',
      projectPath: string | null,
      name: string,
      server: unknown,
    ) =>
      ipcRenderer.invoke(IPC.MCP_CREATE, scope, projectPath, name, server),
  },
  design: {
    list: (projectPath: string) =>
      ipcRenderer.invoke(IPC.DESIGN_LIST, projectPath),
    get: (projectPath: string, screenId: string) =>
      ipcRenderer.invoke(IPC.DESIGN_GET, projectPath, screenId),
    create: (input: unknown) =>
      ipcRenderer.invoke(IPC.DESIGN_CREATE, input),
    regenerate: (input: unknown) =>
      ipcRenderer.invoke(IPC.DESIGN_REGENERATE, input),
    saveEdits: (input: import('@shared/design').DesignSaveEditsInput) =>
      ipcRenderer.invoke(IPC.DESIGN_SAVE_EDITS, input),
    delete: (projectPath: string, screenId: string) =>
      ipcRenderer.invoke(IPC.DESIGN_DELETE, projectPath, screenId),
    cancel: (projectPath: string, screenId: string) =>
      ipcRenderer.invoke(IPC.DESIGN_CANCEL, projectPath, screenId),
    listSkills: (projectPath: string | null) =>
      ipcRenderer.invoke(IPC.DESIGN_LIST_SKILLS, projectPath),
    listSystems: (projectPath: string | null) =>
      ipcRenderer.invoke(IPC.DESIGN_LIST_SYSTEMS, projectPath),
    readHtml: (projectPath: string, screenId: string, versionId?: string) =>
      ipcRenderer.invoke(IPC.DESIGN_READ_HTML, projectPath, screenId, versionId),
    followUp: (input: import('@shared/design').DesignFollowUpInput) =>
      ipcRenderer.invoke(IPC.DESIGN_FOLLOW_UP, input),
    listMessages: (projectPath: string, screenId: string) =>
      ipcRenderer.invoke(IPC.DESIGN_LIST_MESSAGES, projectPath, screenId),
    getProfile: (projectPath: string) =>
      ipcRenderer.invoke(IPC.DESIGN_GET_PROFILE, projectPath),
    rebuildProfile: (projectPath: string) =>
      ipcRenderer.invoke(IPC.DESIGN_REBUILD_PROFILE, projectPath),
    // v0.15: multi-screen app planning
    planApp: (input: import('@shared/design').PlanAppInput) =>
      ipcRenderer.invoke(IPC.DESIGN_PLAN_APP, input),
    approvePlan: (input: import('@shared/design').ApprovePlanInput) =>
      ipcRenderer.invoke(IPC.DESIGN_APPROVE_PLAN, input),
    listApps: (projectPath: string) =>
      ipcRenderer.invoke(IPC.DESIGN_LIST_APPS, projectPath),
    getApp: (projectPath: string, appId: string) =>
      ipcRenderer.invoke(IPC.DESIGN_GET_APP, projectPath, appId),
    updatePlan: (input: import('@shared/design').ApprovePlanInput) =>
      ipcRenderer.invoke(IPC.DESIGN_UPDATE_PLAN, input),
    deleteApp: (projectPath: string, appId: string) =>
      ipcRenderer.invoke(IPC.DESIGN_DELETE_APP, projectPath, appId),
    runBatch: (projectPath: string, appId: string) =>
      ipcRenderer.invoke(IPC.DESIGN_RUN_BATCH, projectPath, appId),
    // v0.15: project-wide tokens
    getTokens: (projectPath: string) =>
      ipcRenderer.invoke(IPC.DESIGN_GET_TOKENS, projectPath),
    setTokens: (input: import('@shared/design').SetProjectTokensInput) =>
      ipcRenderer.invoke(IPC.DESIGN_SET_TOKENS, input),
    extractTokens: (input: import('@shared/design').ExtractProjectTokensInput) =>
      ipcRenderer.invoke(IPC.DESIGN_EXTRACT_TOKENS, input),
    subscribe: (projectPath: string) =>
      ipcRenderer.invoke(IPC.DESIGN_SUBSCRIBE, projectPath),
    onEvent: (
      projectPath: string,
      cb: (event: import('@shared/design').DesignEvent) => void,
    ) => {
      const listener = (
        _e: unknown,
        ev: {
          projectPath: string;
          event: import('@shared/design').DesignEvent;
        },
      ) => {
        if (ev.projectPath === projectPath) cb(ev.event);
      };
      ipcRenderer.on(IPC.DESIGN_EVENT, listener);
      return () => ipcRenderer.off(IPC.DESIGN_EVENT, listener);
    },
  },
  styleAdapter: {
    detect: (projectPath: string) =>
      ipcRenderer.invoke(IPC.DESIGN_DETECT_ADAPTER, { projectPath }),
    writeBack: (input: import('@shared/design').DesignWriteBackInput) =>
      ipcRenderer.invoke(IPC.DESIGN_WRITE_BACK, input),
  },
  devServer: {
    detect: (projectPath: string) =>
      ipcRenderer.invoke(IPC.DEVSERVER_DETECT, projectPath),
    start: (input: import('@shared/design').DevServerStartInput) =>
      ipcRenderer.invoke(IPC.DEVSERVER_START, input),
    stop: (projectPath: string) =>
      ipcRenderer.invoke(IPC.DEVSERVER_STOP, projectPath),
    status: (projectPath: string) =>
      ipcRenderer.invoke(IPC.DEVSERVER_STATUS, projectPath),
    subscribe: (projectPath: string) =>
      ipcRenderer.invoke(IPC.DEVSERVER_SUBSCRIBE, projectPath),
    unsubscribe: (projectPath: string) =>
      ipcRenderer.invoke(IPC.DEVSERVER_UNSUBSCRIBE, projectPath),
    // v0.16: re-run detection without touching a running PTY.
    refresh: (projectPath: string) =>
      ipcRenderer.invoke(IPC.DEVSERVER_REFRESH, projectPath),
    // v0.16: run `<pm> install` for the project. Result resolves when the
    // PTY exits; live progress streams as 'install_progress' DevServerEvents
    // through the existing onEvent subscription.
    installDependencies: (input: import('@shared/design').DevServerInstallInput) =>
      ipcRenderer.invoke(IPC.DEVSERVER_INSTALL, input),
    onEvent: (
      projectPath: string,
      cb: (event: import('@shared/design').DevServerEvent) => void,
    ) => {
      const listener = (
        _e: unknown,
        ev: {
          projectPath: string;
          event: import('@shared/design').DevServerEvent;
        },
      ) => {
        if (ev.projectPath === projectPath) cb(ev.event);
      };
      ipcRenderer.on(IPC.DEVSERVER_EVENT, listener);
      return () => ipcRenderer.off(IPC.DEVSERVER_EVENT, listener);
    },
  },
  codeflow: {
    getStatus: (projectPath: string) =>
      ipcRenderer.invoke(IPC.CODEFLOW_GET_STATUS, projectPath),
    analyze: (projectPath: string, opts?: { force?: boolean }) =>
      ipcRenderer.invoke(IPC.CODEFLOW_ANALYZE, projectPath, opts),
    cancel: (projectPath: string) =>
      ipcRenderer.invoke(IPC.CODEFLOW_CANCEL, projectPath),
    readDoc: (absPath: string) =>
      ipcRenderer.invoke(IPC.CODEFLOW_READ_DOC, absPath),
    listDocs: (projectPath: string) =>
      ipcRenderer.invoke(IPC.CODEFLOW_LIST_DOCS, projectPath),
    openDir: (projectPath: string) =>
      ipcRenderer.invoke(IPC.CODEFLOW_OPEN_DIR, projectPath),
    buildGraph: (projectPath: string) =>
      ipcRenderer.invoke(IPC.CODEFLOW_BUILD_GRAPH, projectPath),
    buildFunctionGraph: (projectPath: string) =>
      ipcRenderer.invoke(IPC.CODEFLOW_BUILD_FUNCTION_GRAPH, projectPath),
    augmentGraph: (projectPath: string, graph: unknown) =>
      ipcRenderer.invoke(IPC.CODEFLOW_AUGMENT_GRAPH, projectPath, graph),
    augmentCancel: (projectPath: string) =>
      ipcRenderer.invoke(IPC.CODEFLOW_AUGMENT_CANCEL, projectPath),
    augmentLoad: (projectPath: string, fingerprint: string) =>
      ipcRenderer.invoke(IPC.CODEFLOW_AUGMENT_LOAD, projectPath, fingerprint),
    augmentClear: (projectPath: string) =>
      ipcRenderer.invoke(IPC.CODEFLOW_AUGMENT_CLEAR, projectPath),
    augmentFunctions: (projectPath: string, graph: unknown) =>
      ipcRenderer.invoke(IPC.CODEFLOW_AUGMENT_FUNCTIONS, projectPath, graph),
    augmentFunctionsCancel: (projectPath: string) =>
      ipcRenderer.invoke(IPC.CODEFLOW_AUGMENT_FUNCTIONS_CANCEL, projectPath),
    augmentFunctionsLoad: (projectPath: string, fingerprint: string) =>
      ipcRenderer.invoke(IPC.CODEFLOW_AUGMENT_FUNCTIONS_LOAD, projectPath, fingerprint),
    onAugmentFunctionsProgress: (projectPath: string, cb: (msg: string) => void) => {
      const listener = (
        _e: unknown,
        ev: { projectPath: string; message: string },
      ) => {
        if (ev.projectPath === projectPath) cb(ev.message);
      };
      ipcRenderer.on(IPC.CODEFLOW_AUGMENT_FUNCTIONS_PROGRESS, listener);
      return () => ipcRenderer.off(IPC.CODEFLOW_AUGMENT_FUNCTIONS_PROGRESS, listener);
    },
    onAugmentProgress: (projectPath: string, cb: (msg: string) => void) => {
      const listener = (
        _e: unknown,
        ev: { projectPath: string; message: string },
      ) => {
        if (ev.projectPath === projectPath) cb(ev.message);
      };
      ipcRenderer.on(IPC.CODEFLOW_AUGMENT_PROGRESS, listener);
      return () => ipcRenderer.off(IPC.CODEFLOW_AUGMENT_PROGRESS, listener);
    },
    onProgress: (
      projectPath: string,
      cb: (status: import('@shared/types').CodeflowStatus) => void,
    ) => {
      const listener = (
        _e: unknown,
        ev: { projectPath: string; status: import('@shared/types').CodeflowStatus },
      ) => {
        if (ev.projectPath === projectPath) cb(ev.status);
      };
      ipcRenderer.on(IPC.CODEFLOW_PROGRESS, listener);
      return () => ipcRenderer.off(IPC.CODEFLOW_PROGRESS, listener);
    },
  },
  memory: {
    listProjects: () => ipcRenderer.invoke(IPC.MEMORY_LIST_PROJECTS),
    pruneGhostProjects: () => ipcRenderer.invoke(IPC.MEMORY_PRUNE_GHOSTS),
    listEntries: (input: unknown) =>
      ipcRenderer.invoke(IPC.MEMORY_LIST_ENTRIES, input),
    getEntry: (id: string) => ipcRenderer.invoke(IPC.MEMORY_GET_ENTRY, id),
    createEntry: (input: unknown) =>
      ipcRenderer.invoke(IPC.MEMORY_CREATE_ENTRY, input),
    updateEntry: (input: unknown) =>
      ipcRenderer.invoke(IPC.MEMORY_UPDATE_ENTRY, input),
    deleteEntry: (id: string) => ipcRenderer.invoke(IPC.MEMORY_DELETE_ENTRY, id),
    togglePin: (id: string) => ipcRenderer.invoke(IPC.MEMORY_TOGGLE_PIN, id),
    search: (input: unknown) => ipcRenderer.invoke(IPC.MEMORY_SEARCH, input),
    getStats: () => ipcRenderer.invoke(IPC.MEMORY_GET_STATS),
    listInbox: (projectPath?: string) =>
      ipcRenderer.invoke(IPC.MEMORY_LIST_INBOX, projectPath),
    resolveInbox: (input: unknown) =>
      ipcRenderer.invoke(IPC.MEMORY_RESOLVE_INBOX, input),
    dismissInbox: (inboxId: string) =>
      ipcRenderer.invoke(IPC.MEMORY_DISMISS_INBOX, inboxId),
    proposeFromTurn: (input: unknown) =>
      ipcRenderer.invoke(IPC.MEMORY_PROPOSE_FROM_TURN, input),
    listDiary: (input: unknown) =>
      ipcRenderer.invoke(IPC.MEMORY_LIST_DIARY, input),
    getDiary: (date: string, projectPath?: string) =>
      ipcRenderer.invoke(IPC.MEMORY_GET_DIARY, date, projectPath),
    writeDiary: (input: unknown) =>
      ipcRenderer.invoke(IPC.MEMORY_WRITE_DIARY, input),
    listThreads: (projectPath: string) =>
      ipcRenderer.invoke(IPC.MEMORY_LIST_THREADS, projectPath),
    getThread: (threadId: string) =>
      ipcRenderer.invoke(IPC.MEMORY_GET_THREAD, threadId),
    summarizeThread: (input: unknown) =>
      ipcRenderer.invoke(IPC.MEMORY_SUMMARIZE_THREAD, input),
    buildRecallContext: (input: unknown) =>
      ipcRenderer.invoke(IPC.MEMORY_BUILD_RECALL_CONTEXT, input),
    buildInjectPreamble: (projectPath: string) =>
      ipcRenderer.invoke(IPC.MEMORY_BUILD_INJECT_PREAMBLE, projectPath),
    getSettings: () => ipcRenderer.invoke(IPC.MEMORY_GET_SETTINGS),
    setSettings: (patch: unknown) =>
      ipcRenderer.invoke(IPC.MEMORY_SET_SETTINGS, patch),
    openDir: (scope: 'project' | 'global', projectPath?: string) =>
      ipcRenderer.invoke(IPC.MEMORY_OPEN_DIR, scope, projectPath),
    onEvent: (
      cb: (event: import('@shared/types').MemoryEvent) => void,
    ) => {
      const listener = (
        _e: unknown,
        ev: import('@shared/types').MemoryEvent,
      ) => {
        cb(ev);
      };
      ipcRenderer.on(IPC.MEMORY_EVENTS, listener);
      return () => ipcRenderer.off(IPC.MEMORY_EVENTS, listener);
    },
  },
  mempalace: {
    getStatus: () => ipcRenderer.invoke(IPC.MEMPALACE_GET_STATUS),
    install: (input?: import('@shared/mempalace').MemPalaceInstallInput) =>
      ipcRenderer.invoke(IPC.MEMPALACE_INSTALL, input ?? {}),
    uninstall: (input?: import('@shared/mempalace').MemPalaceUninstallInput) =>
      ipcRenderer.invoke(IPC.MEMPALACE_UNINSTALL, input ?? {}),
    openVault: () => ipcRenderer.invoke(IPC.MEMPALACE_OPEN_VAULT),
    onProgress: (
      cb: (ev: import('@shared/mempalace').MemPalaceProgressEvent) => void,
    ) => {
      const listener = (
        _e: unknown,
        ev: import('@shared/mempalace').MemPalaceProgressEvent,
      ) => cb(ev);
      ipcRenderer.on(IPC.MEMPALACE_PROGRESS, listener);
      return () => ipcRenderer.off(IPC.MEMPALACE_PROGRESS, listener);
    },
  },
  mempalaceData: {
    getOverview: () => ipcRenderer.invoke(IPC.MEMPALACE_DATA_GET_OVERVIEW),
    listWings: () => ipcRenderer.invoke(IPC.MEMPALACE_DATA_LIST_WINGS),
    listRooms: (wing: string) => ipcRenderer.invoke(IPC.MEMPALACE_DATA_LIST_ROOMS, wing),
    listDrawers: (input?: import('@shared/mempalaceData').MemPalaceListDrawersInput) =>
      ipcRenderer.invoke(IPC.MEMPALACE_DATA_LIST_DRAWERS, input ?? {}),
    listTriples: (input?: import('@shared/mempalaceData').MemPalaceListTriplesInput) =>
      ipcRenderer.invoke(IPC.MEMPALACE_DATA_LIST_TRIPLES, input ?? {}),
    invalidate: () => ipcRenderer.invoke(IPC.MEMPALACE_DATA_INVALIDATE),
  },
  setup: {
    getStatus: () => ipcRenderer.invoke(IPC.SETUP_GET_STATUS),
    installTool: (toolId: import('@shared/setup').SetupToolId) =>
      ipcRenderer.invoke(IPC.SETUP_INSTALL_TOOL, toolId),
    installAll: () => ipcRenderer.invoke(IPC.SETUP_INSTALL_ALL),
    uninstallRtkHook: () => ipcRenderer.invoke(IPC.SETUP_UNINSTALL_RTK_HOOK),
    openClaudeDir: () => ipcRenderer.invoke(IPC.SETUP_OPEN_CLAUDE_DIR),
    runClaude: (
      opts: { cols?: number; rows?: number } = {},
    ): Promise<import('@shared/setup').SetupClaudeRunResult> =>
      ipcRenderer.invoke(IPC.SETUP_RUN_CLAUDE, opts),
    onProgress: (
      cb: (ev: import('@shared/setup').SetupProgressEvent) => void,
    ) => {
      const listener = (
        _e: unknown,
        ev: import('@shared/setup').SetupProgressEvent,
      ) => cb(ev);
      ipcRenderer.on(IPC.SETUP_PROGRESS, listener);
      return () => ipcRenderer.off(IPC.SETUP_PROGRESS, listener);
    },
  },
  devlog: {
    list: (input: unknown) => ipcRenderer.invoke(IPC.DEVLOG_LIST, input),
    get: (input: unknown) => ipcRenderer.invoke(IPC.DEVLOG_GET, input),
    create: (input: unknown) => ipcRenderer.invoke(IPC.DEVLOG_CREATE, input),
    update: (input: unknown) => ipcRenderer.invoke(IPC.DEVLOG_UPDATE, input),
    delete: (input: unknown) => ipcRenderer.invoke(IPC.DEVLOG_DELETE, input),
    appendLog: (input: unknown) => ipcRenderer.invoke(IPC.DEVLOG_APPEND_LOG, input),
    buildInject: (projectPath: string) =>
      ipcRenderer.invoke(IPC.DEVLOG_BUILD_INJECT, projectPath),
    getSettings: () => ipcRenderer.invoke(IPC.DEVLOG_GET_SETTINGS),
    setSettings: (patch: unknown) =>
      ipcRenderer.invoke(IPC.DEVLOG_SET_SETTINGS, patch),
    openDir: (projectPath: string) =>
      ipcRenderer.invoke(IPC.DEVLOG_OPEN_DIR, projectPath),
    onEvent: (
      cb: (event: import('@shared/types').DevlogEvent) => void,
    ) => {
      const listener = (
        _e: unknown,
        ev: import('@shared/types').DevlogEvent,
      ) => cb(ev);
      ipcRenderer.on(IPC.DEVLOG_EVENTS, listener);
      return () => ipcRenderer.off(IPC.DEVLOG_EVENTS, listener);
    },
  },
  forge: {
    listDrafts: (projectPath: string) =>
      ipcRenderer.invoke(IPC.FORGE_LIST_DRAFTS, projectPath),
    getDraft: (draftId: string) =>
      ipcRenderer.invoke(IPC.FORGE_GET_DRAFT, draftId),
    createDraft: (input: unknown) =>
      ipcRenderer.invoke(IPC.FORGE_CREATE_DRAFT, input),
    generateDraft: (input: unknown) =>
      ipcRenderer.invoke(IPC.FORGE_GENERATE_DRAFT, input),
    updateDraft: (input: unknown) =>
      ipcRenderer.invoke(IPC.FORGE_UPDATE_DRAFT, input),
    saveDraft: (input: unknown) =>
      ipcRenderer.invoke(IPC.FORGE_SAVE_DRAFT, input),
    deleteDraft: (draftId: string) =>
      ipcRenderer.invoke(IPC.FORGE_DELETE_DRAFT, draftId),
    cancelDraft: (draftId: string) =>
      ipcRenderer.invoke(IPC.FORGE_CANCEL_DRAFT, draftId),
    listStats: (projectPath: string) =>
      ipcRenderer.invoke(IPC.FORGE_LIST_STATS, projectPath),
    recordUse: (input: unknown) =>
      ipcRenderer.invoke(IPC.FORGE_RECORD_USE, input),
    recordSignal: (input: unknown) =>
      ipcRenderer.invoke(IPC.FORGE_RECORD_SIGNAL, input),
    listUses: (input: unknown) =>
      ipcRenderer.invoke(IPC.FORGE_LIST_USES, input),
    listSuggestions: (projectPath: string) =>
      ipcRenderer.invoke(IPC.FORGE_LIST_SUGGESTIONS, projectPath),
    dismissSuggestion: (input: unknown) =>
      ipcRenderer.invoke(IPC.FORGE_DISMISS_SUGGESTION, input),
    listCatalog: () => ipcRenderer.invoke(IPC.FORGE_LIST_CATALOG),
    discoverMatches: (projectPath: string) =>
      ipcRenderer.invoke(IPC.FORGE_DISCOVER_MATCHES, projectPath),
    getSettings: () => ipcRenderer.invoke(IPC.FORGE_GET_SETTINGS),
    setSettings: (patch: unknown) =>
      ipcRenderer.invoke(IPC.FORGE_SET_SETTINGS, patch),
    onEvent: (
      cb: (event: import('@shared/types').ForgeEvent) => void,
    ) => {
      const listener = (
        _e: unknown,
        ev: import('@shared/types').ForgeEvent,
      ) => cb(ev);
      ipcRenderer.on(IPC.FORGE_EVENTS, listener);
      return () => ipcRenderer.off(IPC.FORGE_EVENTS, listener);
    },
  },
};

try {
  // Forward menu-driven events to the renderer through a minimal pub/sub.
const appEvents = {
  onCloseTab(cb: () => void): () => void {
    const listener = () => cb();
    ipcRenderer.on('app:close-tab', listener);
    return () => ipcRenderer.off('app:close-tab', listener);
  },
};

contextBridge.exposeInMainWorld('devspace', { ...api, appEvents });
  console.log('[preload] exposed window.devspace');
} catch (err) {
  console.error('[preload] exposeInMainWorld failed:', err);
}

export type DevspaceApi = typeof api;
