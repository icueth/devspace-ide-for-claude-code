// ─── LLM config ─────────────────────────────────────────────────────────────
//
// Generic LLM settings used by features outside the Claude Code CLI dock —
// editor inline-autocomplete is the first consumer, but the same config
// will back future Cmd+K refactor, commit-message generation, and
// anything else that wants a chat-completion endpoint. Two protocols:
//
//   - openai     — POST {baseUrl}/chat/completions with Authorization:
//                  Bearer ... header. Compatible with OpenAI proper, plus
//                  the dozens of OpenAI-API-compatible servers (Azure
//                  OpenAI, OpenRouter, LM Studio, Ollama with the
//                  /v1 endpoint, vLLM, llama.cpp server, Together.ai, …).
//   - anthropic  — POST {baseUrl}/v1/messages with x-api-key + an
//                  anthropic-version header.
//
// `apiKey` is stored on disk in plaintext under ~/.devspace/llm-config.json
// — same security posture as tmux-config and the Claude Code CLI's own
// settings.json. We don't pretend to do secret management.
export type LlmProvider = 'openai' | 'anthropic';

export interface LlmConfig {
  provider: LlmProvider;
  baseUrl: string;       // e.g. "https://api.openai.com/v1" or "https://api.anthropic.com"
  apiKey: string;        // pasted by user; empty string = unconfigured
  model: string;         // e.g. "gpt-4o-mini", "claude-haiku-4-5"
  // Optional knobs — undefined = use sane defaults at the call site.
  temperature?: number;
  maxTokens?: number;
  // Master switch for the editor's inline ghost-text autocomplete.
  // Off by default so users opt in and aren't surprised by latency or
  // token spend.
  autocompleteEnabled: boolean;
  // Debounce window before triggering an autocomplete request after the
  // last keystroke. Lower = more responsive, more LLM calls.
  autocompleteDebounceMs: number;
}

export interface LlmTestResult {
  ok: boolean;
  latencyMs?: number;
  // Echoed model name from the response when the API surfaces it — lets
  // the user catch typos (asked for `gpt-4o`, server returned `gpt-3.5`).
  modelEcho?: string;
  // First few tokens of the response so the user sees a real answer
  // came back, not just a 200.
  sample?: string;
  error?: string;
}

// Effort tiers (claude-code 2.1.154+). Retained for the Skill frontmatter
// `effort:` tag — see SkillDef.effort, parsed by SkillsService and shown as a
// read-only badge; the claude binary reads the frontmatter itself. `ultracode`
// is the top tier introduced with Opus 4.8.
export type ClaudeEffort =
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'ultracode';

// v0.37: background-claude run metadata. See BackgroundClaudeRunner.
export type BackgroundRunStatus = 'pending' | 'running' | 'done' | 'failed';

export interface BackgroundRunMeta {
  runId: string;
  command: string;
  status: BackgroundRunStatus;
  startedAt: number;
  endedAt?: number;
  exitCode: number | null;
  logPath: string;
  pid?: number;
  logBytes: number;
}

export interface LlmCompleteRequest {
  // Code before the cursor (truncated to last ~N chars on the renderer).
  prefix: string;
  // Code after the cursor.
  suffix: string;
  // Filename to give Claude/GPT context about the language.
  filename: string;
}

export interface LlmCompleteResponse {
  // Empty string when the model returned no usable completion.
  text: string;
  latencyMs: number;
  error?: string;
}

// Cmd+K-style "edit this selection" round trip. Sends the user's
// selection plus an instruction; expects a drop-in replacement back.
export interface LlmEditRequest {
  selection: string;
  instruction: string;
  // The whole file's code as context — helps the model match style /
  // imports / surrounding patterns. Truncated on the renderer to ~6KB.
  context: string;
  filename: string;
  // Where the selection sits in the file (line range), purely for
  // surfacing in the diff header — model doesn't see this.
  startLine: number;
  endLine: number;
}

export interface LlmEditResponse {
  text: string;
  latencyMs: number;
  error?: string;
}

// v0.30: multi-CLI support. Each CLI runtime is identified by a stable id;
// 'claude' is the default and is built-in (no profile needed, uses tmux-
// backed runner). Other CLIs (currently only 'opencode') require a
// CliProfile that points at their provider config (OpenAI-compatible
// endpoint + key + model). A runtime is locked per session for transcript
// consistency — switching CLI starts a new session, never mutates.
export type CliId = 'claude' | 'opencode';

// Capability flags published by each adapter. Renderer reads these to
// decide which UI affordances apply to a thread (e.g. don't render tool
// cards for CLIs whose stream format doesn't emit
// them). `summaryLabel` is the chip text shown next to the picker.
export interface CliCapabilities {
  toolCards: boolean;
  diffPreview: boolean;
  askUserQuestion: boolean;
  skills: boolean;
  // e.g. "Full" (Claude) / "~90% tools" (OpenCode) / "Bash only" (Codex)
  summaryLabel: string;
}

