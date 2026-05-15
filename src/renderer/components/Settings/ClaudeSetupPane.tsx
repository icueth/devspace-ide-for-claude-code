import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { Loader2, Sparkles, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';

const THEME = {
  background: '#0b0d12',
  foreground: '#e5e7eb',
  cursor: '#3b82f6',
  selectionBackground: 'rgba(59,130,246,0.35)',
};

interface ClaudeSetupPaneProps {
  /**
   * Bumped by parent each time it wants a fresh spawn (e.g. user clicks
   * Run again after a previous Claude session finished). Acts as the React
   * key for the underlying terminal so the effect re-runs cleanly.
   */
  runKey: number;
  /** Fires when the spawned PTY exits, so parent can re-check status. */
  onExit?: (exitCode: number) => void;
  /** Fires when the spawn fails synchronously (before any PTY output). */
  onError?: (message: string) => void;
}

/**
 * Embedded xterm that runs `claude` with an install-the-missing-tools
 * prompt. The user watches Claude work, can intervene by typing, and
 * receives onExit when the session finishes so the parent re-runs status
 * detection.
 */
export function ClaudeSetupPane({
  runKey,
  onExit,
  onError,
}: ClaudeSetupPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [state, setState] = useState<'starting' | 'running' | 'exited' | 'error'>(
    'starting',
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let sessionId: string | null = null;
    let disposeData: (() => void) | null = null;
    let disposeExit: (() => void) | null = null;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      scrollback: 10_000,
      theme: THEME,
      allowProposedApi: true,
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    setState('starting');
    setErrorMsg(null);

    const inputDisposable = term.onData((data) => {
      if (sessionId) void api.pty.write(sessionId, data);
    });
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (sessionId) void api.pty.resize(sessionId, cols, rows);
    });

    const rafId = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          fit.fit();
        } catch {
          /* ignore */
        }

        term.write('\x1b[36m▶ Asking Claude to install the missing tools…\x1b[0m\r\n');

        void api.setup
          .runClaude({ cols: term.cols, rows: term.rows })
          .then((result) => {
            if (disposed) return;
            if (!result.ok || !result.sessionId) {
              const msg =
                result.error ??
                'Failed to start Claude — see Setup tab for details.';
              setState('error');
              setErrorMsg(msg);
              term.write(`\r\n\x1b[31m✗ ${msg}\x1b[0m\r\n`);
              onError?.(msg);
              return;
            }
            sessionId = result.sessionId;
            setState('running');
            disposeData = api.pty.onData(sessionId, (data) => {
              if (!disposed) term.write(data);
            });
            disposeExit = api.pty.onExit(sessionId, (exitCode) => {
              if (disposed) return;
              const code = exitCode ?? -1;
              setState('exited');
              term.write(
                `\r\n\x1b[2m── Claude exited (code ${code}) ──\x1b[0m\r\n`,
              );
              onExit?.(code);
            });
          })
          .catch((err: unknown) => {
            if (disposed) return;
            const msg = (err as Error).message;
            setState('error');
            setErrorMsg(msg);
            term.write(`\r\n\x1b[31m✗ ${msg}\x1b[0m\r\n`);
            onError?.(msg);
          });
      });
    });

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
    });
    ro.observe(host);

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      inputDisposable.dispose();
      resizeDisposable.dispose();
      disposeData?.();
      disposeExit?.();
      ro.disconnect();
      if (sessionId) void api.pty.kill(sessionId).catch(() => undefined);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [runKey, onExit, onError]);

  return (
    <div className="overflow-hidden rounded-[10px] border border-border bg-surface-2/60">
      <div className="flex items-center justify-between border-b border-border-subtle px-3 py-1.5">
        <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-text-muted">
          <Sparkles size={11} className="text-accent" />
          Claude-assisted install
          <StatusPill state={state} />
        </div>
        {errorMsg && (
          <span className="flex items-center gap-1 text-[10.5px] text-semantic-error">
            <XCircle size={10} />
            {errorMsg}
          </span>
        )}
      </div>
      <div
        onClick={() => termRef.current?.focus()}
        className="h-[300px] w-full bg-[#0b0d12]"
      >
        <div ref={hostRef} className="h-full w-full px-2 py-1.5" />
      </div>
    </div>
  );
}

function StatusPill({
  state,
}: {
  state: 'starting' | 'running' | 'exited' | 'error';
}) {
  const map = {
    starting: {
      label: 'starting',
      cls: 'bg-surface-3 text-text-muted',
      icon: <Loader2 size={9} className="animate-spin" />,
    },
    running: {
      label: 'running',
      cls: 'bg-[rgba(34,211,238,0.15)] text-[#67e8f9]',
      icon: <Loader2 size={9} className="animate-spin" />,
    },
    exited: {
      label: 'finished',
      cls: 'bg-[rgba(34,197,94,0.12)] text-semantic-success',
      icon: null,
    },
    error: {
      label: 'failed',
      cls: 'bg-semantic-error/20 text-semantic-error',
      icon: null,
    },
  } as const;
  const { label, cls, icon } = map[state];
  return (
    <span
      className={cn(
        'ml-1.5 inline-flex items-center gap-1 rounded-full px-1.5 py-[1px] text-[9px] font-semibold',
        cls,
      )}
    >
      {icon}
      {label}
    </span>
  );
}
