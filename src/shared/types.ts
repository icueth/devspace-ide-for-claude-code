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

// ─── Chat (CLI agents rendered as conversation, not terminal) ───────────────
//
// Spawns `claude --print --output-format stream-json --verbose` per turn,
// parses the JSONL event stream, and emits a normalized event union the
// renderer turns into chat bubbles + tool-use pills. Same infrastructure as
// CodeflowService's runClaude, surfaced through a different IPC channel
// targeted at long-lived per-project chat threads instead of one-shot doc
// generation.
//
// This is a TEST surface in 0.3.32-beta.x — coexists with the existing
// PTY-backed Claude CLI dock so users can pick per-tab: TTY (interactive,
// per-tool approval) or chat (bypass-permissions Yolo, prettier output).

// Line-by-line unified diff preview for a file-mutating tool call. Built
// in main/utils/diffPreview.ts at tool_use time so the renderer can show
// an inline red/green/context diff inside the ToolCard. Kept as a plain
// data shape (not a class) so it round-trips through IPC and JSON
// persistence cleanly. See diffPreview.ts for safety caps.
export type ToolDiffLineKind = 'add' | 'del' | 'ctx';

export interface ToolDiffLine {
  kind: ToolDiffLineKind;
  text: string;
  // 1-based line numbers — `add` rows carry newLine only, `del` rows
  // carry oldLine only, `ctx` rows carry both.
  oldLine?: number;
  newLine?: number;
}

export interface ToolDiffHunk {
  oldStart: number;
  oldLen: number;
  newStart: number;
  newLen: number;
  lines: ToolDiffLine[];
  // Optional caption (e.g. "Edit 2 of 3" for MultiEdit, "cell <id>" for
  // NotebookEdit). Omitted for single-hunk diffs.
  label?: string;
}

export interface ToolDiffPreview {
  path: string;
  hunks: ToolDiffHunk[];
  // True when input lines were clipped at MAX_LINES_PER_SIDE or hunks
  // were clipped at MAX_HUNKS. Renderer shows a "Diff truncated" hint.
  truncated: boolean;
}

// Lifecycle of a single backend → renderer event during a chat turn.
export type ChatEventKind =
  | 'text_delta'      // streaming assistant text
  | 'thinking_delta'  // claude with thinking enabled (rendered collapsed)
  | 'tool_use'        // start of a tool call
  | 'tool_result'     // matching result by toolUseId
  | 'status'          // 'system:init', 'queued', 'running', etc.
  | 'error'           // upstream error or non-zero exit
  | 'usage'           // final usage payload
  | 'done'            // terminal event closing the stream
  // Team-mode lifecycle. Sequential pipelines emit step_start / step_end
  // around each agent's spawn; text_delta and tool_use events between
  // them carry a `stepIndex` so the renderer can route them into the
  // right step block. Orchestrator mode doesn't emit team_step_* — its
  // sub-agent dispatches show up as ordinary tool_use(name="Task") that
  // the renderer renders inline.
  | 'team_step_start'
  | 'team_step_end'
  // Emitted once when claude calls AskUserQuestion. The runtime can't
  // programmatically answer it in --print mode so we early-finalize the
  // turn — the renderer renders the question card and shows "Waiting
  // for your answer" instead of "Working…".
  | 'awaiting_user_answer'
  // v0.24: implicit Forge rating signal observed in the user turn that
  // FOLLOWS an assistant message. Carries `forgeSignal` + the previous
  // assistant message id so the consumer (ChatService) can look up
  // which skills/agents were loaded for that turn.
  | 'forge_signal';