// User-created profile that binds a non-Claude CLI runtime to a provider
// config. Stored at `~/.devspace/cli-profiles.json` → { profiles: [...] }.
// The matching auto-generated runtime config dir lives at
// `~/.devspace/cli-profiles/<id>/` and is wired via env (e.g.
// OPENCODE_CONFIG_DIR) at spawn time so each profile is isolated and the
// user's own ~/.config/opencode/ is never mutated.
export interface CliProfile {
  id: string;                  // UUID generated on create
  name: string;                // "AEON Qwen3.6" — capped 64 chars
  cliId: Exclude<CliId, 'claude'>; // 'claude' has no profile (built-in)
  provider: {
    baseURL: string;           // e.g. http://123.253.61.68:8000/v1
    apiKey: string;            // plaintext on disk, 0o600 mode
    model: string;             // e.g. AEON-7/Qwen3.6-27B-...
    // Optional knobs forwarded to the auto-generated runtime config:
    contextLimit?: number;
    outputLimit?: number;
  };
  // Optional per-profile system prompt prepended to every turn (after
  // project memory preambles). Capped at 4096 chars by service.
  systemPrompt?: string;
  createdAt: number;           // ms-epoch, stable sort
}

// Per-session auth for the built-in `claude` CLI. Unlike CliProfile (which
// configures OTHER OpenAI-compatible CLIs), this only selects which credentials
// a claude session launches with — its subscription login, or a custom API key
// (optionally a gateway base URL / auth token). Resolved to ANTHROPIC_* env
// vars injected per tmux session, so different tabs can run on different auth at
// the same time. The built-in `subscription` profile carries no env.
export interface ClaudeAuthProfile {
  id: string; // 'subscription' for the built-in; uuid for API profiles
  name: string; // e.g. "Subscription", "Work API", "Gateway"
  kind: 'subscription' | 'api';
  apiKey?: string; // ANTHROPIC_API_KEY — plaintext on disk (0o600), api only
  baseUrl?: string; // ANTHROPIC_BASE_URL — optional custom endpoint
  authToken?: string; // ANTHROPIC_AUTH_TOKEN — optional (some gateways)
  model?: string; // ANTHROPIC_MODEL — optional model override (custom gateways)
  createdAt: number;
}

// Result of probing a CLI binary on PATH (+ fallback bins). Returned by
// `cli:detect` for the Settings UI to gate profile creation on the
// matching runtime actually being installed.
export interface CliDetectionResult {
  cliId: CliId;
  installed: boolean;
  version?: string;
  bin?: string;                // resolved absolute path if installed
}

// ─── MCP servers (Model Context Protocol — claude tool extensibility) ──────
//
// Claude Code reads MCP server definitions from a few places:
//   • ~/.claude.json — global, shared key `mcpServers` inside a much
//     larger JSON document; we have to surgically read/write that one key
//     without disturbing anything else.
//   • <projectRoot>/.mcp.json — per-project, this file is dedicated to
//     MCP so we own it entirely.
//
// Transport types: stdio (CLI child process, args/env) or http/sse
// (network endpoint with optional headers).

export type McpScope = 'global' | 'project';
export type McpTransport = 'stdio' | 'http' | 'sse';

