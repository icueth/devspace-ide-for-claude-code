import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Circle,
  Download,
  ExternalLink,
  Folder,
  Loader2,
  RefreshCw,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ClaudeSetupPane } from '@renderer/components/Settings/ClaudeSetupPane';
import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import type {
  SetupCheck,
  SetupCheckState,
  SetupProgressEvent,
  SetupStatus,
  SetupToolId,
} from '@shared/setup';

/**
 * Environment Setup wizard — Settings → Setup tab. Mirrors install-mempalace's
 * UX: status checklist, one-click installers per tool plus an "Install All
 * Missing" button, streaming progress log, and clear external links for
 * prerequisites that the app can't safely automate (Homebrew).
 */
export function SetupSettings() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [busy, setBusy] = useState<'idle' | SetupToolId | 'all'>('idle');
  const [log, setLog] = useState<SetupProgressEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  // Claude-driven install pane: bumped each click to remount the embedded
  // xterm + spawn a fresh `claude` PTY. 0 = pane hidden.
  const [claudeRunKey, setClaudeRunKey] = useState<number>(0);

  const refreshStatus = async (): Promise<void> => {
    try {
      const s = await api.setup.getStatus();
      setStatus(s);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void api.setup
      .getStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const off = api.setup.onProgress((ev) => {
      setLog((prev) => [...prev, ev]);
      if (ev.stage === 'error' && ev.error) setError(ev.error);
    });
    return off;
  }, []);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length]);

  const handleInstall = async (toolId: SetupToolId): Promise<void> => {
    setBusy(toolId);
    setError(null);
    setLog([]);
    try {
      const result = await api.setup.installTool(toolId);
      setStatus(result.status);
      if (!result.ok && result.error) setError(result.error);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy('idle');
    }
  };

  const handleInstallAll = async (): Promise<void> => {
    setBusy('all');
    setError(null);
    setLog([]);
    try {
      const result = await api.setup.installAll();
      setStatus(result.status);
      if (!result.ok && result.error) setError(result.error);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy('idle');
    }
  };

  const handleRunClaude = useCallback((): void => {
    setError(null);
    setLog([]);
    setClaudeRunKey((k) => k + 1);
  }, []);

  const handleClaudeExit = useCallback((): void => {
    // Re-check status so the checklist reflects whatever Claude actually
    // installed. Don't auto-hide the pane — the user may want to scroll
    // through the transcript.
    void refreshStatus();
  }, []);

  if (!status) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-text-muted">
        <Loader2 size={14} className="mr-2 animate-spin" />
        Detecting environment…
      </div>
    );
  }

  const running = busy !== 'idle';
  const missingCount = status.checks.filter(
    (c) => c.state === 'missing' || c.state === 'blocked',
  ).length;

  return (
    <div className="flex h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5 px-6 py-6">
        <Header status={status} missingCount={missingCount} />

        {status.platform !== 'darwin' && <PlatformNotice platform={status.platform} />}

        <ActionsBar
          status={status}
          running={running}
          busy={busy}
          onInstallAll={handleInstallAll}
          onRefresh={refreshStatus}
          onRunClaude={handleRunClaude}
        />

        {claudeRunKey > 0 && (
          <ClaudeSetupPane
            runKey={claudeRunKey}
            onExit={handleClaudeExit}
            onError={(msg) => setError(msg)}
          />
        )}

        <ChecklistCard
          status={status}
          busy={busy}
          onInstall={handleInstall}
        />

        {(log.length > 0 || error) && (
          <LogCard log={log} error={error} logRef={logRef} />
        )}

        <TipsCard />
      </div>
    </div>
  );
}

