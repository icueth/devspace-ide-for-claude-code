import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { createLogger } from '@shared/logger';
import type { TmuxConfig } from '@shared/types';

const logger = createLogger('TmuxConfigService');

const CONFIG_FILE = path.join(os.homedir(), '.devspace', 'tmux-config.json');

// v0.36.0: bounds for the idle-CLI-tab reaper threshold (minutes).
export const IDLE_CLI_TAB_MIN_MINUTES = 15;
export const IDLE_CLI_TAB_MAX_MINUTES = 720;
export const IDLE_CLI_TAB_DEFAULT_MINUTES = 120;

// v0.36.1: bounds for the unpinned-CLI-tab reaper threshold (minutes).
// Tabs not visible in any column close much faster — they're the dock
// chips the user hasn't surfaced, and each one still holds claude + MCP.
export const UNPINNED_CLI_TAB_MIN_MINUTES = 1;
export const UNPINNED_CLI_TAB_MAX_MINUTES = 60;
export const UNPINNED_CLI_TAB_DEFAULT_MINUTES = 10;

function clampIdleMinutes(n: number): number {
  if (!Number.isFinite(n)) return IDLE_CLI_TAB_DEFAULT_MINUTES;
  return Math.max(
    IDLE_CLI_TAB_MIN_MINUTES,
    Math.min(IDLE_CLI_TAB_MAX_MINUTES, Math.floor(n)),
  );
}

function clampUnpinnedMinutes(n: number): number {
  if (!Number.isFinite(n)) return UNPINNED_CLI_TAB_DEFAULT_MINUTES;
  return Math.max(
    UNPINNED_CLI_TAB_MIN_MINUTES,
    Math.min(UNPINNED_CLI_TAB_MAX_MINUTES, Math.floor(n)),
  );
}

export const DEFAULT_TMUX_CONFIG: TmuxConfig = {
  enabled: true,
  binaryPath: null,
  socketName: 'devspace',
  sessionPrefix: 'devspace',
  // Ctrl+B (0x02) is tmux's stock prefix. Renderer sends this byte when the
  // user picks a tmux command from the right-click menu.
  prefixKey: 'C-b',
  mouseMode: true,
  escapeTimeMs: 0,
  historyLimit: 50000,
  statusBar: false,
  killSessionsOnQuit: false,
  // v0.36.0: idle-CLI-tab reaper. v0.38.0-beta.15: default OFF. The dual-tier
  // reaper killed unpinned tabs (any not visible in one of the ≤3 dock columns)
  // after just 10 min of no PTY output — so a claude session sitting idle while
  // the user stepped away got torn down (tmux kill-session) and couldn't be
  // resumed. Session persistence is DevSpace's whole point, so auto-close is now
  // opt-in: users who want the RAM back enable it in Settings. Thresholds below
  // are retained for when it's re-enabled.
  autoCloseIdleCliTabs: false,
  idleCliTabTimeoutMinutes: IDLE_CLI_TAB_DEFAULT_MINUTES,
  // v0.36.1: unpinned tabs close faster — they're not visible in any column.
  unpinnedCliTabTimeoutMinutes: UNPINNED_CLI_TAB_DEFAULT_MINUTES,
};

let cached: TmuxConfig | null = null;

function sanitize(raw: unknown): TmuxConfig {
  const base = { ...DEFAULT_TMUX_CONFIG };
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Record<string, unknown>;

  if (typeof r.enabled === 'boolean') base.enabled = r.enabled;
  if (typeof r.binaryPath === 'string' && r.binaryPath.trim()) {
    base.binaryPath = r.binaryPath.trim();
  } else if (r.binaryPath === null) {
    base.binaryPath = null;
  }
  if (typeof r.socketName === 'string' && /^[a-zA-Z0-9_-]+$/.test(r.socketName)) {
    base.socketName = r.socketName;
  }
  if (
    typeof r.sessionPrefix === 'string' &&
    /^[a-zA-Z0-9_-]+$/.test(r.sessionPrefix)
  ) {
    base.sessionPrefix = r.sessionPrefix;
  }
  if (typeof r.prefixKey === 'string' && r.prefixKey.trim()) {
    base.prefixKey = r.prefixKey.trim();
  }
  if (typeof r.mouseMode === 'boolean') base.mouseMode = r.mouseMode;
  if (typeof r.escapeTimeMs === 'number' && r.escapeTimeMs >= 0) {
    base.escapeTimeMs = Math.min(1000, Math.floor(r.escapeTimeMs));
  }
  if (typeof r.historyLimit === 'number' && r.historyLimit >= 1000) {
    base.historyLimit = Math.min(1_000_000, Math.floor(r.historyLimit));
  }
  if (typeof r.statusBar === 'boolean') base.statusBar = r.statusBar;
  if (typeof r.killSessionsOnQuit === 'boolean') {
    base.killSessionsOnQuit = r.killSessionsOnQuit;
  }
  // v0.36.0: auto-close idle CLI tabs. Both fields are optional in the
  // shared type so older configs migrate cleanly — undefined → default.
  if (typeof r.autoCloseIdleCliTabs === 'boolean') {
    base.autoCloseIdleCliTabs = r.autoCloseIdleCliTabs;
  }
  if (typeof r.idleCliTabTimeoutMinutes === 'number') {
    base.idleCliTabTimeoutMinutes = clampIdleMinutes(r.idleCliTabTimeoutMinutes);
  }
  if (typeof r.unpinnedCliTabTimeoutMinutes === 'number') {
    base.unpinnedCliTabTimeoutMinutes = clampUnpinnedMinutes(
      r.unpinnedCliTabTimeoutMinutes,
    );
  }
  return base;
}