export interface McpStdioServer {
  transport: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpHttpServer {
  transport: 'http' | 'sse';
  url: string;
  // Headers as `${ENV_VAR}` references are substituted by claude at
  // request time (see claude 2.1.128 changelog). Stored verbatim.
  headers?: Record<string, string>;
}

export type McpServer = McpStdioServer | McpHttpServer;

export interface McpServerEntry {
  // Dictionary key used in the on-disk `mcpServers` map.
  name: string;
  scope: McpScope;
  // Absolute path to the file this entry lives in (so the user can see
  // where the change will land before saving).
  filePath: string;
  server: McpServer;
}

// ─── Skills (~/.claude/skills/<name>/SKILL.md, plugin marketplaces) ────────
//
// Skills are domain-specific instruction packs Claude loads on demand.
// On disk: one folder per skill with a SKILL.md file inside.
//   • ~/.claude/skills/<name>/SKILL.md — user-authored
//   • <projectRoot>/.claude/skills/<name>/SKILL.md — per-project
//   • ~/.claude/plugins/marketplaces/<mkt>/skills/<name>/SKILL.md —
//     plugin-managed (read-only in the UI; deletes belong to the
//     marketplace tooling, not us).
//
// Frontmatter shape is the same as agents except the tools field is
// `allowed-tools` (hyphenated, claude's published convention) instead
// of `tools`.

// 'builtin' is the bundled starter pack we ship inside the .app — these
// live read-only under <Resources>/builtin-packs/skills/. Discovered on
// every list() and merged with global/project. Users can override a
// builtin by creating the same slug at global or project scope.
export type SkillScope = 'global' | 'project' | 'plugin' | 'builtin';

// v0.31: status of the bundled design-skill seeding into ~/.claude/skills.
export interface DesignSeedingStatus {
  enabled: boolean;
  packVersion: string | null;
  seededAt: string | null;
  skillCount: number;
  systemCount: number;
  agentCount: number;
}

export interface DesignSeedingReseedResult {
  status:
    | 'seeded'
    | 'skipped-up-to-date'
    | 'skipped-no-bundle'
    | 'skipped-disabled';
  seededSkills: number;
  seededSystems: number;
  seededAgents: number;
  skippedCollisions: number;
  removedStale: number;
}

export interface SkillDef {
  path: string;          // absolute path to SKILL.md
  scope: SkillScope;
  slug: string;          // folder name
  name: string;
  description: string;
  model?: string;
  allowedTools?: string[];
  // v0.37: optional `effort:` frontmatter tag (claude 2.1.154+). When set,
  // claude scales its extended-thinking budget for turns where this skill
  // is loaded. DevSpace surfaces it as a read-only badge in the Skills
  // settings list — we don't pass it through anywhere else; the active
  // claude binary reads the frontmatter on its own.
  effort?: ClaudeEffort;
  extra: Record<string, unknown>;
  body: string;
  // For plugin-scoped skills, which marketplace/plugin owns this skill.
  pluginSource?: string;
  // True when the same slug exists at a higher-priority scope (project
  // overrides global overrides builtin). The renderer dims overridden
  // entries and labels them so the user understands precedence.
  overridden?: boolean;
}

// ─── Agents (~/.claude/agents/*.md and <project>/.claude/agents/*.md) ───────
//
// Claude Code dispatches sub-agents via the Task tool; each agent is a
// markdown file with YAML frontmatter (name, description, tools, model)
// plus a body that becomes the agent's system prompt. DevSpace exposes a
// visual editor for these so users don't have to hand-edit YAML.
//
// The on-disk format is the canonical source — we re-parse on every list
// call so external edits (from `claude` CLI's `/agents`, plain editors,
// or another DevSpace window) show up immediately.

// 'builtin' is the bundled starter pack inside the .app
// (<Resources>/builtin-packs/agents/). Read-only — user must duplicate
// to global/project before editing. Project > global > builtin.
export type AgentScope = 'global' | 'project' | 'builtin';

export interface AgentDef {
  // Absolute path to the markdown file.
  path: string;
  // 'global' lives in ~/.claude/agents/; 'project' lives in
  // <projectRoot>/.claude/agents/; 'builtin' lives under the app
  // Resources dir and is read-only.
  scope: AgentScope;
  // Filename without `.md` — drives the slug shown when `name` is empty
  // or unset.
  slug: string;
  // YAML frontmatter — parsed. Unknown fields land in `extra` so we can
  // preserve them on round-trip without overwriting user customizations.
  name: string;
  description: string;
  model?: string;          // 'sonnet' | 'opus' | 'haiku' | full id
  tools?: string[];        // ['Read', 'Edit', …] — empty/undefined = all
  color?: string;          // claude convention for sidebar coloring
  // Pass-through bucket for keys we don't know about (e.g. user-custom
  // `skills`, `memory`, etc.). Re-serialized verbatim above the known
  // fields.
  extra: Record<string, unknown>;
  // Markdown body — everything after the closing `---` line. Becomes the
  // agent's system prompt when dispatched.
  body: string;
  // Same as SkillDef.overridden — true when a higher-priority scope has
  // a file with the same slug shadowing this one.
  overridden?: boolean;
}

export interface UpdateInfo {
  // Currently-running app version (no leading "v").
  current: string;
  // Latest release tag (raw, may include leading "v"). null on error.
  latest: string | null;
  // True when latest > current via numeric semver compare.
  hasUpdate: boolean;
  // GitHub release page (open in browser for manual install).
  releaseUrl: string | null;
  // Direct DMG asset URL when published; null if release has no .dmg.
  downloadUrl: string | null;
  // Markdown release notes — rendered in an "Update available" dialog.
  releaseNotes: string | null;
  // User-facing error message when the check failed (rate limit, offline,
  // GitHub down). hasUpdate is always false in this case.
  error: string | null;
  // Epoch ms when the check was performed; used for "Last checked …" labels.
  checkedAt: number;
}

export interface Workspace {
  id: string;
  path: string;
  name: string;
  lastOpened: number;
  pinned?: boolean;
}

export type ProjectVcs = 'git' | 'none';

export interface Project {
  id: string;
  name: string;
  path: string;
  workspaceId: string;
  vcs: ProjectVcs;
  detectedRuntime: string[];
  lastOpened?: number;
  // True when this project IS the workspace root itself (monorepo / single-
  // repo case). The sidebar pins these to the top and CLI uses root cwd.
  isWorkspaceRoot?: boolean;
}

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink?: boolean;
  /** Synthetic sentinel row: the directory had more entries than the listing
   *  cap. Rendered as a non-interactive "… N more" hint, not a real file. */
  truncated?: boolean;
}

export type PtySessionKind =
  | 'claude-cli'
  | 'shell'
  | 'agent'
  | 'dev-server'
  // v0.16: `pm install` runs in a dedicated PTY so its lifetime can be
  // tracked separately from the dev-server (an install is one-shot and
  // exits, but its lifetime may overlap with the workspace close).
  | 'install'
  // Settings → Setup tab spawns claude with an install-the-missing-tools
  // prompt. Distinct kind so it doesn't collide with the dock's claude-cli
  // session and so AgentsRail/Dock don't try to render it.
  | 'setup-claude';

export interface PtyCreateOptions {
  projectId: string;
  kind: PtySessionKind;
  // Lets multiple PTYs of the same kind coexist for one project (e.g. several
  // Claude CLI chat tabs). Omitted = 'default' so callers that don't care
  // (shell pane, AgentsRail) keep the original single-session behavior.
  tabId?: string;
  cwd: string;
  command?: string;
  args?: string[];
  cols?: number;
  rows?: number;
  // Claude auth profile id for a 'claude-cli' session (per-tab credentials).
  authProfileId?: string;
}

export interface PtySession {
  sessionId: string;
  projectId: string;
  kind: PtySessionKind;
  tabId: string;
  pid: number;
}

