/**
 * Canonical IPC channel names. Keep renderer/main/preload in sync from a single source.
 */

export const IPC = {
  // App lifecycle
  APP_READY: 'app:ready',
  APP_GET_VERSION: 'app:get-version',
  APP_GET_HOME: 'app:get-home',

  // Workspace management
  WORKSPACE_LIST: 'workspace:list',
  WORKSPACE_OPEN: 'workspace:open',
  WORKSPACE_PICK: 'workspace:pick-folder',
  WORKSPACE_SCAN: 'workspace:scan',
  WORKSPACE_SET_ACTIVE: 'workspace:set-active',

  // Filesystem
  FS_READ_DIR: 'fs:read-dir',
  FS_READ_FILE: 'fs:read-file',
  FS_READ_BINARY: 'fs:read-binary',
  FS_WRITE_FILE: 'fs:write-file',
  FS_LIST_FILES: 'fs:list-files',
  FS_CREATE: 'fs:create',
  FS_RENAME: 'fs:rename',
  FS_DELETE: 'fs:delete',
  FS_DUPLICATE: 'fs:duplicate',
  FS_REVEAL: 'fs:reveal',
  FS_WATCH: 'fs:watch',
  FS_WATCH_EVENT: 'fs:watch-event',

  // Git
  GIT_STATUS: 'git:status',
  GIT_DIFF: 'git:diff',
  GIT_STAGE: 'git:stage',
  GIT_UNSTAGE: 'git:unstage',
  GIT_DISCARD: 'git:discard',
  GIT_COMMIT: 'git:commit',
  GIT_BRANCHES: 'git:branches',
  GIT_CHECKOUT: 'git:checkout',
  GIT_CREATE_BRANCH: 'git:create-branch',
  GIT_LOG: 'git:log',
  GIT_PUSH: 'git:push',
  GIT_PULL: 'git:pull',
  GIT_FETCH: 'git:fetch',

  // Search
  SEARCH_GREP: 'search:grep',

  // PTY / Claude CLI / Terminal
  PTY_CREATE: 'pty:create',
  PTY_WRITE: 'pty:write',
  PTY_RESIZE: 'pty:resize',
  PTY_KILL: 'pty:kill',
  PTY_DATA: 'pty:data',
  PTY_EXIT: 'pty:exit',

  // tmux inspection + interaction (for native Claude CLI agent teams)
  TMUX_LIST_PANES: 'tmux:list-panes',
  TMUX_CAPTURE_PANE: 'tmux:capture-pane',
  TMUX_SELECT_PANE: 'tmux:select-pane',
  TMUX_SEND_KEYS: 'tmux:send-keys',
  TMUX_LIST_SESSIONS: 'tmux:list-sessions',
  TMUX_KILL_SESSION: 'tmux:kill-session',
  TMUX_RENAME_SESSION: 'tmux:rename-session',
  TMUX_KILL_SERVER: 'tmux:kill-server',
  TMUX_GET_CONFIG: 'tmux:get-config',
  TMUX_SET_CONFIG: 'tmux:set-config',
  TMUX_RENDER_CONF: 'tmux:render-conf',
  TMUX_RESOLVE_BINARY: 'tmux:resolve-binary',

  // Claude config browser (Settings dialog)
  SETTINGS_LIST: 'settings:list',
  SETTINGS_READ: 'settings:read',
  SETTINGS_WRITE: 'settings:write',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
