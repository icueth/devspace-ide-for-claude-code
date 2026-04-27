import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';
import '@xterm/xterm/css/xterm.css';

import { api } from '@renderer/lib/api';

interface TerminalPaneProps {
  projectId: string;
  projectPath: string;
  isActive?: boolean;
}

const THEME = {
  background: '#0b0d12',
  foreground: '#e5e7eb',
  cursor: '#3b82f6',
  selectionBackground: 'rgba(59,130,246,0.35)',
};

export function TerminalPane({ projectId, projectPath, isActive }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let sessionId: string | null = null;
    let disposeData: (() => void) | null = null;
    let disposeExit: (() => void) | null = null;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
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

    const inputDisposable = term.onData((data) => {
      if (sessionId) void api.pty.write(sessionId, data);
    });
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (sessionId) void api.pty.resize(sessionId, cols, rows);
    });

    const rafId = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          try {
            fit.fit();
          } catch {
            /* ignore */
          }
          api.pty
            .create({
              projectId,
              kind: 'shell',
              cwd: projectPath,
              cols: term.cols,
              rows: term.rows,
            })
            .then((session) => {
              if (disposed) return;
              sessionId = session.sessionId;
              disposeData = api.pty.onData(session.sessionId, (data) => {
                if (!disposed) term.write(data);
              });
              disposeExit = api.pty.onExit(session.sessionId, () => undefined);

              const kick = () => {
                if (disposed || !sessionId) return;
                try {
                  fit.fit();
                  void api.pty.resize(sessionId, term.cols + 1, term.rows);
                  void api.pty.resize(sessionId, term.cols, term.rows);
                  term.refresh(0, term.rows - 1);
                } catch {
                  /* ignore */
                }
              };
              setTimeout(kick, 80);
              setTimeout(kick, 250);
            })
            .catch((err) => {
              term.write(
                `\r\n\x1b[31mTerminal failed: ${(err as Error).message}\x1b[0m\r\n`,
              );
            });
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
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [projectId, projectPath]);

  useEffect(() => {
    if (!isActive) return;
    const raf = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        /* ignore */
      }
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [isActive]);

  return (
    <div
      onClick={() => termRef.current?.focus()}
      className="h-full w-full overflow-hidden bg-surface"
    >
      <div ref={hostRef} className="h-full w-full" />
    </div>
  );
}