export interface CliTab {
  id: string;
  projectId: string;
  label: string;
  createdAt: number;
  // Bumped each time the user explicitly reloads the tab. Used as part of
  // the React key on the pane wrapper so the underlying ClaudeCliPane
  // remounts and re-spawns its PTY (the previous PTY is killed by the
  // store action before the bump).
  reloadGen?: number;
  // Claude auth profile this tab launches with (undefined = subscription).
  authProfileId?: string;
}

// Per-project shell terminal tab. The bottom-panel terminal supports many
// concurrent shells per project (frontend dev, backend api, build, …),
// each backed by an independent PTY whose key is `${projectId}:shell:${id}`.
// Tabs survive project switches because BottomPanel is mounted per-project.
export interface ShellTab {
  id: string;
  projectId: string;
  label: string;
  createdAt: number;
}

// Snapshot of a project's identity stored alongside CliTabs so the dock
// can render and respawn its PTY even after the user switches to a
// workspace that doesn't include this project. Without this, switching
// folders would orphan the chips that were docked from the old folder.
export interface DockedProjectMeta {
  id: string;
  name: string;
  path: string;
  workspaceId?: string;
}

// One vertical slot inside the CLI dock. Multiple columns let the user
// see several (project, tab) pairs side-by-side on a single screen — the
// layout is bounded to MAX 3 columns so xterm fontsize stays readable on
// a typical 13-15" laptop display.
export interface DockColumn {
  id: string;
  // What this column is currently showing. null is a transient state used
  // when freshly added before the user clicks a chip.
  pin: { projectId: string; tabId: string } | null;
}

export type SettingsFileKind = 'json' | 'markdown' | 'text';

export interface SettingsFile {
  label: string;
  path: string;
  kind: SettingsFileKind;
}

export interface SettingsCategory {
  id: string;
  label: string;
  scope: 'global' | 'project';
  files: SettingsFile[];
}

export interface TmuxPane {
  paneId: string;           // e.g. "%0"
  paneIndex: number;        // integer pane index inside window
  title: string;            // pane_title (Claude CLI sets this per agent)
  command: string;          // running command
  pid: number;
  activity: number;         // pane_activity timestamp (seconds)
  cwd: string;
}

export interface TmuxConfig {
  // Master switch — when false, ClaudeCliLauncher skips tmux even if installed.
  enabled: boolean;
  // Override the auto-detected `tmux` binary (absolute path). null = auto.
  binaryPath: string | null;
  // tmux `-L <name>` socket. Isolating from default keeps `kill-server` from
  // touching tmux sessions the user spawned outside DevSpace.
  socketName: string;
  // Naming scheme: `<prefix>-cli-<projectId>` / `<prefix>-shell-<projectId>`.
  sessionPrefix: string;
  // Token for tmux send-prefix (e.g. "C-b", "C-a"). Renderer uses this to
  // decide which control byte to send for the right-click context menu.
  prefixKey: string;
  mouseMode: boolean;
  escapeTimeMs: number;
  historyLimit: number;
  statusBar: boolean;
  // When true, kills every devspace-* session on app quit. When false (default)
  // sessions persist so re-opening the app reattaches with state intact.
  killSessionsOnQuit: boolean;
  /** v0.36.0: auto-close CLI tabs idle longer than the threshold below. */
  autoCloseIdleCliTabs?: boolean;
  /** v0.36.0: minutes a claude-cli PTY may sit idle before the reaper kills it.
   * Clamped to [15, 720]. Default 120 (2h). */
  idleCliTabTimeoutMinutes?: number;
  /** v0.36.1: minutes an UNPINNED claude-cli PTY (no column displays it) may
   * sit idle before the reaper kills it. Clamped to [1, 60]. Default 10. */
  unpinnedCliTabTimeoutMinutes?: number;
}

export interface TmuxSession {
  name: string;             // session_name (e.g. "devspace-cli-<projectId>")
  id: string;               // session_id (e.g. "$0")
  windows: number;          // session_windows
  attached: boolean;        // session_attached > 0
  created: number;          // session_created timestamp (seconds)
  activity: number;         // session_activity timestamp (seconds)
  // Best-effort labels parsed out of the devspace-prefixed naming scheme.
  // null when the session wasn't spawned by us (e.g. an external tmux session
  // the user attached to manually).
  kind: 'claude-cli' | 'shell' | 'chatrun' | 'other';
  projectId: string | null;
  tabId: string | null;
}

export type GitChangeType = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict';

export interface GitFileChange {
  path: string;
  absolutePath: string;
  type: GitChangeType;
  staged: boolean;
}

export interface GitSnapshot {
  branch: string | null;
  ahead: number;
  behind: number;
  files: GitFileChange[];
  isRepo: boolean;
  // Repo-relative paths that .gitignore (and `.git/info/exclude`, global
  // excludesFile, etc.) tell git to ignore. Directories carry a trailing
  // `/` so the renderer can treat them as prefix matches without re-stat'ing.
  ignoredPaths: string[];
}

export interface GitDiff {
  oldContent: string;
  newContent: string;
  // True when the file resolves successfully against HEAD. False for new/
  // untracked files where `git show HEAD:<path>` returns an error — in that
  // case `oldContent` is `''` and consumers should treat the file as having
  // no meaningful baseline (skip the gutter rather than paint every line
  // green).
  inHead: boolean;
}

export interface GitBranchInfo {
  name: string;
  current: boolean;
  remote: boolean;
  upstream?: string;
  tracking?: { ahead: number; behind: number };
  commit?: string;
  subject?: string;
}

