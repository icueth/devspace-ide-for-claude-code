import { useEffect, useRef } from 'react';

interface ResizerProps {
  direction: 'horizontal' | 'vertical';
  onResize: (deltaPx: number) => void;
  onResizeEnd?: () => void;
}

/**
 * Draggable handle that reports per-frame delta pixels to the parent.
 *
 * The callbacks are stored in refs so the window-level pointermove listener
 * added on pointerdown is never torn down mid-drag — a store update inside
 * onResize causes the parent to rerender, which on a useCallback-based impl
 * invalidates the listener just as the user is dragging and the drag "dies".
 */
export function Resizer({ direction, onResize, onResizeEnd }: ResizerProps) {
  const onResizeRef = useRef(onResize);
  const onResizeEndRef = useRef(onResizeEnd);

  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);
  useEffect(() => {
    onResizeEndRef.current = onResizeEnd;
  }, [onResizeEnd]);

  // Drag state lives in refs so handlers never read stale values.
  const startXRef = useRef<number | null>(null);
  const lastDeltaRef = useRef(0);
  const moveHandlerRef = useRef<((e: PointerEvent) => void) | null>(null);
  const upHandlerRef = useRef<((e: PointerEvent) => void) | null>(null);

  // Clean up any lingering listeners if the component unmounts mid-drag.
  useEffect(() => {
    return () => {
      if (moveHandlerRef.current) {
        window.removeEventListener('pointermove', moveHandlerRef.current);
      }
      if (upHandlerRef.current) {
        window.removeEventListener('pointerup', upHandlerRef.current);
      }
    };
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const axisStart = direction === 'horizontal' ? e.clientX : e.clientY;
    startXRef.current = axisStart;
    lastDeltaRef.current = 0;
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: PointerEvent) => {
      if (startXRef.current == null) return;
      const cur = direction === 'horizontal' ? ev.clientX : ev.clientY;
      const delta = cur - startXRef.current;
      const step = delta - lastDeltaRef.current;
      lastDeltaRef.current = delta;
      if (step !== 0) onResizeRef.current(step);
    };
    const onUp = () => {
      startXRef.current = null;
      lastDeltaRef.current = 0;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (moveHandlerRef.current) {
        window.removeEventListener('pointermove', moveHandlerRef.current);
      }
      if (upHandlerRef.current) {
        window.removeEventListener('pointerup', upHandlerRef.current);
      }
      moveHandlerRef.current = null;
      upHandlerRef.current = null;
      onResizeEndRef.current?.();
    };

    moveHandlerRef.current = onMove;
    upHandlerRef.current = onUp;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const isH = direction === 'horizontal';
  return (
    <div
      onPointerDown={onPointerDown}
      className={
        isH
          ? 'relative z-20 w-1 shrink-0 cursor-col-resize bg-border-subtle transition hover:bg-accent/60'
          : 'relative z-20 h-1 shrink-0 cursor-row-resize bg-border-subtle transition hover:bg-accent/60'
      }
      role="separator"
      aria-orientation={isH ? 'vertical' : 'horizontal'}
    >
      <span
        aria-hidden
        className={
          isH
            ? 'absolute -left-2 -right-2 top-0 bottom-0'
            : 'absolute -top-2 -bottom-2 left-0 right-0'
        }
        style={{ cursor: isH ? 'col-resize' : 'row-resize' }}
      />
    </div>
  );
}
