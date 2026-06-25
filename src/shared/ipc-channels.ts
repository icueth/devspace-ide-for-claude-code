/**
 * Canonical IPC channel names. Keep renderer/main/preload in sync from a single source.
 */

export const IPC = {
  // App lifecycle
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
  // Lighter sibling of WORKSPACE_CLOSE: tear down per-project main-process
  // state (dev-server, graphify, codeflow-live) WITHOUT killing claude/shell
  // PTYs (dock chips persist cross-workspace by design) and WITHOUT closing
  // fs watchers (FileTree owns that lifecycle). Payload: projectId, projectPath.
  WORKSPACE_SUSPEND: 'workspace:suspend',

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
  // Kill a claude-cli/shell tab's FULL session tree: the PTY (tmux attach
  // client) AND the backing tmux session, so claude + MCP children don't
  // leak detached. Payload: (projectId, tabId, kind) — main derives the
  // tmux session name itself; the renderer never supplies one. PTY_KILL
  // stays detach-only (reloadTab / ClaudeSetupPane depend on that).
  PTY_KILL_SESSION: 'pty:kill-session',
  // Restart one claude-cli tab: full session-tree kill so the pane's next
  // `tmux new-session -A` spawns a brand-new claude (fresh .mcp.json / env).
  PTY_RESTART_CLAUDE: 'pty:restart-claude',
  // Renderer-pulled scrollback replay. invoke(sessionId) adds the sender as
  // a live subscriber AND returns the rolling buffer in one atomic main-side
  // turn. The renderer calls this AFTER arming its `pty:data:<id>` listener —
  // a main-pushed replay at PTY_CREATE time is always dropped because that
  // listener only attaches after create() resolves (+ lazy xterm chunk).
  PTY_SUBSCRIBE: 'pty:subscribe',
  PTY_DATA: 'pty:data',
  PTY_EXIT: 'pty:exit',
  // v0.36.0: emitted when the PtyPool idle reaper auto-closes one or more
  // claude-cli tabs. Payload: { ids: string[]; thresholdMinutes: number }.
  // Renderer's CliTabs store listens to remove the tabs from the dock and a
  // toast surfaces the resource freed.
  PTY_AUTO_CLOSED: 'pty:auto-closed',
  // v0.36.1: renderer → main fire-and-forget push of the set of claude-cli
  // session ids currently pinned by some dock column. Sent after every
  // change to useCliTabsStore.columns so the dual-tier reaper knows which
  // tabs the user is actually looking at vs. which are off-screen chips.
  PTY_SET_PINNED: 'pty:set-pinned',
  // v2 worktree-isolated agent tasks
  TASK_LIST: 'task:list',
  TASK_CREATE: 'task:create',
  TASK_MERGE: 'task:merge',
  TASK_CREATE_PR: 'task:create-pr',
  TASK_DISCARD: 'task:discard',
  TASK_DISMISS: 'task:dismiss', // drop a finished (done/discarded) record
  TASK_DIFF_STAT: 'task:diff-stat',
  TASK_DIFF: 'task:diff', // unified `git diff <base>` text for review
  TASK_CHANGED: 'task:changed', // main → renderer push on any list change
  // Phase 4a: main → renderer broadcast that the per-session
  // ApprovalDetector matched a fresh tool-approval prompt in the PTY's
  // stdout. Payload: { sessionId, request: ApprovalRequest }. Renderer
  // surfaces a small Allow/Deny banner inside the terminal body.
  PTY_TOOL_APPROVAL: 'pty:tool-approval',

  // tmux inspection + interaction (for native Claude CLI agent teams)
  TMUX_LIST_PANES: 'tmux:list-panes',
  TMUX_CAPTURE_PANE: 'tmux:capture-pane',
  TMUX_CAPTURE_PANES: 'tmux:capture-panes',
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
  TMUX_FIND_STALE: 'tmux:find-stale',
  TMUX_PRUNE_STALE: 'tmux:prune-stale',

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

  // CLI runtime detection. Probes binaries on PATH (currently just
  // `claude`) so the UI can version-gate features on the detected CLI.
  CLI_DETECT: 'cli:detect',

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

  // v0.31: bundled design-skill seeding into ~/.claude/skills — status,
  // on-launch toggle, and manual re-seed.
  DESIGN_SEEDING_STATUS: 'design-seeding:status',
  DESIGN_SEEDING_SET_ENABLED: 'design-seeding:set-enabled',
  DESIGN_SEEDING_RESEED: 'design-seeding:reseed',

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

  // v0.31: HTML Preview. After the Design Studio teardown, design work is
  // done by Claude itself (via bundled design skills) writing standalone
  // HTML to `<project>/.devspace/preview/<name>.html`. The main process
  // watches that dir and emits PREVIEW_CHANGED; the renderer opens/refreshes
  // a sandboxed iframe tab. READ_HTML returns file contents (path-contained
  // to .devspace/preview/) for the renderer's Blob URL.
  PREVIEW_LIST: 'preview:list',
  PREVIEW_READ_HTML: 'preview:read-html',
  PREVIEW_SUBSCRIBE: 'preview:subscribe',
  // Drop the sender from a project's preview watcher; the watcher itself is
  // closed once its subscriber set empties. The renderer calls this from the
  // preview effect's cleanup so steady-state is exactly ONE watcher (the
  // active project) instead of one per project ever activated.
  PREVIEW_UNSUBSCRIBE: 'preview:unsubscribe',
  PREVIEW_CHANGED: 'preview:changed',

  // Codeflow — graphify-backed code graph + queryable graph + augment overlay
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
  // Live graph sync: subscribe returns the current graph + starts
  // pushing CODEFLOW_GRAPH_UPDATED on every debounced filesystem change.
  CODEFLOW_GRAPH_SUBSCRIBE: 'codeflow:graph-subscribe',
  CODEFLOW_GRAPH_UNSUBSCRIBE: 'codeflow:graph-unsubscribe',
  CODEFLOW_GRAPH_UPDATED: 'codeflow:graph-updated',
  // Queryable graph (graphify): one-shot query/path/explain over the cached
  // graph.json. Returns graphify's plain-text result.
  CODEFLOW_QUERY: 'codeflow:query',

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
  // sub-project 3 (native learning): manual "Learn from recent work" trigger.
  MEMORY_DISTILL: 'memory:distill',
  MEMORY_LIST_DIARY: 'memory:list-diary',
  MEMORY_GET_DIARY: 'memory:get-diary',
  MEMORY_WRITE_DIARY: 'memory:write-diary',
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

  // Devlog system (v0.24). Per-project work log on disk; read/write through
  // DevlogService — never touch `.devspace/devlog/*` from renderer directly.
  DEVLOG_LIST: 'devlog:list',
  DEVLOG_GET: 'devlog:get',
  DEVLOG_CREATE: 'devlog:create',
  DEVLOG_UPDATE: 'devlog:update',
  DEVLOG_DELETE: 'devlog:delete',
  DEVLOG_APPEND_LOG: 'devlog:append-log',
  DEVLOG_BUILD_INJECT: 'devlog:build-inject',
  DEVLOG_GET_SETTINGS: 'devlog:get-settings',
  DEVLOG_SET_SETTINGS: 'devlog:set-settings',
  DEVLOG_OPEN_DIR: 'devlog:open-dir',
  DEVLOG_EVENTS: 'devlog:events',

  // Forge system (v0.24). Generate + track skills/agents per project.
  FORGE_LIST_DRAFTS: 'forge:list-drafts',
  FORGE_GET_DRAFT: 'forge:get-draft',
  FORGE_CREATE_DRAFT: 'forge:create-draft',
  FORGE_GENERATE_DRAFT: 'forge:generate-draft',
  FORGE_UPDATE_DRAFT: 'forge:update-draft',
  FORGE_SAVE_DRAFT: 'forge:save-draft',
  FORGE_DELETE_DRAFT: 'forge:delete-draft',
  FORGE_CANCEL_DRAFT: 'forge:cancel-draft',
  FORGE_LIST_STATS: 'forge:list-stats',
  FORGE_RECORD_USE: 'forge:record-use',
  FORGE_RECORD_SIGNAL: 'forge:record-signal',
  FORGE_LIST_USES: 'forge:list-uses',
  FORGE_LIST_SUGGESTIONS: 'forge:list-suggestions',
  FORGE_DISMISS_SUGGESTION: 'forge:dismiss-suggestion',
  FORGE_LIST_CATALOG: 'forge:list-catalog',
  FORGE_DISCOVER_MATCHES: 'forge:discover-matches',
  FORGE_GET_SETTINGS: 'forge:get-settings',
  FORGE_SET_SETTINGS: 'forge:set-settings',
  FORGE_EVENTS: 'forge:events',

  // v0.37: background claude runs. Spawn `claude --bg --exec "<text>"`
  // outside any PTY tab, capture logs to ~/.devspace/bg-runs/<runId>.log,
  // and let the renderer query/poll/kill via these IPCs.
  BG_CLAUDE_START: 'bg-claude:start',
  BG_CLAUDE_LIST: 'bg-claude:list',
  BG_CLAUDE_READ_LOG: 'bg-claude:read-log',
  BG_CLAUDE_KILL: 'bg-claude:kill',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
