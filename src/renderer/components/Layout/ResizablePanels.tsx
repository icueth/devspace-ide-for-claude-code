import type { ReactNode } from 'react';

import { cn } from '@renderer/lib/utils';
import { useLayoutStore } from '@renderer/state/layout';

/**
 * Width-owning leaf wrappers for the two drag-resizable panels.
 *
 * Why these exist (perf): the Resizer fires `onResize` on every pointermove
 * during a drag → the layout store's `sidebarWidth`/`dockWidth` updates ~60×/s.
 * If the component that READS those values is `AppInner` (which renders the
 * entire app tree inline), every tick reconciles FileTree + EditorArea +
 * ClaudeCliDock + BottomPanel → dropped frames.
 *
 * By subscribing to the width HERE and taking the panel contents as
 * `children`, a width change re-renders only this wrapper. `children` is built
 * by AppInner; since AppInner no longer reads the width it doesn't re-render
 * during a drag, so the child vnodes are referentially stable and React skips
 * reconciling them — only this one DOM node's `width` updates per frame.
 *
 * Note: there is intentionally NO `transition-[width]` here. Collapse/expand is
 * implemented as mount/unmount of separate elements (the thin rail vs. the full
 * panel in App.tsx), so a width transition never animated the collapse anyway —
 * it only added rubber-band lag during drag, px↔flex jank on the Full CLI
 * toggle, and a double-animation stutter when macOS resizes the window on
 * fullscreen (the dock is `flex-1` in full/focus mode). Removing it makes width
 * changes track 1:1.
 */

export function SidebarSection({ children }: { children: ReactNode }) {
  const width = useLayoutStore((s) => s.sidebarWidth);
  return (
    <aside
      style={{ width }}
      className="no-drag relative flex shrink-0 flex-col border-r border-border bg-surface-sidebar"
    >
      {children}
    </aside>
  );
}

export function DockSection({
  full,
  children,
}: {
  full: boolean;
  children: ReactNode;
}) {
  const width = useLayoutStore((s) => s.dockWidth);
  return (
    <section
      style={full ? undefined : { width }}
      className={cn(
        'no-drag relative flex flex-col border-l border-border bg-surface',
        full ? 'min-w-0 flex-1' : 'shrink-0',
      )}
    >
      {children}
    </section>
  );
}
