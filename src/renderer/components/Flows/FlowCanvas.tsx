import { Maximize2, Minus, Plus } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { FlowNodeCard, NODE_H, NODE_W } from '@renderer/components/Flows/FlowNodeCard';
import { cn } from '@renderer/lib/utils';
import type { FlowGraph, FlowNodeStatus } from '@shared/flowTypes';

const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2;

interface Props {
  graph: FlowGraph;
  statuses: Record<string, FlowNodeStatus>;
  sessionKeys: Record<string, string>;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  onMoveNode: (id: string, x: number, y: number) => void;
  onAddNode: (x: number, y: number) => void;
  onConnect: (from: string, to: string) => void;
  onDeleteNode: (id: string) => void;
  onOpenSession: (nodeId: string) => void;
}

type Drag =
  | { kind: 'pan'; sx: number; sy: number }
  | { kind: 'node'; id: string; ox: number; oy: number }
  | { kind: 'wire'; from: string };

interface Menu {
  clientX: number;
  clientY: number;
  worldX: number;
  worldY: number;
  nodeId: string | null;
}

/** Port anchors in world coords — the fixed card geometry, no DOM measuring. */
const outPort = (n: { x: number; y: number }): [number, number] => [
  n.x + NODE_W,
  n.y + NODE_H / 2,
];
const inPort = (n: { x: number; y: number }): [number, number] => [
  n.x,
  n.y + NODE_H / 2,
];