export interface GitBranches {
  current: string | null;
  branches: GitBranchInfo[];
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: number; // ms since epoch
  subject: string;
  refs: string[]; // branch/tag refs attached to the commit
}

export interface SearchMatchRange {
  start: number;
  end: number;
}

export interface SearchMatch {
  file: string;
  absolutePath: string;
  line: number;
  column: number;
  lineText: string;
  ranges: SearchMatchRange[];
}

export interface SearchResult {
  matches: SearchMatch[];
  truncated: boolean;
  engine: 'ripgrep' | 'node';
  elapsedMs: number;
}

export interface SearchOptions {
  caseSensitive?: boolean;
  regex?: boolean;
  wholeWord?: boolean;
  includeGlobs?: string[];
  excludeGlobs?: string[];
  maxResults?: number;
}

// ─── Codeflow ───────────────────────────────────────────────────────────────
//
// graphify (bundled binary) builds the code graph; the legacy Claude static-doc
// generator (codebase.md / flow-*.md) and its status/doc types were removed in
// v0.38 — the queryable graph (query/path/explain) replaces narrative docs.

// ─── Codeflow function-level graph ──────────────────────────────────────────
//
// Sibling to the file-level graph. Where the file graph has one node per
// file and one edge per import, this has one node per function/method and
// one edge per cross-file call site. Resolution is name-based (no TS type
// checker) so method-name collisions across classes produce low-confidence
// edges rather than disappearing — the renderer surfaces this with
// dashed/faded strokes.

export type CodeflowFunctionKind = 'function' | 'method' | 'arrow' | 'class';

export interface CodeflowFunctionNode {
  id: string;        // `<file>::<name>:<line>` — globally unique
  name: string;      // function/method name (or class name for kind='class')
  file: string;      // project-relative path of the declaring file
  line: number;      // 1-based declaration line
  kind: CodeflowFunctionKind;
  // Exported via `export` keyword or named in an export {…} statement.
  // Imported-then-called counts as cross-file call regardless of this flag,
  // but exposed here for ranking + filtering.
  exported: boolean;
  // Containing class for kind='method'. Empty otherwise.
  className: string | null;
  // Detected architectural layer of the parent file (ui, api, service,
  // util, …). Lets the renderer's "Layer" color mode actually mean
  // something in Functions view — without this every node ended up as
  // 'other' and the canvas was a sea of grey.
  layer: CodeflowLayer;
  // (in + out) cross-file call count, filled after edges are resolved so
  // the renderer can size nodes / filter low-degree ones without
  // re-walking edges.
  degree: number;
}

// Confidence level for a resolved call edge.
//   high = the callee name is unique across the project
//   low  = the callee name has multiple declarations; we picked the most
//          plausible target (or emit edges to every candidate, capped)
export type CodeflowCallConfidence = 'high' | 'low';

export interface CodeflowFunctionEdge {
  source: string;    // caller node id
  target: string;    // callee node id
  count: number;     // number of distinct call sites at this caller→callee
  confidence: CodeflowCallConfidence;
}

export interface CodeflowFunctionGraph {
  nodes: CodeflowFunctionNode[];
  edges: CodeflowFunctionEdge[];
  stats: {
    totalFunctions: number;
    totalEdges: number;
    // How many call sites we saw vs how many turned into edges. Big gap
    // means lots of external/library calls (expected) or unresolved name
    // dispatch (signal to investigate).
    callsSeen: number;
    callsResolved: number;
    confidence: { high: number; low: number };
    truncated: boolean;
    elapsedMs: number;
  };
}

// ─── Codeflow graph (native visualization) ──────────────────────────────────
//
// Native D3 visualization replacing the original iframe approach. The main
// process walks the project, runs a regex-based import extractor, and ships
// a flat graph to the renderer. Renderer paints with d3-force.

export type CodeflowLayer =
  | 'ui'
  | 'api'
  | 'service'
  | 'model'
  | 'util'
  | 'test'
  | 'config'
  | 'tool'
  | 'other';

export interface CodeflowGraphNode {
  id: string;        // project-relative path; doubles as unique key
  name: string;      // basename for label
  folder: string;    // parent dir (or "root")
  ext: string;       // file extension without dot
  layer: CodeflowLayer;
  size: number;      // bytes
  loc: number;       // line count
  degree: number;    // (in + out) edge count
  // ─── Phase 1 (v0.33) static-analysis metadata ───────────────────────────
  // Part of a circular import chain — a Tarjan strongly-connected component
  // of size > 1 (or a self-import). Renderer rings these red.
  inCycle?: boolean;
  // Reachable from a detected entry point by following outgoing import edges.
  // false ⇒ candidate dead code (nothing in the project imports a path here).
  reachable?: boolean;
  // Transitive blast radius. blastIn = how many files would be affected if
  // this file changes (transitive dependents). blastOut = how many files this
  // pulls in (transitive dependencies). Both omitted when the graph exceeds
  // the blast cap — renderer falls back to degree shading + interactive
  // (per-click) blast highlighting, and stats.blastSkipped is set.
  blastIn?: number;
  blastOut?: number;
  // ─── Phase 2 (v0.34) git-intelligence metadata ──────────────────────────
  // Commit frequency over the analysis window (default 90 days). Higher =
  // hotspot. All git fields omitted when the project isn't a git repo or git
  // is unavailable — renderer falls back gracefully (no churn color mode).
  churn?: number;          // commits touching this file in the window
  churnAdds?: number;      // lines added across those commits (numstat sum)
  churnDels?: number;      // lines deleted across those commits
  // Code ownership over the window.
  topOwner?: string;       // author name with the most commits touching this file
  ownerShare?: number;     // 0..1 — topOwner's share of commits touching this file
  authorCount?: number;    // distinct authors touching this file in the window
}

