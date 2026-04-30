import { contextBridge, ipcRenderer } from 'electron';

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
    augmentGraph: (projectPath: string, graph: unknown) =>
      ipcRenderer.invoke(IPC.CODEFLOW_AUGMENT_GRAPH, projectPath, graph),
    augmentCancel: (projectPath: string) =>
      ipcRenderer.invoke(IPC.CODEFLOW_AUGMENT_CANCEL, projectPath),
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
