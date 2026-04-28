import { useEffect, useRef } from 'react';

import { cn } from '@renderer/lib/utils';

export interface TerminalMenuItem {
  id: string;
  label: string;
  hint?: string;
  // When set, the item renders as a separator and other fields are ignored.
  separator?: boolean;
  disabled?: boolean;
  danger?: boolean;
  onSelect?: () => void;
}

interface TerminalContextMenuProps {
  x: number;
  y: number;
  items: TerminalMenuItem[];
  onClose: () => void;
}

/**
 * Floating right-click menu for the Claude CLI / tmux pane. Plain React
 * (no Radix) so we can position it precisely at the click point and keep
 * the bundle inside the lazy xterm chunk.
 */
export function TerminalContextMenu({
  x,
  y,
  items,
  onClose,
}: TerminalContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDocClick, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDocClick, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  // Clamp inside the viewport so the menu never spills off-screen.
  const style: React.CSSProperties = (() => {
    const W = 240;
    const H = items.length * 28 + 12;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.min(x, vw - W - 8);
    const top = Math.min(y, vh - H - 8);
    return { left: Math.max(8, left), top: Math.max(8, top) };
  })();

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-[1000] min-w-[220px] rounded-[10px] border border-border bg-surface-2/95 p-1 shadow-[0_18px_40px_rgba(0,0,0,0.5)] backdrop-blur-md"
      style={style}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, idx) => {
        if (item.separator) {
          return (
            <div
              key={`sep-${idx}`}
              className="my-1 h-px bg-border-subtle"
              role="separator"
            />
          );
        }
        return (
          <button
            key={item.id}
            type="button"
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              item.onSelect?.();
              onClose();
            }}
            className={cn(
              'flex w-full items-center justify-between gap-3 rounded-[6px] px-2.5 py-[5px] text-left text-[12px] transition',
              item.disabled
                ? 'cursor-not-allowed text-text-muted opacity-60'
                : item.danger
                  ? 'text-[#fca5a5] hover:bg-[rgba(239,68,68,0.18)] hover:text-[#fee2e2]'
                  : 'text-text-secondary hover:bg-[rgba(76,141,255,0.18)] hover:text-text',
            )}
          >
            <span className="truncate">{item.label}</span>
            {item.hint && (
              <span className="font-mono text-[10px] text-text-muted">
                {item.hint}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