function bezier(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(70, Math.abs(x2 - x1) * 0.45);
  return `M${x1} ${y1} C${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

/** Cubic-bezier midpoint: B(0.5) = (P0 + 3P1 + 3P2 + P3) / 8. */
function bezierMid(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): [number, number] {
  const dx = Math.max(70, Math.abs(x2 - x1) * 0.45);
  const mx = (x1 + 3 * (x1 + dx) + 3 * (x2 - dx) + x2) / 8;
  const my = (y1 + 3 * y1 + 3 * y2 + y2) / 8;
  return [mx, my];
}

export function FlowCanvas({
  graph,
  statuses,
  sessionKeys,
  selectedNodeId,
  onSelectNode,
  onMoveNode,
  onAddNode,
  onConnect,
  onDeleteNode,
  onOpenSession,
}: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 40, y: 40 });
  const [menu, setMenu] = useState<Menu | null>(null);
  const [wire, setWire] = useState<{ from: string; x: number; y: number } | null>(
    null,
  );

  // Drag lives in a ref: pointermove fires far faster than React can commit,
  // and the handler must read the CURRENT gesture, not a closed-over snapshot.
  const dragRef = useRef<Drag | null>(null);
  const viewRef = useRef({ zoom, pan });
  viewRef.current = { zoom, pan };

  const clientToWorld = useCallback((cx: number, cy: number): [number, number] => {
    const r = viewportRef.current?.getBoundingClientRect();
    const { zoom: z, pan: p } = viewRef.current;
    if (!r) return [0, 0];
    return [(cx - r.left - p.x) / z, (cy - r.top - p.y) / z];
  }, []);

  const fitView = useCallback(() => {
    const r = viewportRef.current?.getBoundingClientRect();
    if (!r || graph.nodes.length === 0) return;
    const xs = graph.nodes.map((n) => n.x);
    const ys = graph.nodes.map((n) => n.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs.map((x) => x + NODE_W));
    const maxY = Math.max(...ys.map((y) => y + NODE_H));
    const pad = 56;
    const z = Math.min(
      1.15,
      Math.max(
        MIN_ZOOM,
        Math.min(
          (r.width - pad * 2) / Math.max(1, maxX - minX),
          (r.height - pad * 2) / Math.max(1, maxY - minY),
        ),
      ),
    );
    setZoom(z);
    setPan({
      x: (r.width - (maxX - minX) * z) / 2 - minX * z,
      y: (r.height - (maxY - minY) * z) / 2 - minY * z,
    });
  }, [graph.nodes]);

  // Frame the graph when the flow changes (not on every node edit).
  useLayoutEffect(() => {
    fitView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph.id]);

  // Wheel zoom around the cursor. Registered imperatively because React's
  // onWheel is passive — preventDefault there is a no-op and the whole
  // workbench would scroll instead of the canvas zooming.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      const { zoom: z, pan: p } = viewRef.current;
      const wx = (mx - p.x) / z;
      const wy = (my - p.y) / z;
      const next = Math.min(
        MAX_ZOOM,
        Math.max(MIN_ZOOM, z * (e.deltaY < 0 ? 1.08 : 0.926)),
      );
      setZoom(next);
      setPan({ x: mx - wx * next, y: my - wy * next });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Global move/up: the pointer routinely leaves the node (or the viewport)
  // mid-drag, so the gesture cannot be owned by the element it started on.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (d.kind === 'pan') {
        setPan({ x: e.clientX - d.sx, y: e.clientY - d.sy });
      } else if (d.kind === 'node') {
        const [wx, wy] = clientToWorld(e.clientX, e.clientY);
        onMoveNode(d.id, wx - d.ox, wy - d.oy);
      } else {
        const [wx, wy] = clientToWorld(e.clientX, e.clientY);
        setWire({ from: d.from, x: wx, y: wy });
      }
    };
    const onUp = (e: PointerEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (d?.kind !== 'wire') return;
      setWire(null);
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const target = el?.closest('[data-node-id]')?.getAttribute('data-node-id');
      if (target && target !== d.from) onConnect(d.from, target);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [clientToWorld, onMoveNode, onConnect]);

  const onViewportPointerDown = (e: React.PointerEvent) => {
    setMenu(null);
    if (e.button !== 0) return;
    const nodeEl = (e.target as HTMLElement).closest('[data-node-id]');
    if (nodeEl) return; // node/port handlers own the gesture
    onSelectNode(null);
    dragRef.current = {
      kind: 'pan',
      sx: e.clientX - pan.x,
      sy: e.clientY - pan.y,
    };
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const [wx, wy] = clientToWorld(e.clientX, e.clientY);
    const nodeId =
      (e.target as HTMLElement).closest('[data-node-id]')?.getAttribute('data-node-id') ??
      null;
    setMenu({ clientX: e.clientX, clientY: e.clientY, worldX: wx, worldY: wy, nodeId });
  };

  return (
    <div
      ref={viewportRef}
      onPointerDown={onViewportPointerDown}
      onContextMenu={onContextMenu}
      className="relative flex-1 overflow-hidden bg-surface"
      style={{
        backgroundImage: 'radial-gradient(circle, var(--color-border) 1px, transparent 1px)',
        backgroundSize: `${22 * zoom}px ${22 * zoom}px`,
        backgroundPosition: `${pan.x}px ${pan.y}px`,
      }}
    >
      <div
        className="absolute left-0 top-0"
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: '0 0',
        }}
      >
        <svg width={1} height={1} style={{ overflow: 'visible' }} aria-hidden>
          <defs>
            <marker id="fl-arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0 0 L8 4 L0 8 z" fill="var(--color-border-hi)" />
            </marker>
            <marker id="fl-arr-run" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0 0 L8 4 L0 8 z" fill="var(--color-accent)" />
            </marker>
            {/* semantic.error is a literal in tailwind.config (no CSS var). */}
            <marker id="fl-arr-fail" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0 0 L8 4 L0 8 z" fill="#ef4444" />
            </marker>
          </defs>

          {graph.edges.map((edge) => {
            const a = graph.nodes.find((n) => n.id === edge.from);
            const b = graph.nodes.find((n) => n.id === edge.to);
            if (!a || !b) return null;
            const [x1, y1] = outPort(a);
            const [x2, y2] = inPort(b);
            const failed = statuses[edge.from] === 'failed';
            const active = statuses[edge.to] === 'running';
            const [mx, my] = bezierMid(x1, y1, x2, y2);
            return (
              <g key={`${edge.from}->${edge.to}`}>
                <path
                  d={bezier(x1, y1, x2, y2)}
                  fill="none"
                  strokeWidth={1.6}
                  className={cn(
                    failed
                      ? 'stroke-semantic-error'
                      : active
                        ? 'stroke-accent'
                        : 'stroke-border-hi',
                  )}
                  strokeDasharray={active ? '6 5' : undefined}
                  markerEnd={`url(#${failed ? 'fl-arr-fail' : active ? 'fl-arr-run' : 'fl-arr'})`}
                />
                {edge.label && (
                  <text
                    x={mx}
                    y={my - 6}
                    textAnchor="middle"
                    className={cn(
                      'font-mono text-[9.5px]',
                      active ? 'fill-accent' : 'fill-[var(--color-text-dim)]',
                    )}
                  >
                    {edge.label}
                  </text>
                )}
              </g>
            );
          })}

          {wire &&
            (() => {
              const from = graph.nodes.find((n) => n.id === wire.from);
              if (!from) return null;
              const [x1, y1] = outPort(from);
              return (
                <path
                  d={bezier(x1, y1, wire.x, wire.y)}
                  fill="none"
                  strokeWidth={1.6}
                  strokeDasharray="5 5"
                  className="stroke-accent"
                />
              );
            })()}
        </svg>

        {graph.nodes.map((node) => (
          <FlowNodeCard
            key={node.id}
            node={node}
            status={statuses[node.id]}
            selected={selectedNodeId === node.id}
            hasSession={!!sessionKeys[node.id]}
            onOpenSession={() => onOpenSession(node.id)}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              onSelectNode(node.id);
              const [wx, wy] = clientToWorld(e.clientX, e.clientY);
              dragRef.current = {
                kind: 'node',
                id: node.id,
                ox: wx - node.x,
                oy: wy - node.y,
              };
            }}
            onPortPointerDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              dragRef.current = { kind: 'wire', from: node.id };
              const [wx, wy] = clientToWorld(e.clientX, e.clientY);
              setWire({ from: node.id, x: wx, y: wy });
            }}
          />
        ))}
      </div>

      <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-border bg-surface-2/90 px-4 py-1.5 text-[11px] text-text-muted backdrop-blur">
        <b className="font-medium text-accent">Right-click</b> add agent ·{' '}
        <b className="font-medium text-accent">drag the right port</b> to connect ·{' '}
        <b className="font-medium text-accent">scroll</b> to zoom
      </div>

      <div className="absolute bottom-3 right-3 flex items-center gap-px overflow-hidden rounded-md border border-border bg-surface-3">
        <ZoomBtn label="Zoom out" onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / 1.15))}>
          <Minus size={12} />
        </ZoomBtn>
        <span className="px-1.5 font-mono text-[10px] text-text-dim">
          {Math.round(zoom * 100)}%
        </span>
        <ZoomBtn label="Zoom in" onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 1.15))}>
          <Plus size={12} />
        </ZoomBtn>
        <ZoomBtn label="Fit view" onClick={fitView}>
          <Maximize2 size={12} />
        </ZoomBtn>
      </div>

      {menu && (
        <ContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onAddNode={onAddNode}
          onDeleteNode={onDeleteNode}
        />
      )}
    </div>
  );
}