// How an edge was discovered.
//   import   — static AST/regex analysis of import/require/from/include
//   event    — Claude inferred event-bus or pub/sub coupling
//   plugin   — Claude inferred plugin/loader registration
//   config   — Claude inferred config-driven coupling
//   dynamic  — Claude inferred dynamic dispatch / DI / reflection
//   inferred — Claude inferred relation that doesn't fit a tighter bucket
export type CodeflowEdgeKind =
  | 'import'
  | 'event'
  | 'plugin'
  | 'config'
  | 'dynamic'
  | 'inferred';

export interface CodeflowGraphEdge {
  source: string;    // node id
  target: string;    // node id
  weight: number;    // distinct refs (imports for static, salience for inferred)
  kind: CodeflowEdgeKind;
  // Free-form one-liner from Claude when kind !== 'import'.
  reason?: string;
}

export interface CodeflowGraph {
  nodes: CodeflowGraphNode[];
  edges: CodeflowGraphEdge[];
  stats: {
    totalFiles: number;
    totalLines: number;
    totalEdges: number;
    // Sorted desc by count.
    languages: Array<{ ext: string; count: number; pct: number }>;
    // True when the walk hit HARD_FILE_LIMIT — graph is a truncated subset.
    truncated: boolean;
    elapsedMs: number;
    // How many import specifiers the parser saw (across all files) and how
    // many of them resolved to a node we walked. The ratio is the most
    // useful diagnostic when the user reports "no edges" — a low ratio means
    // alias config is wrong; a low parsed count means the AST extractor never
    // ran (e.g. typescript module didn't load).
    importsParsed: number;
    importsResolved: number;
    aliasCount: number;
    // sha256 over node ids (sorted, joined). Used to invalidate cached
    // soft-edge augments — when the structure changes enough that node ids
    // no longer match, the saved augment is dropped instead of pointing at
    // ghost files.
    fingerprint: string;
    // ─── Phase 1 (v0.33) additions — optional so older persisted graphs and
    // the function-graph path still satisfy the type ──────────────────────
    // Circular import chains. Each entry is the ordered node ids of one
    // strongly-connected component of size > 1 (or a single self-importing id).
    cycles?: string[][];
    // Count of nodes with reachable === false.
    deadCodeCount?: number;
    // Node ids treated as reachability roots: package.json main/module/bin,
    // root-level index/main/app entries, plus any node with zero incoming
    // import edges (a source nothing else pulls in).
    entryPoints?: string[];
    // True when nodes.length exceeded the blast cap so blastIn/blastOut were
    // skipped for performance — lets the renderer explain why blast shading is
    // unavailable instead of painting everything flat.
    blastSkipped?: boolean;
    // ─── Phase 2 (v0.34) git intelligence ──────────────────────────────────
    // True when churn/ownership data was computed (project is a git repo and
    // `git log` succeeded). false/undefined ⇒ churn color mode is unavailable.
    gitAnalyzed?: boolean;
    // Window the churn/ownership pass covered, in days (default 90).
    churnWindowDays?: number;
    // Max churn (commit count) across all nodes — renderer normalizes the
    // churn heatmap against this.
    maxChurn?: number;
  };
}

// Live-sync push payload (v0.33). Emitted on CODEFLOW_GRAPH_UPDATED whenever a
// subscribed project's watched files change (debounced) or a manual rebuild
// completes. The renderer patches its in-place graph state from this.
export interface CodeflowGraphUpdate {
  projectPath: string;
  graph: CodeflowGraph;
  // 'watch' = a filesystem change triggered the rebuild; 'manual' = explicit
  // subscribe / rebuild. Lets the renderer choose whether to animate the diff.
  reason: 'watch' | 'manual';
}

// ─── Memory system (v0.19) ─────────────────────────────────────────────────
//
// Persistent per-project + global memory stored under ~/.devspace/. Markdown
// is the source of truth (open in Obsidian/VS Code); an in-memory inverted
// index gives sub-100ms FTS across all projects. MemPalace integration is
// opt-in sync, not a hard runtime dep — DevSpace owns its store.
//
// Storage layout:
//   ~/.devspace/
//     projects/<sha1-of-abspath>/
//       manifest.json              {path, name, lastAccessedAt}
//       memory/MEMORY.md           index, like auto-memory
//       memory/<type>_<slug>.md    individual entries
//       diary/YYYY-MM-DD.md        chronological diary
//       pinned.json                ["slug-1", "slug-2"]
//     global/
//       MEMORY.md + <type>_<slug>.md   user-wide memories
//     settings.json                {autoCapture, mempalaceSync, ...}
//
// `id` is `<scope>/<slug>` (e.g. "project:abc123/feedback_no-mocks" or
// "global/user_role"). slugs are kebab-case, ASCII, ≤ 80 chars.

// 'lesson' and 'workflow' (sub-project 3: native learning) are produced by
// DistillationService — durable insights distilled from recent activity by
// real Claude. 'feedback' doubles as the "preference" learning type (it
// already feeds the inject preamble), so distilled preferences reuse it
// rather than adding a third learning type.
export type MemoryType =
  | 'user'
  | 'feedback'
  | 'project'
  | 'reference'
  | 'lesson'
  | 'workflow';