function Header({
  status,
  missingCount,
}: {
  status: SetupStatus;
  missingCount: number;
}) {
  return (
    <div className="flex items-start gap-3">
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] text-white"
        style={{
          background: 'linear-gradient(135deg, var(--color-accent), #22d3ee)',
          boxShadow: '0 4px 16px rgba(34,211,238,0.25)',
        }}
      >
        <Wrench size={16} strokeWidth={2.25} />
      </span>
      <div className="flex flex-col gap-0.5">
        <h2 className="text-[15px] font-semibold text-text">Environment Setup</h2>
        <p className="text-[11.5px] text-text-muted">
          One-click installer for Claude Code, tmux, rtk (token-saver), jq, and
          MemPalace — everything devspace needs to run agents at full power.
        </p>
        <div className="mt-1.5">
          {status.complete ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[rgba(34,197,94,0.15)] px-2.5 py-0.5 text-[10.5px] font-medium text-semantic-success">
              <CheckCircle2 size={11} />
              All systems ready
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[rgba(245,158,11,0.15)] px-2.5 py-0.5 text-[10.5px] font-medium text-[#fcd34d]">
              <Circle size={11} />
              {missingCount} item{missingCount === 1 ? '' : 's'} missing
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function PlatformNotice({ platform }: { platform: NodeJS.Platform }) {
  return (
    <div className="flex gap-2 rounded-[8px] border border-semantic-error/40 bg-semantic-error/10 px-3 py-2 text-[11.5px] text-semantic-error">
      <AlertTriangle size={13} className="mt-[1px] shrink-0" />
      <span>
        Auto-install is currently macOS only ({platform} detected). Detection
        works on every platform — install missing tools manually for now.
      </span>
    </div>
  );
}

function ActionsBar({
  status,
  running,
  busy,
  onInstallAll,
  onRefresh,
  onRunClaude,
}: {
  status: SetupStatus;
  running: boolean;
  busy: 'idle' | SetupToolId | 'all';
  onInstallAll: () => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
  onRunClaude: () => void;
}) {
  const installAllDisabled =
    running || status.complete || status.platform !== 'darwin';

  // "Let Claude install" enabled when:
  //   - claude binary is detected (so we can actually spawn it)
  //   - at least one non-mempalace tool is still missing
  //   - no other install is currently in flight
  const claudeCheck = status.checks.find((c) => c.id === 'claude');
  const claudeReady = claudeCheck?.state === 'ok';
  const hasMissing = status.checks.some(
    (c) =>
      c.id !== 'mempalace' &&
      (c.state === 'missing' || c.state === 'blocked'),
  );
  const claudeDisabled = running || !claudeReady || !hasMissing;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => void onInstallAll()}
        disabled={installAllDisabled}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-[7px] px-4 py-2 text-[12px] font-medium transition',
          installAllDisabled
            ? 'pointer-events-none border border-border bg-surface-3 text-text-muted opacity-60'
            : 'text-white hover:brightness-110',
        )}
        style={
          installAllDisabled
            ? undefined
            : {
                background:
                  'linear-gradient(135deg, var(--color-accent), #22d3ee)',
                boxShadow: '0 4px 14px rgba(34,211,238,0.30)',
              }
        }
      >
        {busy === 'all' ? (
          <Loader2 size={12} className="animate-spin" />
        ) : (
          <Sparkles size={12} />
        )}
        {status.complete ? 'Setup complete' : 'Install All Missing'}
      </button>

      <button
        type="button"
        onClick={onRunClaude}
        disabled={claudeDisabled}
        title={
          !claudeReady
            ? 'Install Claude Code first — then Claude can finish the rest.'
            : !hasMissing
              ? 'Everything is already installed.'
              : 'Let Claude install the remaining tools and verify each one.'
        }
        className={cn(
          'inline-flex items-center gap-1.5 rounded-[7px] px-3 py-2 text-[11.5px] font-medium transition',
          claudeDisabled
            ? 'pointer-events-none border border-border bg-surface-3 text-text-muted opacity-60'
            : 'border border-accent/40 bg-accent/10 text-accent hover:bg-accent/20',
        )}
      >
        <Bot size={12} />
        Let Claude install
      </button>

      <button
        type="button"
        onClick={() => void onRefresh()}
        disabled={running}
        className="inline-flex items-center gap-1.5 rounded-[7px] border border-border bg-surface-3 px-3 py-2 text-[11.5px] text-text-secondary transition hover:border-border-hi hover:bg-surface-4 hover:text-text disabled:pointer-events-none disabled:opacity-50"
      >
        <RefreshCw size={12} />
        Re-check
      </button>

      <button
        type="button"
        onClick={() => void api.setup.openClaudeDir()}
        disabled={running}
        className="inline-flex items-center gap-1.5 rounded-[7px] border border-border bg-surface-3 px-3 py-2 text-[11.5px] text-text-secondary transition hover:border-border-hi hover:bg-surface-4 hover:text-text disabled:pointer-events-none disabled:opacity-50"
      >
        <Folder size={12} />
        Open ~/.claude
      </button>
    </div>
  );
}

