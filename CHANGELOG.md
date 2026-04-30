# Changelog

All notable changes to DevSpace are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.3.19] — 2026-04-30

### Added
- **`Cmd+N` — new file shortcut.** Prompts for a filename (relative to the
  active project root, supports nested paths like `src/components/Foo.tsx`),
  creates the file on disk, and opens it as a new editor tab in one step.
  Cmd+Shift+N stays bound to the menu's "New Window" role.

### Changed
- **Codeflow now writes directly to `.claude/codeflow/`.** Previously the
  Claude headless harness blocked all writes to `.claude/` as a sensitive
  directory — even with `--permission-mode acceptEdits` and explicit allow
  rules in `.claude/settings.local.json`. Switched to
  `--dangerously-skip-permissions` (the only mode that gets past the
  hardcoded sensitive-dir block) coupled with a tightly scoped
  `--allowed-tools Read Glob Grep Write Edit` so even with permission
  checks off the blast radius is contained — no Bash, no WebFetch, no
  network.
- Switched the tool-allow flag from camelCase `--allowedTools` to kebab-case
  `--allowed-tools`. The camelCase form is silently ignored by recent
  claude versions, which is why earlier runs still let Claude reach for
  `Bash` despite our restriction.
- **AST-based import extraction.** JS/TS family files now parse through
  the TypeScript Compiler API (`ts.createSourceFile` + visitor) instead of
  regex. Catches dynamic `import('./literal')`, type-only imports, JSX-tag
  imports, re-exports, `import x = require('y')`, and CommonJS `require()`
  with no false positives from comment strings. Python and other languages
  keep regex extraction.
- **tsconfig path-alias resolution.** Codeflow reads
  `compilerOptions.paths` from `tsconfig.json` (and friends) plus
  `resolve.alias` from `vite.config.*` / `electron.vite.config.*` so
  imports like `@renderer/foo` and `@/components/bar` resolve to the
  actual files instead of being treated as external. DevSpace's own graph
  drops from "scattered dots" to a fully-connected web because of this fix.
- **Soft-edge persistence.** After *Augment with Claude*, soft edges are
  saved to `.claude/codeflow/augment.json` keyed by graph fingerprint and
  auto-restored on the next graph build. Reopening the project no longer
  forces a re-augment.
- **Diagnostic stats.** The graph footer now shows
  `N aliases · imports M parsed / K resolved` so an empty graph is
  debuggable without DevTools — low parsed = AST didn't run, low
  resolved/parsed ratio = alias config is wrong.
- **Color-mode toggle is instant.** Switching Layer ↔ Folder now smooth-
  transitions node colors in place instead of tearing down and rebuilding
  the d3 simulation, so the layout no longer jumps when you re-color.
- **`.run.log` debug artifact.** Every Claude run drops
  `.claude/codeflow/.run.log` with exit code, tool-call count, captured
  stream-json events, stderr, and final result text. When a generation
  produces no docs, this one file says exactly why.

### Fixed
- Sidebar file tree now refreshes in realtime on changes inside `.claude/`
  and `.devspace/` again — an earlier defensive `IGNORED` rule had hidden
  freshly-generated codeflow docs from the watcher. Chokidar's existing
  150ms debounce already collapses codeflow's ~10-file write cycle into a
  single flush event, so the IGNORED rule was solving a problem we didn't
  have at the cost of a real one.

## [0.3.18] — 2026-04-30

