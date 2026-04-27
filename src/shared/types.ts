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