export interface ChatEvent {
  kind: ChatEventKind;
  // text_delta / thinking_delta carry incremental text
  text?: string;
  // tool_use
  toolName?: string;
  toolUseId?: string;
  toolInput?: Record<string, unknown>;
  // tool_use — Cursor-style diff stats for file-mutating tools, computed
  // backend-side so the chip appears live during streaming (not only after
  // a thread reload). Absent for tools that don't touch files.
  diffStats?: {
    additions: number;
    deletions: number;
    path: string;
  };
  // tool_use — line-by-line unified diff for the same tools. Rendered as
  // an inline expandable diff inside the ToolCard. Same caps + path as
  // diffStats. Absent for non-mutating tools and for inputs that exceed
  // the safety caps in main/utils/diffPreview.ts.
  diffPreview?: ToolDiffPreview;
  // tool_result
  toolResult?: string;
  toolIsError?: boolean;
  // status / error
  message?: string;
  // usage
  inputTokens?: number;
  outputTokens?: number;
  // Team mode — index into ChatMessage.teamRun.steps the event targets.
  // When undefined, the event targets the message as a whole (normal /
  // orchestrator modes).
  stepIndex?: number;
  // For team_step_start: which agent slug the step is dispatching to.
  stepAgent?: string;
  // v0.24: forge_signal — the implicit signal kind observed in the
  // following user message (thanks / correction / abandoned).
  forgeSignal?: 'thanks' | 'correction' | 'abandoned';
  // v0.24: forge_signal — id of the prior assistant message the signal
  // refers to. The consumer looks up its `loadedSkillKeys` to fan the
  // signal out to every loaded skill/agent.
  prevAssistantId?: string;
  // Wall-clock ms at which the event was observed in the main process.
  ts: number;
}

// Ordered visual segments of one assistant turn. Each segment renders as
// its own card in the UI. The full sequence preserves the chronological
// order text / tool-use blocks arrived from the model, so a turn that
// reads as "explain → call 3 tools → explain more → call 2 more tools"
// renders as 4 cards in that order instead of a single wall of text
// stacked on top of all tools.
//
// `tool_group` segments only reference tool calls by id — the full tool
// detail lives in ChatMessage.toolCalls[] / TeamStep.toolCalls[] (single
// source of truth, no duplication). Renderer joins them at render time.
//
// Optional for back-compat. Messages persisted before v0.11.0 don't have
// segments[]; renderers fall back to flat `content + toolCalls[]` and
// show the legacy single-bubble layout for those.
export type ChatMessageSegment =
  | { kind: 'text'; id: string; text: string }
  | { kind: 'tool_group'; id: string; toolUseIds: string[] };

// Persisted message. The renderer also keeps an in-memory `streaming`
// shape that mirrors this but with partial text; once the turn completes,
// the streaming view is committed into the chat thread.
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  // Final flattened text after streaming completed. For assistant, also
  // includes everything except thinking blocks. In team mode this stays
  // empty — per-step content lives in teamRun.steps[].content.
  //
  // Note: `content` is the concatenated text across all text-segments,
  // kept in sync for back-compat readers (search, copy-to-clipboard,
  // legacy rendering when `segments` is absent). New code reading the
  // turn should prefer `segments`.
  content: string;
  // Tool use + tool result pairs in order. Renderer renders as collapsible
  // "Reading … (3)" pills.
  toolCalls: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
    result?: string;
    isError?: boolean;
    // Cursor-style additions / deletions for file-mutating tools
    // (Edit, Write, MultiEdit, NotebookEdit). Computed in
    // ChatLineHandler from the tool_use input; null for tools that
    // don't touch the filesystem. `path` is project-relative when
    // possible, absolute otherwise.
    diffStats?: {
      additions: number;
      deletions: number;
      path: string;
    };
    // Inline unified diff for the same set of file-mutating tools.
    // Renderer expands ToolCard to show a red/green/context diff view.
    // Absent for non-mutating tools and when the input exceeds caps.
    diffPreview?: ToolDiffPreview;
  }>;
  // Ordered text / tool_group segments — see ChatMessageSegment. Optional
  // so messages from v0.10.x and earlier still parse cleanly.
  segments?: ChatMessageSegment[];
  thinking?: string;
  createdAt: number;
  // Token usage if the upstream model reported it.
  usage?: { input: number; output: number };
  // Terminal state for the turn — drives the spinner / retry button.
  status: 'streaming' | 'done' | 'error' | 'cancelled';
  error?: string;
  // Set when claude emitted an AskUserQuestion tool_use that DevSpace
  // can't programmatically answer in --print mode. We early-finalize the
  // run so the "Working…" indicator clears and the user sees the
  // "Waiting for your answer" hint instead. The next user message
  // resumes the conversation with full history.
  awaitingUserAnswer?: boolean;
  // Present when this message was produced by a team run (sequential or
  // parallel). Orchestrator mode does NOT set this — the entire run is
  // a single claude turn whose Task tool calls already show up in
  // toolCalls[].
  teamRun?: TeamRun;
  // v0.24: Forge stats keys for every skill/agent loaded into the
  // system prompt when this assistant turn was constructed. Format:
  // `<scope>:<kind>:<slug>` (e.g. 'project:skill:refactor-css'). The
  // implicit signal pipeline reads this off the prior assistant
  // message when the user's next turn matches a thanks/correction/
  // abandoned heuristic — every loaded skill gets its counter bumped.
  // Optional + back-compat: turns persisted before v0.24 omit it.
  loadedSkillKeys?: string[];
}

