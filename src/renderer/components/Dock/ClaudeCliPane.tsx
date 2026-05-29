import {
  MessageSquare,
  RefreshCw,
  Target,
  Terminal as TerminalIcon,
} from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';

import { useClaudeVersion } from '@renderer/hooks/useClaudeVersion';
import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import { claudeCliSessionId, useCliTabsStore } from '@renderer/state/cliTabs';
import { useGitStore } from '@renderer/state/git';
import type { ClaudeEffort } from '@shared/types';

// v0.37: claude-code 2.1.154 introduced /effort, /goal, /reload-skills.
// We gate the matching QuickActions controls on this version.
const MIN_CLAUDE_FOR_NEW_SLASH = { major: 2, minor: 1, patch: 154 };

// xterm bundle (200KB+) only loads when the first pane mounts.
const RawTerminalView = lazy(() =>
  import('@renderer/components/Dock/RawTerminalView').then((m) => ({
    default: m.RawTerminalView,
  })),
);
// New beta chat surface — parsed claude --print stream-json instead of
// PTY passthrough. Loaded on demand so users who never flip to chat
// mode don't pay its bundle cost.
const ChatPanel = lazy(() =>
  import('@renderer/components/Dock/ChatPanel').then((m) => ({
    default: m.ChatPanel,
  })),
);

type CliPaneMode = 'terminal' | 'chat';

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
  // Per-tab toggle between the chat UI (default — parsed stream-json,
  // auto-approves tools, prettier output) and the PTY-backed terminal
  // (alternative — interactive tool approvals, raw output). Tab-local
  // rather than persisted; users who want their old terminal default
  // can flip per tab.
  const [mode, setMode] = useState<CliPaneMode>('chat');

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
        <ModeToggle mode={mode} onChange={setMode} />
      </div>
      <ContextChips shortCwd={shortCwd} branch={branch} ahead={ahead} dirty={dirty} />
      <div className="relative min-h-0 flex-1 overflow-hidden bg-surface">
        {mode === 'chat' ? (
          <Suspense fallback={null}>
            <ChatPanel projectPath={projectPath} />
          </Suspense>
        ) : (
          status !== 'starting' && (
            <Suspense fallback={null}>
              <RawTerminalView sessionId={sessionId} isActive={isActive ?? false} />
            </Suspense>
          )
        )}
      </div>
      {/* Slash actions only make sense in TTY mode — chat surface sends
          messages as natural language and processes one turn at a time. */}
      {mode === 'terminal' && (
        <QuickActions
          projectId={projectId}
          tabId={tabId}
          onSend={sendSlash}
          disabled={status !== 'running'}
        />
      )}
    </div>
  );
}

function ModeToggle({
  mode,
  onChange,
}: {
  mode: CliPaneMode;
  onChange: (m: CliPaneMode) => void;
}) {
  return (
    <div className="inline-flex h-[22px] items-stretch rounded-[6px] border border-border-subtle bg-surface-3 text-[10.5px]">
      <ToggleBtn
        active={mode === 'chat'}
        onClick={() => onChange('chat')}
        title="Chat UI — parsed events, auto-approves tools (default)"
      >
        <MessageSquare size={10} />
        <span>Chat</span>
      </ToggleBtn>
      <ToggleBtn
        active={mode === 'terminal'}
        onClick={() => onChange('terminal')}
        title="Interactive TTY — per-tool approval, raw output"
      >
        <TerminalIcon size={10} />
        <span>Terminal</span>
      </ToggleBtn>
    </div>
  );
}

function ToggleBtn({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        'inline-flex items-center gap-1 px-2 transition first:rounded-l-[6px] last:rounded-r-[6px]',
        active
          ? 'bg-surface-4 text-text'
          : 'text-text-secondary hover:bg-surface-4 hover:text-text',
      )}
    >
      {children}
    </button>
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
  // v0.37: needed for the persisted-effort lookup and the version-gate
  // tooltip on /goal / /reload-skills / /effort.
  projectId: string;
  tabId: string;
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

// v0.37: trimmed labels for the compact dropdown — "Faster" is friendlier
// than "low" for an end-user term. The map sits next to the dropdown so a
// future rename doesn't drift between the option list and the persisted
// store value (which uses the canonical ClaudeEffort tier strings).
const EFFORT_DROPDOWN: Array<{ value: ClaudeEffort; label: string }> = [
  { value: 'low', label: 'Faster' },
  { value: 'medium', label: 'Balanced' },
  { value: 'high', label: 'Smarter' },
  { value: 'xhigh', label: 'X-High' },
  { value: 'ultracode', label: 'Ultracode' },
];

const VERSION_GATE_TOOLTIP = 'Requires claude CLI 2.1.154 or newer';

