import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';
import '@xterm/xterm/css/xterm.css';

import { api } from '@renderer/lib/api';

interface TerminalPaneProps {
  projectId: string;
  projectPath: string;
  // Identifies which shell tab this pane backs. Each tab gets its own PTY
  // keyed `${projectId}:shell:${tabId}` so multiple shells per project can
  // coexist (e.g. frontend dev server in one tab, backend API in another).
  // Defaults to 'default' for backward compat with callers from before
  // multi-tab — they keep their original single-session behavior.
  tabId?: string;
  isActive?: boolean;
}

const THEME = {
  background: '#0b0d12',
  foreground: '#e5e7eb',
  cursor: '#3b82f6',
  selectionBackground: 'rgba(59,130,246,0.35)',
};

export function TerminalPane({
  projectId,
  projectPath,
  tabId = 'default',
  isActive,
}: TerminalPaneProps) {
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
              tabId,
              cwd: projectPath,
              cols: term.cols,
              rows: term.rows,
            })
            .then((session) => {
              if (disposed) return;
              sessionId = session.sessionId;
              // Listener first, gated behind a replay barrier: chunks that
              // arrive while the subscribe() invoke is in flight are queued
              // so they can't land before the scrollback they follow. This
              // is what restores history on pane remount — create-time
              // replay in main is dead (it races this listener attach).
              let replayApplied = false;
              const preReplayQueue: string[] = [];
              disposeData = api.pty.onData(session.sessionId, (data) => {
                if (disposed) return;
                if (!replayApplied) {
                  preReplayQueue.push(data);
                  return;
                }
                term.write(data);
              });
              disposeExit = api.pty.onExit(session.sessionId, () => undefined);

              // Pull the rolling buffer (atomic subscriber-add + snapshot).
              void api.pty
                .subscribe(session.sessionId)
                .catch(() => '') // session gone → just go live
                .then((replay) => {
                  if (disposed) return;
                  replayApplied = true;
                  if (replay) term.write(replay);
                  // Chunks evented while the invoke was in flight were
                  // emitted before the snapshot (this wc subscribed at
                  // create), so they're already the replay's tail — only
                  // write the queue when the replay missed it.
                  const queued = preReplayQueue.join('');
                  preReplayQueue.length = 0;
                  if (queued && !replay.endsWith(queued)) term.write(queued);
                });

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
  }, [projectId, projectPath, tabId]);

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
