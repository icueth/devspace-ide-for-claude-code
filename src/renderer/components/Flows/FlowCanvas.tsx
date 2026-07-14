import { Maximize2, Minus, Plus } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { FlowEdges } from '@renderer/components/Flows/FlowEdges';
import { FlowNodeCard } from '@renderer/components/Flows/FlowNodeCard';
import {
  ContextMenu,
  type Menu,
  ZoomBtn,
} from '@renderer/components/Flows/FlowCanvasChrome';
import { graphBounds } from '@renderer/components/Flows/flowGeometry';
import type {
  FlowEdge,
  FlowGraph,
  FlowNodeKind,
  FlowNodeRun,
  FlowNodeStatus,
} from '@shared/flowTypes';

const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2;

interface Props {
  graph: FlowGraph;
  statuses: Record<string, FlowNodeStatus>;
  nodeRuns: Record<string, FlowNodeRun>;
  sessionKeys: Record<string, string>;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  onMoveNode: (id: string, x: number, y: number) => void;
  onAddNode: (x: number, y: number, kind?: FlowNodeKind) => void;
  onConnect: (from: string, to: string, branch?: FlowEdge['branch']) => void;
  onDeleteNode: (id: string) => void;
  onOpenSession: (nodeId: string) => void;
}

type Drag =
  | { kind: 'pan'; sx: number; sy: number }
  | { kind: 'node'; id: string; ox: number; oy: number }
  | { kind: 'wire'; from: string; branch?: FlowEdge['branch'] };

type Wire = { from: string; branch?: FlowEdge['branch']; x: number; y: number };

export function FlowCanvas({
  graph,
  statuses,
  nodeRuns,
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
  const [wire, setWire] = useState<Wire | null>(null);

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
    const b = graphBounds(graph.nodes);
    if (!r || !b) return;
    const pad = 56;
    const z = Math.min(
      1.15,
      Math.max(
        MIN_ZOOM,
        Math.min(
          (r.width - pad * 2) / Math.max(1, b.maxX - b.minX),
          (r.height - pad * 2) / Math.max(1, b.maxY - b.minY),
        ),
      ),
    );
    setZoom(z);
    setPan({
      x: (r.width - (b.maxX - b.minX) * z) / 2 - b.minX * z,
      y: (r.height - (b.maxY - b.minY) * z) / 2 - b.minY * z,
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
        setWire({ from: d.from, branch: d.branch, x: wx, y: wy });
      }
    };
    const onUp = (e: PointerEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (d?.kind !== 'wire') return;
      setWire(null);
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const target = el?.closest('[data-node-id]')?.getAttribute('data-node-id');
      // The store rejects illegal wires (self, note, fail→non-agent) — the
      // canvas only reports the gesture.
      if (target && target !== d.from) onConnect(d.from, target, d.branch);
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
      (e.target as HTMLElement)
        .closest('[data-node-id]')
        ?.getAttribute('data-node-id') ?? null;
    setMenu({ clientX: e.clientX, clientY: e.clientY, worldX: wx, worldY: wy, nodeId });
  };

  return (
    <div
      ref={viewportRef}
      onPointerDown={onViewportPointerDown}
      onContextMenu={onContextMenu}
      className="relative min-h-0 flex-1 overflow-hidden bg-surface"
      style={{
        backgroundImage:
          'radial-gradient(circle, var(--color-border) 1px, transparent 1px)',
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
        <FlowEdges graph={graph} statuses={statuses} wire={wire} />

        {graph.nodes.map((node) => (
          <FlowNodeCard
            key={node.id}
            node={node}
            status={statuses[node.id]}
            nodeRun={nodeRuns[node.id] ?? null}
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
            onPortPointerDown={(e, branch) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              dragRef.current = { kind: 'wire', from: node.id, branch };
              const [wx, wy] = clientToWorld(e.clientX, e.clientY);
              setWire({ from: node.id, branch, x: wx, y: wy });
            }}
          />
        ))}
      </div>

      <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-border bg-surface-2/90 px-4 py-1.5 text-[11px] text-text-muted backdrop-blur">
        <b className="font-medium text-accent">Right-click</b> add agent / gate / note ·{' '}
        <b className="font-medium text-accent">drag a right port</b> to connect ·{' '}
        <b className="font-medium text-accent">scroll</b> to zoom
      </div>

      <div className="absolute bottom-3 right-3 flex items-center gap-px overflow-hidden rounded-md border border-border bg-surface-3">
        <ZoomBtn
          label="Zoom out"
          onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / 1.15))}
        >
          <Minus size={12} />
        </ZoomBtn>
        <span className="px-1.5 font-mono text-[10px] text-text-dim">
          {Math.round(zoom * 100)}%
        </span>
        <ZoomBtn
          label="Zoom in"
          onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 1.15))}
        >
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
