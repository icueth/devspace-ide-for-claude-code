import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';
import '@xterm/xterm/css/xterm.css';

import { api } from '@renderer/lib/api';

interface RawTerminalViewProps {
  sessionId: string | null;
  isActive?: boolean;
}

const THEME = {
  background: '#0b0d12',
  foreground: '#e5e7eb',
  cursor: '#3b82f6',
  selectionBackground: 'rgba(59,130,246,0.35)',
  black: '#0b0d12',
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#f59e0b',
  blue: '#3b82f6',
  magenta: '#a855f7',
  cyan: '#06b6d4',
  white: '#e5e7eb',
  brightBlack: '#6b7280',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fcd34d',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#ffffff',
};

/**
 * Mounts xterm against an existing PTY session. Lazy-rendered by the parent
 * pane so tabs that stay in chat mode never pay the xterm bundle/render
 * cost. PTY is spawned by the parent and stays alive in PtyPool — when this
 * component remounts, PtyPool replays its rolling buffer so scrollback
 * appears instantly.
 */
export function RawTerminalView({ sessionId, isActive }: RawTerminalViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !sessionId) return;
    let disposed = false;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      scrollback: 10_000,
      theme: THEME,
      allowProposedApi: true,
      macOptionIsMeta: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(host);
    termRef.current = term;
    fitRef.current = fitAddon;

    const inputDisposable = term.onData((data) => {
      void api.pty.write(sessionId, data);
    });
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      void api.pty.resize(sessionId, cols, rows);
    });

    // Three rAFs settle React, flex layout, and font metrics before fit.
    let rafId = 0;
    const tickFit = () => {
      rafId = requestAnimationFrame(() => {
        rafId = requestAnimationFrame(() => {
          rafId = requestAnimationFrame(() => {
            try {
              fitAddon.fit();
            } catch {
              /* ignore */
            }
            // Subscribe AFTER first fit so the replayed buffer renders at
            // the correct cols/rows. Sending a 1-col-off resize jolts the
            // Claude TUI into a fresh repaint.
            const dispose = api.pty.onData(sessionId, (data) => {
              if (!disposed) term.write(data);
            });
            void api.pty.resize(sessionId, term.cols + 1, term.rows);
            void api.pty.resize(sessionId, term.cols, term.rows);
            term.refresh(0, term.rows - 1);

            cleanup.dispose = dispose;
          });
        });
      });
    };
    const cleanup: { dispose: (() => void) | null } = { dispose: null };
    tickFit();

    const observer = new ResizeObserver(() => {
      try {
        fitAddon.fit();
      } catch {
        /* ignore */
      }
    });
    observer.observe(host);

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      inputDisposable.dispose();
      resizeDisposable.dispose();
      cleanup.dispose?.();
      observer.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId]);

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
    <div className="h-full w-full bg-surface" onClick={() => termRef.current?.focus()}>
      <div ref={hostRef} className="h-full w-full" />
    </div>
  );
}
