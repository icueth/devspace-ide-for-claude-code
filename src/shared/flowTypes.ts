/**
 * Agent Flow (phase 1) — shared DTOs for the flow graph, runs, and the
 * FLOW_CHANGED push. A flow is a user-designed process graph: each node is a
 * real CLI agent (claude / codex / …) with a role brief; each edge hands the
 * upstream node's output to the downstream node's prompt. Runs are triggered
 * from chat (control socket / MCP) only — never from the canvas.
 *
 * On disk: `<projectPath>/.devspace/flows/<id>.flow.json` (graphs) and
 * `.devspace/flows/runs/<runId>.json` (run journal) — plain curatable JSON.
 */

import type { CliId } from './types';

export type FlowNodeStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped';
export type FlowRunStatus = 'running' | 'done' | 'failed' | 'stopped';

// headless => `claude -p` with captured stdout (claude only; deterministic
// completion). interactive => a real tmux-backed PTY session the user can
// dock and watch; completion is the idle heuristic (see FlowService).
export type FlowNodeMode = 'headless' | 'interactive';

// agent — a real CLI agent (the phase-1 node; `kind` undefined means agent so
//         phase-1 files stay valid). gate — a branch point: an LLM judge
//         evaluates `condition` against the upstream outputs and answers
//         pass/fail; pass-branch edges proceed, fail-branch edges re-queue
//         their target (bounded by maxRetries). note — canvas annotation,
//         never executed, may not carry edges.
export type FlowNodeKind = 'agent' | 'gate' | 'note';

export interface FlowNode {
  id: string;
  kind?: FlowNodeKind; // undefined = 'agent' (back-compat with phase-1 files)
  role: string; // "researcher" — short label shown on the node card
  rolePrompt: string; // the node's brief template (what this agent does)
  cliId: CliId;
  // Claude credentials profile for claude nodes (undefined = subscription).
  authProfileId?: string;
  // Provider profile for non-claude nodes (undefined = the CLI's own default).
  cliProfileId?: string;
  mode: FlowNodeMode;
  // Claude nodes only: `--model` for this node's session (works on
  // subscription logins, unlike ANTHROPIC_MODEL). Non-claude models come from
  // the CliProfile. undefined = the CLI's default.
  model?: string;
  // gate only: the condition the judge evaluates against upstream outputs
  // ("tests pass — tester output shows 0 failures").
  condition?: string;
  // gate only: how many times a fail branch may re-queue its target before the
  // run fails (default 3).
  maxRetries?: number;
  // note only: the annotation text.
  noteText?: string;
  // Canvas position (world coords) — pure presentation, but persisted so the
  // layout survives reloads and external edits stay meaningful.
  x: number;
  y: number;
}

export interface FlowEdge {
  from: string; // FlowNode.id
  to: string; // FlowNode.id
  label?: string;
  // Only meaningful when `from` is a gate: 'pass' fires on a pass verdict,
  // 'fail' re-queues its target for a retry (and is exempt from the cycle
  // check — a fail edge pointing backward IS the retry loop). undefined on a
  // gate edge = 'pass'.
  branch?: 'pass' | 'fail';
}

export interface FlowGraph {
  id: string; // stable slug, generated on create
  name: string; // "feature-pipeline"
  // Routing hint for the lead agent choosing a flow from chat ("use for
  // multi-step feature work with tests"). Surfaced verbatim by list_flows.
  description: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  createdAt: number;
  updatedAt: number;
}

export interface FlowNodeRun {
  nodeId: string;
  status: FlowNodeStatus;
  startedAt?: number;
  endedAt?: number;
  // How many times this node has been (re)launched — bumps when a gate's fail
  // branch re-queues it. undefined = first attempt.
  attempts?: number;
  // gate nodes: the judge's verdict for the latest evaluation.
  verdict?: 'pass' | 'fail';
  // Captured output (headless stdout / interactive terminal tail), capped at
  // 20_000 chars before persist — feeds downstream prompts and flow_status.
  output?: string;
  error?: string;
  // Interactive nodes: PtyPool key `${projectId}:${kind}:flow-${runId}-${nodeId}`
  // so the renderer can dock the live session and reconcile can protect it.
  sessionKey?: string;
}

export interface FlowRun {
  id: string;
  flowId: string;
  flowName: string;
  projectPath: string;
  projectId: string;
  task: string; // kickoff prompt from chat
  status: FlowRunStatus;
  nodes: FlowNodeRun[];
  startedAt: number;
  endedAt?: number;
  error?: string;
}

// One node's preflight result (IPC.FLOW_TEST): does this node's CLI + model +
// profile actually work? Probes are tiny one-shot calls ("reply OK") — they
// validate the runtime, they do NOT execute the flow (chat stays the only
// run trigger).
export interface FlowNodeTestResult {
  nodeId: string;
  ok: boolean;
  // "claude · opus — OK (3.1s)" / "codex — exit 1: model_not_found …"
  detail: string;
}

export interface FlowTestReport {
  graphErrors: string[]; // validateGraph findings — structural problems
  nodes: FlowNodeTestResult[];
}

// Single main → renderer push payload for IPC.FLOW_CHANGED.
export interface FlowChangedEvent {
  projectPath: string;
  flows?: FlowGraph[]; // present when the flow list changed
  run?: FlowRun; // present when a run changed
}

// ── dock flow selection (phase 3) ────────────────────────────────────────────
// Chat lives in the dock: the user's normal claude tab is the lead. A flow can
// be PINNED to one dock tab (right-click the tab → Use flow); the MCP server
// identifies the calling session via DEVSPACE_CLI_TAB_ID and `run_flow`
// defaults to the pinned flow. Payload for IPC.FLOW_SELECT.
export interface FlowSelectEvent {
  projectId: string;
  projectPath: string;
  tabId: string;
  flowId: string | null; // null = unpin
}
