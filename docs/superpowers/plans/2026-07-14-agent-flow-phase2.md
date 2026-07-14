# Agent Flow — Phase 2 Implementation Plan (mockup parity)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Contract (flowTypes + IPC channels) is already committed — compile against it verbatim.

**Goal:** Close the gap to the approved mockup: an embedded lead-chat panel inside FlowsView, gate nodes with pass/fail branching + bounded retry loops, note nodes, per-node model, flow templates, and a run log strip.

**Base:** branch `feature/agent-flow` after commit `ddc2836` + contract edits (flowTypes: kind/branch/condition/maxRetries/model/noteText/attempts/verdict + FlowChat types; IPC: FLOW_CHAT_SEND/HISTORY/CLEAR/EVENT).

## Global Constraints (in addition to phase 1's)

- Lead chat runs on `claude` print mode via TmuxChatRunner ONLY (normal login; NEVER the Agent SDK, NEVER `--bg`).
- Continuity by prompt-stuffing (the codebase's proven pattern — TmuxChatRunner StartRunOptions.prompt is documented as "full conversation history + tail instruction"). No --resume.
- The lead MUST see the flow MCP tools: pass an explicit `--mcp-config <generated file>` (project-scoped .mcp.json is approval-gated and its command points at a packaged app path — generate a fresh config with the dev-correct command from taskMcpPaths + DEVSPACE_TASK_SOCK/DEVSPACE_FLOW_SOCK/DEVSPACE_PROJECT_PATH env, same as taskMcpRegister builds).
- Do NOT reuse ForgeService.buildClaudeArgs (it strips tools via --disallowed-tools).
- Gate fail edges are exempt from the DAG cycle check — they ARE the retry loop; everything else must stay acyclic.
- Chat history = plain curatable JSON at `<projectPath>/.devspace/flows/chat.json`, capped at 200 messages.

### Task A: engine — gates, retry, model (main process)

- `flowScheduler.ts`:
  - `validateGraph`: run Kahn over `edges.filter(e => e.branch !== 'fail')`; skip the headless⇒claude rule for `kind==='gate'|'note'`; new rules — gate needs non-empty `condition`, fail/pass branch only legal on edges FROM a gate, note nodes may not carry edges, fail-edge target must be an agent node.
  - `readyNodes(g, statusById, verdictById)`: readiness ignores fail edges entirely; an edge from a gate (branch pass/undefined) requires gate done AND verdict 'pass'.
  - New `retryTargets(g, gateId): string[]` (fail-edge targets) and `resetForRetry(g, gateId, statusById): StatusById` — BFS from each fail-target along non-fail edges, flipping done/failed back to queued (never crossing the gate itself).
  - `composeNodePrompt` unchanged for agents; new `composeGatePrompt(condition, upstreamOutputs)` instructing a strict one-word `PASS` or `FAIL` first-line answer.
- `FlowService.ts`:
  - `launchNode` short-circuits gates: evaluate via `startClaudePrintIn(projectPath, composeGatePrompt(...), envPairs, node.model)` — parse first PASS/FAIL token (unparseable ⇒ fail the gate node). On verdict: set FlowNodeRun.verdict; PASS ⇒ completeNode; FAIL ⇒ if attempts budget left, `resetForRetry` + bump each re-queued node's `attempts` + gate's own attempts, mark gate done (verdict fail) so the tick relaunches the loop; budget exhausted ⇒ failNode(gate, 'condition failed after N retries').
  - A failed AGENT node still fails the run (phase-1 semantics) — only gate verdicts route.
  - Pass `node.model` through both paths.
- `flowExec.ts`: `startClaudePrintIn(cwd, prompt, envPairs, model?)` — push `'--model', model` into argv when set.
- `ClaudeCliLauncher.ts`: add `model?: string` to ClaudeLaunchOptions; when set push `'--model', model` into claudeArgs (line ~149). `flowSessions.ts` passes node.model for claude interactive nodes.
- Tests: scheduler (fail-edge cycle allowed / other cycles rejected; gate-verdict readiness; resetForRetry scope; validation rules), FlowService gate retry loop with mocked exec (pass on attempt 2; budget exhaustion fails run).

### Task B: lead chat backend (main process)

- Create `src/main/services/FlowChatService.ts` (+ `flowChatStore.ts` if needed): `createFlowChatService(deps)` → `{ history(projectPath), send(projectPath, text), clear(projectPath) }`. send(): reject when a turn is in flight for that project ({ok:false,error:'lead is busy'}); append user msg; build prompt = system preamble (you are the LEAD for this project: converse normally; use list_flows/run_flow/flow_status/send_flow/stop_flow for procedural work; ask-don't-guess between flows; reply in the user's language) + stuffed history + tail; write a generated mcp-config JSON (taskMcpPaths command + env incl. DEVSPACE_FLOW_SOCK) under `~/.devspace/flow-chat/`; run one TmuxChatRunner turn with args `['--print','--dangerously-skip-permissions','--mcp-config',<file>]`; on done parse out.jsonl/plain text → append lead msg (error flag on non-zero exit) → persist → push deps.onEvent.
- `src/main/ipc/flows.ts`: FLOW_CHAT_SEND/HISTORY/CLEAR handlers (assertInWorkspace) + FLOW_CHAT_EVENT broadcast.
- Tests: prompt-stuffing shape + busy-lock + history cap (mock the runner).

### Task C: renderer — chat panel + canvas parity

- `FlowChatPanel.tsx` as a 4th `shrink-0` column (w-80, border-l) in FlowsView's root flex row (FlowsView.tsx:67): bubbles (user right / lead left), run-event chips derived from the flows store's runs (status transitions), busy indicator, composer (Enter to send), error styling; header "Chat — lead · claude -p".
- `state/flowChat.ts` store: history/busy per project, send(), applyEvent(); subscribe to api.flows.chat.onEvent.
- preload + api.ts: `flows.chat.{send,history,clear,onChanged}` typed to the contract.
- Canvas kinds: FlowNodeCard renders gate (amber, ◇, condition line, pass ✓/fail ✗ dual out-ports at 32%/68% height) and note (sticky, no ports) — export per-kind geometry (gate 172w, note 180w) for FlowCanvas edge anchors; fail edges dashed red with 'fail ✗' label default, backward fail edges arc below the row (mockup behavior).
- Context menu: enable Add Gate / Add Note. Inspector: gate fields (condition, maxRetries), note text, model input for claude nodes (datalist: fable-5, opus-4.8, sonnet-5, haiku-4.5), attempts badge on node card when >1.
- Templates in the left rail (Pipeline 5-node with gate+fail-loop like the mockup; Fan-out/Fan-in; Supervisor) — clicking creates that flow.
- Run log strip: collapsible bottom bar in FlowsView deriving timestamped entries from run transitions (renderer-side accumulation), plus ~tokens per node (output length / 4, labelled "≈").
- Tests: flows-store event derivation + gate/note geometry invariants; extend cliTabsAttach untouched.
