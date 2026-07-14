import { create } from 'zustand';

import { edgeLabelFor } from '@renderer/components/Flows/flowGeometry';
import { api } from '@renderer/lib/api';
import { FLOW_TEMPLATES } from '@renderer/state/flowTemplates';
import type {
  FlowChangedEvent,
  FlowEdge,
  FlowGraph,
  FlowNode,
  FlowNodeKind,
  FlowNodeStatus,
  FlowRun,
  FlowTestReport,
} from '@shared/flowTypes';
import type { CliId } from '@shared/types';

/**
 * Agent Flow store. Deliberately localStorage-free: main owns the flows
 * (`<project>/.devspace/flows/*.flow.json`) and pushes FLOW_CHANGED, so the
 * renderer holds no durable copy that could go stale against the files.
 *
 * Editing model: `draft` is a local copy of the selected graph. Every mutation
 * updates the draft immediately (canvas stays at 60fps) and schedules a
 * debounced FLOW_SAVE. `flush()` forces the pending write — callers MUST run it
 * on unmount / before switching flows, or the last edits die with the tab.
 */

const SAVE_DEBOUNCE_MS = 800;

export const NEW_NODE_DEFAULTS = {
  role: 'new-agent',
  cliId: 'claude' as CliId,
  mode: 'headless' as const,
  rolePrompt: '',
};

/**
 * Defaults for a node added from the canvas, per kind. Gates and notes still
 * carry cliId/mode/rolePrompt because FlowNode requires them — main never
 * reads those fields for a non-agent kind, but a partial node would not
 * round-trip through the JSON schema.
 */
export function newNodeDefaults(kind: FlowNodeKind): Omit<FlowNode, 'id' | 'x' | 'y'> {
  const shell = { cliId: 'claude' as CliId, mode: 'headless' as const, rolePrompt: '' };
  switch (kind) {
    case 'gate':
      return {
        ...shell,
        kind: 'gate',
        role: 'condition?',
        // Empty on purpose: validateGraph rejects a gate with no condition, so
        // the inspector's empty field is the prompt to write one.
        condition: '',
        maxRetries: 3,
      };
    case 'note':
      return { ...shell, kind: 'note', role: 'note', noteText: 'Note' };
    default:
      return { ...shell, kind: 'agent', ...NEW_NODE_DEFAULTS };
  }
}

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

/** undefined kind = 'agent' — phase-1 files predate the field. */
function kindOf(node: FlowNode | undefined): FlowNodeKind {
  return node?.kind ?? 'agent';
}

/** The run the canvas visualizes for a flow: the most recently started one. */
export function latestRunFor(runs: FlowRun[], flowId: string): FlowRun | null {
  let best: FlowRun | null = null;
  for (const r of runs) {
    if (r.flowId !== flowId) continue;
    if (!best || r.startedAt > best.startedAt) best = r;
  }
  return best;
}

/** nodeId → status for the status ring/dot. Empty when no run exists yet. */
export function statusByNode(run: FlowRun | null): Record<string, FlowNodeStatus> {
  const out: Record<string, FlowNodeStatus> = {};
  if (!run) return out;
  for (const n of run.nodes) out[n.nodeId] = n.status;
  return out;
}

/** Starter graph for the empty state: researcher → coder, one handoff edge. */
export function starterFlow(): FlowGraph {
  const now = Date.now();
  const researcher: FlowNode = {
    id: 'researcher',
    role: 'researcher',
    rolePrompt: 'Read the codebase and summarize what the task touches.',
    cliId: 'claude',
    mode: 'headless',
    x: 120,
    y: 160,
  };
  const coder: FlowNode = {
    id: 'coder',
    role: 'coder',
    rolePrompt: "Implement the task using the researcher's findings.",
    cliId: 'claude',
    mode: 'interactive',
    x: 440,
    y: 160,
  };
  return {
    id: uid('flow'),
    name: 'new-flow',
    description: '',
    nodes: [researcher, coder],
    edges: [{ from: 'researcher', to: 'coder', label: 'handoff' }],
    createdAt: now,
    updatedAt: now,
  };
}