// Snapshot of a team execution attached to one assistant message. Each
// step mirrors a regular ChatMessage's content/toolCalls but scoped to
// the agent that produced it. The renderer treats this as the source of
// truth and ignores message.content when teamRun is present.
export interface TeamRun {
  teamId: string;
  teamName: string;
  mode: TeamMode;
  steps: TeamStep[];
}

export interface TeamStep {
  agentSlug: string;
  // Frozen at run start so the renderer can show the agent name even if
  // the agent file gets renamed / deleted while the run is in flight.
  agentName: string;
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  content: string;
  toolCalls: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
    result?: string;
    isError?: boolean;
    diffStats?: {
      additions: number;
      deletions: number;
      path: string;
    };
    // Inline unified diff for the same set of file-mutating tools.
    // Renderer expands ToolCard to show a red/green/context diff view.
    // Absent for non-mutating tools and when the input exceeds caps.
    diffPreview?: ToolDiffPreview;
  }>;
  // Same chronological segmentation as ChatMessage.segments — present
  // for v0.11+ runs, absent for legacy steps where the renderer falls
  // back to flat content+toolCalls.
  segments?: ChatMessageSegment[];
  thinking?: string;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  usage?: { input: number; output: number };
}

export interface ChatThread {
  id: string;
  projectId: string;
  title: string;       // first user-message prefix or user-chosen
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  // Per-thread config override. When unset, the project-level default
  // from .devspace/chat-config.json is used. Lets the user pin a
  // different model / system prompt / tool set to a specific thread.
  config?: ChatConfig;
  // Set while a tmux-backed run is in flight for this thread. Persists
  // across app restarts so on next boot ChatService can re-attach its
  // watcher to the still-running tmux session and continue streaming
  // events into the assistant message. Cleared when the run terminates
  // (done / error / cancelled).
  activeRun?: ChatActiveRun;
  // v0.19: set true after the project's memory preamble has been
  // injected into a turn on this thread. Inject is one-shot per thread
  // (not per turn) so a user can resume a long thread without the
  // memory file getting tacked on every send. Set explicitly rather
  // than inferred from messages.length so retries / errors don't cause
  // double-inject or skipped-inject edge cases.
  memoryInjected?: boolean;
}

// Metadata describing an in-flight chat run that was spawned inside a
// detached tmux session. Persisted on disk so the watcher can resume
// after an app restart — without this, closing the app would orphan the
// tmux session (still running, still writing to disk) but the renderer
// would have no way to find it again.
export interface ChatActiveRun {
  // Stable identifier (timestamp + randomness) — also the leaf dirname
  // for runDir and a component of sessionName.
  runId: string;
  // Tmux session name. `tmux has-session -t <sessionName>` is how the
  // watcher decides whether the run is still alive.
  sessionName: string;
  // Absolute path to the per-run directory holding prompt.txt /
  // out.jsonl / stderr.log / done. Reading out.jsonl from offset 0 is
  // sufficient to reconstruct the assistant's output on resume.
  runDir: string;
  // ms-epoch when the run was spawned. Used for stale-run cleanup
  // heuristics (e.g. a run that's been "active" for >24h is almost
  // certainly an orphaned record from a crash).
  startedAt: number;
  // id of the assistant ChatMessage whose state is being filled by this
  // run. Solo runs target message.content / message.toolCalls; team
  // runs target one step inside message.teamRun.steps.
  assistantMessageId: string;
  // 'solo'      — single claude --print spawn
  // 'team-step' — one step inside a sequential pipeline. stepIndex is
  //               required and points into message.teamRun.steps. After
  //               this step finishes successfully on resume, the
  //               pipeline does NOT continue past it (the post-restart
  //               continuation is intentionally minimal — user can
  //               always resend if they want more steps).
  kind: 'solo' | 'team-step';
  stepIndex?: number;
}

