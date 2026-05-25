import { useRef } from 'react';

/**
 * Dev-only render tracer for diagnosing re-render cascades.
 *
 * Why this exists: AppInner subscribes to many high-frequency store slices
 * (activeTabPath, chat-dock columns, layout toggles). Before v0.31.4 none of
 * the heavy view subsystems were memoized, so a single tab switch or Full-CLI
 * toggle re-rendered the entire shell (editor + chat dock + file tree + bottom
 * panel + agents rail). This tracer makes that cascade *measurable* — flip it
 * on, perform the interaction, and watch which components actually re-render.
 *
 * It is NOT gated on import.meta.env.DEV so it works in the packaged dmg too
 * (the only build users actually run). Cost when OFF is a single ref increment
 * + one boolean check per render — negligible. When ON it logs to the console.
 *
 * Toggle from the devtools console:
 *   localStorage.setItem('devspace:renderTrace', '1'); location.reload();
 *   // or, live without reload:
 *   window.__setRenderTrace(true);
 *   window.__setRenderTrace(false);
 */

let TRACE_ENABLED = (() => {
  try {
    return localStorage.getItem('devspace:renderTrace') === '1';
  } catch {
    return false;
  }
})();

if (typeof window !== 'undefined') {
  (window as unknown as { __setRenderTrace?: (on: boolean) => void }).__setRenderTrace =
    (on: boolean) => {
      TRACE_ENABLED = !!on;
      // eslint-disable-next-line no-console
      console.info(`[rtrace] ${on ? 'enabled' : 'disabled'}`);
    };
}

export function useRenderTrace(name: string): void {
  const count = useRef(0);
  const last = useRef(0);
  count.current += 1;
  if (TRACE_ENABLED) {
    const now = performance.now();
    const delta = last.current ? (now - last.current).toFixed(1) : '—';
    last.current = now;
    // eslint-disable-next-line no-console
    console.debug(`[rtrace] ${name} #${count.current} (+${delta}ms)`);
  }
}
