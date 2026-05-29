import {
  AlertTriangle,
  CheckCircle2,
  Folder,
  Loader2,
  Puzzle,
  Sparkles,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import { useWorkspaceStore } from '@renderer/state/workspace';
import type {
  RufloInitProgressEvent,
  RufloProjectStatus,
} from '@shared/ruflo';

/**
 * Per-project Ruflo card mounted at the top of the Setup tab. Shows the
 * active project's `.claude-flow/` status with a one-click `npx ruflo init`.
 * Streams init output below so the user can see what's happening (npx /
 * download / scaffolding can take 15-30s on a cold cache).
 */
export function RufloProjectCard() {
  // Project selection drives everything: when there's no active project we
  // render a muted hint instead of bogus UI.
  const activeProject = useWorkspaceStore((s) => {
    if (!s.activeProjectId) return null;
    return s.projects.find((p) => p.id === s.activeProjectId) ?? null;
  });

  const [status, setStatus] = useState<RufloProjectStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<RufloInitProgressEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  // null = still checking. The overlay resolves `ruflo` the same way
  // (whichRuflo on PATH), so this is the source of truth for "init now will
  // actually be usable from the Terminal overlay".
  const [binaryInstalled, setBinaryInstalled] = useState<boolean | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const projectPath = activeProject?.path ?? null;

  const refreshStatus = useCallback(
    async (p: string): Promise<void> => {
      try {
        const next = await api.ruflo.getProjectStatus(p);
        setStatus(next);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [],
  );

  // Initial load + refetch when the active project changes. Clearing local
  // state on switch avoids leaking the previous project's log/errors.
  useEffect(() => {
    setLog([]);
    setError(null);
    setStatus(null);
    if (!projectPath) return;
    void refreshStatus(projectPath);
  }, [projectPath, refreshStatus]);

  // Is the `ruflo` binary on PATH? Re-checked per project switch (the main
  // side caches the PATH walk for 30s, so this is cheap). Drives the
  // "install Ruflo first" guard below.
  useEffect(() => {
    let cancelled = false;
    void api.ruflo.dashboard
      .isInstalled()
      .then((v) => {
        if (!cancelled) setBinaryInstalled(v);
      })
      .catch(() => {
        if (!cancelled) setBinaryInstalled(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  // Subscribe once. We filter events to the active project so a background
  // init for another window/project doesn't pollute this card's log.
  useEffect(() => {
    const off = api.ruflo.onInitProgress((ev) => {
      if (!projectPath || ev.projectPath !== projectPath) return;
      setLog((prev) => {
        const next = [...prev, ev];
        // Keep the last ~12 lines so the box stays compact.
        return next.length > 12 ? next.slice(next.length - 12) : next;
      });
      if (ev.stage === 'error' && ev.error) setError(ev.error);
      if (ev.done) {
        void refreshStatus(projectPath);
      }
    });
    return off;
  }, [projectPath, refreshStatus]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length]);

  const handleInit = useCallback(async (): Promise<void> => {
    if (!projectPath) return;
    setBusy(true);
    setError(null);
    setLog([]);
    try {
      // Guard: `npx ruflo init` succeeds even with no global install, but the
      // Terminal overlay resolves `ruflo` on PATH — so initializing without
      // the binary leaves a half-working project. Re-check at click time so a
      // fresh install since mount is picked up.
      const installed = await api.ruflo.dashboard.isInstalled();
      setBinaryInstalled(installed);
      if (!installed) {
        setError(
          'Ruflo isn’t installed yet. Install it from the Setup checklist below first — otherwise the Terminal overlay won’t find the `ruflo` binary.',
        );
        return;
      }
      const result = await api.ruflo.initProject(projectPath);
      setStatus(result.status);
      if (!result.ok && result.error) setError(result.error);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [projectPath]);

  if (!activeProject || !projectPath) {
    return (
      <div className="rounded-[10px] border border-border bg-surface-2/40 px-3 py-2.5 text-[11px] text-text-muted">
        Select a project in the sidebar to manage Ruflo for it.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-[10px] border border-border bg-surface-2/60">
      <div className="flex items-center justify-between border-b border-border-subtle px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-text-muted">
        <span className="inline-flex items-center gap-1.5">
          <Sparkles size={11} />
          Ruflo — active project
        </span>
        <StatusBadge status={status} busy={busy} />
      </div>

      <div className="flex flex-col gap-3 px-3 py-3">
        <ProjectHeader name={activeProject.name} projectPath={projectPath} />

        {binaryInstalled === false && <NotInstalledNotice />}

        <div className="flex items-center gap-2">
          <InitButton
            status={status}
            busy={busy}
            binaryInstalled={binaryInstalled}
            onClick={() => void handleInit()}
          />
          {status?.hasClaudeMd && (
            <span className="text-[10.5px] text-text-muted">CLAUDE.md present</span>
          )}
          {status?.hasClaudeDir && (
            <span className="text-[10.5px] text-text-muted">.claude/ present</span>
          )}
        </div>

        {status?.initialized && <PluginsHint />}

        {(log.length > 0 || error) && (
          <LogBox logRef={logRef} log={log} error={error} />
        )}
      </div>
    </div>
  );
}

function StatusBadge({
  status,
  busy,
}: {
  status: RufloProjectStatus | null;
  busy: boolean;
}) {
  if (busy) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-surface-3 px-2 py-[1px] text-[9px] font-semibold uppercase tracking-wide text-text-secondary">
        <Loader2 size={9} className="animate-spin" />
        Initializing
      </span>
    );
  }
  if (status?.initialized) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[rgba(34,197,94,0.12)] px-2 py-[1px] text-[9px] font-semibold uppercase tracking-wide text-semantic-success">
        <CheckCircle2 size={9} />
        Initialized
      </span>
    );
  }
  return (
    <span className="rounded-full bg-surface-3 px-2 py-[1px] text-[9px] font-semibold uppercase tracking-wide text-text-muted">
      Not initialized
    </span>
  );
}

function ProjectHeader({
  name,
  projectPath,
}: {
  name: string;
  projectPath: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <Folder size={13} className="mt-[2px] shrink-0 text-text-muted" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-[12px] font-medium text-text">{name}</span>
        <span className="truncate font-mono text-[10px] text-text-muted">
          {tilde(projectPath)}
        </span>
      </div>
    </div>
  );
}

function InitButton({
  status,
  busy,
  binaryInstalled,
  onClick,
}: {
  status: RufloProjectStatus | null;
  busy: boolean;
  binaryInstalled: boolean | null;
  onClick: () => void;
}) {
  const initialized = status?.initialized ?? false;
  const missingBinary = binaryInstalled === false;
  const disabled = busy || initialized || missingBinary;
  const label = busy
    ? 'Initializing…'
    : initialized
      ? 'Already initialized'
      : missingBinary
        ? 'Install Ruflo first'
        : 'Init';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={
        initialized
          ? '.claude-flow/ already exists — re-running ruflo init is not needed.'
          : missingBinary
            ? 'Install the Ruflo binary from the Setup checklist below before initializing.'
            : 'Run `npx ruflo@latest init` inside the active project.'
      }
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[6px] px-2.5 py-1 text-[10.5px] font-medium transition',
        disabled
          ? 'pointer-events-none border border-border bg-surface-3 text-text-muted opacity-60'
          : 'border border-accent/40 bg-accent/10 text-accent hover:bg-accent/20',
      )}
    >
      {busy ? (
        <Loader2 size={10} className="animate-spin" />
      ) : initialized ? (
        <CheckCircle2 size={10} />
      ) : (
        <Sparkles size={10} />
      )}
      {label}
    </button>
  );
}

function NotInstalledNotice() {
  return (
    <div className="flex items-start gap-2 rounded-[7px] border border-semantic-warning/40 bg-semantic-warning/10 px-2.5 py-2 text-[10.5px] text-semantic-warning">
      <AlertTriangle size={12} className="mt-[1px] shrink-0" />
      <span>
        Ruflo isn’t installed yet. Install it from the checklist below first —
        running init without it leaves the Terminal overlay unable to find the{' '}
        <code className="rounded bg-surface-3 px-1">ruflo</code> binary.
      </span>
    </div>
  );
}

function PluginsHint() {
  return (
    <button
      type="button"
      onClick={() =>
        window.dispatchEvent(
          new CustomEvent('devspace:open-settings', {
            detail: { tab: 'ruflo' },
          }),
        )
      }
      title="Open the Ruflo tab to install the recommended plugins"
      className="inline-flex items-center gap-1.5 self-start rounded-[6px] border border-border-subtle bg-surface-3 px-2.5 py-1 text-[10.5px] text-text-secondary transition hover:border-border-hi hover:bg-surface-4 hover:text-text"
    >
      <Puzzle size={11} />
      Next: install plugins in the Ruflo tab →
    </button>
  );
}

function LogBox({
  logRef,
  log,
  error,
}: {
  logRef: React.RefObject<HTMLDivElement | null>;
  log: RufloInitProgressEvent[];
  error: string | null;
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
    <div
      ref={logRef}
      className="max-h-[160px] overflow-y-auto rounded-[7px] border border-border-subtle bg-surface-3/50 px-2.5 py-2 font-mono text-[10.5px] leading-relaxed"
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
  );
}

function tilde(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, '~');
}
