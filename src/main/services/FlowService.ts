// Agent Flow — the run engine.
//
// A run walks a user-drawn DAG: every 2s it launches whatever is ready (all of
// it, concurrently — a fan-out branch runs in parallel), watches what's in
// flight, and hands each node's captured output to its downstream nodes as
// context. Two node flavours:
//
//   headless    `claude -p` in the project cwd — stdout IS the output, exit
//               code IS the verdict (flowExec).
//   interactive a real tmux-backed CLI session the user can dock and watch.
//               There is no exit code to wait on, so completion is the same
//               idle heuristic the Tasks subsystem uses (ipc/tasks.ts:175):
//               no PTY output for 25s *after* the agent first spoke.
//
// Runs are triggered from chat only (control socket / MCP) — never the canvas.
// Every state transition is persisted (flowStore) and pushed to the renderer
// (onRunChanged), so the canvas overlay and `flow_status` read the same truth.

import {
  startClaudePrintIn,
  type FlowExecHandle,
} from '@main/services/flowExec';
import {
  captureFlowOutput,
  killFlowSession,
  launchFlowSession,
  OUTPUT_CAP,
  sendToFlowSession,
} from '@main/services/flowSessions';
import {
  composeNodePrompt,
  finishStatuses,
  readyNodes,
  upstreamOf,
  validateGraph,
  type StatusById,
} from '@main/services/flowScheduler';
import * as store from '@main/services/flowStore';
import { getSessionStats } from '@main/services/PtyPool';
import { projectIdForPath } from '@main/services/ProjectScanner';
import { resolveAuthEnvPairs } from '@main/services/ClaudeAuthService';
import type {
  FlowGraph,
  FlowNode,
  FlowNodeRun,
  FlowRun,
  FlowNodeStatus,
} from '@shared/flowTypes';
import { createLogger } from '@shared/logger';

const logger = createLogger('FlowService');

// Engine cadence. 2s is well below any agent's turn time — the cost of a tick
// is one getSessionStats() pass over the PTY map.
const TICK_MS = 2_000;
// Interactive completion: silence for this long AFTER first output means the
// agent is parked at its prompt (a spinner tick / redraw refreshes activity, so
// silence really is silence). 25s ≳ the Tasks poller's 20s — a flow node hands
// its output straight to the next node, so a false "done" is costlier here.
const IDLE_DONE_MS = 25_000;

export interface FlowServiceDeps {
  /** Broadcast a run transition to the renderer (IPC.FLOW_CHANGED). */
  onRunChanged: (run: FlowRun) => void;
  now?: () => number;
  idgen?: () => string;
}

export interface FlowService {
  list(projectPath: string): Promise<FlowGraph[]>;
  save(projectPath: string, graph: FlowGraph): Promise<void>;
  remove(projectPath: string, id: string): Promise<void>;
  runs(projectPath: string): Promise<FlowRun[]>;
  runFlow(
    projectPath: string,
    flowIdOrName: string,
    task: string,
  ): Promise<{ ok: true; runId: string } | { ok: false; error: string }>;
  stopRun(runId: string): Promise<{ ok: boolean; error?: string }>;
  sendToNode(
    runId: string,
    nodeId: string,
    text: string,
  ): Promise<{ ok: boolean; error?: string }>;
  getRun(runId: string): FlowRun | undefined;
  activeSessionKeys(): Set<string>;
}

// In-flight bookkeeping for one run. Deliberately NOT persisted: a run does not
// survive an app restart (phase 1) — the journal on disk is the record, the
// live handles are the process.
interface LiveRun {
  run: FlowRun;
  graph: FlowGraph;
  timer: ReturnType<typeof setInterval>;
  execs: Map<string, FlowExecHandle>; // headless children, for stopRun
  watchers: Map<string, () => void>; // interactive PTY unsubscribes
  firstActivityAt: Map<string, number>; // interactive: when the agent first spoke
  starting: Set<string>; // launch in progress — guards a double-launch across ticks
}