function ChecklistCard({
  status,
  busy,
  onInstall,
}: {
  status: SetupStatus;
  busy: 'idle' | SetupToolId | 'all';
  onInstall: (toolId: SetupToolId) => void | Promise<void>;
}) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-border bg-surface-2/60">
      <div className="border-b border-border-subtle px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-text-muted">
        Required tools
      </div>
      <ul className="flex flex-col">
        {status.checks.map((c, i) => (
          <li
            key={c.id}
            className={cn(
              'flex items-start gap-3 px-3 py-2.5',
              i !== status.checks.length - 1 && 'border-b border-border-subtle',
            )}
          >
            <CheckIcon state={c.state} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-medium text-text">{c.label}</span>
                {c.version && (
                  <span className="rounded-full bg-surface-3 px-1.5 py-[1px] font-mono text-[9.5px] text-text-muted">
                    {c.version}
                  </span>
                )}
                <StateBadge state={c.state} />
              </div>
              <span className="text-[11px] text-text-muted">{c.description}</span>
              {c.path && (
                <span className="truncate font-mono text-[10px] text-text-muted">
                  {tilde(c.path)}
                </span>
              )}
              {c.state === 'blocked' && c.blockedBy && (
                <span className="text-[10.5px] text-[#fcd34d]">
                  Install {c.blockedBy} first.
                </span>
              )}
            </div>
            <ToolAction
              check={c}
              busy={busy}
              onInstall={() => void onInstall(c.id)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function CheckIcon({ state }: { state: SetupCheckState }) {
  if (state === 'ok') {
    return (
      <CheckCircle2
        size={14}
        className="mt-[2px] shrink-0 text-semantic-success"
      />
    );
  }
  if (state === 'unsupported') {
    return (
      <AlertTriangle size={14} className="mt-[2px] shrink-0 text-text-muted" />
    );
  }
  if (state === 'blocked') {
    return <AlertTriangle size={14} className="mt-[2px] shrink-0 text-[#fcd34d]" />;
  }
  return <Circle size={14} className="mt-[2px] shrink-0 text-text-muted" />;
}

function StateBadge({ state }: { state: SetupCheckState }) {
  const map: Record<
    SetupCheckState,
    { label: string; cls: string }
  > = {
    ok: {
      label: 'ready',
      cls: 'bg-[rgba(34,197,94,0.12)] text-semantic-success',
    },
    missing: {
      label: 'missing',
      cls: 'bg-surface-3 text-text-muted',
    },
    blocked: {
      label: 'blocked',
      cls: 'bg-[rgba(245,158,11,0.12)] text-[#fcd34d]',
    },
    unsupported: {
      label: 'n/a',
      cls: 'bg-surface-3 text-text-muted',
    },
  };
  const { label, cls } = map[state];
  return (
    <span
      className={cn(
        'rounded-full px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-wide',
        cls,
      )}
    >
      {label}
    </span>
  );
}

function ToolAction({
  check,
  busy,
  onInstall,
}: {
  check: SetupCheck;
  busy: 'idle' | SetupToolId | 'all';
  onInstall: () => void;
}) {
  // MemPalace points users at its dedicated Memory tab installer.
  if (check.id === 'mempalace') {
    return (
      <a
        href="#"
        onClick={(e) => {
          e.preventDefault();
          // Custom event picked up by SettingsPage to switch tabs without
          // coupling components.
          window.dispatchEvent(new CustomEvent('devspace:switch-settings-tab', {
            detail: { tab: 'memory' },
          }));
        }}
        className="inline-flex items-center gap-1 rounded-[6px] border border-border bg-surface-3 px-2 py-1 text-[10.5px] text-text-secondary transition hover:border-border-hi hover:bg-surface-4 hover:text-text"
      >
        Open Memory tab
        <ExternalLink size={9} />
      </a>
    );
  }

  if (check.state === 'ok') {
    // For rtk hook only, expose a small remove control. Other "ok" tools
    // don't get an uninstall button — this isn't a package manager UI.
    if (check.id === 'rtkHook') {
      return (
        <button
          type="button"
          onClick={() =>
            void api.setup.uninstallRtkHook().catch(() => undefined)
          }
          disabled={busy !== 'idle'}
          className="rounded-[6px] border border-semantic-error/40 bg-semantic-error/10 px-2 py-1 text-[10.5px] text-semantic-error transition hover:bg-semantic-error/20 disabled:pointer-events-none disabled:opacity-50"
        >
          Remove
        </button>
      );
    }
    return null;
  }

  if (check.state === 'unsupported') return null;

  const isThis = busy === check.id;
  const externalOnly = check.id === 'brew';
  const disabled = busy !== 'idle' || !check.installable;

  return (
    <button
      type="button"
      onClick={onInstall}
      disabled={disabled}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-[6px] border border-border bg-surface-3 px-2.5 py-1 text-[10.5px] text-text-secondary transition hover:border-border-hi hover:bg-surface-4 hover:text-text disabled:pointer-events-none disabled:opacity-50',
      )}
    >
      {isThis ? (
        <Loader2 size={10} className="animate-spin" />
      ) : externalOnly ? (
        <ExternalLink size={10} />
      ) : (
        <Download size={10} />
      )}
      {externalOnly ? 'Open installer' : isThis ? 'Installing…' : 'Install'}
    </button>
  );
}

function LogCard({
  log,
  error,
  logRef,
}: {
  log: SetupProgressEvent[];
  error: string | null;
  logRef: React.RefObject<HTMLDivElement | null>;
}) {
  const lines = useMemo(
    () =>
      log.map((ev, i) => ({
        key: `${ev.toolId}-${ev.stage}-${i}`,
        toolId: ev.toolId,
        stage: ev.stage,
        message: ev.message,
        isError: ev.stage === 'error',
        isDone: ev.stage === 'done',
      })),
    [log],
  );

  return (
    <div className="rounded-[10px] border border-border bg-surface-2/60">
      <div className="border-b border-border-subtle px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-text-muted">
        Progress log
      </div>
      <div
        ref={logRef}
        className="max-h-[240px] overflow-y-auto px-3 py-2 font-mono text-[10.5px] leading-relaxed"
      >
        {lines.map((line) => (
          <div
            key={line.key}
            className={cn(
              'whitespace-pre-wrap',
              line.isError
                ? 'text-semantic-error'
                : line.isDone
                  ? 'text-semantic-success'
                  : 'text-text-secondary',
            )}
          >
            [{line.toolId}/{line.stage}] {line.message}
          </div>
        ))}
        {error && lines.every((l) => !l.isError) && (
          <div className="mt-1 whitespace-pre-wrap text-semantic-error">
            [error] {error}
          </div>
        )}
      </div>
    </div>
  );
}

function TipsCard() {
  return (
    <div className="rounded-[10px] border border-border bg-surface-2/40 px-3 py-2.5 text-[10.5px] text-text-muted">
      <div className="mb-1 font-semibold uppercase tracking-wide">Notes</div>
      <ul className="flex list-disc flex-col gap-0.5 pl-4">
        <li>
          Run <code className="font-mono">claude</code> once in any terminal
          after installing Claude Code to sign in to your Anthropic account.
        </li>
        <li>
          Once Claude is signed-in, “Let Claude install” will run the AI
          agent against the remaining tools and verify each one before
          declaring success.
        </li>
        <li>
          The rtk hook rewrites your Bash commands inside Claude Code to save
          60–90% tokens — no behavior change for you.
        </li>
        <li>
          Restart Claude Code after the rtk hook or MemPalace is installed so it
          reloads <code className="font-mono">~/.claude/settings.json</code>.
        </li>
      </ul>
    </div>
  );
}

function tilde(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, '~');
}
