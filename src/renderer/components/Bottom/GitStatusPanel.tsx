import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CornerUpLeft,
  GitCommit,
  History,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { BranchPicker } from '@renderer/components/Bottom/BranchPicker';
import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import { useEditorStore } from '@renderer/state/editor';
import { useGitStore } from '@renderer/state/git';
import type { GitChangeType, GitFileChange, GitLogEntry } from '@shared/types';

interface GitStatusPanelProps {
  projectId: string;
  projectPath: string;
}

type GitTab = 'changes' | 'history';

const TYPE_TAG: Record<GitChangeType, { label: string; className: string }> = {
  modified: { label: 'M', className: 'text-semantic-warning' },
  added: { label: 'A', className: 'text-semantic-success' },
  deleted: { label: 'D', className: 'text-semantic-error' },
  renamed: { label: 'R', className: 'text-semantic-info' },
  untracked: { label: 'U', className: 'text-text-muted' },
  conflict: { label: '!', className: 'text-semantic-error' },
};

export function GitStatusPanel({ projectId, projectPath }: GitStatusPanelProps) {
  const snapshot = useGitStore((s) => s.byProject[projectId]);
  const loading = useGitStore((s) => s.loading[projectId] ?? false);
  const error = useGitStore((s) => s.error[projectId]);
  const refresh = useGitStore((s) => s.refresh);

  const [tab, setTab] = useState<GitTab>('changes');
  const [remoteBusy, setRemoteBusy] = useState<'push' | 'pull' | 'fetch' | null>(null);
  const [remoteError, setRemoteError] = useState<string | null>(null);

  useEffect(() => {
    void refresh(projectId, projectPath, true);
    setRemoteError(null);
  }, [projectId, projectPath, refresh]);

  const doRefresh = useCallback(() => {
    void refresh(projectId, projectPath, true);
  }, [projectId, projectPath, refresh]);

  const runRemote = useCallback(
    async (kind: 'push' | 'pull' | 'fetch') => {
      if (remoteBusy) return;
      setRemoteBusy(kind);
      setRemoteError(null);
      try {
        if (kind === 'push') await api.git.push(projectPath);
        else if (kind === 'pull') await api.git.pull(projectPath);
        else await api.git.fetch(projectPath);
        doRefresh();
      } catch (err) {
        setRemoteError((err as Error).message);
      } finally {
        setRemoteBusy(null);
      }
    },
    [projectPath, doRefresh, remoteBusy],
  );

  if (error) {
    return (
      <div className="p-3 text-[11px] text-semantic-error">Git error: {error}</div>
    );
  }

  if (!snapshot) {
    return (
      <div className="p-3 text-[11px] text-text-muted">
        {loading ? 'Loading…' : 'Run refresh.'}
      </div>
    );
  }

  if (!snapshot.isRepo) {
    return (
      <div className="p-3 text-[11px] text-text-muted">Not a git repository.</div>
    );
  }

  return (
    <div className="flex h-full flex-col text-[12px]">
      {/* Header: branch picker + push/pull + refresh */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border-subtle pl-1 pr-2 text-text-secondary">
        <div className="flex items-center gap-1.5">
          <BranchPicker
            projectPath={projectPath}
            currentBranch={snapshot.branch}
            onChanged={doRefresh}
          />
          <RemoteButton
            label={`${snapshot.behind}`}
            icon={<ArrowDownToLine size={11} />}
            title="Pull"
            active={snapshot.behind > 0}
            busy={remoteBusy === 'pull'}
            disabled={!!remoteBusy}
            onClick={() => void runRemote('pull')}
          />
          <RemoteButton
            label={`${snapshot.ahead}`}
            icon={<ArrowUpFromLine size={11} />}
            title="Push"
            active={snapshot.ahead > 0}
            busy={remoteBusy === 'push'}
            disabled={!!remoteBusy}
            onClick={() => void runRemote('push')}
          />
          <button
            onClick={() => void runRemote('fetch')}
            disabled={!!remoteBusy}
            title="Fetch"
            className="flex h-5 items-center gap-1 rounded px-1.5 text-[10.5px] text-text-muted hover:bg-surface-raised hover:text-text disabled:opacity-40"
          >
            {remoteBusy === 'fetch' ? (
              <Loader2 size={10} className="animate-spin" />
            ) : (
              <RefreshCw size={10} />
            )}
            <span>fetch</span>
          </button>
        </div>
        <div className="flex items-center gap-1">
          <TabButton active={tab === 'changes'} onClick={() => setTab('changes')}>
            <GitCommit size={10.5} />
            <span>Changes</span>
            {snapshot.files.length > 0 && (
              <span className="ml-0.5 rounded-full bg-surface-4 px-1.5 py-[0.5px] text-[9px] text-text-muted">
                {snapshot.files.length}
              </span>
            )}
          </TabButton>
          <TabButton active={tab === 'history'} onClick={() => setTab('history')}>
            <History size={10.5} />
            <span>History</span>
          </TabButton>
          <button
            onClick={doRefresh}
            className="ml-1 flex h-5 w-5 items-center justify-center rounded hover:bg-surface-raised"
            title="Refresh"
          >
            <RefreshCw size={11} className={cn(loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {remoteError && (
        <div className="shrink-0 border-b border-border-subtle bg-semantic-error/10 px-3 py-1 text-[11px] text-semantic-error">
          {remoteError}
        </div>
      )}

      {tab === 'changes' ? (
        <ChangesView projectId={projectId} projectPath={projectPath} />
      ) : (
        <HistoryView projectPath={projectPath} />
      )}
    </div>
  );
}

interface ChangesViewProps {
  projectId: string;
  projectPath: string;
}

function ChangesView({ projectId, projectPath }: ChangesViewProps) {
  const snapshot = useGitStore((s) => s.byProject[projectId]);
  const refresh = useGitStore((s) => s.refresh);
  const openFile = useEditorStore((s) => s.open);
  const openDiff = useEditorStore((s) => s.openDiff);

  const [message, setMessage] = useState('');
  const [amend, setAmend] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  useEffect(() => {
    setMessage('');
    setAmend(false);
    setCommitError(null);
  }, [projectId]);

  const { staged, unstaged } = useMemo(() => {
    const s: GitFileChange[] = [];
    const u: GitFileChange[] = [];
    for (const f of snapshot?.files ?? []) {
      if (f.staged) s.push(f);
      else u.push(f);
    }
    return { staged: s, unstaged: u };
  }, [snapshot]);

  const doRefresh = () => refresh(projectId, projectPath, true);

  const stage = async (paths: string[]) => {
    try {
      await api.git.stage(projectPath, paths);
      void doRefresh();
    } catch (err) {
      setCommitError((err as Error).message);
    }
  };
  const unstage = async (paths: string[]) => {
    try {
      await api.git.unstage(projectPath, paths);
      void doRefresh();
    } catch (err) {
      setCommitError((err as Error).message);
    }
  };
  const discard = async (paths: string[]) => {
    const ok = window.confirm(
      `Discard changes in ${paths.length} file${paths.length === 1 ? '' : 's'}? This cannot be undone.`,
    );
    if (!ok) return;
    try {
      await api.git.discard(projectPath, paths);
      void doRefresh();
    } catch (err) {
      setCommitError((err as Error).message);
    }
  };
  const commit = async () => {
    setCommitError(null);
    if (!amend && staged.length === 0) {
      setCommitError('Stage files first, or tick Amend.');
      return;
    }
    if (!amend && !message.trim()) {
      setCommitError('Enter a commit message.');
      return;
    }
    setCommitting(true);
    try {
      await api.git.commit(projectPath, message.trim() || 'amend', { amend });
      setMessage('');
      setAmend(false);
      void doRefresh();
    } catch (err) {
      setCommitError((err as Error).message);
    } finally {
      setCommitting(false);
    }
  };

  if (!snapshot) return null;

  return (
    <>
      {/* Commit box */}
      <div className="shrink-0 border-b border-border-subtle px-3 py-2">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              void commit();
            }
          }}
          rows={2}
          placeholder="Commit message (Cmd+Enter to commit)"
          className="w-full resize-none rounded border border-border bg-surface-raised px-2 py-1.5 text-[12px] text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
        <div className="mt-1 flex items-center justify-between gap-2 text-[11px]">
          <label className="flex items-center gap-1 text-text-secondary">
            <input
              type="checkbox"
              checked={amend}
              onChange={(e) => setAmend(e.target.checked)}
              className="h-3 w-3"
            />
            Amend last commit
          </label>
          <div className="flex items-center gap-2">
            {staged.length > 0 && (
              <span className="text-text-muted">{staged.length} staged</span>
            )}
            <button
              onClick={() => void commit()}
              disabled={committing}
              className={cn(
                'rounded bg-accent px-3 py-1 text-white transition hover:opacity-90',
                committing && 'opacity-60',
              )}
            >
              {committing ? 'Committing…' : amend ? 'Amend' : 'Commit'}
            </button>
          </div>
        </div>
        {commitError && (
          <div className="mt-1 text-[11px] text-semantic-error">{commitError}</div>
        )}
      </div>

      {/* File lists */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section
          label="Staged"
          files={staged}
          onPrimary={(paths) => stage(paths)}
          onSecondary={(paths) => discard(paths)}
          isStaged
          onUnstageAll={() => unstage(staged.map((f) => f.path))}
          primaryIcon={<Minus size={11} />}
          primaryTitle="Unstage"
          secondaryIcon={<CornerUpLeft size={11} />}
          secondaryTitle="Discard"
          projectPath={projectPath}
          openFile={openFile}
          openDiff={openDiff}
          onRowPrimary={(path) => unstage([path])}
        />
        <Section
          label="Changes"
          files={unstaged}
          onPrimary={(paths) => stage(paths)}
          onSecondary={(paths) => discard(paths)}
          primaryIcon={<Plus size={11} />}
          primaryTitle="Stage"
          secondaryIcon={<CornerUpLeft size={11} />}
          secondaryTitle="Discard"
          projectPath={projectPath}
          openFile={openFile}
          openDiff={openDiff}
          onRowPrimary={(path) => stage([path])}
        />
        {snapshot.files.length === 0 && (
          <div className="p-3 text-[11px] text-text-muted">Working tree clean.</div>
        )}
      </div>
    </>
  );
}

interface HistoryViewProps {
  projectPath: string;
}

function HistoryView({ projectPath }: HistoryViewProps) {
  const [entries, setEntries] = useState<GitLogEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api.git
      .log(projectPath, 50)
      .then((rows) => {
        if (cancelled) return;
        setEntries(rows);
      })
      .catch((e: Error) => {
        if (!cancelled) setErr(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  if (loading && !entries) {
    return (
      <div className="flex flex-1 items-center justify-center text-[11px] text-text-muted">
        <Loader2 size={12} className="mr-1.5 animate-spin" /> Loading history…
      </div>
    );
  }
  if (err) {
    return <div className="p-3 text-[11px] text-semantic-error">{err}</div>;
  }
  if (!entries || entries.length === 0) {
    return <div className="p-3 text-[11px] text-text-muted">No commits yet.</div>;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {entries.map((c) => (
        <CommitRow key={c.hash} entry={c} />
      ))}
    </div>
  );
}

function CommitRow({ entry }: { entry: GitLogEntry }) {
  const rel = useMemo(() => formatRelative(entry.date), [entry.date]);
  return (
    <div className="flex items-start gap-2 border-b border-border-subtle/50 px-3 py-1.5 hover:bg-surface-raised">
      <span className="mt-[2px] font-mono text-[10px] text-accent-2">{entry.shortHash}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] text-text">{entry.subject}</div>
        <div className="mt-0.5 flex items-center gap-2 text-[10.5px] text-text-muted">
          <span className="truncate">{entry.author}</span>
          <span>·</span>
          <span title={new Date(entry.date).toLocaleString()}>{rel}</span>
          {entry.refs.length > 0 && (
            <>
              <span>·</span>
              <span className="flex items-center gap-1">
                {entry.refs.map((r) => (
                  <span
                    key={r}
                    className="rounded border border-border-subtle bg-surface-4 px-1 py-[0.5px] text-[9.5px]"
                  >
                    {r.replace(/^HEAD -> /, '')}
                  </span>
                ))}
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function formatRelative(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86400);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

interface RemoteButtonProps {
  label: string;
  icon: React.ReactNode;
  title: string;
  active: boolean;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}

function RemoteButton({ label, icon, title, active, busy, disabled, onClick }: RemoteButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'flex h-5 items-center gap-1 rounded px-1.5 text-[10.5px] transition',
        active
          ? 'bg-accent/15 text-accent hover:bg-accent/25'
          : 'text-text-muted hover:bg-surface-raised hover:text-text',
        disabled && 'cursor-not-allowed opacity-40',
      )}
    >
      {busy ? <Loader2 size={10} className="animate-spin" /> : icon}
      <span className="tabular-nums">{label}</span>
    </button>
  );
}

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function TabButton({ active, onClick, children }: TabButtonProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex h-6 items-center gap-1 rounded-[5px] px-2 text-[11px] transition',
        active
          ? 'bg-surface-4 text-text'
          : 'text-text-muted hover:bg-surface-raised hover:text-text',
      )}
    >
      {children}
    </button>
  );
}

interface SectionProps {
  label: string;
  files: GitFileChange[];
  onPrimary: (paths: string[]) => void;
  onSecondary: (paths: string[]) => void;
  primaryIcon: React.ReactNode;
  primaryTitle: string;
  secondaryIcon: React.ReactNode;
  secondaryTitle: string;
  projectPath: string;
  openFile: (path: string) => void;
  openDiff: (cwd: string, relPath: string, absPath: string) => void;
  onRowPrimary: (path: string) => void;
  isStaged?: boolean;
  onUnstageAll?: () => void;
}

function Section({
  label,
  files,
  onPrimary,
  onSecondary,
  primaryIcon,
  primaryTitle,
  secondaryIcon,
  secondaryTitle,
  projectPath,
  openFile,
  openDiff,
  onRowPrimary,
  isStaged,
  onUnstageAll,
}: SectionProps) {
  if (files.length === 0) return null;
  return (
    <div>
      <div className="sticky top-0 z-10 flex items-center justify-between bg-surface-sidebar px-3 py-1 text-[10px] uppercase tracking-wide text-text-muted">
        <span>
          {label} <span className="ml-1 text-text-muted">{files.length}</span>
        </span>
        <div className="flex items-center gap-1">
          {isStaged && onUnstageAll && (
            <button
              onClick={onUnstageAll}
              className="rounded px-1.5 py-0.5 text-[10px] text-text-secondary hover:bg-surface-raised"
              title="Unstage all"
            >
              Unstage all
            </button>
          )}
          {!isStaged && (
            <button
              onClick={() => onPrimary(files.map((f) => f.path))}
              className="rounded px-1.5 py-0.5 text-[10px] text-text-secondary hover:bg-surface-raised"
              title={`${primaryTitle} all`}
            >
              {primaryTitle} all
            </button>
          )}
        </div>
      </div>
      {files.map((f) => {
        const tag = TYPE_TAG[f.type];
        return (
          <div
            key={f.path}
            className="group flex w-full items-center gap-2 px-3 py-1 text-[11px] hover:bg-surface-raised"
          >
            <button
              onClick={() => void openDiff(projectPath, f.path, f.absolutePath)}
              onMouseDown={(e) => {
                if (e.shiftKey) {
                  e.preventDefault();
                  void openFile(f.absolutePath);
                }
              }}
              title="Open diff · Shift-click: open file"
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
            >
              <span className={cn('w-3 font-mono', tag.className)}>{tag.label}</span>
              <span className="flex-1 truncate text-text">{f.path}</span>
            </button>
            <div className="flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
              <button
                onClick={() => onSecondary([f.path])}
                title={`${secondaryTitle} (${f.path})`}
                className="flex h-5 w-5 items-center justify-center rounded text-text-muted hover:bg-surface-overlay hover:text-text"
              >
                {secondaryIcon}
              </button>
              <button
                onClick={() => onRowPrimary(f.path)}
                title={`${primaryTitle} (${f.path})`}
                className="flex h-5 w-5 items-center justify-center rounded text-text-muted hover:bg-surface-overlay hover:text-text"
              >
                {primaryIcon}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
