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
    // Lighter than close: frees dev-server/graphify/codeflow-live state but
    // keeps claude/shell PTYs and fs watchers alive (workspace switch).
    suspend: (id: string, path: string) =>
      ipcRenderer.invoke(IPC.WORKSPACE_SUSPEND, id, path),
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
    // Listener-only tap on FS_WATCH_EVENT — no FS_WATCH invoke in either
    // direction. This separation is load-bearing, not cosmetic: main's
    // FileWatcherService tracks subscribers as a Set<WebContents>, NOT a
    // refcount per watch() call, so with a single window a component-level
    // watch() cleanup (enable=false) would close the chokidar watcher that a
    // mount-level owner (useProjectWatchers) still needs. Watcher LIFECYCLE
    // stays with `watch` callers; this only observes the event stream.
    // `ev.root` arrives path.resolve()'d by main — callers filter with
    // strict equality against their (already absolute) project paths.
    onWatchEvent: (cb: (ev: { root: string; dirs: string[] }) => void) => {
      const listener = (_e: unknown, ev: { root: string; dirs: string[] }) => cb(ev);
      ipcRenderer.on(IPC.FS_WATCH_EVENT, listener);
      return () => {
        ipcRenderer.off(IPC.FS_WATCH_EVENT, listener);
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
    // Full session-tree kill (PTY + backing tmux session). Main derives the
    // tmux session name from (projectId, tabId, kind) — never pass one.
    killSessionTree: (
      projectId: string,
      tabId: string,
      kind: 'claude-cli' | 'shell',
    ) => ipcRenderer.invoke(IPC.PTY_KILL_SESSION, projectId, tabId, kind),
    // Restart one claude-cli tab so the remounted pane spawns a brand-new
    // claude (PTY_KILL alone only detaches; `new-session -A` reattaches).
    restartClaude: (projectId: string, tabId: string) =>
      ipcRenderer.invoke(IPC.PTY_RESTART_CLAUDE, projectId, tabId),
    // Pull the session's rolling buffer for scrollback restore. Call AFTER
    // arming onData — the subscriber-add and buffer snapshot are atomic in
    // main, so chunks after the snapshot arrive only as onData events.
    subscribe: (sessionId: string): Promise<string> =>
      ipcRenderer.invoke(IPC.PTY_SUBSCRIBE, sessionId),
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
    // v0.36.0: subscribe to the idle-reaper broadcast. Fires once per
    // reaper tick that closed at least one claude-cli session. Returns
    // an unsubscribe — caller is responsible for tearing down on unmount.
    onAutoClosed: (
      cb: (ev: { ids: string[]; thresholdMinutes: number }) => void,
    ) => {
      const listener = (
        _e: unknown,
        ev: { ids: string[]; thresholdMinutes: number },
      ) => cb(ev);
      ipcRenderer.on(IPC.PTY_AUTO_CLOSED, listener);
      return () => ipcRenderer.off(IPC.PTY_AUTO_CLOSED, listener);
    },
    // v0.36.1: push the renderer's pinned-session set to main. Fire-and-
    // forget — no response, no await — so a reaper tick can race with the
    // push without blocking either side.
    setPinned: (ids: string[]) => {
      ipcRenderer.send(IPC.PTY_SET_PINNED, { ids });
    },
    // Phase 4a: subscribe to the per-session tool-approval prompt event.
    // Channel is namespaced by sessionId so we can fan out without the
    // renderer having to filter. Returns an unsubscribe handle.
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
    ) => {
      const channel = `${IPC.PTY_TOOL_APPROVAL}:${sessionId}`;
      const listener = (
        _e: unknown,
        ev: {
          sessionId: string;
          request: {
            toolName: string | null;
            raw: string;
            matchedAt: number;
          };
        },
      ) => cb(ev);
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
  },
  // CLI runtime detection (claude version gate).
  cli: {
    detect: () => ipcRenderer.invoke(IPC.CLI_DETECT),
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
  designSeeding: {
    status: () => ipcRenderer.invoke(IPC.DESIGN_SEEDING_STATUS),
    setEnabled: (enabled: boolean) =>
      ipcRenderer.invoke(IPC.DESIGN_SEEDING_SET_ENABLED, enabled),
    reseed: () => ipcRenderer.invoke(IPC.DESIGN_SEEDING_RESEED),
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
  preview: {
    list: (projectPath: string) =>
      ipcRenderer.invoke(IPC.PREVIEW_LIST, projectPath),
    readHtml: (projectPath: string, htmlPath: string) =>
      ipcRenderer.invoke(IPC.PREVIEW_READ_HTML, projectPath, htmlPath),
    subscribe: (projectPath: string) =>
      ipcRenderer.invoke(IPC.PREVIEW_SUBSCRIBE, projectPath),
    // Counterpart of subscribe — drops this window from the project's
    // preview watcher so main can close it when nobody is listening.
    unsubscribe: (projectPath: string) =>
      ipcRenderer.invoke(IPC.PREVIEW_UNSUBSCRIBE, projectPath),
    onChanged: (
      projectPath: string,
      cb: (event: import('@shared/preview').PreviewChangedEvent) => void,
    ) => {
      const listener = (
        _e: unknown,
        ev: {
          projectPath: string;
          event: import('@shared/preview').PreviewChangedEvent;
        },
      ) => {
        if (ev.projectPath === projectPath) cb(ev.event);
      };
      ipcRenderer.on(IPC.PREVIEW_CHANGED, listener);
      return () => ipcRenderer.off(IPC.PREVIEW_CHANGED, listener);
    },
  },
  codeflow: {
    buildGraph: (projectPath: string) =>
      ipcRenderer.invoke(IPC.CODEFLOW_BUILD_GRAPH, projectPath),
    buildFunctionGraph: (projectPath: string) =>
      ipcRenderer.invoke(IPC.CODEFLOW_BUILD_FUNCTION_GRAPH, projectPath),
    query: (projectPath: string, mode: 'query' | 'path' | 'explain', args: string[]) =>
      ipcRenderer.invoke(IPC.CODEFLOW_QUERY, projectPath, mode, args),
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
    // Live graph sync.
    subscribeGraph: (projectPath: string) =>
      ipcRenderer.invoke(IPC.CODEFLOW_GRAPH_SUBSCRIBE, projectPath),
    unsubscribeGraph: (projectPath: string) =>
      ipcRenderer.invoke(IPC.CODEFLOW_GRAPH_UNSUBSCRIBE, projectPath),
    onGraphUpdated: (
      projectPath: string,
      cb: (update: import('@shared/types').CodeflowGraphUpdate) => void,
    ) => {
      const listener = (
        _e: unknown,
        ev: import('@shared/types').CodeflowGraphUpdate,
      ) => {
        if (ev.projectPath === projectPath) cb(ev);
      };
      ipcRenderer.on(IPC.CODEFLOW_GRAPH_UPDATED, listener);
      return () => ipcRenderer.off(IPC.CODEFLOW_GRAPH_UPDATED, listener);
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
  bgClaude: {
    start: (command: string) =>
      ipcRenderer.invoke(IPC.BG_CLAUDE_START, command),
    list: () => ipcRenderer.invoke(IPC.BG_CLAUDE_LIST),
    readLog: (runId: string, offset?: number) =>
      ipcRenderer.invoke(IPC.BG_CLAUDE_READ_LOG, runId, offset ?? 0),
    kill: (runId: string) => ipcRenderer.invoke(IPC.BG_CLAUDE_KILL, runId),
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
