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

export type PtySessionKind = 'claude-cli' | 'shell' | 'agent';

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

