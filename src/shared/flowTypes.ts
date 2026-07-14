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

export interface FlowNode {
  id: string;
  role: string; // "researcher" — short label shown on the node card
  rolePrompt: string; // the node's brief template (what this agent does)
  cliId: CliId;
  // Claude credentials profile for claude nodes (undefined = subscription).
  authProfileId?: string;
  // Provider profile for non-claude nodes (undefined = the CLI's own default).
  cliProfileId?: string;
  mode: FlowNodeMode;
  // Canvas position (world coords) — pure presentation, but persisted so the
  // layout survives reloads and external edits stay meaningful.
  x: number;
  y: number;
}

export interface FlowEdge {
  from: string; // FlowNode.id
  to: string; // FlowNode.id
  label?: string;
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

// Single main → renderer push payload for IPC.FLOW_CHANGED.
export interface FlowChangedEvent {
  projectPath: string;
  flows?: FlowGraph[]; // present when the flow list changed
  run?: FlowRun; // present when a run changed
}
