import { contextBridge, ipcRenderer, webUtils } from 'electron';

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
  },
  chat: {
    listThreads: (projectPath: string) =>
      ipcRenderer.invoke(IPC.CHAT_LIST_THREADS, projectPath),
    createThread: (projectPath: string, title?: string) =>
      ipcRenderer.invoke(IPC.CHAT_CREATE_THREAD, projectPath, title),
    deleteThread: (projectPath: string, threadId: string) =>
      ipcRenderer.invoke(IPC.CHAT_DELETE_THREAD, projectPath, threadId),
    send: (req: unknown) => ipcRenderer.invoke(IPC.CHAT_SEND, req),
    cancel: (projectPath: string) =>
      ipcRenderer.invoke(IPC.CHAT_CANCEL, projectPath),
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
