import {
  Activity,
  Check,
  Clock,
  RefreshCw,
  Server,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import { useWorkspaceStore } from '@renderer/state/workspace';
import type { TmuxSession } from '@shared/types';

type Status =
  | { kind: 'idle' }
  | { kind: 'ok'; message: string; ts: number }
  | { kind: 'error'; message: string };

const REFRESH_INTERVAL_MS = 4000;

export function TmuxSettings() {
  const projects = useWorkspaceStore((s) => s.projects);
  const projectById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projects) map.set(p.id, p.name);
    return map;
  }, [projects]);

  const [sessions, setSessions] = useState<TmuxSession[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [renamingName, setRenamingName] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const refresh = async (showSpinner = true) => {
    if (showSpinner) setLoading(true);
    try {
      const list = await api.tmux.listSessions();
      setSessions(list);
    } catch (err) {
      setStatus({ kind: 'error', message: (err as Error).message });
    } finally {
      if (showSpinner) setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(false), REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  // Settle the saved-status pill back to idle after 2.5s.
  useEffect(() => {
    if (status.kind !== 'ok') return;
    const id = window.setTimeout(() => setStatus({ kind: 'idle' }), 2500);
    return () => clearTimeout(id);
  }, [status]);

  const handleKill = async (name: string) => {
    if (!window.confirm(`Kill tmux session "${name}"? Running processes inside it will be terminated.`)) {
      return;
    }
    const ok = await api.tmux.killSession(name);
    setStatus(
      ok
        ? { kind: 'ok', message: `Killed ${name}`, ts: Date.now() }
        : { kind: 'error', message: `Failed to kill ${name}` },
    );
    void refresh();
  };

  const handleKillServer = async () => {
    if (!window.confirm('Kill the entire tmux server? Every session — including ones spawned outside DevSpace — will be terminated.')) {
      return;
    }
    const ok = await api.tmux.killServer();
    setStatus(
      ok
        ? { kind: 'ok', message: 'tmux server stopped', ts: Date.now() }
        : { kind: 'error', message: 'kill-server failed' },
    );
    void refresh();
  };

  const beginRename = (s: TmuxSession) => {
    setRenamingName(s.name);
    setRenameValue(s.name);
  };

  const commitRename = async () => {
    if (!renamingName) return;
    const next = renameValue.trim();
    if (!next || next === renamingName) {
      setRenamingName(null);
      return;
    }
    const ok = await api.tmux.renameSession(renamingName, next);
    setStatus(
      ok
        ? { kind: 'ok', message: `Renamed → ${next}`, ts: Date.now() }
        : { kind: 'error', message: `Rename failed (name in use?)` },
    );
    setRenamingName(null);
    void refresh();
  };

  const labelFor = (s: TmuxSession): { primary: string; secondary: string | null } => {
    if (s.kind === 'claude-cli' && s.projectId) {
      const project = projectById.get(s.projectId) ?? `project ${s.projectId.slice(0, 6)}`;
      const tab = s.tabId && s.tabId !== 'default' ? ` · tab ${s.tabId}` : '';
      return { primary: `Claude CLI · ${project}${tab}`, secondary: s.name };
    }
    if (s.kind === 'shell' && s.projectId) {
      const project = projectById.get(s.projectId) ?? `project ${s.projectId.slice(0, 6)}`;
      return { primary: `Shell · ${project}`, secondary: s.name };
    }
    return { primary: s.name, secondary: null };
  };

  const total = sessions?.length ?? 0;
  const claudeCount = sessions?.filter((s) => s.kind === 'claude-cli').length ?? 0;
  const shellCount = sessions?.filter((s) => s.kind === 'shell').length ?? 0;
  const otherCount = sessions?.filter((s) => s.kind === 'other').length ?? 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border bg-surface-2/60 px-4 py-2.5">
        <Server size={13} className="text-text-muted" />
        <span className="text-[12px] font-semibold text-text">tmux sessions</span>
        <span className="rounded-full border border-border-subtle bg-surface-3 px-2 py-[1px] text-[10px] text-text-muted">
          {total} total
        </span>
        {claudeCount > 0 && (
          <span className="rounded-full bg-[rgba(168,85,247,0.15)] px-2 py-[1px] text-[10px] text-[#d8b4fe]">
            {claudeCount} claude
          </span>
        )}
        {shellCount > 0 && (
          <span className="rounded-full bg-[rgba(34,197,94,0.12)] px-2 py-[1px] text-[10px] text-[#86efac]">
            {shellCount} shell
          </span>
        )}
        {otherCount > 0 && (
          <span className="rounded-full bg-surface-3 px-2 py-[1px] text-[10px] text-text-muted">
            {otherCount} other
          </span>
        )}
        <div className="flex-1" />
        {status.kind === 'ok' && (
          <span className="flex items-center gap-1 text-[10.5px] text-semantic-success">
            <Check size={10} /> {status.message}
          </span>
        )}
        {status.kind === 'error' && (
          <span className="truncate text-[10.5px] text-semantic-error">
            {status.message}
          </span>
        )}
        <button
          type="button"
          onClick={() => void refresh()}
          className={cn(
            'inline-flex items-center gap-1 rounded-[6px] border border-border bg-surface-3 px-2 py-[4px] text-[11px] text-text-secondary transition hover:border-border-hi hover:bg-surface-4 hover:text-text',
            loading && 'opacity-60',
          )}
          title="Refresh session list"
        >
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
        <button
          type="button"
          onClick={() => void handleKillServer()}
          className="inline-flex items-center gap-1 rounded-[6px] border border-[rgba(239,68,68,0.4)] bg-[rgba(239,68,68,0.1)] px-2 py-[4px] text-[11px] text-[#fca5a5] transition hover:bg-[rgba(239,68,68,0.18)] hover:text-[#fee2e2]"
          title="Kill the tmux server (terminates every session)"
        >
          <Trash2 size={11} />
          Kill server
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {sessions === null && (
          <div className="py-10 text-center text-[12px] text-text-muted">Loading…</div>
        )}
        {sessions !== null && sessions.length === 0 && (
          <div className="py-10 text-center text-[12px] text-text-muted">
            No tmux sessions running.
            <div className="mt-1 text-[11px] text-text-dim">
              Open a Claude CLI tab or terminal to spawn one.
            </div>
          </div>
        )}
        {sessions && sessions.length > 0 && (
          <div className="overflow-hidden rounded-[10px] border border-border-subtle">
            <table className="w-full border-collapse text-[11.5px]">
              <thead className="bg-surface-2/70 text-[10.5px] uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">Session</th>
                  <th className="px-3 py-2 text-left font-semibold">Windows</th>
                  <th className="px-3 py-2 text-left font-semibold">Activity</th>
                  <th className="px-3 py-2 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => {
                  const { primary, secondary } = labelFor(s);
                  const isRenaming = renamingName === s.name;
                  return (
                    <tr
                      key={s.id}
                      className="border-t border-border-subtle transition hover:bg-surface-2/50"
                    >
                      <td className="px-3 py-2.5 align-top">
                        <div className="flex flex-col gap-0.5">
                          {isRenaming ? (
                            <input
                              autoFocus
                              type="text"
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  void commitRename();
                                } else if (e.key === 'Escape') {
                                  e.preventDefault();
                                  setRenamingName(null);
                                }
                              }}
                              onBlur={() => void commitRename()}
                              className="rounded-[5px] border border-accent/50 bg-surface px-2 py-1 font-mono text-[11px] text-text outline-none focus:border-accent"
                            />
                          ) : (
                            <button
                              type="button"
                              onClick={() => beginRename(s)}
                              title="Click to rename"
                              className="text-left text-[12px] font-medium text-text transition hover:text-accent"
                            >
                              {primary}
                            </button>
                          )}
                          {secondary && (
                            <span className="font-mono text-[10px] text-text-muted">
                              {secondary}
                            </span>
                          )}
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                            {s.attached && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-[rgba(34,197,94,0.12)] px-1.5 py-[1px] text-[9.5px] text-[#86efac]">
                                <span
                                  className="h-1.5 w-1.5 rounded-full bg-semantic-success"
                                  style={{ boxShadow: '0 0 6px #22c55e' }}
                                />
                                attached
                              </span>
                            )}
                            <span
                              className={cn(
                                'rounded-full px-1.5 py-[1px] text-[9.5px]',
                                s.kind === 'claude-cli'
                                  ? 'bg-[rgba(168,85,247,0.15)] text-[#d8b4fe]'
                                  : s.kind === 'shell'
                                    ? 'bg-[rgba(76,141,255,0.15)] text-[var(--color-accent-2)]'
                                    : 'bg-surface-3 text-text-muted',
                              )}
                            >
                              {s.kind === 'claude-cli'
                                ? 'claude'
                                : s.kind === 'shell'
                                  ? 'shell'
                                  : 'other'}
                            </span>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 align-top text-text-secondary">
                        {s.windows}
                      </td>
                      <td className="px-3 py-2.5 align-top text-[10.5px] text-text-muted">
                        <div className="flex flex-col gap-0.5">
                          <span className="inline-flex items-center gap-1">
                            <Activity size={10} /> {formatRelative(s.activity)}
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <Clock size={10} /> created {formatRelative(s.created)}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 align-top text-right">
                        <div className="flex justify-end gap-1.5">
                          {isRenaming ? (
                            <button
                              type="button"
                              onClick={() => setRenamingName(null)}
                              className="inline-flex items-center gap-1 rounded-[5px] border border-border bg-surface-3 px-2 py-[3px] text-[10.5px] text-text-secondary transition hover:bg-surface-4 hover:text-text"
                              title="Cancel"
                            >
                              <X size={10} />
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => beginRename(s)}
                              className="inline-flex items-center gap-1 rounded-[5px] border border-border bg-surface-3 px-2 py-[3px] text-[10.5px] text-text-secondary transition hover:bg-surface-4 hover:text-text"
                              title="Rename"
                            >
                              Rename
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => void handleKill(s.name)}
                            className="inline-flex items-center gap-1 rounded-[5px] border border-[rgba(239,68,68,0.35)] bg-[rgba(239,68,68,0.08)] px-2 py-[3px] text-[10.5px] text-[#fca5a5] transition hover:bg-[rgba(239,68,68,0.18)] hover:text-[#fee2e2]"
                            title="Kill session"
                          >
                            <Trash2 size={10} />
                            Kill
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-4 text-[11px] leading-relaxed text-text-muted">
          DevSpace spawns tmux sessions named{' '}
          <code className="rounded bg-surface-3 px-1 font-mono text-[10.5px]">
            devspace-cli-&lt;projectId&gt;
          </code>{' '}
          for Claude CLI tabs and{' '}
          <code className="rounded bg-surface-3 px-1 font-mono text-[10.5px]">
            devspace-shell-&lt;projectId&gt;
          </code>{' '}
          for the integrated terminal. Killing a session here is the same as running{' '}
          <code className="rounded bg-surface-3 px-1 font-mono text-[10.5px]">
            tmux kill-session -t &lt;name&gt;
          </code>{' '}
          — the next time you reopen the tab DevSpace will spawn a fresh one.
        </p>
      </div>
    </div>
  );
}

function formatRelative(unixSeconds: number): string {
  if (!unixSeconds) return '—';
  const diff = Date.now() / 1000 - unixSeconds;
  if (diff < 60) return `${Math.max(0, Math.round(diff))}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}
