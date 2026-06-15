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
import type { TmuxConfig, TmuxSession } from '@shared/types';

// v0.36.0 — idle-timeout choices for the auto-cleanup section. Kept in
// sync with the [15, 720] clamp in TmuxConfigService / PtyPool — 30m
// shows up here because users may legitimately want aggressive cleanup
// on a small RAM laptop; the backend clamps anything below 15m on save
// so a renderer typo can't disable the reaper by stealth.
const IDLE_TIMEOUT_OPTIONS: Array<{ label: string; minutes: number }> = [
  { label: '30m', minutes: 30 },
  { label: '1h', minutes: 60 },
  { label: '2h', minutes: 120 },
  { label: '4h', minutes: 240 },
  { label: '8h', minutes: 480 },
];

// v0.36.1 — unpinned threshold choices. Tabs not visible in any dock column
// close faster; the backend clamps to [1, 60] so a renderer typo can't
// silently disable this tier.
const UNPINNED_TIMEOUT_OPTIONS: Array<{ label: string; minutes: number }> = [
  { label: '1m', minutes: 1 },
  { label: '5m', minutes: 5 },
  { label: '10m', minutes: 10 },
  { label: '20m', minutes: 20 },
  { label: '30m', minutes: 30 },
  { label: '60m', minutes: 60 },
];

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

  // v0.36.0 — auto-cleanup section state. We hold a full TmuxConfig in
  // local state and mutate the two new fields. Updates are optimistic: we
  // patch local state immediately, then call setConfig — on failure we
  // restore the prior config snapshot and surface the error inline.
  const [tmuxCfg, setTmuxCfg] = useState<TmuxConfig | null>(null);
  const [cfgError, setCfgError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api.tmux
      .getConfig()
      .then((cfg) => {
        if (!cancelled) setTmuxCfg(cfg);
      })
      .catch((err) => {
        if (!cancelled) setCfgError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const autoCloseEnabled = tmuxCfg?.autoCloseIdleCliTabs ?? false;
  const idleTimeoutMinutes = tmuxCfg?.idleCliTabTimeoutMinutes ?? 120;
  const unpinnedTimeoutMinutes = tmuxCfg?.unpinnedCliTabTimeoutMinutes ?? 10;

  const patchTmuxConfig = async (patch: Partial<TmuxConfig>) => {
    if (!tmuxCfg) return;
    const prev = tmuxCfg;
    const next: TmuxConfig = { ...tmuxCfg, ...patch };
    setTmuxCfg(next); // optimistic
    setCfgError(null);
    try {
      const saved = await api.tmux.setConfig(next);
      setTmuxCfg(saved);
    } catch (err) {
      setTmuxCfg(prev);
      setCfgError((err as Error).message);
    }
  };

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
    if (s.kind === 'chatrun' && s.projectId) {
      // projectId here is the project basename slug (folder name), not the
      // workspace project id — match against project.path basename for the
      // most informative label.
      const slug = s.projectId;
      const match = projects.find((p) => {
        const base = p.path.split('/').filter(Boolean).pop() ?? '';
        return base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_').slice(0, 24) === slug;
      });
      const project = match?.name ?? slug;
      return { primary: `Chat run · ${project}`, secondary: s.name };
    }
    return { primary: s.name, secondary: null };
  };

  const total = sessions?.length ?? 0;
  const claudeCount = sessions?.filter((s) => s.kind === 'claude-cli').length ?? 0;
  const shellCount = sessions?.filter((s) => s.kind === 'shell').length ?? 0;
  const chatrunCount = sessions?.filter((s) => s.kind === 'chatrun').length ?? 0;
  const otherCount = sessions?.filter((s) => s.kind === 'other').length ?? 0;
  const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const staleCount = sessions?.filter((s) => {
    if (!s.name.startsWith('devspace-')) return false;
    const created = s.created * 1000;
    if (!Number.isFinite(created) || created <= 0) return false;
    return now - created > TWO_DAYS_MS;
  }).length ?? 0;

  const handlePrune = async () => {
    if (staleCount === 0) return;
    if (!window.confirm(`Prune ${staleCount} devspace tmux session${staleCount === 1 ? '' : 's'} older than 2 days?`)) {
      return;
    }
    try {
      const killed = await api.tmux.pruneStale();
      setStatus({
        kind: 'ok',
        message: `Pruned ${killed.length} stale session${killed.length === 1 ? '' : 's'}`,
        ts: Date.now(),
      });
      await refresh(false);
    } catch (err) {
      setStatus({ kind: 'error', message: (err as Error).message });
    }
  };

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
        {chatrunCount > 0 && (
          <span className="rounded-full bg-[rgba(76,141,255,0.15)] px-2 py-[1px] text-[10px] text-[var(--color-accent-2)]">
            {chatrunCount} chat run
          </span>
        )}
        {otherCount > 0 && (
          <span className="rounded-full bg-surface-3 px-2 py-[1px] text-[10px] text-text-muted">
            {otherCount} other
          </span>
        )}
        <div className="flex-1" />
        {staleCount > 0 && (
          <button
            type="button"
            onClick={() => void handlePrune()}
            className="inline-flex items-center gap-1 rounded-[6px] border border-[rgba(251,191,36,0.4)] bg-[rgba(251,191,36,0.1)] px-2 py-[4px] text-[11px] text-[#fcd34d] transition hover:bg-[rgba(251,191,36,0.18)] hover:text-[#fde68a]"
            title="Kill devspace tmux sessions older than 2 days"
          >
            <Trash2 size={11} />
            Prune {staleCount} stale
          </button>
        )}
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
        {/* v0.36.0 — Auto-cleanup of idle Claude CLI tabs. Each tab holds
            ~245 MB (claude) + commonly ~165 MB (Playwright MCP) of RAM the
            user can't see — closing them on idle is the most reliable
            single-tap way to reclaim memory on a busy session. */}
        <section className="mb-4 rounded-[10px] border border-border bg-surface-2/60 p-4">
          <div className="mb-3 flex items-center gap-2">
            <span className="text-[10.5px] font-semibold uppercase tracking-wide text-text-muted">
              Auto-cleanup
            </span>
            {cfgError && (
              <span className="truncate text-[10.5px] text-semantic-error">
                {cfgError}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex cursor-pointer items-center gap-2 text-[12px] text-text">
              <input
                type="checkbox"
                checked={autoCloseEnabled}
                onChange={(e) =>
                  void patchTmuxConfig({
                    autoCloseIdleCliTabs: e.target.checked,
                  })
                }
                className="h-3.5 w-3.5 cursor-pointer rounded border-border bg-surface-3 text-accent focus:ring-accent"
              />
              <span>Auto-close idle CLI tabs</span>
            </label>
            <div className="flex items-center gap-2 text-[12px] text-text-secondary">
              <span>Idle timeout</span>
              <select
                value={idleTimeoutMinutes}
                disabled={!autoCloseEnabled}
                onChange={(e) =>
                  void patchTmuxConfig({
                    idleCliTabTimeoutMinutes: Number(e.target.value),
                  })
                }
                className={cn(
                  'rounded-[6px] border border-border bg-surface-3 px-2 py-[3px] text-[11.5px] text-text outline-none transition focus:border-accent',
                  !autoCloseEnabled && 'cursor-not-allowed opacity-50',
                )}
              >
                {IDLE_TIMEOUT_OPTIONS.map((opt) => (
                  <option key={opt.minutes} value={opt.minutes}>
                    {opt.label}
                  </option>
                ))}
                {/* Round-trip a non-standard value the user set via JSON edit
                    so the picker doesn't silently snap it. Hidden if it
                    matches a preset. */}
                {!IDLE_TIMEOUT_OPTIONS.some(
                  (o) => o.minutes === idleTimeoutMinutes,
                ) && (
                  <option value={idleTimeoutMinutes}>
                    {idleTimeoutMinutes}m (custom)
                  </option>
                )}
              </select>
            </div>
          </div>
          {/* v0.36.1 — dual-tier reaper. Tabs not visible in any dock column
              close much faster than pinned tabs the user is actually looking
              at. Same patch flow as the master select above. */}
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-text-secondary">
            <span>Background tab timeout (not visible in dock columns)</span>
            <select
              value={unpinnedTimeoutMinutes}
              disabled={!autoCloseEnabled}
              onChange={(e) =>
                void patchTmuxConfig({
                  unpinnedCliTabTimeoutMinutes: Number(e.target.value),
                })
              }
              className={cn(
                'rounded-[6px] border border-border bg-surface-3 px-2 py-[3px] text-[11.5px] text-text outline-none transition focus:border-accent',
                !autoCloseEnabled && 'cursor-not-allowed opacity-50',
              )}
            >
              {UNPINNED_TIMEOUT_OPTIONS.map((opt) => (
                <option key={opt.minutes} value={opt.minutes}>
                  {opt.label}
                </option>
              ))}
              {!UNPINNED_TIMEOUT_OPTIONS.some(
                (o) => o.minutes === unpinnedTimeoutMinutes,
              ) && (
                <option value={unpinnedTimeoutMinutes}>
                  {unpinnedTimeoutMinutes}m (custom)
                </option>
              )}
            </select>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
            Tabs you can't see in any column close faster — frees ≈400 MB each.
          </p>
          <p className="mt-2 text-[11px] leading-relaxed text-text-muted">
            When a visible CLI tab has had no I/O for {formatMinutes(idleTimeoutMinutes)},
            it'll close automatically. Frees ≈400 MB per closed tab (claude + MCP children).
          </p>
        </section>

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
                                    ? 'bg-[rgba(34,197,94,0.12)] text-[#86efac]'
                                    : s.kind === 'chatrun'
                                      ? 'bg-[rgba(76,141,255,0.15)] text-[var(--color-accent-2)]'
                                      : 'bg-surface-3 text-text-muted',
                              )}
                            >
                              {s.kind === 'claude-cli'
                                ? 'claude'
                                : s.kind === 'shell'
                                  ? 'shell'
                                  : s.kind === 'chatrun'
                                    ? 'chat run'
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

// v0.36.0 — render a minute count as the friendliest unit. Matches the
// labels in IDLE_TIMEOUT_OPTIONS for the preset values; falls back to a
// raw "Nm" for custom values the user typed via JSON edit.
function formatMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return `${minutes}m`;
  if (minutes < 60) return `${minutes}m`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function formatRelative(unixSeconds: number): string {
  if (!unixSeconds) return '—';
  const diff = Date.now() / 1000 - unixSeconds;
  if (diff < 60) return `${Math.max(0, Math.round(diff))}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}
