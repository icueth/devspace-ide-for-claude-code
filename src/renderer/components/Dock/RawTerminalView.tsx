import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { useCallback, useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';

import { TerminalContextMenu, type TerminalMenuItem } from '@renderer/components/Dock/TerminalContextMenu';
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

// tmux's default prefix is Ctrl+B (0x02). The user can pick a different
// modifier in Settings → tmux → Config; we pull that token from the main
// process and translate it to a control byte. Anything we can't parse falls
// back to Ctrl+B so the menu still works.
const DEFAULT_TMUX_PREFIX = '\x02';

function prefixTokenToByte(token: string | null | undefined): string {
  if (!token) return DEFAULT_TMUX_PREFIX;
  const m = /^[Cc]-([a-zA-Z])$/.exec(token.trim());
  if (!m) return DEFAULT_TMUX_PREFIX;
  const ch = m[1]!.toLowerCase();
  // ASCII control byte: Ctrl+a = 0x01, Ctrl+b = 0x02, etc.
  return String.fromCharCode(ch.charCodeAt(0) - 96);
}

interface ContextMenuState {
  x: number;
  y: number;
}

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
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [tmuxPrefixByte, setTmuxPrefixByte] = useState<string>(DEFAULT_TMUX_PREFIX);

  useEffect(() => {
    let cancelled = false;
    void api.tmux
      .getConfig()
      .then((cfg) => {
        if (!cancelled) setTmuxPrefixByte(prefixTokenToByte(cfg.prefixKey));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

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

  const writeToSession = useCallback(
    (data: string) => {
      if (!sessionId) return;
      void api.pty.write(sessionId, data);
    },
    [sessionId],
  );

  const sendTmux = useCallback(
    (key: string) => writeToSession(`${tmuxPrefixByte}${key}`),
    [writeToSession, tmuxPrefixByte],
  );

  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // Shift+right-click bypasses the in-app menu so users can still reach the
    // browser's native context menu when they explicitly ask for it.
    if (e.shiftKey) return;
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const buildMenuItems = useCallback((): TerminalMenuItem[] => {
    const term = termRef.current;
    const selection = term?.getSelection() ?? '';
    // Show the user's actual prefix in hint labels (e.g. "⌃A c" if they
    // remapped to Ctrl+A). Falls back to ⌃B for the stock binding.
    const prefixHint = (() => {
      const code = tmuxPrefixByte.charCodeAt(0);
      if (code >= 1 && code <= 26) {
        return `⌃${String.fromCharCode(code + 64)}`;
      }
      return '⌃B';
    })();
    return [
      {
        id: 'copy',
        label: 'Copy',
        hint: '⌘C',
        disabled: !selection,
        onSelect: () => {
          if (!selection) return;
          void navigator.clipboard.writeText(selection).catch(() => undefined);
          term?.clearSelection();
        },
      },
      {
        id: 'paste',
        label: 'Paste',
        hint: '⌘V',
        onSelect: async () => {
          try {
            const text = await navigator.clipboard.readText();
            if (text) writeToSession(text);
          } catch {
            /* clipboard read denied — silent */
          }
        },
      },
      {
        id: 'select-all',
        label: 'Select all',
        onSelect: () => term?.selectAll(),
      },
      {
        id: 'clear',
        label: 'Clear screen',
        hint: '⌃L',
        onSelect: () => writeToSession('\x0c'),
      },
      { id: 'sep-1', label: '', separator: true },
      {
        id: 'tmux-new-window',
        label: 'New tmux window',
        hint: `${prefixHint} c`,
        onSelect: () => sendTmux('c'),
      },
      {
        id: 'tmux-split-h',
        label: 'Split pane (horizontal)',
        hint: `${prefixHint} "`,
        onSelect: () => sendTmux('"'),
      },
      {
        id: 'tmux-split-v',
        label: 'Split pane (vertical)',
        hint: `${prefixHint} %`,
        onSelect: () => sendTmux('%'),
      },
      {
        id: 'tmux-choose',
        label: 'Choose window/session…',
        hint: `${prefixHint} w`,
        onSelect: () => sendTmux('w'),
      },
      {
        id: 'tmux-cmd',
        label: 'tmux command prompt',
        hint: `${prefixHint} :`,
        onSelect: () => sendTmux(':'),
      },
      {
        id: 'tmux-detach',
        label: 'Detach session',
        hint: `${prefixHint} d`,
        onSelect: () => sendTmux('d'),
      },
      { id: 'sep-2', label: '', separator: true },
      {
        id: 'manage-sessions',
        label: 'Manage tmux sessions…',
        onSelect: () => {
          window.dispatchEvent(
            new CustomEvent('devspace:open-settings', { detail: { tab: 'tmux' } }),
          );
        },
      },
      {
        id: 'kill-pane',
        label: 'Kill tmux pane',
        hint: `${prefixHint} x`,
        danger: true,
        onSelect: () => sendTmux('x'),
      },
    ];
  }, [sendTmux, writeToSession, tmuxPrefixByte]);

  return (
    <div
      className="h-full w-full bg-surface"
      onClick={() => termRef.current?.focus()}
      onContextMenu={handleContextMenu}
    >
      <div ref={hostRef} className="h-full w-full" />
      {menu && (
        <TerminalContextMenu
          x={menu.x}
          y={menu.y}
          items={buildMenuItems()}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
