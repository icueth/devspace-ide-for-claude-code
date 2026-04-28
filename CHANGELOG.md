# Changelog

All notable changes to DevSpace are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/).

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

[0.3.17]: https://github.com/icueth/devspace-ide-for-claude-code/releases/tag/v0.3.17
[0.3.16]: https://github.com/icueth/devspace-ide-for-claude-code/releases/tag/v0.3.16
[0.3.14]: https://github.com/icueth/devspace-ide-for-claude-code/releases/tag/v0.3.14
