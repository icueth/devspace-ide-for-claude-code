import { Sparkles, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@renderer/lib/api';

// v0.36.0 — small, non-blocking toast surface for resource-management
// events. The only producer right now is the PtyPool idle reaper firing
// `pty:auto-closed` — but the host is built as a stack so future signals
// (manual cleanup, OOM warnings, etc.) can be slotted in without a
// second component. Bottom-right, fixed, z-50, ignores layout.
//
// Roughly 400 MB per closed tab is a rule-of-thumb (claude ≈245 MB +
// commonly Playwright MCP ≈165 MB). We surface it with "≈" so users
// understand it's an estimate, not a measurement.
const PER_TAB_FREED_MB = 400;
const TOAST_LIFETIME_MS = 5000;

interface Toast {
  id: number;
  message: string;
  // ms-epoch when the toast was pushed — used by the auto-dismiss timer.
  createdAt: number;
}

let nextId = 1;

export function ResourceToastHost(): JSX.Element | null {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Track timers per-toast id so a click-to-dismiss tears the timer
  // down too (no late setState on an already-removed toast).
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    const t = timersRef.current.get(id);
    if (t) {
      clearTimeout(t);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (message: string) => {
      const id = nextId++;
      setToasts((prev) => [...prev, { id, message, createdAt: Date.now() }]);
      const handle = setTimeout(() => dismiss(id), TOAST_LIFETIME_MS);
      timersRef.current.set(id, handle);
    },
    [dismiss],
  );

  useEffect(() => {
    const off = api.pty.onAutoClosed((ev) => {
      const count = ev.ids?.length ?? 0;
      if (count <= 0) return;
      const freedMb = count * PER_TAB_FREED_MB;
      const noun = count === 1 ? 'idle CLI tab' : 'idle CLI tabs';
      push(`Closed ${count} ${noun} · ≈${freedMb} MB freed`);
    });
    return () => {
      off();
      // Tear down any in-flight timers when the host unmounts (rare —
      // it's app-root scoped — but cleanup-on-unmount is the rule).
      for (const handle of timersRef.current.values()) clearTimeout(handle);
      timersRef.current.clear();
    };
  }, [push]);

  if (toasts.length === 0) return null;

  return (
    <div
      // Fixed bottom-right stack with vertical gap between toasts. Pointer
      // events on individual toasts only — the wrapper passes clicks
      // through to whatever's underneath.
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2"
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="pointer-events-auto flex max-w-[360px] items-start gap-2 rounded-[10px] border border-border bg-surface-2/95 px-3 py-2 text-[12px] text-text shadow-[0_8px_24px_rgba(0,0,0,0.35)] backdrop-blur animate-in fade-in slide-in-from-bottom-2 duration-200"
          role="status"
        >
          <Sparkles
            size={13}
            className="mt-[1px] shrink-0 text-[var(--color-accent-2)]"
            aria-hidden
          />
          <span className="flex-1 leading-snug">{toast.message}</span>
          <button
            type="button"
            onClick={() => dismiss(toast.id)}
            className="ml-1 -mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] text-text-muted transition hover:bg-surface-3 hover:text-text"
            aria-label="Dismiss"
            title="Dismiss"
          >
            <X size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}
