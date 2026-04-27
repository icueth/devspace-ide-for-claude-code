import { RefreshCw, Send, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import { useLayoutStore } from '@renderer/state/layout';
import { useTmuxStore } from '@renderer/state/tmux';
import { useWorkspaceStore } from '@renderer/state/workspace';
import type { TmuxPane } from '@shared/types';

// Mirror of main's ClaudeCliLauncher.claudeCliTmuxSessionName — keep in sync.
// We can't import from main into renderer, so duplicate the one-liner.
function claudeCliSessionName(projectId: string): string {
  return `devspace-cli-${projectId}`;
}

// Palette used by Claude CLI agent-teams (stable ordering matches typical
// member order: lead, devs, reviewer, qa). Paneindex → gradient.
const PANE_COLORS = [
  { from: '#a855f7', to: '#7c3aed' }, // purple — lead
  { from: '#4c8dff', to: '#2b5fc7' }, // blue — dev 1
  { from: '#22c55e', to: '#15803d' }, // green — dev 2
  { from: '#f59e0b', to: '#b45309' }, // amber — reviewer / db
  { from: '#ec4899', to: '#be185d' }, // pink — qa
  { from: '#14b8a6', to: '#0f766e' }, // teal — extra
  { from: '#06b6d4', to: '#0369a1' }, // cyan — extra
  { from: '#ef4444', to: '#b91c1c' }, // red — extra
];

function colorFor(index: number): { from: string; to: string } {
  return PANE_COLORS[index % PANE_COLORS.length];
}

function relativeTime(epochSec: number): string {
  if (!epochSec) return 'unknown';
  const now = Date.now() / 1000;
  const diff = Math.max(0, now - epochSec);
  if (diff < 30) return 'just now';
  if (diff < 60) return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

function statusOf(pane: TmuxPane): 'run' | 'idle' | 'standby' {
  if (!pane.activity) return 'standby';
  const age = Date.now() / 1000 - pane.activity;
  if (age < 30) return 'run';
  if (age < 600) return 'idle';
  return 'standby';
}

// Pane title from Claude CLI agent-teams looks like "agent-name@team" or
// similar. Fall back to command for bare shells.
function displayName(pane: TmuxPane): string {
  if (pane.title && pane.title !== pane.command && pane.title.trim()) {
    // Strip '@team' suffix if present.
    const at = pane.title.indexOf('@');
    return at > 0 ? pane.title.slice(0, at) : pane.title;
  }
  return pane.command || `pane ${pane.paneIndex}`;
}

interface AgentsRailProps {
  slim?: boolean;
}

export function AgentsRail({ slim }: AgentsRailProps) {
  const panes = useTmuxStore((s) => s.panes);
  const previews = useTmuxStore((s) => s.previews);
  const startPolling = useTmuxStore((s) => s.startPolling);
  const stopPolling = useTmuxStore((s) => s.stopPolling);
  const refresh = useTmuxStore((s) => s.refresh);
  const setSessionName = useTmuxStore((s) => s.setSessionName);
  const error = useTmuxStore((s) => s.error);
  const teamMode = useLayoutStore((s) => s.teamMode);
  const setTeamMode = useLayoutStore((s) => s.setTeamMode);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);

  const [focusedPane, setFocusedPane] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [targetPane, setTargetPane] = useState<string | null>(null);

  // Scope panes query to the current project's tmux session. Reset when the
  // active project changes so we don't mix stale panes.
  useEffect(() => {
    setSessionName(activeProjectId ? claudeCliSessionName(activeProjectId) : null);
    setFocusedPane(null);
    setTargetPane(null);
  }, [activeProjectId, setSessionName]);

  useEffect(() => {
    if (teamMode === 'off') return;
    startPolling(2500);
    return () => stopPolling();
  }, [teamMode, startPolling, stopPolling]);

  const sortedPanes = useMemo(
    () => [...panes].sort((a, b) => a.paneIndex - b.paneIndex),
    [panes],
  );

  // Default target = first pane once we have data.
  useEffect(() => {
    if (!targetPane && sortedPanes[0]) setTargetPane(sortedPanes[0].paneId);
  }, [sortedPanes, targetPane]);

  // Talk to the tmux server directly via IPC (subprocess → tmux CLI). Do NOT
  // route through the xterm PTY — that would just type the commands into the
  // Claude prompt as text.
  const focusPane = async (pane: TmuxPane): Promise<void> => {
    setFocusedPane(pane.paneId);
    await api.tmux.selectPane(pane.paneId);
  };

  const sendMessage = async (): Promise<void> => {
    if (!message.trim() || !targetPane) return;
    await api.tmux.sendKeys(targetPane, message, true);
    setMessage('');
  };

  const hasTmux = sortedPanes.length > 0;
  const target = sortedPanes.find((p) => p.paneId === targetPane);

  return (
    <div
      className={cn(
        'flex h-full flex-col border-l border-border',
        slim ? 'w-[240px]' : 'w-[300px]',
      )}
      style={{ background: 'var(--color-surface-2)' }}
    >
      {/* header */}
      <div
        className="flex items-center gap-2.5 border-b border-border px-3.5 py-3"
        style={{ background: 'var(--color-surface-3)' }}
      >
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] text-[12px] font-bold text-white"
          style={{
            background: 'linear-gradient(135deg, #a855f7, #ec4899)',
            boxShadow: '0 3px 10px rgba(168,85,247,0.25)',
          }}
        >
          T
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-semibold">tmux team</div>
          <div className="mt-0.5 font-mono text-[10px] text-text-muted">
            {hasTmux ? `${sortedPanes.length} pane${sortedPanes.length > 1 ? 's' : ''}` : 'no session'}
          </div>
        </div>
        <button
          onClick={() => void refresh()}
          className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition hover:bg-surface-4 hover:text-text"
          title="Refresh"
        >
          <RefreshCw size={12} />
        </button>
        <button
          onClick={() => setTeamMode('off')}
          className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition hover:bg-surface-4 hover:text-text"
          title="Close team rail"
        >
          <X size={13} />
        </button>
      </div>

      {/* panes list */}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        <div className="mb-2 flex items-center justify-between px-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
          <span>Panes · click to focus</span>
          {hasTmux && <span className="font-mono text-text-dim">{sortedPanes.length}</span>}
        </div>

        {error && (
          <div className="rounded-md border border-semantic-error/30 bg-semantic-error/10 px-2.5 py-2 text-[11px] text-semantic-error">
            {error}
          </div>
        )}

        {!hasTmux && !error && <EmptyState />}

        {sortedPanes.map((pane, i) => {
          const color = colorFor(i);
          const status = statusOf(pane);
          const name = displayName(pane);
          const isFocused = focusedPane === pane.paneId;
          const preview = previews[pane.paneId]?.split('\n').filter(Boolean).slice(-2).join(' · ');

          return (
            <div
              key={pane.paneId}
              onClick={() => void focusPane(pane)}
              className={cn(
                'mb-2 cursor-pointer rounded-[9px] border p-2.5 transition',
                isFocused
                  ? 'border-accent/40'
                  : 'border-border bg-surface-3 hover:border-border-hi',
              )}
              style={
                isFocused
                  ? {
                      background:
                        'linear-gradient(135deg, rgba(76,141,255,0.14), rgba(168,85,247,0.06))',
                    }
                  : undefined
              }
            >
              <div className="flex items-center gap-2.5">
                <div
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-[11px] font-bold text-white"
                  style={{
                    background: `linear-gradient(135deg, ${color.from}, ${color.to})`,
                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.15)',
                  }}
                >
                  {name.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-medium">{name}</div>
                  <div className="mt-0.5 truncate font-mono text-[9.5px] text-text-muted">
                    {pane.command} · pid {pane.pid}
                  </div>
                </div>
                <span
                  className="shrink-0 rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[9.5px] text-text-muted"
                  title={`tmux ${pane.paneId}`}
                >
                  {pane.paneId}
                </span>
              </div>

              {!slim && preview && (
                <div
                  className={cn(
                    'mt-2 rounded-md border-l-2 px-2 py-1.5 font-mono text-[10px] leading-snug',
                    isFocused ? 'border-l-accent text-text-secondary' : 'border-l-border-hi text-text-muted',
                  )}
                  style={{ background: 'var(--color-surface-2)', maxHeight: 42, overflow: 'hidden' }}
                >
                  {preview}
                </div>
              )}

              <div className="mt-2 flex items-center gap-2 font-mono text-[9.5px] text-text-muted">
                <StatusBadge status={status} />
                <span>last: {relativeTime(pane.activity)}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* dispatch bar */}
      {hasTmux && (
        <div
          className="border-t border-border px-3 py-2.5"
          style={{ background: 'var(--color-surface-3)' }}
        >
          <div className="mb-1.5 text-[9.5px] font-semibold uppercase tracking-wider text-text-muted">
            Send to pane
          </div>
          <div
            className="flex items-center gap-2 rounded-lg border border-border px-2 py-1.5"
            style={{ background: 'var(--color-surface-2)' }}
          >
            <select
              value={targetPane ?? ''}
              onChange={(e) => setTargetPane(e.target.value)}
              className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[10.5px] text-accent-2 outline-none"
              style={{ background: 'rgba(76,141,255,0.12)' }}
            >
              {sortedPanes.map((p) => (
                <option key={p.paneId} value={p.paneId}>
                  @{displayName(p)}
                </option>
              ))}
            </select>
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void sendMessage();
                }
              }}
              placeholder="message, ↵ to send"
              className="min-w-0 flex-1 bg-transparent text-[11.5px] text-text outline-none placeholder:text-text-dim"
            />
            <button
              onClick={() => void sendMessage()}
              disabled={!message.trim()}
              className="flex h-6 w-6 items-center justify-center rounded text-text-muted transition hover:bg-surface-4 hover:text-text disabled:opacity-30"
              title="Send"
            >
              <Send size={11} />
            </button>
          </div>
          <div className="mt-1.5 font-mono text-[9.5px] text-text-dim">
            {target ? `→ tmux send-keys -t ${target.paneId}` : ''}
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: 'run' | 'idle' | 'standby' }) {
  const cfg = {
    run: { label: 'run', bg: 'rgba(34,197,94,0.14)', fg: '#22c55e' },
    idle: { label: 'idle', bg: 'var(--color-surface-2)', fg: 'var(--color-text-muted)' },
    standby: { label: 'standby', bg: 'var(--color-surface-2)', fg: 'var(--color-text-muted)' },
  }[status];
  return (
    <span
      className="rounded-full px-1.5 py-[1px] font-mono text-[9px] font-semibold"
      style={{ background: cfg.bg, color: cfg.fg }}
    >
      {cfg.label}
    </span>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center">
      <div className="mb-2 text-[11px] font-semibold text-text-muted">No tmux session</div>
      <div className="px-3 text-[10.5px] leading-relaxed text-text-dim">
        Ask Claude to <code className="rounded bg-surface-3 px-1 py-0.5 font-mono text-accent-2">/agents</code> or
        start a team to spawn tmux panes. They'll appear here automatically.
      </div>
    </div>
  );
}