// Chat-time configuration applied to the claude --print spawn. Every
// field is optional: undefined / empty means "let claude use its own
// default" (i.e. the flag isn't passed). Persisted at the project level
// in `<projectRoot>/.devspace/chat-config.json` and optionally per-thread
// inside ChatThread.config.
export interface ChatConfig {
  // Maps to `--model <id>`. Accepts the alias (`sonnet`, `opus`, `haiku`)
  // or a fully-qualified model id like `claude-sonnet-4-5`.
  model?: string;
  // Maps to `--append-system-prompt "..."`. Preserves Claude's built-in
  // system prompt and tacks ours on the end (vs. `--system-prompt` which
  // replaces it wholesale — too disruptive for everyday use).
  systemPromptAppend?: string;
  // Maps to `--allowed-tools "Read,Edit,Bash,…"`. Empty / undefined = all
  // tools allowed. Non-empty list = ONLY these tools are usable.
  allowedTools?: string[];
  // Maps to `--disallowed-tools "Bash"`. Subtractive layer on top of the
  // allow-list. Use to block a specific dangerous tool without re-listing
  // every other tool in `allowedTools`.
  disallowedTools?: string[];
  // Escape hatch for power users — raw CLI tokens appended verbatim at
  // the end of the args array. Each entry is one shell token, so a flag
  // and its value are two entries: ['--max-turns', '20'].
  extraArgs?: string[];
}

export interface ChatSendRequest {
  projectId: string;
  threadId: string;
  // Just the new user text — backend appends history from the persisted
  // thread before spawning the agent.
  text: string;
  // Optional override of which agent to use for this turn — for now
  // always 'claude'; the adapter table is the seam for future codex /
  // gemini / etc. backends.
  agent?: 'claude';
  // Per-turn config override. Highest precedence: turn > thread > project
  // default. Mostly unused by the UI today (the gear drawer writes to
  // project or thread config); reserved for slash-palette commands like
  // `/model X` that swap a single turn without persisting.
  config?: ChatConfig;
  // When set, the turn runs in team mode using this team's config from
  // <projectRoot>/.devspace/teams.json. Behavior depends on team.mode:
  //   • orchestrator — single claude turn with system prompt instructing
  //     claude to dispatch to listed agents via the Task tool
  //   • sequential   — N claude spawns chained, each step's output
  //     feeding the next step's prompt as context
  //   • parallel     — (not implemented in this pass)
  teamId?: string;
}

// ─── Teams (multi-agent workflows) ──────────────────────────────────────────
//
// A team coordinates multiple sub-agents to handle one user task.
// Stored at <projectRoot>/.devspace/teams.json so teams are per-project
// (different repos want different review squads).
//
// Three execution modes:
//   • orchestrator — claude itself decides who to call via the Task tool
//   • sequential   — DevSpace runs each member in order, piping outputs
//   • parallel     — DevSpace fans out, then runs an aggregator pass
//
// Members reference agent files by slug. The agent's frontmatter
// (description, model, tools) is read at turn time so renaming an agent
// or changing its model is picked up automatically.

export type TeamMode = 'orchestrator' | 'sequential' | 'parallel';
export type TeamScope = 'global' | 'project';

export interface TeamMember {
  // Matches AgentDef.slug — the basename of <slug>.md in ~/.claude/agents/.
  agentSlug: string;
  // Optional per-member model override (otherwise uses the agent's own
  // frontmatter, otherwise claude's default).
  modelOverride?: string;
}