function QuickActions({ projectId, tabId, onSend, disabled }: QuickActionsProps) {
  const { meets } = useClaudeVersion();
  const newSlashSupported = meets(MIN_CLAUDE_FOR_NEW_SLASH);

  // v0.37: persisted per-tab effort so the dropdown re-mounts on the user's
  // last choice. Single-tab selector — no fancy memoization needed.
  const effort = useCliTabsStore(
    (s) => s.tabsByProject[projectId]?.find((t) => t.id === tabId)?.effort,
  );
  const setTabEffort = useCliTabsStore((s) => s.setTabEffort);

  const [goalOpen, setGoalOpen] = useState(false);
  // v0.37: ephemeral "Skills reloaded" inline label. Self-clears after 1.5s.
  // Cheaper than wiring through the global ResourceToastHost for a single
  // surface and keeps the toast scoped to the action button.
  const [reloadedAt, setReloadedAt] = useState<number | null>(null);

  const onEffortChange = (v: string): void => {
    if (!v) return;
    const tier = v as ClaudeEffort;
    setTabEffort(projectId, tabId, tier);
    onSend(`/effort ${tier}`);
  };

  const onReloadSkills = (): void => {
    onSend('/reload-skills');
    setReloadedAt(Date.now());
    window.setTimeout(() => {
      setReloadedAt((curr) => (curr && Date.now() - curr >= 1400 ? null : curr));
    }, 1500);
  };

  const newSlashDisabled = disabled || !newSlashSupported;

  return (
    <>
      <div
        className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-t border-border px-2 py-1.5"
        style={{ background: 'var(--color-surface-2)' }}
      >
        {/* Effort dropdown — left of everything else per the v0.37 spec.
            Disabled when the installed claude is older than 2.1.154 (the
            release that introduced /effort) so picking a tier doesn't
            silently no-op. */}
        <select
          value={effort ?? ''}
          disabled={newSlashDisabled}
          onChange={(e) => onEffortChange(e.target.value)}
          title={
            newSlashSupported
              ? 'Send /effort <tier> — extended thinking budget'
              : VERSION_GATE_TOOLTIP
          }
          className={cn(
            'h-[24px] shrink-0 rounded-[7px] border bg-surface-3 px-2 text-[10.5px] text-text-secondary transition hover:border-border-hi hover:text-text focus:border-accent focus:outline-none',
            newSlashDisabled
              ? 'pointer-events-none border-border opacity-40'
              : 'border-border-subtle',
          )}
        >
          <option value="" disabled>
            Effort…
          </option>
          {EFFORT_DROPDOWN.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        {/* Goal modal trigger — opens an inline dialog that posts
            /goal <text>. Same version-gate as /effort. */}
        <button
          onClick={() => setGoalOpen(true)}
          disabled={newSlashDisabled}
          title={
            newSlashSupported
              ? 'Set a high-level goal for this session'
              : VERSION_GATE_TOOLTIP
          }
          className={cn(
            'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[7px] border border-border bg-surface-3 px-2.5 py-1 text-[11px] text-text-secondary transition hover:border-border-hi hover:bg-surface-4 hover:text-text',
            newSlashDisabled && 'pointer-events-none opacity-40',
          )}
        >
          <Target size={11} />
          Goal
        </button>

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

        <div className="flex-1" />

        {/* Reload-skills lives on the far right because it's a maintenance
            action — not part of the everyday flow. The inline "✓ reloaded"
            label uses the same transient-toast pattern as v0.36.0's
            resource banner without pulling in the global host for one chip. */}
        <button
          onClick={onReloadSkills}
          disabled={newSlashDisabled}
          title={
            newSlashSupported
              ? 'Send /reload-skills'
              : VERSION_GATE_TOOLTIP
          }
          className={cn(
            'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[7px] border border-border bg-surface-3 px-2 py-1 text-[11px] text-text-secondary transition hover:border-border-hi hover:bg-surface-4 hover:text-text',
            newSlashDisabled && 'pointer-events-none opacity-40',
          )}
        >
          <RefreshCw size={11} />
          Reload skills
          {reloadedAt && (
            <span className="ml-1 text-[10px] text-semantic-success">
              ✓
            </span>
          )}
        </button>
      </div>
      {goalOpen && (
        <GoalDialog
          onClose={() => setGoalOpen(false)}
          onSubmit={(text) => {
            const trimmed = text.trim();
            if (trimmed) onSend(`/goal ${trimmed}`);
            setGoalOpen(false);
          }}
        />
      )}
    </>
  );
}

// v0.37: minimal in-file modal. Existing dialog patterns in the dock all
// pull in DesignSeedingRow / ForgeGenerateDialog scope; this stays local
// to keep the bundle cost ~zero for a feature this small.
function GoalDialog({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (text: string) => void;
}) {
  const [text, setText] = useState('');
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[420px] rounded-[10px] border border-border-subtle bg-surface-2 p-4 shadow-xl"
      >
        <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold text-text">
          <Target size={12} className="text-accent" />
          Set session goal
        </div>
        <p className="mb-3 text-[10.5px] text-text-muted">
          Sends <code className="rounded bg-surface-3 px-1">/goal &lt;text&gt;</code>{' '}
          to Claude — useful to anchor multi-turn work.
        </p>
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          placeholder="e.g. Refactor the auth service to use JWT…"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              onSubmit(text);
            }
            if (e.key === 'Escape') onClose();
          }}
          className="w-full resize-y rounded-[7px] border border-border-subtle bg-surface-3 px-3 py-2 font-mono text-[12px] text-text placeholder:text-text-dim focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40"
        />
        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="inline-flex h-[26px] items-center rounded-[7px] border border-border-subtle bg-surface-3 px-3 text-[11px] text-text-secondary transition hover:bg-surface-4 hover:text-text"
          >
            Cancel
          </button>
          <button
            onClick={() => onSubmit(text)}
            disabled={!text.trim()}
            className="inline-flex h-[26px] items-center rounded-[7px] px-3 text-[11px] font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            style={{
              background:
                'linear-gradient(135deg, var(--color-accent), #a855f7)',
            }}
          >
            Set goal
          </button>
        </div>
      </div>
    </div>
  );
}