export type MemoryScope = 'project' | 'global';

export interface MemoryEntry {
  // Stable id of the form `<scopeKey>/<slug>` where scopeKey is `global` or
  // `project:<projectHash>`. Used as the React key + dedupe identity.
  id: string;
  scope: MemoryScope;
  // For project scope, the SHA-1 of the abspath (`crypto.createHash('sha1')`).
  // Empty string for global.
  projectHash: string;
  type: MemoryType;
  slug: string;
  // Single-line summary from frontmatter `description:`.
  description: string;
  // Full markdown body (frontmatter + content). Loaded lazily by the
  // dashboard; the index keeps a truncated preview only.
  body?: string;
  // Optional tags from frontmatter `tags: [a, b]`. Lowercased on parse.
  tags: string[];
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  // Wikilinks `[[other-slug]]` discovered in body. Resolved at search time
  // against the index — missing targets are kept as dangling strings.
  links: string[];
  // First 280 chars of body for preview cards.
  preview: string;
}

export interface DiaryEntry {
  // YYYY-MM-DD
  date: string;
  scope: MemoryScope;
  projectHash: string;
  body: string;
  // Word count for stats.
  wordCount: number;
  updatedAt: number;
}

export interface MemoryProject {
  hash: string;
  path: string;
  name: string;
  lastAccessedAt: number;
  // How many memory entries this project has (across types).
  memoryCount: number;
  // How many diary entries.
  diaryCount: number;
  // False when the manifest's `path` no longer exists on disk (e.g. an
  // earlier session worked inside a temp dir, or the user moved the
  // project). Ghosts stay in the list so users can find leftover
  // memories, but the dashboard renders them dimmed and routes them
  // through `pruneGhostProjects` for deletion.
  pathExists: boolean;
}

export interface MemoryInboxItem {
  // Stable id for dedup across capture batches. Hash of (thread+turn+content).
  id: string;
  // Source thread (so dashboard can deep-link).
  threadId: string;
  projectHash: string;
  // Suggested type — user can change on accept.
  suggestedType: MemoryType;
  suggestedSlug: string;
  suggestedDescription: string;
  body: string;
  // Why the auto-capture flagged this — drives the explanation chip.
  signal: 'correction' | 'confirmation' | 'decision' | 'named-entity' | 'manual';
  createdAt: number;
}

export interface MemorySearchHit {
  entry: MemoryEntry;
  // Match score (higher = better).
  score: number;
  // Which fields matched — drives the highlight chip in dashboard. 'semantic'
  // means the hit came from the vector (cosine) index rather than a literal
  // keyword/substring match (sub-project 2: native semantic search).
  matchedFields: Array<'slug' | 'description' | 'body' | 'tags' | 'semantic'>;
}

export interface MemoryStats {
  totalProjects: number;
  totalMemories: number;
  totalDiaryDays: number;
  // Day-streak: consecutive days with at least one diary entry, ending today.
  diaryStreak: number;
  // Top tags by count, capped to 12.
  topTags: Array<{ tag: string; count: number }>;
}

export interface MemorySettings {
  // Master switch — when false, capture/recall both no-op.
  enabled: boolean;
  // Auto-capture mode. 'smart' = capture only when signal detected
  // (correction/confirmation/decision/named-entity). 'manual' = only via
  // /remember or right-click. 'off' = disabled (entries still surface via
  // recall, just no new ones land in inbox).
  autoCapture: 'smart' | 'manual' | 'off';
  // Whether to auto-inject MEMORY.md into Claude system prompt on new
  // threads. Bounded by `maxInjectLines`.
  injectOnNewThread: boolean;
  maxInjectLines: number;
  // MemPalace MCP sync — opt-in. When true, memories tagged with
  // `[mempalace]` get pushed to MemPalace via the MCP server. Pure one-way
  // push for now (no pull-back).
  mempalaceSyncEnabled: boolean;
}

export interface MemoryEvent {
  kind:
    | 'entry_created'
    | 'entry_updated'
    | 'entry_deleted'
    | 'inbox_added'
    | 'inbox_resolved'
    | 'diary_updated'
    | 'index_rebuilt'
    | 'project_list_changed';
  // The affected entry/inbox-item/thread id, when applicable.
  targetId?: string;
  // The scope key (`global` or `project:<hash>`) the event belongs to.
  scopeKey?: string;
  ts: number;
}

// ─── Forge (v0.24) ──────────────────────────────────────────────────────────
//
// Self-evolving skill/agent workshop. Lets the user (or Claude on their
// behalf) generate new SKILL.md / agent .md files tailored to the current
// project, track how often each skill is invoked, and roll up an aggregate
// rating from a mix of explicit thumbs and implicit chat signals.
//
// Storage:
//   <project>/.devspace/forge/
//     drafts/         WIP skills/agents not yet committed to .claude/
//     stats.json      uses + outcomes per slug
//     suggestions.json auto-suggest inbox
//
// Stats key = `<scope>:<kind>:<slug>` (e.g. `project:skill:refactor-css`).
// That key is stable across rename/move; if a skill is deleted, we keep
// the stats row tagged `removed: true` for 30d so user can see what they
// archived.

export type ForgeKind = 'skill' | 'agent';

export type ForgeScope = 'project' | 'global';