export interface TeamDef {
  id: string;
  name: string;
  mode: TeamMode;
  members: TeamMember[];
  // Parallel only — slug of the member that produces the final merged
  // summary. Falls back to the first member when unset.
  aggregatorSlug?: string;
  // Computed at read time from which file the team lives in. NOT
  // persisted in JSON — set by TeamsService.listTeams so the renderer
  // can render scope badges without an extra round-trip.
  //   • 'global'  — ~/.devspace/teams.json (available to every project)
  //   • 'project' — <projectPath>/.devspace/teams.json (this repo only)
  scope?: TeamScope;
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

export interface SkillDef {
  path: string;          // absolute path to SKILL.md
  scope: SkillScope;
  slug: string;          // folder name
  name: string;
  description: string;
  model?: string;
  allowedTools?: string[];
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
  kind: 'claude-cli' | 'shell' | 'other';
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
// Each project gets its own analysis stored under `.devspace/codeflow/`.
// Cache survives across sessions; freshness is judged by per-file content
// hashes so renames-without-edit and edits-then-revert don't trigger Claude.

export type CodeflowStage =
  | 'idle'         // No job running
  | 'walking'      // Listing files + computing hashes
  | 'overview'     // Claude generating codebase.md (architecture overview)
  | 'flows'        // Claude generating per-feature flow-*.md docs
  | 'done'
  | 'cancelled'
  | 'error';

export interface CodeflowDoc {
  // Filename inside .devspace/codeflow/, e.g. "codebase.md", "flow-auth.md".
  name: string;
  // Absolute path on disk so the renderer can pass it to api.fs.readFile.
  path: string;
  // Modified time (ms) — lets the renderer auto-refresh open docs.
  mtime: number;
  size: number;
}

export interface CodeflowCacheMeta {
  // Project root that this cache belongs to. Stored so renderer can detect
  // a stale tab pointing at the wrong project.
  projectPath: string;
  // When the analysis last completed (ms epoch).
  lastAnalyzedAt: number;
  // Total files scanned at last analysis.
  fileCount: number;
  // SHA-256 over all (relPath, contentHash) pairs sorted, used to short-
  // circuit re-runs when nothing actually changed.
  fingerprint: string;
}

export interface CodeflowStatus {
  stage: CodeflowStage;
  // 0..1 — best-effort, may stay at 0 during indeterminate stages.
  progress: number;
  // Free-form line shown under the progress bar.
  message: string;
  // Surfaced after stage === 'error' so the UI can show a retry hint.
  error: string | null;
  // Snapshot of cache metadata if the project has been analyzed before.
  cache: CodeflowCacheMeta | null;
  // True when FileWatcher has observed changes since the cache was written.
  // The renderer shows a "Re-analyze" badge based on this.
  stale: boolean;
  docs: CodeflowDoc[];
}

export interface CodeflowAnalyzeOptions {
  // When true, ignore cache and re-run every stage. Defaults to false; the
  // service will short-circuit unchanged files even on a "fresh" run.
  force?: boolean;
}

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
  };
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
//       manifest.json              {path, name, lastAccessedAt, threadCount}
//       memory/MEMORY.md           index, like auto-memory
//       memory/<type>_<slug>.md    individual entries
//       threads/<thread-id>.md     thread summaries (not raw transcripts)
//       diary/YYYY-MM-DD.md        chronological diary
//       pinned.json                ["slug-1", "slug-2"]
//     global/
//       MEMORY.md + <type>_<slug>.md   user-wide memories
//     settings.json                {autoCapture, mempalaceSync, ...}
//
// `id` is `<scope>/<slug>` (e.g. "project:abc123/feedback_no-mocks" or
// "global/user_role"). slugs are kebab-case, ASCII, ≤ 80 chars.

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

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

export interface ThreadSummary {
  threadId: string;
  projectHash: string;
  // Human-readable title (first user message or model-derived).
  title: string;
  // 1-3 sentence summary of what happened in the thread.
  summary: string;
  // Decisions/learnings the auto-capture flagged.
  highlights: string[];
  createdAt: number;
  updatedAt: number;
}

export interface MemoryProject {
  hash: string;
  path: string;
  name: string;
  lastAccessedAt: number;
  // How many memory entries this project has (across types).
  memoryCount: number;
  // How many thread summaries.
  threadCount: number;
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
  // Which fields matched — drives the highlight chip in dashboard.
  matchedFields: Array<'slug' | 'description' | 'body' | 'tags'>;
}

export interface MemoryStats {
  totalProjects: number;
  totalMemories: number;
  totalThreads: number;
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
    | 'thread_summarized'
    | 'index_rebuilt'
    | 'project_list_changed';
  // The affected entry/inbox-item/thread id, when applicable.
  targetId?: string;
  // The scope key (`global` or `project:<hash>`) the event belongs to.
  scopeKey?: string;
  ts: number;
}

// ─── Devlog (v0.24) ─────────────────────────────────────────────────────────
//
// Per-project work log stored under `<project>/.devspace/devlog/`. Tracks
// plans (user intent), agents (Task tool dispatches + outcomes), results
// (release/feature completions), and a daily append-only log. Source of
// truth = markdown files; we don't index in SQLite (FTS-on-disk on demand).
//
// All file IO goes through DevlogService — never write `.devspace/devlog/*`
// directly. Service enforces:
//   - filename validation (YYYY-MM-DD-<slug>.md, slug = ascii kebab ≤ 80c)
//   - retention caps (log ≤ 90d, agents ≤ 60d, plans+results forever)
//   - INDEX.md regen on every mutation
//
// Auto-capture writes 1 `agents/` entry per `Task(...)` tool_use that
// completes, with verdict derived from `is_error` on the tool_result.

export type DevlogEntryType = 'plan' | 'agent' | 'result' | 'log';

export type DevlogPlanStatus = 'in_progress' | 'done' | 'abandoned';

export type DevlogVerdict = 'success' | 'partial' | 'failed';

export interface DevlogEntry {
  // Stable id `<type>/<filename-without-ext>` for React keys + dedup.
  id: string;
  type: DevlogEntryType;
  projectPath: string;
  // Filename relative to the type dir, e.g. `2026-05-18-design-tier1.md`.
  // Source of truth; everything else is derived from frontmatter.
  filename: string;
  // Display title (frontmatter `title:` or filename slug).
  title: string;
  createdAt: number;
  updatedAt: number;
  // Markdown body — loaded lazily by Dashboard. Index keeps `preview` only.
  body?: string;
  preview: string;
  // Plan-only fields.
  status?: DevlogPlanStatus;
  // Agent-only fields. `subagentType` matches the `subagent_type` param of
  // the Task tool — never trust unknown values from disk.
  subagentType?: string;
  durationMs?: number;
  verdict?: DevlogVerdict;
  // Files the agent touched (extracted from tool result, capped 50).
  filesTouched?: string[];
  // Cross-links — wiki-style `[[name]]` rendered as clickable in dashboard,
  // resolved against the same project's index. Missing targets stay as
  // dangling strings (just like memory entries).
  links: string[];
  // Cross-version tracking (result only). e.g. "0.24.0".
  version?: string;
  // For result entries — quick stats badge in timeline.
  diffStats?: { files: number; additions: number; deletions: number };
  testsPassing?: number;
  // Linked entry ids (plan ↔ agents ↔ result). Populated by the service
  // when wiki-links are resolved.
  linkedPlanIds?: string[];
  linkedAgentIds?: string[];
  linkedResultIds?: string[];
  // Source thread (when auto-captured from chat).
  threadId?: string;
  toolUseId?: string;
}

export interface DevlogIndex {
  projectPath: string;
  entries: DevlogEntry[];
  // INDEX.md regen timestamp.
  generatedAt: number;
}

export interface DevlogSettings {
  enabled: boolean;
  // Auto-capture Task() dispatches → agent entries. ON by default.
  autoCaptureAgents: boolean;
  // Auto-capture release commits (chore(release): X.Y.Z) → result entries.
  // Wired in v0.25; flag exists in 0.24 for forward-compat.
  autoCaptureReleases: boolean;
  // Inject latest N devlog entries into chat system prompt on new threads.
  // Bounded by `maxInjectLines`.
  injectOnNewThread: boolean;
  maxInjectEntries: number;
  maxInjectLines: number;
  // Commit devlog dir to repo (default OFF — added to .gitignore).
  commitToRepo: boolean;
  // Retention (days). 0 = forever.
  logRetentionDays: number;
  agentRetentionDays: number;
}

export interface DevlogEvent {
  kind:
    | 'entry_created'
    | 'entry_updated'
    | 'entry_deleted'
    | 'index_rebuilt';
  projectPath: string;
  entryId?: string;
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
  // Streamed chat turns from the generator run. Mirror DesignMessage shape.
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

