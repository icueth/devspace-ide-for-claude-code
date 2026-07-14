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
import { applyGateResult, startGateEval } from '@main/services/flowGates';
import {
  applyStatuses,
  nodeRun,
  reopen,
  setNode,
  statusMap,
  teardown,
  upstreamOutputs,
  verdictMap,
  type LiveRun,
} from '@main/services/flowRunState';
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
  kindOf,
  readyNodes,
  validateGraph,
  type StatusById,
} from '@main/services/flowScheduler';
import * as store from '@main/services/flowStore';
import { getSessionStats } from '@main/services/PtyPool';
import { projectIdForPath } from '@main/services/ProjectScanner';
import { resolveAuthEnvPairs } from '@main/services/ClaudeAuthService';
import type { FlowGraph, FlowNode, FlowNodeRun, FlowRun } from '@shared/flowTypes';
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

  // The slice of the live run a gate verdict may touch (flowGates owns the
  // decision, this service owns the state).
  const gateHooks = (lr: LiveRun) => ({
    nodeRun: (id: string) => nodeRun(lr, id),
    setNode: (id: string, patch: Partial<FlowNodeRun>) => setNode(lr, id, patch),
    statusMap: () => statusMap(lr),
    applyStatuses: (next: StatusById) => applyStatuses(lr, next),
    reopen: (ids: string[]) => reopen(lr, ids),
    commit: () => commit(lr),
    completeNode: (id: string, output: string) => completeNode(lr, id, output),
    failNode: (id: string, error: string) => failNode(lr, id, error),
  });

  // ── node launch ─────────────────────────────────────────────────────────
  const launchNode = async (lr: LiveRun, node: FlowNode): Promise<void> => {
    // Bumped here, on every launch, so it counts *attempts* for free: a gate
    // re-queues a node, the tick relaunches it, and the counter follows. A
    // gate's own attempts counter is its evaluation count (flowGates reads it
    // to know how much of the retry budget is left).
    const attempts = (nodeRun(lr, node.id)?.attempts ?? 0) + 1;
    const upstream = upstreamOutputs(lr, node.id);
    setNode(lr, node.id, {
      status: 'running',
      startedAt: now(),
      attempts,
      endedAt: undefined,
      error: undefined,
    });

    // A gate has no agent: the engine runs the judge itself and routes on the
    // verdict. Same exec path as a headless node (claude -p in the project).
    if (kindOf(node) === 'gate') {
      const envPairs = node.authProfileId
        ? await resolveAuthEnvPairs(node.authProfileId)
        : [];
      const handle = await startGateEval(lr.run.projectPath, node, upstream, envPairs);
      lr.execs.set(node.id, handle);
      commit(lr);

      void handle.done.then((res) => {
        if (lr.run.status !== 'running') return; // terminal run owns the status
        applyGateResult(lr.graph, node, res, gateHooks(lr));
      });
      return;
    }

    const prompt = composeNodePrompt(lr.run.task, node, upstream);

    if (node.mode === 'headless') {
      // claude -p, cwd = the project, with the node's auth profile + model.
      const envPairs = node.authProfileId
        ? await resolveAuthEnvPairs(node.authProfileId)
        : [];
      const handle = await startClaudePrintIn(
        lr.run.projectPath,
        prompt,
        envPairs,
        node.model,
      );
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
    if (lr.run.status !== 'running') {
      // The run went terminal while the session was spawning (a sibling failed,
      // or stopRun ran). Same guard the headless path has: don't resurrect the
      // node under a finished run — and kill the newborn session, or an agent
      // would keep working invisibly with no run to stop it through.
      void killFlowSession(lr.run.projectId, node.cliId, lr.run.id, node.id);
      return;
    }
    // Output starts empty on EVERY attempt — on a retry the PTY capture would
    // otherwise append the new attempt onto the rejected one.
    setNode(lr, node.id, { status: 'running', sessionKey: key, output: '' });
    lr.firstActivityAt.delete(node.id);

    // Retry of an interactive claude node: the tmux session already exists, and
    // `new-session -A` reattaches WITHOUT the trailing command — so the agent
    // would never see the new brief (it would just sit there and be declared
    // idle-done with stale output). Type it in instead. The other CLIs are typed
    // into by launchFlowSession anyway, on every launch.
    if (attempts > 1 && node.cliId === 'claude') sendToFlowSession(key, prompt);

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
      const stat = stats.find((s) => s.id === n.sessionKey);
      if (!stat) {
        // The PTY entry is gone — tab closed, agent crashed, or the user typed
        // `exit`. Nothing will ever produce activity again; without this the
        // node (and the whole run) would sit 'running' forever.
        failNode(lr, n.nodeId, 'session ended before completion');
        return; // failNode finished the run — the rest of this tick is moot
      }
      // Never "done" before the agent has produced anything — a session that
      // has only ever booted is not an idle session, it is a slow one.
      const first = lr.firstActivityAt.get(n.nodeId);
      if (first === undefined) continue;
      if (t - stat.lastActivityAt < IDLE_DONE_MS) continue;
      completeNode(lr, n.nodeId, n.output ?? '');
    }

    // 2. Launch everything that is ready (fan-out runs concurrently). Gate
    //    verdicts route here: a gate's pass edges only release on 'pass', and a
    //    fail edge never gates anything (it re-queues, see flowGates).
    for (const id of readyNodes(lr.graph, statusMap(lr), verdictMap(lr))) {
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

    async runs(projectPath) {
      const runs = await store.loadRecentRuns(projectPath);
      // A journal that says 'running' with no live engine entry is a leftover
      // of an app quit/crash mid-run (live state is deliberately not restored).
      // Heal it on read so the canvas and flow_status stop reporting a phantom
      // run the user has no way to clear.
      for (const r of runs) {
        if (r.status !== 'running' || live.has(r.id)) continue;
        r.status = 'stopped';
        r.endedAt = r.endedAt ?? now();
        r.error = 'app restarted mid-run';
        for (const n of r.nodes) {
          if (n.status === 'running') n.status = 'failed';
          else if (n.status === 'queued') n.status = 'skipped';
        }
        void store.saveRun(projectPath, r).catch(() => undefined);
      }
      return runs;
    },

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
        // Notes are annotations, not steps: they get no journal entry at all
        // (an entry would sit 'queued' forever and the run would never close).
        nodes: graph.nodes
          .filter((n) => kindOf(n) !== 'note')
          .map((n) => ({ nodeId: n.id, status: 'queued' as const })),
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

      // Settle the terminal state SYNCHRONOUSLY, before any await. The tick and
      // every late child/launch callback guard on status === 'running', so this
      // single ordering closes two races: a tick firing mid-kill completing a
      // node and launching its downstream past the kill loop, and a killed
      // headless child's done-handler flipping the run to 'failed' first.
      // A killed node did run — 'skipped' would be a lie, so it is 'failed'
      // with the reason. finishRun turns the still-queued ones into 'skipped'
      // and reaps the headless children.
      const running = lr.run.nodes.filter((n) => n.status === 'running');
      for (const n of running) {
        setNode(lr, n.nodeId, { status: 'failed', endedAt: now(), error: 'stopped' });
      }
      finishRun(lr, 'stopped');

      // An explicit user stop kills the interactive sessions too (unlike a
      // failure, which leaves them dockable for inspection). Status is already
      // journaled, so a slow SIGTERM here can't change what the run says.
      for (const n of running) {
        const node = lr.graph.nodes.find((g) => g.id === n.nodeId);
        if (!node || node.mode !== 'interactive') continue;
        await killFlowSession(lr.run.projectId, node.cliId, lr.run.id, node.id);
      }
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
