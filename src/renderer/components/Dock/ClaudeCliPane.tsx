import { lazy, Suspense, useEffect, useRef, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import { claudeCliSessionId } from '@renderer/state/cliTabs';
import { useGitStore } from '@renderer/state/git';

// xterm bundle (200KB+) only loads when the first pane mounts.
const RawTerminalView = lazy(() =>
  import('@renderer/components/Dock/RawTerminalView').then((m) => ({
    default: m.RawTerminalView,
  })),
);

interface ClaudeCliPaneProps {
  projectId: string;
  projectPath: string;
  // Distinct PTY/tmux session per tab. Multiple tabs can run concurrently
  // for the same project; switching tabs hides this pane (visibility only,
  // the PTY stays alive so output keeps streaming in the background).
  tabId: string;
  isActive?: boolean;
}

export function ClaudeCliPane({
  projectId,
  projectPath,
  tabId,
  isActive,
}: ClaudeCliPaneProps) {
  const sessionId = claudeCliSessionId(projectId, tabId);

  const [status, setStatus] = useState<'starting' | 'running' | 'exited' | 'error'>(
    'starting',
  );
  const [pid, setPid] = useState<number | null>(null);
  const [exitMsg, setExitMsg] = useState<string | null>(null);

  const gitSnapshot = useGitStore((s) => s.byProject[projectId]);
  const branch = gitSnapshot?.branch;
  const ahead = gitSnapshot?.ahead ?? 0;
  const dirty = gitSnapshot?.files.length ?? 0;

  // Derive short project name for the cwd chip — full path is too wide.
  const shortCwd = projectPath
    .replace(/^\/Users\/[^/]+/, '~')
    .split('/')
    .slice(-2)
    .join('/');

  // Spawn (or attach to) the PTY at the moment the pane first mounts. PtyPool
  // dedupes by sessionKey so calling create() repeatedly is safe; this
  // effect runs once per tab.
  const spawnedRef = useRef(false);
  useEffect(() => {
    if (spawnedRef.current) return;
    spawnedRef.current = true;
    let disposeExit: (() => void) | null = null;
    let cancelled = false;

    api.pty
      .create({
        projectId,
        tabId,
        kind: 'claude-cli',
        cwd: projectPath,
        cols: 120,
        rows: 32,
      })
      .then((session) => {
        if (cancelled) return;
        setPid(session.pid);
        setStatus('running');
        disposeExit = api.pty.onExit(session.sessionId, (code) => {
          setStatus('exited');
          setExitMsg(`Exited with code ${code ?? '?'}`);
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStatus('error');
        setExitMsg(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
      disposeExit?.();
      // PTY stays in the pool — close-tab handler explicitly kills it.
    };
  }, [projectId, projectPath, tabId]);

  const sendSlash = (cmd: string): void => {
    void api.pty.write(sessionId, `${cmd}\r`);
  };

  return (
    <div className="flex h-full flex-col">
      <div
        className="flex h-10 shrink-0 items-center gap-2.5 border-b border-border px-3"
        style={{
          background:
            'linear-gradient(180deg, var(--color-surface-3), var(--color-surface-2))',
        }}
      >
        <div
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] text-[11px] font-bold text-white"
          style={{
            background: 'linear-gradient(135deg, #a855f7, #ec4899)',
            boxShadow: '0 0 12px rgba(168,85,247,0.3)',
          }}
        >
          C
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-[12px] font-semibold text-text">Claude Code</span>
          {status === 'running' && (
            <span
              className="flex items-center gap-1.5 rounded-full px-2 py-[2px] text-[10px] font-medium"
              style={{
                background: 'rgba(34,197,94,0.12)',
                color: '#22c55e',
              }}
            >
              <span
                className="h-[5px] w-[5px] rounded-full bg-semantic-success"
                style={{
                  boxShadow: '0 0 6px #22c55e',
                  animation: 'pulse-ring 2s infinite',
                }}
              />
              running
              {pid && <span className="text-text-muted">· pid {pid}</span>}
            </span>
          )}
          {status === 'starting' && (
            <span className="text-[10.5px] text-semantic-warning">starting…</span>
          )}
          {(status === 'exited' || status === 'error') && (
            <span className="text-[10.5px] text-semantic-error">{exitMsg}</span>
          )}
        </div>
        <div className="flex-1" />
      </div>
      <ContextChips shortCwd={shortCwd} branch={branch} ahead={ahead} dirty={dirty} />
      <div className="relative min-h-0 flex-1 overflow-hidden bg-surface">
        {status !== 'starting' && (
          <Suspense fallback={null}>
            <RawTerminalView sessionId={sessionId} isActive={isActive ?? false} />
          </Suspense>
        )}
      </div>
      <QuickActions onSend={sendSlash} disabled={status !== 'running'} />
    </div>
  );
}

interface ContextChipsProps {
  shortCwd: string;
  branch: string | null | undefined;
  ahead: number;
  dirty: number;
}

function ContextChips({ shortCwd, branch, ahead, dirty }: ContextChipsProps) {
  return (
    <div
      className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border px-3 py-1.5 font-mono text-[10px]"
      style={{ background: 'var(--color-surface-2)' }}
    >
      <Chip
        style={{
          background: 'rgba(168,85,247,0.08)',
          border: '1px solid rgba(168,85,247,0.25)',
          color: '#d8b4fe',
        }}
      >
        ✦ Claude
      </Chip>
      <Chip
        style={{
          background: 'rgba(76,141,255,0.08)',
          border: '1px solid rgba(76,141,255,0.2)',
          color: 'var(--color-accent-2)',
        }}
      >
        {shortCwd}
      </Chip>
      {branch && (
        <Chip
          style={{
            background: 'rgba(34,197,94,0.08)',
            border: '1px solid rgba(34,197,94,0.2)',
            color: '#86efac',
          }}
        >
          ⎇ {branch}
          {ahead > 0 && <span className="ml-1 text-text-muted">↑{ahead}</span>}
          {dirty > 0 && <span className="ml-1 text-semantic-warning">●{dirty}</span>}
        </Chip>
      )}
    </div>
  );
}

function Chip({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-border bg-surface-3 px-2.5 py-[2px] text-text-secondary"
      style={style}
    >
      {children}
    </span>
  );
}

interface QuickActionsProps {
  onSend: (cmd: string) => void;
  disabled: boolean;
}

// Slash commands that map 1:1 to Claude CLI's built-in commands. Clicking a
// button types the command into the PTY exactly as the user would — no
// interception, no parsing. Plan mode, tool approval, etc. keep working.
const SLASH_ACTIONS: Array<{ label: string; cmd: string; primary?: boolean }> = [
  { label: 'plan', cmd: '/plan', primary: true },
  { label: 'model', cmd: '/model' },
  { label: 'compact', cmd: '/compact' },
  { label: 'clear', cmd: '/clear' },
  { label: 'agents', cmd: '/agents' },
  { label: 'help', cmd: '/help' },
];

function QuickActions({ onSend, disabled }: QuickActionsProps) {
  return (
    <div
      className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-t border-border px-2 py-1.5"
      style={{ background: 'var(--color-surface-2)' }}
    >
      {SLASH_ACTIONS.map((a) => (
        <button
          key={a.cmd}
          onClick={() => onSend(a.cmd)}
          disabled={disabled}
          className={cn(
            'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[7px] border px-2.5 py-1 text-[11px] transition',
            a.primary
              ? 'border-[rgba(76,141,255,0.3)] text-text'
              : 'border-border bg-surface-3 text-text-secondary hover:border-border-hi hover:bg-surface-4 hover:text-text',
            disabled && 'pointer-events-none opacity-40',
          )}
          style={
            a.primary
              ? {
                  background:
                    'linear-gradient(135deg, rgba(76,141,255,0.2), rgba(168,85,247,0.12))',
                }
              : undefined
          }
          title={`Send ${a.cmd} to Claude`}
        >
          <span
            className="font-mono text-[10px] text-[color:var(--color-accent-2)]"
            style={{ color: '#a855f7' }}
          >
            /
          </span>
          {a.label}
        </button>
      ))}
    </div>
  );
}
