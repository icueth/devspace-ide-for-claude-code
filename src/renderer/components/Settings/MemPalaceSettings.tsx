import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  Circle,
  Download,
  ExternalLink,
  Folder,
  Loader2,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import type {
  MemPalaceCheck,
  MemPalaceCheckState,
  MemPalaceProgressEvent,
  MemPalaceStatus,
} from '@shared/mempalace';

/**
 * One-click installer for the MemPalace MCP plugin + Claude Code hooks.
 *
 * Mirrors install-mempalace.sh but runs entirely inside the app: a bundled
 * `uv` binary provisions the Python package, hooks are copied from the
 * app's resources directory, and ~/.claude/settings.json is patched
 * (with a timestamped backup) via JSON parse/write — no jq dependency.
 */
export function MemPalaceSettings() {
  const [status, setStatus] = useState<MemPalaceStatus | null>(null);
  const [busy, setBusy] = useState<'idle' | 'installing' | 'uninstalling'>(
    'idle',
  );
  const [log, setLog] = useState<MemPalaceProgressEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  // Load initial status. The IPC handler subscribes this webContents to
  // progress events as a side effect — no extra setup call needed.
  useEffect(() => {
    let cancelled = false;
    void api.mempalace
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

  // Stream progress events into the log pane while install/uninstall runs.
  useEffect(() => {
    const off = api.mempalace.onProgress((ev) => {
      setLog((prev) => [...prev, ev]);
      if (ev.stage === 'error' && ev.error) setError(ev.error);
    });
    return off;
  }, []);

  // Auto-scroll log to bottom on append.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length]);

  const handleInstall = async () => {
    setBusy('installing');
    setError(null);
    setLog([]);
    try {
      const result = await api.mempalace.install();
      setStatus(result.status);
      if (!result.ok && result.error) setError(result.error);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy('idle');
    }
  };

  const handleUninstall = async () => {
    if (
      !window.confirm(
        'Remove MemPalace?\n\nThis removes hooks + settings entries. ' +
          'Your memory vault is preserved unless you uncheck "Keep vault" below.',
      )
    ) {
      return;
    }
    setBusy('uninstalling');
    setError(null);
    setLog([]);
    try {
      const result = await api.mempalace.uninstall({ keepVault: true });
      setStatus(result.status);
      if (!result.ok && result.error) setError(result.error);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy('idle');
    }
  };

  if (!status) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-text-muted">
        <Loader2 size={14} className="mr-2 animate-spin" />
        Loading MemPalace status…
      </div>
    );
  }

  const running = busy !== 'idle';

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-5 px-6 py-6">
        <Header status={status} />

        {!status.hostSupported && <UnsupportedNotice />}

        <ChecklistCard status={status} />

        <ActionsCard
          status={status}
          running={running}
          busy={busy}
          onInstall={handleInstall}
          onUninstall={handleUninstall}
        />

        {(log.length > 0 || error) && (
          <LogCard log={log} error={error} logRef={logRef} />
        )}

        <PathsCard status={status} />
      </div>
    </div>
  );
}

