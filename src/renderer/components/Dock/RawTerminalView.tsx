import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal, type IDecoration, type IMarker } from '@xterm/xterm';
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

// Phase 4b: cap on how many simultaneous turn dividers we keep in the
// terminal. Each decoration is a DOM node + a marker; 50 covers any
// realistic scrollback window the user actually looks at, and the
// FIFO eviction below keeps memory bounded on long-running sessions.
const MAX_TURN_DIVIDERS = 50;

// Regex matching claude's per-turn prompt prefix. Claude has used `❯ `
// (current), `> ` (older builds), and `│ ` (when wrapped inside its
// rounded-box UI). We anchor on a line that STARTS with one of these
// after optional ANSI cursor codes — the leading `(?:\x1b\[[0-9;]*m)*`
// tolerates color escapes like `\x1b[36m❯\x1b[0m ` without missing the
// match. The trailing space is required: it distinguishes a real prompt
// from claude's tree-drawing characters elsewhere in the TUI.
const TURN_PROMPT_RE = /(?:^|\n)(?:\x1b\[[0-9;]*m)*[❯>│]\s/;

/**
 * Mounts xterm against an existing PTY session. Lazy-rendered by the parent
 * pane so tabs that stay in chat mode never pay the xterm bundle/render
 * cost. PTY is spawned by the parent and stays alive in PtyPool — on every
 * (re)mount this component PULLS the pool's rolling buffer via
 * api.pty.subscribe() after arming its data listener, so scrollback is
 * restored without racing the listener attach.
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
      // Both 'JetBrains Mono' (Latin) and 'Sarabun' (Thai) are bundled and
      // each scoped to its own unicode-range, so Latin always renders in JB
      // Mono and Thai always renders in Sarabun regardless of OS. TlwgMono /
      // DejaVu Sans Mono are kept as Linux fallbacks for users who prefer
      // their distro's monospace Thai. unicode11 below handles cell width
      // math for combining vowels/tones.
      fontFamily:
        '"JetBrains Mono", "Sarabun", "TlwgMono", "DejaVu Sans Mono", "Sukhumvit Set", "Thonburi", Menlo, Monaco, "Courier New", monospace',
      scrollback: 10_000,
      theme: THEME,
      allowProposedApi: true,
      macOptionIsMeta: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    // Unicode 11 width tables — fixes Thai combining vowels/tones (zero-width)
    // and other complex scripts that the default Unicode 6 tables miscount,
    // which causes cursor offsets and overlapping glyphs in Thai/Arabic/etc.
    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = '11';
    term.open(host);
    termRef.current = term;
    fitRef.current = fitAddon;

    const inputDisposable = term.onData((data) => {
      void api.pty.write(sessionId, data);
    });
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      void api.pty.resize(sessionId, cols, rows);
    });

    // Phase 4b: rolling state for per-turn divider decorations. Each entry
    // owns a marker + a decoration; xterm tracks scroll position via the
    // marker so the divider sticks to the right row without us doing any
    // bookkeeping on onScroll. FIFO bounded by MAX_TURN_DIVIDERS — once we
    // hit the cap we dispose the oldest before adding a new one.
    const turnDividers: Array<{
      marker: IMarker;
      decoration: IDecoration;
    }> = [];
    // Suppress dividers that would fire on the SAME row we already
    // marked — claude redraws its prompt line on every keystroke, and
    // without this we'd register a fresh decoration per redraw.
    let lastTurnAbsY = -1;

    const tryRegisterTurnDivider = (): void => {
      try {
        // After write(), the cursor is AT the line that just gained the
        // prompt prefix. baseY shifts as the scrollback grows, so we
        // compute the absolute row index for dedup, and pass cursorYOffset
        // of 0 to anchor the marker on the current cursor row.
        const absY = term.buffer.active.baseY + term.buffer.active.cursorY;
        if (absY === lastTurnAbsY) return;
        const marker = term.registerMarker(0);
        if (!marker) return;
        const decoration = term.registerDecoration({
          marker,
          width: term.cols,
          height: 1,
          layer: 'bottom',
        });
        if (!decoration) {
          marker.dispose();
          return;
        }
        decoration.onRender((el) => {
          // Style the cell-wide decoration as a faint gradient hairline.
          // Pointer-events disabled so it never swallows clicks meant for
          // selection / link-following. The transform pulls the line down
          // so it visually sits BETWEEN turns rather than under the prompt.
          el.style.pointerEvents = 'none';
          el.style.background =
            'linear-gradient(90deg, transparent, rgb(var(--color-accent-rgb) / 0.38) 20%, rgb(var(--color-accent-rgb) / 0.18) 80%, transparent)';
          el.style.height = '1px';
          el.style.transform = 'translateY(-1px)';
          el.style.opacity = '0.55';
        });
        lastTurnAbsY = absY;
        turnDividers.push({ marker, decoration });
        if (turnDividers.length > MAX_TURN_DIVIDERS) {
          const stale = turnDividers.shift();
          stale?.decoration.dispose();
          stale?.marker.dispose();
        }
      } catch {
        // registerMarker / registerDecoration can throw if the terminal
        // is mid-teardown; swallow so a bad frame can't break the data
        // pipeline. The next chunk will get another chance.
      }
    };

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
            const writeLive = (data: string) => {
              term.write(data, () => {
                // Phase 4b: check for a turn-prompt prefix AFTER xterm has
                // parsed the chunk — the cursor is now on the row we want
                // to anchor the divider to. We test the raw chunk (not the
                // buffer) so claude's TUI redraws of OLD rows don't trigger
                // false positives.
                if (TURN_PROMPT_RE.test(data)) {
                  tryRegisterTurnDivider();
                }
              });
            };

            // Attach the data listener FIRST (after first fit, so writes
            // render at correct cols/rows), gated behind a replay barrier:
            // chunks arriving while the subscribe() invoke is in flight are
            // queued — writing them now would put them BEFORE their own
            // history once the replay lands.
            let replayApplied = false;
            const preReplayQueue: string[] = [];
            const dispose = api.pty.onData(sessionId, (data) => {
              if (disposed) return;
              if (!replayApplied) {
                preReplayQueue.push(data);
                return;
              }
              writeLive(data);
            });
            cleanup.dispose = dispose;

            // Pull the rolling buffer. Main adds this wc as a subscriber and
            // snapshots the buffer in one atomic turn, so everything after
            // the snapshot arrives only as onData events above.
            void api.pty
              .subscribe(sessionId)
              .catch(() => '') // session gone / IPC failure → just go live
              .then((replay) => {
                if (disposed) return;
                replayApplied = true;
                // History only — no turn-divider scan: replayed rows can't
                // be re-anchored reliably after a remount.
                if (replay) term.write(replay);
                // This wc has been a live subscriber since PTY_CREATE, so a
                // chunk evented while the invoke was in flight was emitted
                // BEFORE the snapshot — main appends to the buffer before
                // fanning out, so that chunk is already the replay's tail.
                // Only write the queue when it is NOT that tail (i.e. the
                // replay missed it), otherwise we'd duplicate output.
                const queued = preReplayQueue.join('');
                preReplayQueue.length = 0;
                if (queued && !replay.endsWith(queued)) writeLive(queued);
              });

            // Keep the ±1-col resize jolt: the replay restores xterm
            // scrollback, but tmux only repaints the live screen (alt-buffer
            // TUIs like claude) when it observes a size change.
            void api.pty.resize(sessionId, term.cols + 1, term.rows);
            void api.pty.resize(sessionId, term.cols, term.rows);
            term.refresh(0, term.rows - 1);
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
      // Phase 4b: dispose decoration markers before tearing down xterm so
      // we don't leak detached DOM nodes if Electron keeps the page alive
      // (HMR remount).
      for (const td of turnDividers) {
        td.decoration.dispose();
        td.marker.dispose();
      }
      turnDividers.length = 0;
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
