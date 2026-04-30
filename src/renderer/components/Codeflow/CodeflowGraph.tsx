import * as d3 from 'd3';
import {
  Braces,
  Brain,
  CircleSlash,
  FileCode,
  Loader2,
  RefreshCw,
  Sparkles,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import type {
  CodeflowEdgeKind,
  CodeflowFunctionGraph,
  CodeflowGraph,
  CodeflowGraphEdge,
  CodeflowGraphNode,
  CodeflowLayer,
} from '@shared/types';

interface CodeflowGraphViewProps {
  projectPath: string;
  visible: boolean;
}

type ColorMode = 'layer' | 'folder';
type ViewMode = 'files' | 'functions';

// Layer palette — distinct hues so a glance at the canvas tells you the
// architecture's shape even before you read any node label.
const LAYER_COLORS: Record<CodeflowLayer, string> = {
  ui: '#60a5fa',       // blue — components / pages / renderer
  api: '#f472b6',      // pink — handlers / IPC / endpoints
  service: '#a78bfa',  // violet — business logic
  model: '#fb923c',    // orange — types / schemas
  util: '#34d399',     // green — helpers
  test: '#94a3b8',     // gray — tests
  config: '#fbbf24',   // yellow — config
  tool: '#22d3ee',     // cyan — scripts / tooling
  other: '#6b7280',    // neutral — fallback
};

// Stable folder palette: hash the folder name into a fixed hue so the same
// folder is the same color across different runs.
function folderColor(folder: string): string {
  let hash = 0;
  for (let i = 0; i < folder.length; i++) {
    hash = (hash * 31 + folder.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 65% 60%)`;
}

// Soft-edge palette — each kind gets a distinct color so the user can read
// the augmented overlay at a glance. Stays softer than the static-import
// stroke so the original graph still reads as the "spine".
const EDGE_KIND_COLORS: Record<CodeflowEdgeKind, string> = {
  import: 'rgba(255,255,255,0.12)',
  event: '#fb923c',     // orange — pub/sub
  plugin: '#22d3ee',    // cyan — registries / loaders
  config: '#fbbf24',    // yellow — configuration coupling
  dynamic: '#a78bfa',   // violet — dynamic dispatch / DI
  inferred: '#f472b6',  // pink — fallback bucket
};

const EDGE_KIND_LABELS: Record<CodeflowEdgeKind, string> = {
  import: 'Imports',
  event: 'Events',
  plugin: 'Plugins',
  config: 'Config',
  dynamic: 'Dynamic',
  inferred: 'Inferred',
};

interface SimNode extends CodeflowGraphNode, d3.SimulationNodeDatum {}

// d3.SimulationLinkDatum's source/target start as the node id (string) and
// d3 mutates them into actual node objects after the first tick. Typing
// allows both states.
interface SimEdge
  extends Omit<CodeflowGraphEdge, 'source' | 'target'>,
    d3.SimulationLinkDatum<SimNode> {
  source: string | SimNode;
  target: string | SimNode;
}

type AugmentStatus = 'idle' | 'running' | 'cancelled' | 'error';

export function CodeflowGraphView({ projectPath, visible }: CodeflowGraphViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const simRef = useRef<d3.Simulation<SimNode, SimEdge> | null>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const [graph, setGraph] = useState<CodeflowGraph | null>(null);
  const [functionGraph, setFunctionGraph] = useState<CodeflowFunctionGraph | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('files');
  const [hideOrphans, setHideOrphans] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [colorMode, setColorMode] = useState<ColorMode>('layer');
  const [hovered, setHovered] = useState<CodeflowGraphNode | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [softEdges, setSoftEdges] = useState<CodeflowGraphEdge[]>([]);
  const [augmentStatus, setAugmentStatus] = useState<AugmentStatus>('idle');
  const [augmentMessage, setAugmentMessage] = useState<string>('');
  const [augmentError, setAugmentError] = useState<string | null>(null);
  // Per-kind visibility toggles. Default everything on.
  const [edgeKindVisible, setEdgeKindVisible] = useState<
    Record<CodeflowEdgeKind, boolean>
  >({
    import: true,
    event: true,
    plugin: true,
    config: true,
    dynamic: true,
    inferred: true,
  });

  // Auto-load on first show. Replays whenever the project path changes.
  useEffect(() => {
    if (!visible || !projectPath || loading || graph) return;
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, projectPath]);

  // Lazy-fetch the function graph the first time the user flips into
  // Functions mode. Function-level analysis is heavier (10-50x more nodes
  // on a real codebase), so we don't pay the cost until asked.
  useEffect(() => {
    if (viewMode !== 'functions' || !projectPath || functionGraph || loading) return;
    setLoading(true);
    setError(null);
    void api.codeflow
      .buildFunctionGraph(projectPath)
      .then((fg) => setFunctionGraph(fg))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [viewMode, projectPath, functionGraph, loading]);

  // Project change invalidates current graph and any augment overlay.
  useEffect(() => {
    setGraph(null);
    setFunctionGraph(null);
    setSelected(null);
    setHovered(null);
    setSoftEdges([]);
    setAugmentStatus('idle');
    setAugmentMessage('');
    setAugmentError(null);
  }, [projectPath]);

  const reload = useCallback(async () => {
    if (!projectPath) return;
    setLoading(true);
    setError(null);
    setAugmentStatus('idle');
    setAugmentError(null);
    try {
      const g = await api.codeflow.buildGraph(projectPath);
      setGraph(g);
      // Re-hydrate soft edges from disk if we have a saved augment that
      // matches the new fingerprint. Mismatch means the codebase has
      // shifted enough that the cache is stale; we drop it and let the
      // user re-augment when they want.
      const cached = await api.codeflow.augmentLoad(
        projectPath,
        g.stats.fingerprint,
      );
      if (cached) {
        setSoftEdges(cached.softEdges);
        setAugmentMessage(
          `Loaded ${cached.softEdges.length} cached soft edge${cached.softEdges.length === 1 ? '' : 's'} (${formatRelative(cached.savedAt)}).`,
        );
      } else {
        setSoftEdges([]);
        setAugmentMessage('');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  const augment = useCallback(async () => {
    if (!projectPath || !graph || augmentStatus === 'running') return;
    setAugmentStatus('running');
    setAugmentMessage('Starting Claude…');
    setAugmentError(null);
    const unsub = api.codeflow.onAugmentProgress(projectPath, (msg) => {
      setAugmentMessage(msg);
    });
    try {
      const res = await api.codeflow.augmentGraph(projectPath, graph);
      if (res.ok) {
        setSoftEdges(res.softEdges);
        setAugmentStatus('idle');
        setAugmentMessage(
          `Added ${res.softEdges.length} soft edge${res.softEdges.length === 1 ? '' : 's'}.`,
        );
      } else if (res.error === 'cancelled') {
        setAugmentStatus('cancelled');
        setAugmentMessage('Cancelled.');
      } else {
        setAugmentStatus('error');
        setAugmentError(res.error);
        setAugmentMessage('');
      }
    } catch (err) {
      setAugmentStatus('error');
      setAugmentError((err as Error).message);
      setAugmentMessage('');
    } finally {
      unsub();
    }
  }, [projectPath, graph, augmentStatus]);

  const cancelAugment = useCallback(() => {
    if (!projectPath) return;
    void api.codeflow.augmentCancel(projectPath);
  }, [projectPath]);

  // Merged graph (static + Claude soft edges) actually rendered by d3.
  // Filtered through edgeKindVisible so the user can hide categories they
  // don't want cluttering the canvas.
  const renderedGraph: CodeflowGraph | null = useMemo(() => {
    if (viewMode === 'functions') {
      if (!functionGraph) return null;
      // Convert function graph → renderable graph shape so the existing
      // d3 simulation can paint it without a parallel render path. Each
      // function node fakes a "folder" of its parent file so colorMode
      // 'folder' clusters per-file. Layer ends up as 'other' for v1 —
      // function-level layer detection isn't meaningful yet.
      const visible = hideOrphans
        ? functionGraph.nodes.filter((n) => n.degree > 0)
        : functionGraph.nodes;
      const visibleIds = new Set(visible.map((n) => n.id));
      return {
        nodes: visible.map((n) => ({
          id: n.id,
          // `name` is what the renderer's tooltip + node-details panel
          // shows. Append `:line` so identically-named functions in
          // different files stay distinguishable in the UI.
          name: n.className ? `${n.className}.${n.name}` : n.name,
          folder: n.file,
          ext: '',
          layer: 'other' as CodeflowLayer,
          size: 0,
          loc: 0,
          degree: n.degree,
        })),
        edges: functionGraph.edges
          .filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target))
          .map((e) => ({
            source: e.source,
            target: e.target,
            weight: e.count,
            // Surface confidence via edge kind so the renderer paints
            // low-confidence (ambiguous name) edges as dashed/inferred.
            kind: e.confidence === 'high' ? 'import' : ('inferred' as const),
          })),
        stats: {
          totalFiles: functionGraph.stats.totalFunctions,
          totalLines: 0,
          totalEdges: functionGraph.stats.totalEdges,
          languages: [],
          truncated: functionGraph.stats.truncated,
          elapsedMs: functionGraph.stats.elapsedMs,
          importsParsed: functionGraph.stats.callsSeen,
          importsResolved: functionGraph.stats.callsResolved,
          aliasCount: 0,
          fingerprint: '',
        },
      };
    }
    if (!graph) return null;
    const merged: CodeflowGraphEdge[] = [
      ...graph.edges.filter((e) => edgeKindVisible[e.kind]),
      ...softEdges.filter((e) => edgeKindVisible[e.kind]),
    ];
    return { ...graph, edges: merged };
  }, [graph, functionGraph, viewMode, hideOrphans, softEdges, edgeKindVisible]);

  // Edge index for blast-radius highlighting on selection: maps node id to
  // its connected node ids. Computed off the rendered (filtered+merged)
  // graph so hiding a kind also drops it from blast radius.
  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();
    if (!renderedGraph) return map;
    const ensure = (id: string) => {
      let s = map.get(id);
      if (!s) {
        s = new Set();
        map.set(id, s);
      }
      return s;
    };
    for (const e of renderedGraph.edges) {
      ensure(e.source).add(e.target);
      ensure(e.target).add(e.source);
    }
    return map;
  }, [renderedGraph]);

  // Mount the d3 simulation + svg renderer. Re-runs whenever the rendered
  // graph (static + visible soft edges) changes — but NOT on color-mode
  // toggle, since recoloring shouldn't reset the layout. Color updates run
  // in their own effect below.
  useEffect(() => {
    if (!renderedGraph || !svgRef.current || !containerRef.current) return;

    const container = containerRef.current;
    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const { width, height } = container.getBoundingClientRect();
    const w = Math.max(width, 600);
    const h = Math.max(height, 400);
    svg.attr('viewBox', `0 0 ${w} ${h}`);

    // Clone so d3 can mutate fx/fy/x/y without leaking back into React state.
    const nodes: SimNode[] = renderedGraph.nodes.map((n) => ({ ...n }));
    const edges: SimEdge[] = renderedGraph.edges.map((e) => ({ ...e }));

    const root = svg.append('g').attr('class', 'cf-root');

    // Edges first so nodes paint on top. Static-import edges use a soft
    // white; soft edges (event/plugin/config/dynamic/inferred) use their
    // kind palette and a dashed stroke so the user can read the overlay
    // separately from the spine.
    const edgeSel = root
      .append('g')
      .attr('class', 'cf-edges')
      .attr('stroke-linecap', 'round')
      .selectAll<SVGLineElement, SimEdge>('line')
      .data(edges)
      .join('line')
      .attr('stroke', (d) => EDGE_KIND_COLORS[d.kind])
      .attr('stroke-dasharray', (d) => (d.kind === 'import' ? null : '4 3'))
      .attr('stroke-width', (d) =>
        Math.max(0.5, Math.min(2.5, Math.sqrt(d.weight))),
      );

    const nodeSel = root
      .append('g')
      .attr('class', 'cf-nodes')
      .selectAll<SVGCircleElement, SimNode>('circle')
      .data(nodes, (d) => d.id)
      .join('circle')
      .attr('r', (d) => 3.5 + Math.min(8, Math.sqrt(d.degree)))
      .attr('fill', (d) =>
        colorMode === 'layer' ? LAYER_COLORS[d.layer] : folderColor(d.folder),
      )
      .attr('stroke', 'rgba(0,0,0,0.4)')
      .attr('stroke-width', 1)
      .style('cursor', 'pointer');

    // Tooltip + hover/select state are driven from these handlers; the
    // imperative path is the only sane way to wire d3 mouse events into
    // React without one-handler-per-node overhead.
    nodeSel
      .on('pointerenter', (_event, d) => setHovered(d))
      .on('pointerleave', () => setHovered(null))
      .on('click', (_event, d) =>
        setSelected((cur) => (cur === d.id ? null : d.id)),
      );

    const sim = d3
      .forceSimulation<SimNode, SimEdge>(nodes)
      .force(
        'link',
        d3
          .forceLink<SimNode, SimEdge>(edges)
          .id((d) => d.id)
          .distance(60)
          .strength(0.6),
      )
      .force('charge', d3.forceManyBody().strength(-180))
      .force('center', d3.forceCenter(w / 2, h / 2))
      .force(
        'collision',
        d3.forceCollide<SimNode>().radius((d) => 5 + Math.sqrt(d.degree) * 2),
      )
      .alpha(1)
      .alphaDecay(0.03);

    sim.on('tick', () => {
      edgeSel
        .attr('x1', (d) => (d.source as SimNode).x ?? 0)
        .attr('y1', (d) => (d.source as SimNode).y ?? 0)
        .attr('x2', (d) => (d.target as SimNode).x ?? 0)
        .attr('y2', (d) => (d.target as SimNode).y ?? 0);
      nodeSel.attr('cx', (d) => d.x ?? 0).attr('cy', (d) => d.y ?? 0);
    });

    // Drag interaction lets the user push hubs out of the way to reveal
    // clusters underneath. Classic d3-force pattern.
    const drag = d3
      .drag<SVGCircleElement, SimNode>()
      .on('start', (event, d) => {
        if (!event.active) sim.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', (event, d) => {
        if (!event.active) sim.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });
    nodeSel.call(drag);

    // Pan + zoom on the whole canvas. d3.zoom emits a transform that we
    // pipe straight into the root group so simulation coordinates remain
    // in the original "logical" space.
    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 6])
      .on('zoom', (event) => {
        root.attr('transform', event.transform.toString());
      });
    svg.call(zoom).on('dblclick.zoom', null);
    zoomRef.current = zoom;

    simRef.current = sim;
    return () => {
      sim.stop();
      simRef.current = null;
      zoomRef.current = null;
    };
  }, [renderedGraph]);

  // Color-mode update — recolor existing circles in place so toggling
  // Layer ↔ Folder is instant and doesn't disturb the force layout.
  useEffect(() => {
    if (!svgRef.current) return;
    d3.select(svgRef.current)
      .selectAll<SVGCircleElement, SimNode>('.cf-nodes circle')
      .transition()
      .duration(180)
      .attr('fill', (d) =>
        colorMode === 'layer' ? LAYER_COLORS[d.layer] : folderColor(d.folder),
      );
  }, [colorMode, renderedGraph]);

  // Selection / hover highlight pass — stays separate from the main render
  // effect so we don't tear down the simulation on every mouse move.
  useEffect(() => {
    if (!svgRef.current || !renderedGraph) return;
    const focusId = hovered?.id ?? selected ?? null;
    const neighbors = focusId ? adjacency.get(focusId) ?? new Set<string>() : null;
    const svg = d3.select(svgRef.current);
    svg
      .selectAll<SVGCircleElement, SimNode>('.cf-nodes circle')
      .attr('opacity', (d) => {
        if (!focusId) return 1;
        if (d.id === focusId) return 1;
        return neighbors?.has(d.id) ? 0.95 : 0.18;
      })
      .attr('stroke-width', (d) => (d.id === focusId ? 2.5 : 1));
    svg
      .selectAll<SVGLineElement, SimEdge>('.cf-edges line')
      .attr('stroke', (d) => {
        const s = (d.source as SimNode).id ?? (d.source as unknown as string);
        const t = (d.target as SimNode).id ?? (d.target as unknown as string);
        if (focusId && (s === focusId || t === focusId)) {
          return 'rgba(168,85,247,0.85)'; // selected — purple highlight
        }
        if (focusId) return 'rgba(255,255,255,0.04)'; // dimmed
        return EDGE_KIND_COLORS[d.kind];
      })
      .attr('stroke-width', (d) => {
        const s = (d.source as SimNode).id ?? (d.source as unknown as string);
        const t = (d.target as SimNode).id ?? (d.target as unknown as string);
        const base = Math.max(0.5, Math.min(2.5, Math.sqrt(d.weight)));
        return focusId && (s === focusId || t === focusId) ? base + 1 : base;
      });
  }, [hovered, selected, adjacency, renderedGraph]);

  const onZoom = useCallback((dir: 1 | -1) => {
    const svg = svgRef.current;
    const zoom = zoomRef.current;
    if (!svg || !zoom) return;
    const factor = dir === 1 ? 1.4 : 1 / 1.4;
    d3.select(svg).transition().duration(180).call(zoom.scaleBy, factor);
  }, []);

  const onResetZoom = useCallback(() => {
    const svg = svgRef.current;
    const zoom = zoomRef.current;
    if (!svg || !zoom) return;
    d3.select(svg).transition().duration(220).call(zoom.transform, d3.zoomIdentity);
  }, []);

  return (
    <div
      className="relative h-full w-full bg-[#0b0d12]"
      style={visible ? undefined : { display: 'none' }}
    >
      <div ref={containerRef} className="absolute inset-0">
        <svg
          ref={svgRef}
          className="h-full w-full"
          style={{ touchAction: 'none' }}
        />
      </div>

      <ToolbarOverlay
        graph={renderedGraph}
        baseGraph={graph}
        loading={loading}
        colorMode={colorMode}
        onColorMode={setColorMode}
        viewMode={viewMode}
        onViewMode={setViewMode}
        hideOrphans={hideOrphans}
        onHideOrphans={setHideOrphans}
        onReload={() => void reload()}
        onZoom={onZoom}
        onResetZoom={onResetZoom}
        augmentStatus={augmentStatus}
        augmentMessage={augmentMessage}
        augmentError={augmentError}
        softEdgeCount={softEdges.length}
        onAugment={() => void augment()}
        onCancelAugment={cancelAugment}
        edgeKindVisible={edgeKindVisible}
        onToggleEdgeKind={(kind) =>
          setEdgeKindVisible((v) => ({ ...v, [kind]: !v[kind] }))
        }
      />

      {(loading || (!graph && !error)) && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-text-muted">
          <div className="flex items-center gap-2 rounded-md bg-surface-3/80 px-3 py-2 text-[12px] backdrop-blur">
            <Loader2 size={13} className="animate-spin" />
            <span>Building graph…</span>
          </div>
        </div>
      )}

      {error && (
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 max-w-[480px] rounded-md border border-semantic-error/40 bg-semantic-error/10 px-4 py-3 text-center text-[12px] text-semantic-error">
          <div className="mb-1 font-semibold">Could not build graph</div>
          <pre className="whitespace-pre-wrap text-[11px]">{error}</pre>
        </div>
      )}

      {renderedGraph && hovered && <NodeTooltip node={hovered} graph={renderedGraph} />}
      {renderedGraph && selected && (
        <NodeDetails
          nodeId={selected}
          graph={renderedGraph}
          adjacency={adjacency}
          onClose={() => setSelected(null)}
          onSelectNode={setSelected}
        />
      )}
    </div>
  );
}

interface ToolbarProps {
  graph: CodeflowGraph | null;
  // The pre-merge static graph — used to decide whether the Augment button
  // is even available. We can't merge until we have a base graph.
  baseGraph: CodeflowGraph | null;
  loading: boolean;
  colorMode: ColorMode;
  onColorMode: (m: ColorMode) => void;
  viewMode: ViewMode;
  onViewMode: (m: ViewMode) => void;
  hideOrphans: boolean;
  onHideOrphans: (v: boolean) => void;
  onReload: () => void;
  onZoom: (dir: 1 | -1) => void;
  onResetZoom: () => void;
  augmentStatus: AugmentStatus;
  augmentMessage: string;
  augmentError: string | null;
  softEdgeCount: number;
  onAugment: () => void;
  onCancelAugment: () => void;
  edgeKindVisible: Record<CodeflowEdgeKind, boolean>;
  onToggleEdgeKind: (kind: CodeflowEdgeKind) => void;
}

function ToolbarOverlay({
  graph,
  baseGraph,
  loading,
  colorMode,
  onColorMode,
  viewMode,
  onViewMode,
  hideOrphans,
  onHideOrphans,
  onReload,
  onZoom,
  onResetZoom,
  augmentStatus,
  augmentMessage,
  augmentError,
  softEdgeCount,
  onAugment,
  onCancelAugment,
  edgeKindVisible,
  onToggleEdgeKind,
}: ToolbarProps) {
  const augmentRunning = augmentStatus === 'running';
  // Only kinds actually present in the rendered graph get a toggle, so the
  // legend stays compact on a fresh static graph (just "Imports").
  const presentKinds = useMemo(() => {
    const kinds = new Set<CodeflowEdgeKind>();
    for (const e of graph?.edges ?? []) kinds.add(e.kind);
    // Always show imports if base has any.
    if ((baseGraph?.edges.length ?? 0) > 0) kinds.add('import');
    return Array.from(kinds);
  }, [graph, baseGraph]);
  return (
    <>
      <div className="absolute left-3 top-3 flex items-center gap-1.5">
        {/* View mode — file-level (one node per file) vs function-level
            (one node per function/method, edges = cross-file calls). */}
        <div className="inline-flex h-[26px] items-stretch rounded-[7px] border border-border-subtle bg-surface-3/90 text-[11px] backdrop-blur">
          <ToolbarBtn
            active={viewMode === 'files'}
            onClick={() => onViewMode('files')}
            title="File-level graph: one node per file, edges = imports"
          >
            <FileCode size={11} className="shrink-0" />
            <span>Files</span>
          </ToolbarBtn>
          <ToolbarBtn
            active={viewMode === 'functions'}
            onClick={() => onViewMode('functions')}
            title="Function-level graph: one node per function/method, edges = cross-file calls"
          >
            <Braces size={11} className="shrink-0" />
            <span>Functions</span>
          </ToolbarBtn>
        </div>
        <div className="inline-flex h-[26px] items-stretch rounded-[7px] border border-border-subtle bg-surface-3/90 text-[11px] backdrop-blur">
          <ToolbarBtn
            active={colorMode === 'layer'}
            onClick={() => onColorMode('layer')}
            title={
              viewMode === 'functions'
                ? 'Layer mode is file-level only — function nodes default to neutral'
                : 'Color nodes by detected architectural layer'
            }
          >
            Layer
          </ToolbarBtn>
          <ToolbarBtn
            active={colorMode === 'folder'}
            onClick={() => onColorMode('folder')}
            title={
              viewMode === 'functions'
                ? 'Color functions by their parent file (each file gets a stable hue)'
                : 'Color nodes by their parent folder'
            }
          >
            {viewMode === 'functions' ? 'File' : 'Folder'}
          </ToolbarBtn>
        </div>
        {viewMode === 'functions' && (
          <button
            onClick={() => onHideOrphans(!hideOrphans)}
            className={cn(
              'inline-flex h-[26px] items-center gap-1.5 rounded-[7px] border px-2.5 text-[11px] transition',
              hideOrphans
                ? 'border-accent/40 bg-accent/10 text-accent'
                : 'border-border-subtle bg-surface-3 text-text-secondary hover:border-border-hi hover:bg-surface-4 hover:text-text',
            )}
            title="Hide functions with no resolved cross-file calls (most are local helpers)"
          >
            <span>{hideOrphans ? 'Hiding orphans' : 'Show all'}</span>
          </button>
        )}
        <button
          onClick={onReload}
          disabled={loading || augmentRunning}
          className="inline-flex h-[26px] items-center gap-1.5 rounded-[7px] border border-border-subtle bg-surface-3/90 px-2.5 text-[11px] text-text-secondary backdrop-blur transition hover:border-border-hi hover:bg-surface-4 hover:text-text disabled:opacity-50"
          title="Re-walk the project and rebuild the graph"
        >
          {loading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
          <span>{loading ? 'Building…' : 'Rebuild'}</span>
        </button>

        {!augmentRunning ? (
          <button
            onClick={onAugment}
            disabled={!baseGraph || loading}
            className="inline-flex h-[26px] items-center gap-1.5 rounded-[7px] px-2.5 text-[11px] font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            style={{
              background:
                'linear-gradient(135deg, var(--color-accent), #a855f7)',
              boxShadow: '0 2px 8px var(--color-accent-glow)',
            }}
            title={
              softEdgeCount > 0
                ? `Re-augment with Claude (currently ${softEdgeCount} soft edges)`
                : 'Ask Claude to add soft edges (events, plugins, dynamic dispatch) the static parser missed'
            }
          >
            <Brain size={11} strokeWidth={2.2} />
            <span>{softEdgeCount > 0 ? 'Re-augment' : 'Augment with Claude'}</span>
          </button>
        ) : (
          <button
            onClick={onCancelAugment}
            className="inline-flex h-[26px] items-center gap-1.5 rounded-[7px] border border-semantic-error/40 bg-semantic-error/10 px-2.5 text-[11px] text-semantic-error transition hover:bg-semantic-error/15"
            title="Stop the running Claude augment"
          >
            <CircleSlash size={11} />
            <span>Cancel</span>
          </button>
        )}
      </div>

      {/* Augment progress + edge-kind legend, anchored top-center so it
          doesn't fight with the corners. */}
      {(augmentRunning || augmentMessage || augmentError) && (
        <div
          className="absolute left-1/2 top-3 -translate-x-1/2 flex max-w-[60%] items-center gap-2 rounded-[7px] border border-border-subtle bg-surface-3/95 px-3 py-1.5 text-[11px] backdrop-blur"
          style={{ minWidth: 220 }}
        >
          {augmentRunning ? (
            <Loader2 size={11} className="shrink-0 animate-spin text-accent" />
          ) : augmentError ? (
            <Sparkles size={11} className="shrink-0 text-semantic-error" />
          ) : (
            <Sparkles size={11} className="shrink-0 text-semantic-success" />
          )}
          <span
            className={cn(
              'truncate font-mono',
              augmentError ? 'text-semantic-error' : 'text-text-secondary',
            )}
            title={augmentError ?? augmentMessage}
          >
            {augmentError ?? augmentMessage}
          </span>
        </div>
      )}

      {/* Edge-kind legend / filter. Hidden when only "imports" exist — no
          point showing a single-item legend. */}
      {presentKinds.length > 1 && (
        <div className="absolute bottom-3 right-3 inline-flex items-center gap-1 rounded-[7px] border border-border-subtle bg-surface-3/90 p-1 text-[10.5px] backdrop-blur">
          {presentKinds.map((kind) => {
            const visible = edgeKindVisible[kind];
            return (
              <button
                key={kind}
                onClick={() => onToggleEdgeKind(kind)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-[5px] px-2 py-0.5 transition',
                  visible
                    ? 'bg-surface-4 text-text'
                    : 'text-text-muted hover:text-text-secondary',
                )}
                title={`Toggle ${EDGE_KIND_LABELS[kind]} edges`}
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{
                    background: EDGE_KIND_COLORS[kind],
                    opacity: visible ? 1 : 0.35,
                  }}
                />
                <span>{EDGE_KIND_LABELS[kind]}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="absolute right-3 top-3 inline-flex h-[26px] items-stretch rounded-[7px] border border-border-subtle bg-surface-3/90 text-[11px] backdrop-blur">
        <ToolbarBtn onClick={() => onZoom(1)} title="Zoom in">
          <ZoomIn size={11} />
        </ToolbarBtn>
        <ToolbarBtn onClick={() => onZoom(-1)} title="Zoom out">
          <ZoomOut size={11} />
        </ToolbarBtn>
        <ToolbarBtn onClick={onResetZoom} title="Reset zoom + center">
          1:1
        </ToolbarBtn>
      </div>

      {graph && (
        <div className="absolute bottom-3 left-3 rounded-[7px] border border-border-subtle bg-surface-3/90 px-3 py-1.5 text-[10.5px] text-text-muted backdrop-blur space-y-0.5">
          <div>
            <span className="font-mono tabular-nums text-text">
              {graph.stats.totalFiles}
            </span>{' '}
            files ·{' '}
            <span className="font-mono tabular-nums text-text">
              {graph.edges.length}
            </span>{' '}
            edges
            {softEdgeCount > 0 && (
              <span className="ml-1 text-accent">(+{softEdgeCount} soft)</span>
            )}{' '}
            ·{' '}
            <span className="font-mono tabular-nums text-text">
              {graph.stats.totalLines.toLocaleString()}
            </span>{' '}
            loc · {graph.stats.elapsedMs}ms
            {graph.stats.truncated && (
              <span className="ml-2 text-semantic-warning">
                (truncated — large repo)
              </span>
            )}
          </div>
          {/* Diagnostic line — disambiguates "no edges because no imports"
              from "no edges because alias resolution failed". The first
              path means the project genuinely has no internal coupling;
              the second means our config detection missed something. */}
          <div className="font-mono tabular-nums text-[10px] text-text-dim">
            {graph.stats.aliasCount} alias{graph.stats.aliasCount === 1 ? '' : 'es'} · imports{' '}
            <span className={graph.stats.importsParsed === 0 ? 'text-semantic-warning' : ''}>
              {graph.stats.importsParsed} parsed
            </span>
            {' / '}
            <span
              className={
                graph.stats.importsResolved === 0 && graph.stats.importsParsed > 0
                  ? 'text-semantic-warning'
                  : ''
              }
            >
              {graph.stats.importsResolved} resolved
            </span>
          </div>
        </div>
      )}
    </>
  );
}

function ToolbarBtn({
  active,
  onClick,
  title,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        'inline-flex items-center gap-1 px-2.5 transition first:rounded-l-[7px] last:rounded-r-[7px]',
        active
          ? 'bg-surface-4 text-text'
          : 'text-text-secondary hover:bg-surface-4 hover:text-text',
      )}
    >
      {children}
    </button>
  );
}

function NodeTooltip({
  node,
  graph,
}: {
  node: CodeflowGraphNode;
  graph: CodeflowGraph;
}) {
  const inbound = graph.edges.filter((e) => e.target === node.id).length;
  const outbound = graph.edges.filter((e) => e.source === node.id).length;
  return (
    <div className="pointer-events-none absolute right-3 bottom-12 max-w-[360px] rounded-md border border-border-subtle bg-surface-3/95 px-3 py-2 text-[11px] backdrop-blur">
      <div className="truncate font-mono text-text">{node.id}</div>
      <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 font-mono tabular-nums text-text-muted">
        <span>layer: {node.layer}</span>
        <span>loc: {node.loc.toLocaleString()}</span>
        <span>in: {inbound}</span>
        <span>out: {outbound}</span>
      </div>
    </div>
  );
}

interface NodeDetailsProps {
  nodeId: string;
  graph: CodeflowGraph;
  adjacency: Map<string, Set<string>>;
  onClose: () => void;
  onSelectNode: (id: string) => void;
}

function NodeDetails({
  nodeId,
  graph,
  adjacency,
  onClose,
  onSelectNode,
}: NodeDetailsProps) {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  const inbound = graph.edges.filter((e) => e.target === nodeId);
  const outbound = graph.edges.filter((e) => e.source === nodeId);
  const blastRadius = adjacency.get(nodeId)?.size ?? 0;

  return (
    <div className="absolute right-3 bottom-3 top-12 w-[340px] overflow-y-auto rounded-md border border-border-subtle bg-surface-3/95 backdrop-blur">
      <div className="sticky top-0 flex items-center justify-between border-b border-border-subtle bg-surface-3/95 px-3 py-2 backdrop-blur">
        <span className="truncate font-mono text-[11.5px] text-text">{node.name}</span>
        <button
          onClick={onClose}
          className="text-[10px] text-text-muted hover:text-text"
        >
          ✕
        </button>
      </div>
      <div className="p-3 text-[11px] text-text-secondary">
        <div className="font-mono text-[10.5px] text-text-muted">{node.id}</div>
        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono tabular-nums">
          <span>Layer: <span className="text-text">{node.layer}</span></span>
          <span>Lines: <span className="text-text">{node.loc.toLocaleString()}</span></span>
          <span>Imports: <span className="text-text">{outbound.length}</span></span>
          <span>Imported by: <span className="text-text">{inbound.length}</span></span>
          <span className="col-span-2">
            Blast radius: <span className="text-text">{blastRadius}</span> direct neighbors
          </span>
        </div>

        <NeighborSection
          title={`Imports (${outbound.length})`}
          rows={outbound.map((e) => ({
            id: e.target,
            label: e.target,
            weight: e.weight,
          }))}
          onSelectNode={onSelectNode}
        />
        <NeighborSection
          title={`Imported by (${inbound.length})`}
          rows={inbound.map((e) => ({
            id: e.source,
            label: e.source,
            weight: e.weight,
          }))}
          onSelectNode={onSelectNode}
        />
      </div>
    </div>
  );
}

function formatRelative(ms: number | null | undefined): string {
  if (!ms) return 'never';
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))}h ago`;
  return new Date(ms).toLocaleDateString();
}

function NeighborSection({
  title,
  rows,
  onSelectNode,
}: {
  title: string;
  rows: Array<{ id: string; label: string; weight: number }>;
  onSelectNode: (id: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="mt-3">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
        {title}
      </div>
      <ul className="space-y-0.5">
        {rows.slice(0, 50).map((r) => (
          <li key={r.id}>
            <button
              onClick={() => onSelectNode(r.id)}
              className="block w-full truncate rounded px-1.5 py-0.5 text-left font-mono text-[10.5px] text-text-secondary hover:bg-surface-4 hover:text-text"
              title={r.label}
            >
              <span className="text-text-muted">{r.weight}×</span> {r.label}
            </button>
          </li>
        ))}
        {rows.length > 50 && (
          <li className="text-[10px] text-text-muted">+ {rows.length - 50} more</li>
        )}
      </ul>
    </div>
  );
}
