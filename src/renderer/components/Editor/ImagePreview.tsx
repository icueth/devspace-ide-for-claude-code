import { Maximize2, Minus, Plus, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '@renderer/lib/utils';
import type { EditorTab } from '@renderer/state/editor';

interface ImagePreviewProps {
  tab: EditorTab;
}

const MIN_SCALE = 0.1;
const MAX_SCALE = 16;

function formatBytes(n?: number): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function ImagePreview({ tab }: ImagePreviewProps) {
  const [scale, setScale] = useState(1);
  const [fit, setFit] = useState(true);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(
    null,
  );

  // Reset when a new image is opened (different tab.path or new dataUrl).
  useEffect(() => {
    setScale(1);
    setFit(true);
    setOffset({ x: 0, y: 0 });
  }, [tab.path, tab.dataUrl]);

  const zoomAt = useCallback((mult: number, clientX?: number, clientY?: number) => {
    setFit(false);
    setScale((prev) => {
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, prev * mult));
      if (containerRef.current && clientX != null && clientY != null) {
        // Zoom toward the cursor — keeps the pixel under the cursor fixed.
        const rect = containerRef.current.getBoundingClientRect();
        const relX = clientX - rect.left - rect.width / 2;
        const relY = clientY - rect.top - rect.height / 2;
        setOffset((o) => ({
          x: o.x - relX * (next / prev - 1),
          y: o.y - relY * (next / prev - 1),
        }));
      }
      return next;
    });
  }, []);

  // React's synthetic `onWheel` is attached as a passive listener, so we can't
  // preventDefault there. Register a native wheel listener with passive:false
  // so Cmd+wheel zoom doesn't also scroll the outer surface.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const mult = Math.pow(1.0015, -e.deltaY);
      zoomAt(mult, e.clientX, e.clientY);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [zoomAt]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (fit) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: offset.x,
      origY: offset.y,
    };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setOffset({ x: d.origX + (e.clientX - d.startX), y: d.origY + (e.clientY - d.startY) });
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    dragRef.current = null;
  };

  const reset = () => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
    setFit(true);
  };

  if (!tab.dataUrl) {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-text-muted">
        Decoding image…
      </div>
    );
  }

  const imgStyle = fit
    ? { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' as const }
    : {
        transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) scale(${scale})`,
        transformOrigin: 'center center',
        position: 'absolute' as const,
        top: '50%',
        left: '50%',
        maxWidth: 'none',
        maxHeight: 'none',
      };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={containerRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className={cn(
          'relative min-h-0 flex-1 overflow-hidden',
          fit ? 'flex items-center justify-center p-6' : 'cursor-grab active:cursor-grabbing',
        )}
        style={{
          backgroundImage:
            "url('data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20width%3D%2220%22%20height%3D%2220%22%3E%3Crect%20width%3D%2210%22%20height%3D%2210%22%20fill%3D%22%23111827%22/%3E%3Crect%20x%3D%2210%22%20y%3D%2210%22%20width%3D%2210%22%20height%3D%2210%22%20fill%3D%22%23111827%22/%3E%3Crect%20x%3D%2210%22%20width%3D%2210%22%20height%3D%2210%22%20fill%3D%22%230b0d12%22/%3E%3Crect%20y%3D%2210%22%20width%3D%2210%22%20height%3D%2210%22%20fill%3D%22%230b0d12%22/%3E%3C/svg%3E')",
        }}
      >
        <img
          src={tab.dataUrl}
          alt={tab.name}
          draggable={false}
          onLoad={(e) => {
            const el = e.currentTarget;
            setDims({ w: el.naturalWidth, h: el.naturalHeight });
          }}
          style={{ ...imgStyle, imageRendering: scale >= 4 ? 'pixelated' : 'auto' }}
          className="select-none"
        />
      </div>

      <div className="flex h-8 shrink-0 items-center justify-between gap-3 border-t border-border-subtle bg-surface-sidebar px-3 text-[11px] text-text-muted">
        <div className="flex items-center gap-3">
          {dims && (
            <span>
              {dims.w} × {dims.h}
            </span>
          )}
          <span>{formatBytes(tab.size)}</span>
          <span>{fit ? 'Fit' : `${Math.round(scale * 100)}%`}</span>
        </div>
        <div className="flex items-center gap-1">
          <ToolBtn onClick={() => zoomAt(0.8)} title="Zoom out (Cmd+wheel down)">
            <Minus size={12} />
          </ToolBtn>
          <ToolBtn onClick={() => zoomAt(1.25)} title="Zoom in (Cmd+wheel up)">
            <Plus size={12} />
          </ToolBtn>
          <ToolBtn onClick={reset} title="Fit to pane">
            <Maximize2 size={12} />
          </ToolBtn>
          <ToolBtn
            onClick={() => {
              setFit(false);
              setScale(1);
              setOffset({ x: 0, y: 0 });
            }}
            title="Actual size (100%)"
          >
            <RotateCcw size={12} />
          </ToolBtn>
        </div>
      </div>
    </div>
  );
}

interface ToolBtnProps {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}

function ToolBtn({ onClick, title, children }: ToolBtnProps) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="flex h-6 w-6 items-center justify-center rounded text-text-muted transition hover:bg-surface-raised hover:text-text"
    >
      {children}
    </button>
  );
}