function Header({ status }: { status: MemPalaceStatus }) {
  return (
    <div className="flex items-start gap-3">
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] text-white"
        style={{
          background: 'linear-gradient(135deg, #a855f7, var(--color-accent))',
          boxShadow: '0 4px 16px rgba(168,85,247,0.25)',
        }}
      >
        <Brain size={16} strokeWidth={2.25} />
      </span>
      <div className="flex flex-col gap-0.5">
        <h2 className="text-[15px] font-semibold text-text">MemPalace</h2>
        <p className="text-[11.5px] text-text-muted">
          Persistent long-term memory for Claude Code — wings, rooms, knowledge
          graph, and daily diary. One-click install adds the MCP server,
          session hooks, and a local vault.
        </p>
        <div className="mt-1.5">
          {status.installed ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[rgba(34,197,94,0.15)] px-2.5 py-0.5 text-[10.5px] font-medium text-semantic-success">
              <CheckCircle2 size={11} />
              Installed
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[rgba(245,158,11,0.15)] px-2.5 py-0.5 text-[10.5px] font-medium text-[#fcd34d]">
              <Circle size={11} />
              Not installed
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function UnsupportedNotice() {
  return (
    <div className="flex gap-2 rounded-[8px] border border-semantic-error/40 bg-semantic-error/10 px-3 py-2 text-[11.5px] text-semantic-error">
      <AlertTriangle size={13} className="mt-[1px] shrink-0" />
      <span>
        This devspace build doesn't ship a uv binary for your platform
        ({navigator.platform}). MemPalace install requires the bundled uv —
        please use a build that includes your platform target.
      </span>
    </div>
  );
}

const CHECK_LABELS: Record<MemPalaceCheck, string> = {
  uv: 'uv (Python package manager)',
  mempalacePackage: 'mempalace Python package',
  vault: 'Memory vault directory',
  hooks: 'Claude Code hooks',
  plugin: 'Plugin enabled in settings.json',
};

function ChecklistCard({ status }: { status: MemPalaceStatus }) {
  const order: MemPalaceCheck[] = [
    'uv',
    'mempalacePackage',
    'vault',
    'hooks',
    'plugin',
  ];
  const detailFor = (k: MemPalaceCheck): string | null => {
    if (k === 'mempalacePackage' && status.mempalacePackagePath) {
      return status.mempalacePackagePath;
    }
    if (k === 'vault') return status.vaultPath;
    if (k === 'hooks') return status.hooksDir;
    if (k === 'plugin') return status.settingsFile;
    return null;
  };
  return (
    <div className="rounded-[10px] border border-border bg-surface-2/60 p-3">
      <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-wide text-text-muted">
        Installation checks
      </div>
      <ul className="flex flex-col gap-1">
        {order.map((key) => {
          const detail = detailFor(key);
          return (
            <li
              key={key}
              className="flex flex-col gap-0.5 rounded-[6px] px-2 py-1 text-[11.5px]"
            >
              <div className="flex items-center gap-2">
                <CheckIcon state={status.checks[key]} />
                <span className="text-text">{CHECK_LABELS[key]}</span>
                <span className="ml-auto text-[10px] text-text-muted">
                  {checkStateLabel(status.checks[key])}
                </span>
              </div>
              {detail && status.checks[key] === 'ok' && (
                <div className="ml-[21px] truncate font-mono text-[10px] text-text-muted">
                  {detail}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function CheckIcon({ state }: { state: MemPalaceCheckState }) {
  if (state === 'ok') {
    return <CheckCircle2 size={13} className="text-semantic-success" />;
  }
  if (state === 'unsupported') {
    return <AlertTriangle size={13} className="text-semantic-error" />;
  }
  return <Circle size={13} className="text-text-muted" />;
}

function checkStateLabel(state: MemPalaceCheckState): string {
  switch (state) {
    case 'ok':
      return 'ready';
    case 'missing':
      return 'missing';
    case 'unsupported':
      return 'unsupported host';
  }
}

function ActionsCard({
  status,
  running,
  busy,
  onInstall,
  onUninstall,
}: {
  status: MemPalaceStatus;
  running: boolean;
  busy: 'idle' | 'installing' | 'uninstalling';
  onInstall: () => void | Promise<void>;
  onUninstall: () => void | Promise<void>;
}) {
  const installDisabled = running || !status.hostSupported;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => void onInstall()}
        disabled={installDisabled}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-[7px] px-4 py-2 text-[12px] font-medium transition',
          installDisabled
            ? 'pointer-events-none border border-border bg-surface-3 text-text-muted opacity-60'
            : 'text-white hover:brightness-110',
        )}
        style={
          installDisabled
            ? undefined
            : {
                background:
                  'linear-gradient(135deg, #a855f7, var(--color-accent))',
                boxShadow: '0 4px 14px rgba(168,85,247,0.30)',
              }
        }
      >
        {busy === 'installing' ? (
          <Loader2 size={12} className="animate-spin" />
        ) : (
          <Download size={12} />
        )}
        {status.installed ? 'Repair / Update' : 'Install MemPalace'}
      </button>

      <button
        type="button"
        onClick={() => void api.mempalace.openVault()}
        disabled={running}
        className="inline-flex items-center gap-1.5 rounded-[7px] border border-border bg-surface-3 px-3 py-2 text-[11.5px] text-text-secondary transition hover:border-border-hi hover:bg-surface-4 hover:text-text disabled:pointer-events-none disabled:opacity-50"
      >
        <Folder size={12} />
        Open vault
      </button>

      {status.installed && (
        <button
          type="button"
          onClick={() => void onUninstall()}
          disabled={running}
          className="inline-flex items-center gap-1.5 rounded-[7px] border border-semantic-error/40 bg-semantic-error/10 px-3 py-2 text-[11.5px] text-semantic-error transition hover:bg-semantic-error/20 disabled:pointer-events-none disabled:opacity-50"
        >
          {busy === 'uninstalling' ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Trash2 size={12} />
          )}
          Remove
        </button>
      )}

      <button
        type="button"
        onClick={() =>
          void api.app.openExternal('https://github.com/MemPalace/mempalace')
        }
        className="ml-auto inline-flex items-center gap-1 rounded-[6px] px-2 py-1.5 text-[10.5px] text-text-muted transition hover:text-text"
      >
        Learn more
        <ExternalLink size={10} />
      </button>
    </div>
  );
}

function LogCard({
  log,
  error,
  logRef,
}: {
  log: MemPalaceProgressEvent[];
  error: string | null;
  logRef: React.RefObject<HTMLDivElement | null>;
}) {
  const lines = useMemo(
    () =>
      log.map((ev, i) => ({
        key: `${ev.stage}-${i}`,
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
        className="max-h-[200px] overflow-y-auto px-3 py-2 font-mono text-[10.5px] leading-relaxed"
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
            [{line.stage}] {line.message}
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

function PathsCard({ status }: { status: MemPalaceStatus }) {
  const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');
  return (
    <div className="rounded-[10px] border border-border bg-surface-2/40 px-3 py-2.5 text-[10.5px] text-text-muted">
      <div className="mb-1 font-semibold uppercase tracking-wide">Paths</div>
      <div className="flex flex-col gap-0.5 font-mono">
        <div>Vault: {tilde(status.vaultPath) || '—'}</div>
        <div>Hooks: {tilde(status.hooksDir)}</div>
        <div>Settings: {tilde(status.settingsFile)}</div>
      </div>
      {status.installed && (
        <div className="mt-2 text-[10.5px] text-text-muted">
          Restart Claude Code after install/remove so it reloads hooks and the
          plugin.
        </div>
      )}
    </div>
  );
}
