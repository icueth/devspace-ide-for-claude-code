# Agent Flow — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chat-triggered multi-agent flows: the user designs a flow graph on a canvas (node = real CLI agent with cli/model/role, edge = handoff); the lead agent (the user's normal Claude dock session) starts/monitors/stops runs via MCP tools; a main-process runner executes the graph with real CLI sessions.

**Architecture:** Mirrors the Tasks subsystem exactly. `FlowService` (main) owns graph CRUD + a run engine; persistence is plain JSON under `<project>/.devspace/flows/`; a unix control socket + the bundled MCP server give the chat agent `run_flow`/`flow_status`/`stop_flow` tools; renderer gets a `FlowsView` canvas as an editor tab (`kind: 'flows'`) reachable from a new WorkbenchRail destination. Chat is the ONLY run trigger (user decision) — the canvas has no Run button; it designs and monitors.

**Tech Stack:** Electron main services + IPC (existing patterns), Zustand, plain SVG canvas (no graph lib), vitest.

## Global Constraints

- Chat is the only run trigger. No Run/Dry-run buttons anywhere in FlowsView.
- Headless node execution = `claude -p` (print mode; NEVER `claude --bg` — stub output, see DistillationService.ts:22-28).
- All persistence via `atomicWriteAsync`; per-project data under `<projectPath>/.devspace/flows/`.
- Every renderer-supplied path passes `assertInWorkspace` before main-side use.
- Interactive flow sessions must survive boot reconcile (extend the protected-keys set in sessionReconcile.ts).
- Keep files under 500 lines; new logic in new modules (never grow existing services).
- Prefix all shell commands with `rtk`. Run `rtk tsc`, `rtk vitest run` before any commit.
- No `Co-Authored-By` trailer on commits.

---

## Shared contract (Task 1 — owned by lead; both subagents compile against this)

**Create `src/shared/flowTypes.ts`:**

```ts
import type { CliId } from './types';

export type FlowNodeStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped';
export type FlowRunStatus = 'running' | 'done' | 'failed' | 'stopped';
export type FlowNodeMode = 'headless' | 'interactive';

export interface FlowNode {
  id: string;
  role: string;               // "researcher"
  rolePrompt: string;         // the node's brief template
  cliId: CliId;               // 'claude' | 'codex' | 'gemini' | 'opencode' | 'antigravity'
  authProfileId?: string;     // claude credentials profile
  cliProfileId?: string;      // non-claude provider profile
  mode: FlowNodeMode;         // headless => claude -p (claude only); interactive => tmux PTY session
  x: number;
  y: number;
}

export interface FlowEdge { from: string; to: string; label?: string }

export interface FlowGraph {
  id: string;                 // uuid-ish slug, stable
  name: string;               // "feature-pipeline"
  description: string;        // routing hint for the lead agent
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
  output?: string;            // capped 20_000 chars
  error?: string;
  sessionKey?: string;        // interactive nodes: `${projectId}:${kind}:flow-${runId}-${nodeId}`
}

export interface FlowRun {
  id: string;
  flowId: string;
  flowName: string;
  projectPath: string;
  projectId: string;
  task: string;               // kickoff prompt from chat
  status: FlowRunStatus;
  nodes: FlowNodeRun[];
  startedAt: number;
  endedAt?: number;
  error?: string;
}
```

**Modify `src/shared/ipc-channels.ts`** — append before the closing `} as const;`:

```ts
  // Agent Flow (phase 1). Graph CRUD + chat-triggered runs. FLOW_CHANGED is
  // the single main → renderer push: { projectPath, flows?, run? }.
  FLOW_LIST: 'flow:list',
  FLOW_SAVE: 'flow:save',
  FLOW_DELETE: 'flow:delete',
  FLOW_RUNS: 'flow:runs',
  FLOW_STOP: 'flow:stop',
  FLOW_SEND: 'flow:send',
  FLOW_CHANGED: 'flow:changed',
```

(No FLOW_RUN invoke channel — runs start from chat via the control socket only.)

Push payload type (in flowTypes.ts):

```ts
export interface FlowChangedEvent {
  projectPath: string;
  flows?: FlowGraph[];   // present when the flow list changed
  run?: FlowRun;         // present when a run changed
}
```

---