export async function loadTmuxConfig(): Promise<TmuxConfig> {
  if (cached) return cached;
  try {
    const text = await fs.readFile(CONFIG_FILE, 'utf8');
    cached = sanitize(JSON.parse(text));
    logger.info('loaded tmux config from disk');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn('load failed, using defaults:', (err as Error).message);
    }
    cached = { ...DEFAULT_TMUX_CONFIG };
  }
  return cached;
}

/**
 * Synchronous accessor — returns the last loaded config or defaults. Use this
 * in hot paths where awaiting a load every call would be wasteful (the config
 * is cached after the first read on app boot).
 */
export function getTmuxConfigSync(): TmuxConfig {
  return cached ?? { ...DEFAULT_TMUX_CONFIG };
}

export async function saveTmuxConfig(next: TmuxConfig): Promise<TmuxConfig> {
  const clean = sanitize(next);
  await atomicWriteAsync(CONFIG_FILE, JSON.stringify(clean, null, 2));
  cached = clean;
  logger.info('saved tmux config');
  // v0.36.0: push the new idle-reaper config to PtyPool so toggling the
  // setting takes effect without an app restart. Imported lazily here to
  // avoid an import cycle (PtyPool already imports from this module via
  // ClaudeCliLauncher).
  try {
    const { configureIdleReaper } = await import('@main/services/PtyPool');
    configureIdleReaper({
      enabled: clean.autoCloseIdleCliTabs ?? false,
      thresholdMinutes:
        clean.idleCliTabTimeoutMinutes ?? IDLE_CLI_TAB_DEFAULT_MINUTES,
      unpinnedThresholdMinutes:
        clean.unpinnedCliTabTimeoutMinutes ?? UNPINNED_CLI_TAB_DEFAULT_MINUTES,
    });
  } catch (err) {
    logger.warn(
      'configureIdleReaper after save failed:',
      (err as Error).message,
    );
  }
  return clean;
}

/**
 * Pure: produce the tmux.conf snippet that mirrors the user's current
 * preferences. Surfaced in the UI as a copy-able block — we never overwrite
 * the user's ~/.tmux.conf.
 */
export function renderTmuxConfSnippet(cfg: TmuxConfig): string {
  const lines: string[] = [];
  lines.push('# DevSpace recommended tmux settings');
  lines.push('# Append this to ~/.tmux.conf (or to a file in ~/.config/tmux/).');
  lines.push('# DevSpace does NOT write this file for you — copy/paste only.');
  lines.push('');

  if (cfg.prefixKey && cfg.prefixKey.toUpperCase() !== 'C-B') {
    lines.push('# Custom prefix key');
    lines.push('unbind C-b');
    lines.push(`set -g prefix ${cfg.prefixKey}`);
    lines.push(`bind ${cfg.prefixKey} send-prefix`);
    lines.push('');
  }

  lines.push('# Snappy escape (Vim/Helix friendly)');
  lines.push(`set -sg escape-time ${cfg.escapeTimeMs}`);
  lines.push('');

  lines.push('# Scrollback');
  lines.push(`set -g history-limit ${cfg.historyLimit}`);
  lines.push('');

  lines.push('# Mouse');
  lines.push(`set -g mouse ${cfg.mouseMode ? 'on' : 'off'}`);
  lines.push('');

  lines.push('# Status bar (DevSpace has its own UI)');
  lines.push(`set -g status ${cfg.statusBar ? 'on' : 'off'}`);
  lines.push('');

  lines.push('# Truecolor in supporting terminals');
  lines.push('set -g default-terminal "tmux-256color"');
  lines.push('set -ag terminal-overrides ",xterm-256color:RGB"');
  lines.push('');

  lines.push('# Pane border colors aligned with DevSpace theme');
  lines.push('set -g pane-border-style "fg=#1f2937"');
  lines.push('set -g pane-active-border-style "fg=#4c8dff"');
  return lines.join('\n');
}