interface FlowsState {
  projectPath: string | null;
  flows: FlowGraph[];
  runs: FlowRun[];
  selectedFlowId: string | null;
  selectedNodeId: string | null;
  draft: FlowGraph | null;
  loading: boolean;
  /** Preflight results for the selected flow ("Test nodes") — cleared whenever
   *  the draft changes flows. NOT a run: probes validate CLI/model/profile. */
  nodeTests: FlowTestReport | null;
  testing: boolean;

  loadForProject: (projectPath: string) => Promise<void>;
  applyChanged: (evt: FlowChangedEvent) => void;
  selectFlow: (id: string) => void;
  selectNode: (id: string | null) => void;
  /** No id = a blank starter; an id from FLOW_TEMPLATES = that template. */
  createFlow: (templateId?: string) => void;
  /** Duplicate a flow — the parallel-work path, since a flow can only carry
   *  ONE live run at a time (each clone runs and is monitored on its own). */
  cloneFlow: (id: string) => void;
  deleteFlow: (id: string) => Promise<void>;
  flush: () => Promise<void>;
  testNodes: () => Promise<void>;

  // Draft mutations — all schedule a debounced save.
  addNode: (x: number, y: number, kind?: FlowNodeKind) => void;
  moveNode: (id: string, x: number, y: number) => void;
  updateNode: (id: string, patch: Partial<FlowNode>) => void;
  deleteNode: (id: string) => void;
  connect: (from: string, to: string, branch?: FlowEdge['branch']) => void;
  disconnect: (from: string, to: string, branch?: FlowEdge['branch']) => void;
  setEdgeBranch: (edge: FlowEdge, branch: FlowEdge['branch']) => void;
  updateFlowMeta: (patch: Partial<Pick<FlowGraph, 'name' | 'description'>>) => void;
}

// Debounce state lives outside the store: it's scheduling machinery, not
// rendered state, and a re-render must never reset a pending write.
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPath: string | null = null;