function ZoomBtn({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex h-6 w-7 items-center justify-center text-text-muted transition hover:bg-accent/10 hover:text-accent"
    >
      {children}
    </button>
  );
}

function ContextMenu({
  menu,
  onClose,
  onAddNode,
  onDeleteNode,
}: {
  menu: Menu;
  onClose: () => void;
  onAddNode: (x: number, y: number) => void;
  onDeleteNode: (id: string) => void;
}) {
  return (
    <>
      <div className="fixed inset-0 z-40" onPointerDown={onClose} />
      <div
        role="menu"
        style={{ left: menu.clientX, top: menu.clientY }}
        className="fixed z-50 min-w-[188px] rounded-lg border border-border-emphasis bg-surface-3 p-1 shadow-2xl shadow-black/60"
      >
        <MenuItem
          onClick={() => {
            onAddNode(menu.worldX - NODE_W / 2, menu.worldY - NODE_H / 2);
            onClose();
          }}
        >
          Add Agent
        </MenuItem>
        {/* The phase-1 FlowNode schema has no note kind — persisting one would
            make main try to RUN it as an agent. Ships in phase 2. */}
        <MenuItem disabled title="Notes arrive in phase 2">
          Add Note
        </MenuItem>
        {menu.nodeId && (
          <>
            <hr className="my-1 border-border" />
            <MenuItem
              danger
              onClick={() => {
                onDeleteNode(menu.nodeId!);
                onClose();
              }}
            >
              Delete node
            </MenuItem>
          </>
        )}
      </div>
    </>
  );
}

function MenuItem({
  children,
  onClick,
  disabled,
  danger,
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn(
        'flex w-full items-center rounded px-2.5 py-1.5 text-left text-[12.5px] transition',
        disabled
          ? 'cursor-default text-text-dim'
          : danger
            ? 'text-semantic-error hover:bg-semantic-error/10'
            : 'text-text hover:bg-accent/10',
      )}
    >
      {children}
    </button>
  );
}
