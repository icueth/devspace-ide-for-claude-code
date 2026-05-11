/**
 * Canonical IPC channel names. Keep renderer/main/preload in sync from a single source.
 */

export const IPC = {
  // App lifecycle
  APP_READY: 'app:ready',
  APP_GET_VERSION: 'app:get-version',
  APP_GET_HOME: 'app:get-home',
  APP_CHECK_UPDATE: 'app:check-update',
  APP_OPEN_EXTERNAL: 'app:open-external',

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

  // Generic LLM (separate from Claude Code CLI) — used by editor
  // autocomplete and any future Cmd+K-style refactor / commit-msg gen.
  LLM_GET_CONFIG: 'llm:get-config',
  LLM_SET_CONFIG: 'llm:set-config',
  LLM_TEST: 'llm:test',
  LLM_COMPLETE: 'llm:complete',
  LLM_EDIT: 'llm:edit',

  // Chat (CLI-agent rendered as conversation, alternative to PTY dock)
  CHAT_LIST_THREADS: 'chat:list-threads',
  CHAT_CREATE_THREAD: 'chat:create-thread',
  CHAT_DELETE_THREAD: 'chat:delete-thread',
  CHAT_SEND: 'chat:send',
  CHAT_CANCEL: 'chat:cancel',
  CHAT_SUBSCRIBE: 'chat:subscribe',
  CHAT_EVENT: 'chat:event',
  CHAT_GET_CONFIG: 'chat:get-config',
  CHAT_SET_CONFIG: 'chat:set-config',
  CHAT_UPDATE_THREAD_CONFIG: 'chat:update-thread-config',

  // Agents (~/.claude/agents/*.md and <project>/.claude/agents/*.md)
  AGENTS_LIST: 'agents:list',
  AGENTS_READ: 'agents:read',
  AGENTS_SAVE: 'agents:save',
  AGENTS_CREATE: 'agents:create',
  AGENTS_DELETE: 'agents:delete',

  // MCP servers (~/.claude.json + <project>/.mcp.json)
  MCP_LIST: 'mcp:list',
  MCP_SAVE: 'mcp:save',
  MCP_RENAME: 'mcp:rename',
  MCP_DELETE: 'mcp:delete',
  MCP_CREATE: 'mcp:create',

  // Skills (~/.claude/skills/<name>/SKILL.md + plugin marketplaces)
  SKILLS_LIST: 'skills:list',
  SKILLS_READ: 'skills:read',
  SKILLS_SAVE: 'skills:save',
  SKILLS_CREATE: 'skills:create',
  SKILLS_DELETE: 'skills:delete',

  // Teams (.devspace/teams.json)
  TEAMS_LIST: 'teams:list',
  TEAMS_GET: 'teams:get',
  TEAMS_SAVE: 'teams:save',
  TEAMS_DELETE: 'teams:delete',

  // Codeflow — codebase visualization + Claude-generated architecture docs
  CODEFLOW_GET_STATUS: 'codeflow:get-status',
  CODEFLOW_ANALYZE: 'codeflow:analyze',
  CODEFLOW_CANCEL: 'codeflow:cancel',
  CODEFLOW_READ_DOC: 'codeflow:read-doc',
  CODEFLOW_LIST_DOCS: 'codeflow:list-docs',
  CODEFLOW_OPEN_DIR: 'codeflow:open-dir',
  CODEFLOW_BUILD_GRAPH: 'codeflow:build-graph',
  CODEFLOW_BUILD_FUNCTION_GRAPH: 'codeflow:build-function-graph',
  CODEFLOW_AUGMENT_GRAPH: 'codeflow:augment-graph',
  CODEFLOW_AUGMENT_CANCEL: 'codeflow:augment-cancel',
  CODEFLOW_AUGMENT_PROGRESS: 'codeflow:augment-progress',
  CODEFLOW_AUGMENT_LOAD: 'codeflow:augment-load',
  CODEFLOW_AUGMENT_CLEAR: 'codeflow:augment-clear',
  CODEFLOW_AUGMENT_FUNCTIONS: 'codeflow:augment-functions',
  CODEFLOW_AUGMENT_FUNCTIONS_CANCEL: 'codeflow:augment-functions-cancel',
  CODEFLOW_AUGMENT_FUNCTIONS_LOAD: 'codeflow:augment-functions-load',
  CODEFLOW_AUGMENT_FUNCTIONS_PROGRESS: 'codeflow:augment-functions-progress',
  CODEFLOW_PROGRESS: 'codeflow:progress',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