export const useFlowsStore = create<FlowsState>((set, get) => {
  /** Persist the draft now. Errors surface in the console — a failed write
   *  must not wipe the user's in-memory graph. */
  const writeDraft = async (): Promise<void> => {
    const { draft } = get();
    const path = pendingPath;
    pendingPath = null;
    if (!draft || !path) return;
    try {
      await api.flows.save(path, draft);
    } catch (err) {
      console.error('[flows] save failed:', err);
    }
  };

  const scheduleSave = (): void => {
    pendingPath = get().projectPath;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void writeDraft();
    }, SAVE_DEBOUNCE_MS);
  };

  /** Apply a pure transform to the draft + bump updatedAt + schedule a save. */
  const mutate = (fn: (g: FlowGraph) => FlowGraph): void => {
    const { draft } = get();
    if (!draft) return;
    set({ draft: { ...fn(draft), updatedAt: Date.now() } });
    scheduleSave();
  };

  return {
    projectPath: null,
    flows: [],
    runs: [],
    selectedFlowId: null,
    selectedNodeId: null,
    draft: null,
    loading: false,
    nodeTests: null,
    testing: false,

    async testNodes() {
      const s = get();
      if (!s.draft || !s.projectPath || s.testing) return;
      // Probe what is REALLY on disk — flush the debounced edit first, or the
      // probes would validate values the engine won't actually use.
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        await writeDraft();
      }
      set({ testing: true, nodeTests: null });
      try {
        const report = await api.flows.testNodes(s.projectPath, get().draft!);
        set({ nodeTests: report, testing: false });
      } catch (err) {
        set({
          nodeTests: {
            graphErrors: [err instanceof Error ? err.message : String(err)],
            nodes: [],
          },
          testing: false,
        });
      }
    },

    async loadForProject(projectPath) {
      // A queued save belongs to the project we're LEAVING — flush it before
      // repointing the store, or the timer would pair the old pendingPath with
      // the new draft and write one project's flow into another's flows dir.
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        await writeDraft();
      }
      set({ projectPath, loading: true });
      const [flows, runs] = await Promise.all([
        api.flows.list(projectPath).catch(() => [] as FlowGraph[]),
        api.flows.runs(projectPath).catch(() => [] as FlowRun[]),
      ]);
      // A newer project may have been selected while we awaited.
      if (get().projectPath !== projectPath) return;
      const first = flows[0] ?? null;
      set({
        flows,
        runs,
        loading: false,
        selectedFlowId: first?.id ?? null,
        draft: first ? structuredClone(first) : null,
        selectedNodeId: null,
        nodeTests: null,
      });
    },

    applyChanged(evt) {
      const s = get();
      if (evt.projectPath !== s.projectPath) return;
      const next: Partial<FlowsState> = {};

      if (evt.flows) {
        next.flows = evt.flows;
        // Adopt the server copy ONLY when nothing is queued locally: with a
        // pending save the push is either our own echo or an external edit we
        // would be about to overwrite anyway — adopting it mid-edit would drop
        // the keystrokes/drag the user just made.
        if (s.draft && !saveTimer) {
          const fresh = evt.flows.find((f) => f.id === s.draft!.id);
          if (fresh) next.draft = structuredClone(fresh);
        }
        // The selected flow was deleted elsewhere — fall back to the first.
        if (s.selectedFlowId && !evt.flows.some((f) => f.id === s.selectedFlowId)) {
          const first = evt.flows[0] ?? null;
          next.selectedFlowId = first?.id ?? null;
          next.draft = first ? structuredClone(first) : null;
          next.selectedNodeId = null;
        }
      }

      if (evt.run) {
        const run = evt.run;
        const runs = s.runs.some((r) => r.id === run.id)
          ? s.runs.map((r) => (r.id === run.id ? run : r))
          : [run, ...s.runs];
        next.runs = runs;
      }

      set(next);
    },

    selectFlow(id) {
      const s = get();
      if (s.selectedFlowId === id) return;
      // Don't lose a queued edit to the flow we're leaving.
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        void writeDraft();
      }
      const flow = s.flows.find((f) => f.id === id);
      if (!flow) return;
      set({
        selectedFlowId: id,
        draft: structuredClone(flow),
        selectedNodeId: null,
        nodeTests: null,
      });
    },

    selectNode(id) {
      set({ selectedNodeId: id });
    },

    createFlow(templateId) {
      const s = get();
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        void writeDraft();
      }
      const template = templateId
        ? FLOW_TEMPLATES.find((t) => t.id === templateId)
        : undefined;
      const flow = template ? template.build() : starterFlow();
      set({
        flows: [...s.flows, flow],
        selectedFlowId: flow.id,
        draft: flow,
        selectedNodeId: null,
        nodeTests: null,
      });
      // Persist immediately: an unsaved flow can't be run from chat, and the
      // whole point of "New flow" is to make it addressable by the lead agent.
      pendingPath = s.projectPath;
      void writeDraft();
    },

    cloneFlow(id) {
      const s = get();
      const src =
        (s.draft?.id === id ? s.draft : null) ?? s.flows.find((f) => f.id === id);
      if (!src || !s.projectPath) return;
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        void writeDraft();
      }
      // Unique name: run_flow resolves by name too, so "-copy", "-copy-2", …
      const taken = new Set(s.flows.map((f) => f.name));
      let name = `${src.name}-copy`;
      for (let i = 2; taken.has(name); i++) name = `${src.name}-copy-${i}`;
      const flow: FlowGraph = {
        ...structuredClone(src),
        id: uid('flow'),
        name,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      set({
        flows: [...s.flows, flow],
        selectedFlowId: flow.id,
        draft: flow,
        selectedNodeId: null,
        nodeTests: null,
      });
      // Persist immediately — the whole point of a clone is to run/pin it now.
      pendingPath = s.projectPath;
      void writeDraft();
    },

    async deleteFlow(id) {
      const s = get();
      if (!s.projectPath) return;
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        pendingPath = null;
      }
      const flows = s.flows.filter((f) => f.id !== id);
      const nextSel = s.selectedFlowId === id ? (flows[0] ?? null) : null;
      set({
        flows,
        ...(s.selectedFlowId === id
          ? {
              selectedFlowId: nextSel?.id ?? null,
              draft: nextSel ? structuredClone(nextSel) : null,
              selectedNodeId: null,
        nodeTests: null,
            }
          : {}),
      });
      try {
        await api.flows.remove(s.projectPath, id);
      } catch (err) {
        console.error('[flows] delete failed:', err);
      }
    },

    async flush() {
      if (!saveTimer) return;
      clearTimeout(saveTimer);
      saveTimer = null;
      await writeDraft();
    },

    addNode(x, y, kind = 'agent') {
      mutate((g) => ({
        ...g,
        nodes: [
          ...g.nodes,
          {
            id: uid(kind === 'agent' ? 'n' : kind),
            ...newNodeDefaults(kind),
            x: Math.round(x),
            y: Math.round(y),
          },
        ],
      }));
      const added = get().draft?.nodes.at(-1);
      if (added) set({ selectedNodeId: added.id });
    },

    moveNode(id, x, y) {
      mutate((g) => ({
        ...g,
        nodes: g.nodes.map((n) =>
          n.id === id ? { ...n, x: Math.round(x), y: Math.round(y) } : n,
        ),
      }));
    },

    updateNode(id, patch) {
      mutate((g) => ({
        ...g,
        nodes: g.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
      }));
    },

    deleteNode(id) {
      mutate((g) => ({
        ...g,
        nodes: g.nodes.filter((n) => n.id !== id),
        // Dangling edges fail validateGraph on the main side — drop them with
        // the node rather than shipping an unrunnable graph.
        edges: g.edges.filter((e) => e.from !== id && e.to !== id),
      }));
      if (get().selectedNodeId === id) set({ selectedNodeId: null });
    },

    connect(from, to, branch) {
      if (from === to) return; // self-edge = a cycle; validateGraph rejects it
      mutate((g) => {
        const src = g.nodes.find((n) => n.id === from);
        const dst = g.nodes.find((n) => n.id === to);
        if (!src || !dst) return g;
        // Notes are annotations — validateGraph rejects any edge touching one,
        // so refuse the wire here rather than shipping an unrunnable graph.
        if (kindOf(src) === 'note' || kindOf(dst) === 'note') return g;
        // A branch is only meaningful leaving a gate, and a fail branch must
        // land on an agent (it re-queues its target — you cannot retry a gate).
        const isGate = kindOf(src) === 'gate';
        const b = isGate ? (branch ?? 'pass') : undefined;
        if (b === 'fail' && kindOf(dst) !== 'agent') return g;
        // Dedupe per (from, to, branch): a gate legitimately points at the same
        // node on both branches only if the user really wants that, but the
        // same branch twice is a no-op.
        if (g.edges.some((e) => e.from === from && e.to === to && e.branch === b)) {
          return g;
        }
        const edge: FlowEdge = {
          from,
          to,
          label: edgeLabelFor(b),
          ...(b ? { branch: b } : {}),
        };
        return { ...g, edges: [...g.edges, edge] };
      });
    },

    disconnect(from, to, branch) {
      // Exact-match on branch: a gate may run pass AND fail edges to the same
      // node, and deleting one must never take the other with it.
      mutate((g) => ({
        ...g,
        edges: g.edges.filter(
          (e) => !(e.from === from && e.to === to && e.branch === branch),
        ),
      }));
    },

    setEdgeBranch(edge, branch) {
      mutate((g) => {
        const src = g.nodes.find((n) => n.id === edge.from);
        const dst = g.nodes.find((n) => n.id === edge.to);
        // Same legality rules as connect(): branches only leave a gate, and a
        // fail branch must land on an agent.
        if (!src || kindOf(src) !== 'gate') return g;
        if (branch === 'fail' && kindOf(dst) !== 'agent') return g;
        // The target slot is taken — switching would collapse two edges.
        if (g.edges.some((e) => e.from === edge.from && e.to === edge.to && e.branch === branch)) {
          return g;
        }
        const defaults = ['handoff', 'pass ✓', 'fail ✗ retry'];
        return {
          ...g,
          edges: g.edges.map((e) => {
            if (e.from !== edge.from || e.to !== edge.to || e.branch !== edge.branch) return e;
            // Default labels follow the branch; hand-written ones stay.
            const label = !e.label || defaults.includes(e.label) ? edgeLabelFor(branch) : e.label;
            return { ...e, branch, label };
          }),
        };
      });
    },

    updateFlowMeta(patch) {
      mutate((g) => ({ ...g, ...patch }));
    },
  };
});

// Live pushes from main (FLOW_CHANGED): flow-list changes and run transitions.
// Subscribed once at module init — same shape as the tasks store.
if (typeof window !== 'undefined' && api?.flows?.onChanged) {
  api.flows.onChanged((evt) => useFlowsStore.getState().applyChanged(evt));
}
