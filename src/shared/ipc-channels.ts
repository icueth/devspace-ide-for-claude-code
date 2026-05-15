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
  WORKSPACE_CLOSE: 'workspace:close',

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
  // v0.11: copy any-scope (typically builtin) agent into global/project so
  // the user can edit it. Builtin agents themselves are read-only.
  AGENTS_DUPLICATE: 'agents:duplicate',

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
  // v0.11: copy any-scope (typically builtin/plugin) skill into
  // global/project so the user can edit it.
  SKILLS_DUPLICATE: 'skills:duplicate',

  // Teams (.devspace/teams.json)
  TEAMS_LIST: 'teams:list',
  TEAMS_GET: 'teams:get',
  TEAMS_SAVE: 'teams:save',
  TEAMS_DELETE: 'teams:delete',

  // Design Studio — Claude-driven HTML/JSX generation per project. State
  // lives under <project>/.devspace/design/. Generation reuses
  // TmuxChatRunner for the actual claude spawn so runs survive restart.
  DESIGN_LIST: 'design:list',
  DESIGN_GET: 'design:get',
  DESIGN_CREATE: 'design:create',
  DESIGN_REGENERATE: 'design:regenerate',
  DESIGN_DELETE: 'design:delete',
  DESIGN_CANCEL: 'design:cancel',
  DESIGN_LIST_SKILLS: 'design:list-skills',
  DESIGN_LIST_SYSTEMS: 'design:list-systems',
  DESIGN_READ_HTML: 'design:read-html',
  DESIGN_SUBSCRIBE: 'design:subscribe',
  DESIGN_EVENT: 'design:event',
  // Phase B: write-back of inline edits as a new version. Renderer sends
  // the full edited HTML snapshot (already serialized from the iframe
  // bridge) plus the op log for provenance. Main hardens + archives the
  // previous index.html into history/ + writes the new one atomically.
  DESIGN_SAVE_EDITS: 'design:save-edits',
  // v0.10: chat-style transcript + project profile
  DESIGN_FOLLOW_UP: 'design:follow-up',
  DESIGN_LIST_MESSAGES: 'design:list-messages',
  DESIGN_GET_PROFILE: 'design:get-profile',
  DESIGN_REBUILD_PROFILE: 'design:rebuild-profile',

  // Phase C: Live preview against a real project dev-server. Main detects
  // the framework (Vite / Next / Astro / Remix), spawns the dev script
  // through PtyPool, parses the emitted URL, and exposes lifecycle events.
  // Renderer mounts a <webview> at that URL and injects a bridge script
  // via webview.executeJavaScript.
  DEVSERVER_DETECT: 'devserver:detect',
  DEVSERVER_START: 'devserver:start',
  DEVSERVER_STOP: 'devserver:stop',
  DEVSERVER_STATUS: 'devserver:status',
  DEVSERVER_SUBSCRIBE: 'devserver:subscribe',
  DEVSERVER_UNSUBSCRIBE: 'devserver:unsubscribe',
  DEVSERVER_EVENT: 'devserver:event',
  // v0.16: refresh re-runs the framework / script / preflight detection
  // without touching a running PTY. Used by the toolbar Refresh button.
  DEVSERVER_REFRESH: 'devserver:refresh',
  // v0.16: install dependencies in a managed PTY. Required preflight when
  // node_modules is missing (no other detection failure is recoverable
  // in-app without leaving devspace).
  DEVSERVER_INSTALL: 'devserver:install',

  // Phase 0.8+: source-aware write-back. Main resolves each edit through
  // the appropriate StyleAdapter (Tailwind / vanilla CSS / styled / CSS
  // Modules) and writes atomically. Pre-flight `DETECT_ADAPTER` returns
  // the preferred adapter for the project so the UI can label the
  // confirmation toast accordingly.
  DESIGN_DETECT_ADAPTER: 'design:detect-adapter',
  DESIGN_WRITE_BACK: 'design:write-back',

  // v0.15: Multi-screen app planning. Claude breaks a free-form brief
  // into a JSON plan (screens + shared theme). User reviews/edits, then
  // approves to materialize each screen as a normal DesignScreen + run
  // batched generation with the shared theme injected.
  DESIGN_PLAN_APP: 'design:plan-app',
  DESIGN_APPROVE_PLAN: 'design:approve-plan',
  DESIGN_LIST_APPS: 'design:list-apps',
  DESIGN_GET_APP: 'design:get-app',
  DESIGN_UPDATE_PLAN: 'design:update-plan',
  DESIGN_DELETE_APP: 'design:delete-app',
  DESIGN_RUN_BATCH: 'design:run-batch',
  // v0.15: Project-wide design tokens. When `lockedAt` is set the prompt
  // builder injects these into every generation regardless of per-screen
  // reuseTheme. UI lives in DesignSettings → Project Tokens tab.
  DESIGN_GET_TOKENS: 'design:get-tokens',
  DESIGN_SET_TOKENS: 'design:set-tokens',
  DESIGN_EXTRACT_TOKENS: 'design:extract-tokens',

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

  // Memory system (v0.19)
  MEMORY_LIST_PROJECTS: 'memory:list-projects',
  MEMORY_PRUNE_GHOSTS: 'memory:prune-ghosts',
  MEMORY_LIST_ENTRIES: 'memory:list-entries',
  MEMORY_GET_ENTRY: 'memory:get-entry',
  MEMORY_CREATE_ENTRY: 'memory:create-entry',
  MEMORY_UPDATE_ENTRY: 'memory:update-entry',
  MEMORY_DELETE_ENTRY: 'memory:delete-entry',
  MEMORY_TOGGLE_PIN: 'memory:toggle-pin',
  MEMORY_SEARCH: 'memory:search',
  MEMORY_GET_STATS: 'memory:get-stats',
  MEMORY_LIST_INBOX: 'memory:list-inbox',
  MEMORY_RESOLVE_INBOX: 'memory:resolve-inbox',
  MEMORY_DISMISS_INBOX: 'memory:dismiss-inbox',
  MEMORY_PROPOSE_FROM_TURN: 'memory:propose-from-turn',
  MEMORY_LIST_DIARY: 'memory:list-diary',
  MEMORY_GET_DIARY: 'memory:get-diary',
  MEMORY_WRITE_DIARY: 'memory:write-diary',
  MEMORY_LIST_THREADS: 'memory:list-threads',
  MEMORY_GET_THREAD: 'memory:get-thread',
  MEMORY_SUMMARIZE_THREAD: 'memory:summarize-thread',
  MEMORY_BUILD_RECALL_CONTEXT: 'memory:build-recall-context',
  MEMORY_BUILD_INJECT_PREAMBLE: 'memory:build-inject-preamble',
  MEMORY_GET_SETTINGS: 'memory:get-settings',
  MEMORY_SET_SETTINGS: 'memory:set-settings',
  MEMORY_OPEN_DIR: 'memory:open-dir',
  MEMORY_EVENTS: 'memory:events',

  // MemPalace installer (Settings → Memory tab). One-click install of the
  // MemPalace MCP plugin + Claude Code hooks for end users of the app.
  MEMPALACE_GET_STATUS: 'mempalace:get-status',
  MEMPALACE_INSTALL: 'mempalace:install',
  MEMPALACE_UNINSTALL: 'mempalace:uninstall',
  MEMPALACE_OPEN_VAULT: 'mempalace:open-vault',
  MEMPALACE_PROGRESS: 'mempalace:progress',

  // MemPalace data viewer (Memory Dashboard). Read-only browse of the vault
  // SQLite stores — drawers, wings/rooms, knowledge-graph triples. Powers
  // the post-v0.21 dashboard which replaced the legacy ~/.devspace memory
  // system.
  MEMPALACE_DATA_GET_OVERVIEW: 'mempalace-data:get-overview',
  MEMPALACE_DATA_LIST_WINGS: 'mempalace-data:list-wings',
  MEMPALACE_DATA_LIST_ROOMS: 'mempalace-data:list-rooms',
  MEMPALACE_DATA_LIST_DRAWERS: 'mempalace-data:list-drawers',
  MEMPALACE_DATA_LIST_TRIPLES: 'mempalace-data:list-triples',
  MEMPALACE_DATA_INVALIDATE: 'mempalace-data:invalidate',

  // Environment Setup wizard (Settings → Setup tab). Detects + installs
  // Homebrew / Claude / tmux / rtk / jq / rtk hook / MemPalace so a fresh
  // install of devspace can reach a fully-working state without leaving
  // the app.
  SETUP_GET_STATUS: 'setup:get-status',
  SETUP_INSTALL_TOOL: 'setup:install-tool',
  SETUP_INSTALL_ALL: 'setup:install-all',
  SETUP_UNINSTALL_RTK_HOOK: 'setup:uninstall-rtk-hook',
  SETUP_OPEN_CLAUDE_DIR: 'setup:open-claude-dir',
  SETUP_PROGRESS: 'setup:progress',
  // AI-driven installer: spawn `claude` with a prompt asking it to finish
  // installing whatever the deterministic installer couldn't. Renderer
  // mounts an xterm against the returned PTY sessionId.
  SETUP_RUN_CLAUDE: 'setup:run-claude',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
