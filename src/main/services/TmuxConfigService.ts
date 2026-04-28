import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { createLogger } from '@shared/logger';
import type { TmuxConfig } from '@shared/types';

const logger = createLogger('TmuxConfigService');

const CONFIG_FILE = path.join(os.homedir(), '.devspace', 'tmux-config.json');

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