// ── module-level session registry ───────────────────────────────────────────
// sessionReconcile lazy-imports this to protect live flow sessions from the
// boot orphan sweep (an interactive flow node is nobody's open tab, so without
// it the sweep would kill a working agent). Empty when no service exists.
let active: FlowService | null = null;

export function getActiveFlowSessionKeys(): Set<string> {
  return active ? active.activeSessionKeys() : new Set<string>();
}

export function createFlowService(deps: FlowServiceDeps): FlowService {
  const now = deps.now ?? (() => Date.now());
  const idgen = deps.idgen ?? (() => Math.random().toString(36).slice(2, 8));
  const live = new Map<string, LiveRun>();

  // ── persistence + broadcast: every transition goes through here ──────────
  const commit = (lr: LiveRun): void => {
    void store.saveRun(lr.run.projectPath, lr.run).catch((e) => {
      logger.warn(`saveRun failed: ${(e as Error).message}`);
    });
    deps.onRunChanged(lr.run);
  };

  const nodeRun = (lr: LiveRun, nodeId: string): FlowNodeRun | undefined =>
    lr.run.nodes.find((n) => n.nodeId === nodeId);

  const statusMap = (lr: LiveRun): StatusById =>
    Object.fromEntries(lr.run.nodes.map((n) => [n.nodeId, n.status]));

  const applyStatuses = (lr: LiveRun, statuses: StatusById): void => {
    for (const n of lr.run.nodes) {
      const next = statuses[n.nodeId];
      if (next && next !== n.status) n.status = next;
    }
  };

  const setNode = (
    lr: LiveRun,
    nodeId: string,
    patch: Partial<FlowNodeRun> & { status: FlowNodeStatus },
  ): void => {
    const n = nodeRun(lr, nodeId);
    if (!n) return;
    Object.assign(n, patch);
  };

  // Context handed to a node: each upstream node's captured output. Nodes only
  // ever see their own upstream — that is what an edge means.
  const upstreamOutputs = (
    lr: LiveRun,
    nodeId: string,
  ): Array<{ role: string; output: string }> =>
    upstreamOf(lr.graph, nodeId).map((upId) => ({
      role: lr.graph.nodes.find((n) => n.id === upId)?.role ?? upId,
      output: nodeRun(lr, upId)?.output ?? '',
    }));

  const teardown = (lr: LiveRun): void => {
    clearInterval(lr.timer);
    for (const un of lr.watchers.values()) un();
    lr.watchers.clear();
  };

  // ── terminal transitions ────────────────────────────────────────────────
  const finishRun = (lr: LiveRun, status: FlowRun['status'], error?: string): void => {
    if (lr.run.status !== 'running') return; // already terminal — first writer wins
    // Anything still queued was never reached and never will be.
    applyStatuses(lr, finishStatuses(lr.graph, statusMap(lr)));
    lr.run.status = status;
    lr.run.endedAt = now();
    if (error) lr.run.error = error;
    teardown(lr);
    // Headless children are invisible to the user — never leave one running
    // past its run. Interactive sessions are deliberately left alive: they are
    // dockable and hold the agent's work; the user (or stopRun) decides.
    for (const h of lr.execs.values()) h.kill();
    lr.execs.clear();
    live.delete(lr.run.id);
    logger.info(`run ${lr.run.id} (${lr.run.flowName}) → ${status}${error ? `: ${error}` : ''}`);
    commit(lr);
  };

  const failNode = (lr: LiveRun, nodeId: string, error: string): void => {
    setNode(lr, nodeId, { status: 'failed', endedAt: now(), error });
    const role = lr.graph.nodes.find((n) => n.id === nodeId)?.role ?? nodeId;
    finishRun(lr, 'failed', `node "${role}" failed: ${error}`);
  };

  const completeNode = (lr: LiveRun, nodeId: string, output: string): void => {
    const un = lr.watchers.get(nodeId);
    if (un) {
      un();
      lr.watchers.delete(nodeId);
    }
    lr.execs.delete(nodeId);
    setNode(lr, nodeId, {
      status: 'done',
      endedAt: now(),
      output: output.slice(-OUTPUT_CAP),
    });
    commit(lr);
  };

  // ── node launch ─────────────────────────────────────────────────────────
  const launchNode = async (lr: LiveRun, node: FlowNode): Promise<void> => {
    const prompt = composeNodePrompt(lr.run.task, node, upstreamOutputs(lr, node.id));
    setNode(lr, node.id, { status: 'running', startedAt: now() });

    if (node.mode === 'headless') {
      // claude -p, cwd = the project, with the node's auth profile.
      const envPairs = node.authProfileId
        ? await resolveAuthEnvPairs(node.authProfileId)
        : [];
      const handle = await startClaudePrintIn(lr.run.projectPath, prompt, envPairs);
      lr.execs.set(node.id, handle);
      commit(lr);

      void handle.done.then((res) => {
        // A run that already went terminal (stopRun / a sibling's failure) owns
        // the node's status — a late child result must not resurrect it.
        if (lr.run.status !== 'running') return;
        if (res.ok) completeNode(lr, node.id, res.text.trim());
        else failNode(lr, node.id, res.error ?? 'claude -p failed');
      });
      return;
    }

    // Interactive: a dockable CLI session. Completion is the idle heuristic in
    // tick(); output is accumulated from the PTY stream as it appears.
    const key = await launchFlowSession(node, {
      projectId: lr.run.projectId,
      projectPath: lr.run.projectPath,
      runId: lr.run.id,
      prompt,
    });
    setNode(lr, node.id, { status: 'running', sessionKey: key });

    const unsub = captureFlowOutput(key, {
      append: (text) => {
        const n = nodeRun(lr, node.id);
        if (!n) return;
        n.output = `${n.output ?? ''}${text}`.slice(-OUTPUT_CAP);
      },
      onFirstData: () => lr.firstActivityAt.set(node.id, now()),
    });
    lr.watchers.set(node.id, unsub);
    commit(lr);
  };

  // ── the tick ────────────────────────────────────────────────────────────
  const tick = (lr: LiveRun): void => {
    if (lr.run.status !== 'running') return;

    // 1. Interactive nodes that have gone quiet long enough → done.
    const stats = getSessionStats();
    const t = now();
    for (const n of lr.run.nodes) {
      if (n.status !== 'running' || !n.sessionKey) continue;
      // Never "done" before the agent has produced anything — a session that
      // has only ever booted is not an idle session, it is a slow one.
      const first = lr.firstActivityAt.get(n.nodeId);
      if (first === undefined) continue;
      const act = stats.find((s) => s.id === n.sessionKey)?.lastActivityAt;
      if (act === undefined || t - act < IDLE_DONE_MS) continue;
      completeNode(lr, n.nodeId, n.output ?? '');
    }

    // 2. Launch everything that is ready (fan-out runs concurrently).
    for (const id of readyNodes(lr.graph, statusMap(lr))) {
      if (lr.starting.has(id)) continue;
      const node = lr.graph.nodes.find((n) => n.id === id);
      if (!node) continue;
      lr.starting.add(id);
      void launchNode(lr, node).catch((e) => {
        lr.starting.delete(id);
        if (lr.run.status === 'running') failNode(lr, id, (e as Error).message);
      });
    }

    // 3. Nothing left in flight and nothing left to start → the run is done.
    const open = lr.run.nodes.some(
      (n) => n.status === 'queued' || n.status === 'running',
    );
    if (!open) finishRun(lr, 'done');
  };

  const svc: FlowService = {
    list: (projectPath) => store.loadFlows(projectPath),
    save: (projectPath, graph) => store.saveFlow(projectPath, graph),
    remove: (projectPath, id) => store.deleteFlow(projectPath, id),
    runs: (projectPath) => store.loadRecentRuns(projectPath),

    async runFlow(projectPath, flowIdOrName, task) {
      const wanted = (flowIdOrName ?? '').trim().toLowerCase();
      if (!wanted) return { ok: false, error: 'flow id or name required' };
      if (!(task ?? '').trim()) return { ok: false, error: 'task required' };

      const flows = await store.loadFlows(projectPath);
      const graph = flows.find(
        (f) =>
          f.id.toLowerCase() === wanted || (f.name ?? '').toLowerCase() === wanted,
      );
      if (!graph) {
        const names = flows.map((f) => f.name).join(', ') || '(none)';
        return { ok: false, error: `flow not found: ${flowIdOrName}. Available: ${names}` };
      }

      const errors = validateGraph(graph);
      if (errors.length > 0) {
        return { ok: false, error: `flow "${graph.name}" is invalid — ${errors.join('; ')}` };
      }

      const run: FlowRun = {
        id: idgen(),
        flowId: graph.id,
        flowName: graph.name,
        projectPath,
        // Path-derived, same sha1 the workspace scan uses for Project.id — the
        // renderer attaches a pane by (projectId, tabId), so a different id here
        // would silently orphan every interactive node. See ProjectScanner.
        projectId: projectIdForPath(projectPath),
        task: task.trim(),
        status: 'running',
        nodes: graph.nodes.map((n) => ({ nodeId: n.id, status: 'queued' as const })),
        startedAt: now(),
      };

      const timer = setInterval(() => {
        const lr = live.get(run.id);
        if (lr) tick(lr);
      }, TICK_MS);
      timer.unref?.(); // never keep the app alive on account of a run

      const lr: LiveRun = {
        run,
        graph,
        timer,
        execs: new Map(),
        watchers: new Map(),
        firstActivityAt: new Map(),
        starting: new Set(),
      };
      live.set(run.id, lr);
      logger.info(`run ${run.id} started: ${graph.name} (${graph.nodes.length} nodes)`);
      commit(lr);
      tick(lr); // launch the entry nodes now rather than a tick from now
      return { ok: true, runId: run.id };
    },

    async stopRun(runId) {
      const lr = live.get(runId);
      if (!lr) return { ok: false, error: 'run not found (or already finished)' };

      // An explicit user stop kills everything, including the interactive
      // sessions (unlike a failure, which leaves them dockable for inspection).
      const running = lr.run.nodes.filter((n) => n.status === 'running');
      for (const h of lr.execs.values()) h.kill();
      for (const n of running) {
        const node = lr.graph.nodes.find((g) => g.id === n.nodeId);
        if (!node || node.mode !== 'interactive') continue;
        await killFlowSession(lr.run.projectId, node.cliId, lr.run.id, node.id);
      }
      // A killed node did run — 'skipped' would be a lie, so it is 'failed'
      // with the reason. finishRun turns the still-queued ones into 'skipped'.
      for (const n of running) {
        setNode(lr, n.nodeId, { status: 'failed', endedAt: now(), error: 'stopped' });
      }
      finishRun(lr, 'stopped');
      return { ok: true };
    },

    async sendToNode(runId, nodeId, text) {
      const lr = live.get(runId);
      if (!lr) return { ok: false, error: 'run not found (or already finished)' };
      const n = nodeRun(lr, nodeId);
      if (!n) return { ok: false, error: `node not found: ${nodeId}` };
      if (!n.sessionKey) {
        return {
          ok: false,
          error: `node "${nodeId}" has no live session (headless nodes cannot be steered mid-run)`,
        };
      }
      if (!(text ?? '').trim()) return { ok: false, error: 'text required' };
      sendToFlowSession(n.sessionKey, text);
      return { ok: true };
    },

    getRun: (runId) => live.get(runId)?.run,

    activeSessionKeys() {
      const keys = new Set<string>();
      for (const lr of live.values()) {
        for (const n of lr.run.nodes) {
          if (n.sessionKey && n.status === 'running') keys.add(n.sessionKey);
        }
      }
      return keys;
    },
  };

  active = svc;
  return svc;
}