### Added
- **Codeflow tab.** New `Codeflow` button in the header bar opens a project-
  scoped tab with two complementary views in one tab strip:
  - **Visualization** — embedded
    [`codeflow`](https://github.com/braedonsaunders/codeflow) single-file
    React app, auto-loaded with the active project's files via a synthetic
    `FileSystemDirectoryHandle` bridge so the user never has to pick a
    folder. The GitHub-URL/Auth/Analyze input row is hidden to avoid
    clutter; everything else (Open Folder, sidebar, theme, export) stays.
    *Reload viz* in the toolbar refreshes the graph after edits.
  - **Codebase / flow-* tabs** — `claude --print` runs headless against the
    project (prompt fed via stdin, `--output-format stream-json --verbose`
    for live activity events, `--permission-mode acceptEdits`, tools
    `Read,Glob,Grep,Write,Edit`). A two-stage pipeline writes
    `codebase.md` (architecture overview) and `flow-<slug>.md` per major
    user-facing feature. Inline Markdown preview, tabs auto-pretty their
    names (e.g. `flow-auth.md` → `Auth`).
- **Live activity line.** During a Claude run a monospace `<%>  <action>`
  line shows what tool Claude just invoked (`📖 Reading src/foo.ts`,
  `🔍 Grep "..."`, `✍️ Writing flow-billing.md`) so the progress bar's
  movement is no longer a mystery — the % is driven by the tool-call count
  (`1 - exp(-n/25)` curve) per stage band.
- **Claude Code integration via `.claude/`.** Generated docs land in
  `<project>/.claude/codeflow/` so Claude Code running in the same project
  sees them automatically. Each successful run also:
  - Updates `.claude/CLAUDE.md` with a guarded
    `<!-- BEGIN devspace-codeflow -->` block pointing at the docs (file is
    created if missing, the block is replaced in place on subsequent runs;
    the rest of CLAUDE.md is left untouched).
  - Writes a project-scoped skill at
    `.claude/skills/codeflow-context/SKILL.md` so Claude reads
    `codebase.md` / `flow-*.md` *before* answering architecture or flow
    questions, instead of guessing.
- **Incremental cache + auto-stale detection.** Each analysis stores a
  fingerprint of (relPath, size, mtime) tuples for every code file. Re-runs
  short-circuit when the fingerprint matches; FileWatcher events flip the tab
  to *Out of date* with a one-click *Re-analyze* button. *Force* button
  ignores the fingerprint for a full rebuild.
- New `CodeflowService` (main) + `codeflow:*` IPC channels (get-status,
  analyze, cancel, read-doc, list-docs, open-dir, progress stream). Cancel
  sends SIGTERM to the live `claude` child so the user can bail mid-run.
- New shared types `CodeflowStage`, `CodeflowStatus`, `CodeflowDoc`,
  `CodeflowCacheMeta`, `CodeflowAnalyzeOptions`.
- New `EditorTabKind: 'codeflow'` and `useEditorStore.openCodeflow()` action.
  Codeflow tabs dedup per-project, never go dirty, and skip the *Add to
  Claude CLI* context-menu entry.

### Changed
- `FileWatcherService` now also notifies `CodeflowService.markStale()` on
  every flush so a project's codeflow tab can show its *Out of date* badge
  the moment the user edits any tracked file. Best-effort wrapped — a
  watcher error never crashes the codeflow side.
- `.claude/codeflow/` ships a self-written `.gitignore` (`*`) so the
  generated docs and the cache don't accidentally get committed. Delete the
  `.gitignore` if you do want to commit the docs.

## [0.3.17] — 2026-04-28

### Added
- **Bundled monospace fonts.** JetBrains Mono for Latin / programming and
  Sarabun for Thai now ship with the app — terminal rendering no longer
  depends on whatever monospace font the OS picks for missing glyphs.
- `@xterm/addon-unicode11` enables Unicode 11 width tables in the
  terminal so Thai combining vowels and tone marks (สระบน / ล่าง,
  วรรณยุกต์) are counted as zero-width and stack correctly over their
  base consonant. Fixes cursor offsets and overlapping glyphs that
  previously made Thai output unreadable on macOS.

### Changed
- Terminal `fontFamily` stack now leads with `JetBrains Mono` (Latin via
  `unicode-range`) and `Sarabun` (Thai via `unicode-range`), with
  `TlwgMono` / `DejaVu Sans Mono` / `Sukhumvit Set` / `Thonburi` as
  cross-platform fallbacks. Sarabun's tighter metrics keep leading
  vowels (`เ`, `ไ`, `ใ`, `แ`) close to their base consonant inside
  monospace cells.

## [0.3.16] — 2026-04-28

### Added
- **Configurable tmux backend.** New Settings → tmux tab with:
  - Live session list (rename, kill, kill-server)
  - Config form for binary path override, socket name, session prefix,
    prefix key, mouse mode, escape time, history limit, status bar, and
    "kill sessions on quit"
  - Rendered `.tmux.conf` snippet so the same settings can be copied into
    the user's own config
- **Right-click context menu in terminal panes.** Copy, Paste, Select all,
  Clear screen, plus tmux quick actions: new window, split horizontal /
  vertical, choose window/session, and tmux command prompt. Hint labels
  show the user's actual prefix (e.g. `⌃A c` if you remapped to Ctrl+A).
  Shift + right-click bypasses the in-app menu and falls through to the
  native browser context menu.
- New `TmuxConfigService` persists the config and exposes both async and
  sync getters; the cache is eager-loaded on startup so the first
  launcher call doesn't pay the I/O cost.
- New shared types `TmuxConfig` and `TmuxSession`.
- New IPC channels: `tmux:list-sessions`, `tmux:kill-session`,
  `tmux:rename-session`, `tmux:kill-server`, `tmux:get-config`,
  `tmux:set-config`, `tmux:render-conf`, `tmux:resolve-binary`.
- Window event `devspace:open-settings` lets any component deep-link
  straight into a specific Settings tab; `SettingsPage` accepts an
  `initialTab` prop for first-render targeting.
- `before-quit` hook optionally tears down the DevSpace tmux server
  (`killSessionsOnQuit`, default off so sessions persist for reattach).

### Changed
- **Isolated tmux socket.** Every tmux invocation now goes through
  `-L <socketName>` (default `devspace`). DevSpace no longer touches the
  user's default tmux server, which means `kill-server` on quit is safe
  even if the user runs unrelated tmux sessions outside the app.
- `ClaudeCliLauncher` now exports `resolveTmuxBinary` (honors the user's
  configured `binaryPath`, falls back to PATH lookup), `tmuxSocketArgs()`,
  and `shellTmuxSessionName`. Session names use the configurable
  `cfg.sessionPrefix` instead of the hard-coded `devspace-` prefix.
- The launcher and `PtyPool.restartClaudeCli` honor the master switch
  `cfg.enabled` — when off, panes fall back to a plain shell with a hint
  in the log.
- `RawTerminalView` reads the configured tmux prefix on mount and
  translates `C-a` / `C-b` / etc. into the matching ASCII control byte
  before sending through the PTY.

## [0.3.14] — 2026-04-27

- First public release. One-window MacBook dev workspace with Claude Code
  CLI at the core: file tree, CodeMirror editor, integrated git, search-in-
  project, persistent tmux-backed CLI panes, multi-agent Team mode, and
  Claude Code account/files settings.

[0.3.19]: https://github.com/icueth/devspace-ide-for-claude-code/releases/tag/v0.3.19
[0.3.18]: https://github.com/icueth/devspace-ide-for-claude-code/releases/tag/v0.3.18
[0.3.17]: https://github.com/icueth/devspace-ide-for-claude-code/releases/tag/v0.3.17
[0.3.16]: https://github.com/icueth/devspace-ide-for-claude-code/releases/tag/v0.3.16
[0.3.14]: https://github.com/icueth/devspace-ide-for-claude-code/releases/tag/v0.3.14