// Generation lifecycle. Drafts can be saved to .claude/ once `ready`.
export type ForgeDraftStatus = 'pending' | 'generating' | 'ready' | 'error';

export interface ForgeDraft {
  // Stable id (uuid). React key + storage filename.
  id: string;
  kind: ForgeKind;
  scope: ForgeScope;
  projectPath: string;
  // User-provided one-line brief that seeded generation.
  brief: string;
  // Slug user picked (or generated). Will become directory name on save.
  slug: string;
  // Streamed chat turns from the generator run.
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    ts: number;
  }>;
  // Final SKILL.md / agent.md body — separate from chat because we save
  // exactly this, not the full transcript.
  body: string;
  // Frontmatter that will be merged on save.
  frontmatter: {
    name: string;
    description: string;
    [key: string]: unknown;
  };
  status: ForgeDraftStatus;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ForgeStats {
  // Same keying as the map ("<scope>:<kind>:<slug>").
  key: string;
  scope: ForgeScope;
  kind: ForgeKind;
  slug: string;
  // Where the artifact lives on disk (absolute). Null if removed.
  path: string | null;
  uses: number;
  lastUsedAt: number | null;
  // Counts of each outcome signal. Aggregated rating = useful / (uses or 1).
  useful: number;
  ignored: number;
  harmful: number;
  // Tracks explicit user thumbs separately so we can show "explicit ratings:
  // 4" vs implicit signal-only counts.
  explicit: { up: number; down: number };
  // True when the underlying file is gone; row kept for grace window.
  removed: boolean;
  // Soft-archive grace window — stats GC drops the row after this.
  archivedAt: number | null;
  createdAt: number;
}

export type ForgeSignal = 'thanks' | 'correction' | 'abandoned' | 'commit' | 'explicit-up' | 'explicit-down';

export interface ForgeUseEvent {
  // Stable id (uuid). React key.
  id: string;
  key: string; // matches ForgeStats.key
  threadId: string;
  // Which Claude turn (assistant message id) this use was attributed to.
  messageId: string;
  ts: number;
  // Implicit + explicit signal tags applied to this use. Multiple OK.
  signals: ForgeSignal[];
  // Free-form note user typed when applying explicit thumbs.
  note?: string;
}

export interface ForgeSuggestion {
  id: string;
  projectPath: string;
  // What pattern fired this suggestion.
  reason:
    | 'repeated-question'
    | 'repeated-agent-dispatch'
    | 'repeated-files'
    | 'repeated-boilerplate'
    | 'project-stack-match'; // capability D discover
  suggestedKind: ForgeKind;
  suggestedSlug: string;
  suggestedBrief: string;
  // Evidence — thread ids / phrases / file paths the detector saw.
  evidence: string[];
  createdAt: number;
}

export interface ForgeCatalogItem {
  // Curated stack-match item bundled with the app. Source = the existing
  // `resources/builtin-packs/skills/<slug>/SKILL.md` registry.
  slug: string;
  kind: ForgeKind;
  name: string;
  description: string;
  // Which detected stack signals match this item ("vitest", "tailwind", …).
  // Discover banner uses these to score relevance against ProjectProfile.
  matches: string[];
  builtinPath: string;
}

export interface ForgeSettings {
  enabled: boolean;
  // Auto-suggest mode mirrors memory autoCapture.
  autoSuggest: 'smart' | 'manual' | 'off';
  // Implicit signal sources. Each can be toggled off if user wants.
  implicitThanks: boolean;
  implicitCorrection: boolean;
  implicitAbandoned: boolean;
  // Show Discover banner on project first-open.
  showDiscoverBanner: boolean;
  // Max suggestions per day so we don't spam the inbox.
  maxSuggestionsPerDay: number;
}

export interface ForgeEvent {
  kind:
    | 'draft_created'
    | 'draft_updated'
    | 'draft_streaming'
    | 'draft_ready'
    | 'draft_error'
    | 'draft_saved'
    | 'draft_deleted'
    | 'stats_updated'
    | 'suggestion_added'
    | 'suggestion_dismissed';
  projectPath?: string;
  draftId?: string;
  key?: string;
  suggestionId?: string;
  // For draft_streaming events: append-this-text-to-last-assistant-msg.
  delta?: string;
  ts: number;
}

// --- v2 worktree-isolated agent tasks ---
// A Task runs an agent in its own git worktree + branch. Flat, top-level,
// cross-workspace (keyed only by sourceRepoPath, not a project id).
export type TaskStatus =
  | 'setting-up' // worktree being created
  | 'running' // agent session live
  | 'awaiting-review' // session idle and a diff exists
  | 'integrating' // merge/PR in flight
  | 'done' // merged or PR'd, worktree removed
  | 'discarded'
  | 'error';

export interface Task {
  id: string;
  title: string;
  sourceRepoPath: string; // repo the worktree forks from
  baseBranch: string; // HEAD of sourceRepo at creation time
  branch: string; // devspace/task/<slug>-<id>
  worktreePath: string; // ~/.devspace/worktrees/<id>
  agent: string; // cli/registry adapter id (default 'claude')
  status: TaskStatus;
  // MUST equal what ClaudeCliPane composes for (projectId=id, tabId='agent'),
  // i.e. `<id>:claude-cli:agent`, so the detail pane ATTACHES to the session
  // TaskService pre-launched (tmux new-session -A) instead of spawning a 2nd.
  sessionKey: string;
  createdAt: number;
  error?: string;
}