### Task 2: Main-side engine (subagent A)

**Files:**
- Create: `src/main/services/flowStore.ts` — `loadFlows(projectPath): Promise<FlowGraph[]>`, `saveFlow(projectPath, graph)`, `deleteFlow(projectPath, id)`, `saveRun(projectPath, run)`, `loadRecentRuns(projectPath, limit=20)`. Files: `<projectPath>/.devspace/flows/<id>.flow.json`, runs at `.devspace/flows/runs/<runId>.json`. Pattern: taskStore.ts (corrupt → empty; atomicWriteAsync).
- Create: `src/main/services/flowScheduler.ts` — pure functions: `validateGraph(g): string[]` (dup ids, dangling edges, cycles via Kahn, >0 nodes, headless⇒cliId==='claude'), `readyNodes(g, statusById): string[]` (queued && all upstream done), `finishStatuses(g, statusById)` (failed node ⇒ downstream 'skipped'), `composeNodePrompt(task, node, upstreamOutputs: Array<{role, output}>): string`.
- Create: `src/main/services/flowExec.ts` — `runClaudePrintIn(cwd: string, prompt: string, envPairs?: Array<[string,string]>): Promise<{ok, text, error?, kill(): void}>`-style headless exec: spawn `claude -p` with `cwd`, prompt via stdin, 15-min timeout, returns child handle for stop. Model on DistillationService.runClaudePrint (ts:449) but with cwd + env injection + external kill.
- Create: `src/main/services/FlowService.ts` — `createFlowService(deps)` returning `{ list, save, remove, runs, runFlow(projectPath, flowIdOrName, task), stopRun(runId), sendToNode(runId, nodeId, text), activeSessionKeys(): Set<string> }`. Engine loop: statuses all 'queued' → repeatedly launch readyNodes (parallel-safe); headless via flowExec; interactive via `launchClaudeCli({projectId, tabId: 'flow-<runId>-<nodeId>', cwd, initialPrompt, authProfileId})` (ClaudeCliLauncher.ts:120; non-claude interactive via launchCodexCli/launchGeminiCli/launchOpenCodeCli with cliProfileId) with completion = PtyPool `getSessionStats()` idle ≥ 25s after first activity (pattern: startReviewPoller, ipc/tasks.ts:175); on node fail → run failed + finishStatuses; persist run on every transition; `onRunChanged(run)` callback injected for broadcast. `projectId` derivation: reuse the same hash the workspace uses if trivially importable, else `createHash('sha1').update(projectPath).digest('hex').slice(0,12)` — MUST match what renderer cliTabs uses to attach panes; verify against src/renderer (workspace store project ids come from main WORKSPACE_SCAN — simplest correct: pass projectId in from callers; control socket resolves it via the workspaces file if available, else hash. Document choice in code).
- Create: `src/main/services/flowControl.ts` — socket `~/.devspace/flow-control.sock`; pure `routeFlowControl(svc, req)` with ops: `list` (flows of repo), `run {repo, flow, task}` → `{ok, runId}`, `status {runId}` → per-node status/output tail, `send {runId, node, text}`, `stop {runId}`, `runs {repo}`. Copy the newline-JSON socket shape from taskControl.ts:136-181. `assertInWorkspace(repo)` on every repo-bearing op.
- Create: `src/main/ipc/flows.ts` — `registerFlowsIpc()`: handlers for FLOW_LIST/SAVE/DELETE/RUNS/STOP/SEND (assertInWorkspace on projectPath); broadcast helper `push(event: FlowChangedEvent)` to all windows on IPC.FLOW_CHANGED (pattern ipc/tasks.ts:56-60); calls `startFlowControlSocket`.
- Modify: `src/main/index.ts` — call `registerFlowsIpc()` next to `registerTasksIpc()` in app.whenReady.
- Modify: `src/main/services/sessionReconcile.ts` — in `reconcileOrphanCliSessions`, union a third protected set from `FlowService.activeSessionKeys()` (lazy import, same style as the existing lazy imports) merged into `taskKeys` before `selectOrphans` (keep selectOrphans' 3-arg signature).
- Modify: `resources/task-mcp/server.mjs` — add tools `list_flows`, `run_flow {flow, task, repo?}`, `flow_status {runId}`, `send_flow {runId, node, text}`, `stop_flow {runId}` targeting the flow socket (`DEVSPACE_FLOW_SOCK` default `~/.devspace/flow-control.sock`); descriptions must tell the lead when to route work into a flow. Bump serverInfo version.
- Test: `src/main/services/__tests__/flowScheduler.test.ts` (cycle, dangling edge, ready progression incl. fan-in, failed⇒skipped, prompt composition), `__tests__/flowStore.test.ts` (tmpdir round-trip + corrupt fallback), `__tests__/flowControl.test.ts` (routeFlowControl with mocked svc — run/list/status/stop/unknown op).

**Interfaces:** Consumes Task 1's flowTypes verbatim. Produces `registerFlowsIpc`, control-socket op set above, `FlowService.activeSessionKeys`.

### Task 3: Renderer (subagent B)

**Files:**
- Modify: `src/preload/index.ts` + `src/renderer/lib/api.ts` — `flows` namespace: `list(projectPath)`, `save(projectPath, graph)`, `remove(projectPath, id)`, `runs(projectPath)`, `stop(runId)`, `send(runId, nodeId, text)`, `onChanged(cb): unsubscribe` (pattern: tasks.onChanged, preload/index.ts:38-42).
- Create: `src/renderer/state/flows.ts` — Zustand store: `{ flows, runs, selectedFlowId, selectedNodeId, loadForProject(path), saveFlow, deleteFlow, selectFlow, selectNode, applyChanged(evt) }`; subscribes once to `api.flows.onChanged`.
- Create: `src/renderer/components/Flows/FlowsView.tsx` (shell: left flow list + canvas + right inspector, ≤300 lines), `FlowCanvas.tsx` (SVG edges + node cards + pan/zoom + drag + right-click context menu + port-drag edge creation — port the mockup's interactions to React), `FlowNodeCard.tsx`, `FlowInspector.tsx` (role/cliId/profile/model/mode/rolePrompt fields; flow-level: name + description + hint "รันผ่านแชท: บอก lead ให้ใช้ run_flow"), live run overlay: node status ring from latest run, click node with sessionKey → dock the session (useCliTabsStore addTab with matching tabId so tmux `-A` attaches — pattern src/renderer/lib/claudeCli.ts:45).
- Modify: `src/renderer/state/editor.ts` — add `'flows'` to EditorTabKind + `flowsProjectPath?` field + `openFlows(projectPath, projectName)` action (copy openCodeflow, editor.ts:249; tab path `flows:<projectPath>`).
- Modify: `src/renderer/components/Editor/EditorArea.tsx` — lazy `FlowsView` + `tab.kind === 'flows'` branch (pattern lines 24-35, 239).
- Modify: `src/renderer/components/Layout/WorkbenchRail.tsx` — add `'flows'` to WorkbenchDestination + destinations entry (icon: `Spline` from lucide-react; disabled when `!hasProject`).
- Modify: `src/renderer/components/Layout/workbenchRouting.ts` — `resolveEditorDestination`: `activeTabKind === 'flows'` → `'flows'`; falling out of a flows tab behaves like codeflow. Update `Layout/__tests__/workbenchRouting.test.ts`.
- Modify: `src/renderer/App.tsx` — `navigateWorkbench` case `'flows'` mirroring `'codeflow'` (App.tsx:692), persisted-destination allowlist (App.tsx:1040-1059), spotlight command `nav.flows` "Open Agent Flows" (App.tsx:486-520).
- Test: extend `workbenchRouting.test.ts`; `src/renderer/state/__tests__/flows.test.ts` (applyChanged merge semantics).

**Interfaces:** Consumes flowTypes + IPC names from Task 1; api.flows surface as above. No files shared with Task 2.

### Task 4: Verify + commit (lead)

- [ ] `rtk tsc` — 0 errors
- [ ] `rtk vitest run` — all green (existing 800+ suite + new)
- [ ] `rtk npm run build` — clean
- [ ] Commit per logical unit on `feature/agent-flow`

## Phase 2 (explicitly out of scope now)

Gate/condition nodes, fan-out templates, dedicated chat panel UI (lead session embedded in FlowsView), per-node tool-approval badges (`pty:tool-approval`), token metrics, run history browser, non-claude headless execs (`codex exec`).
