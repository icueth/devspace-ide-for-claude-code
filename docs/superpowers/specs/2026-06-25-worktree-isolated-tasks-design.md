# Worktree-Isolated Agent Tasks (v2 · Sub-project A) — Design Spec

**Status:** Approved design, pending implementation plan
**Date:** 2026-06-25
**Branch:** `feat/v2-worktree-tasks` (off `feat/tab-sidebar-workspace-sync`, which carries the Plan C dock/sidebar sync this design reuses)

## Context

DevSpace today is project-centric: a picked **workspace** (folder) contains detected **projects** (git repos / runtime-marker folders); each project docks one or more persistent Claude CLI sessions (tmux) whose working directory is the project root. All sessions for a project share that one working directory — so running multiple agents on the same repo makes them clobber each other's files.

Inspired by [superset](https://github.com/superset-sh/superset), v2 adds **worktree-isolated agent tasks**: a first-class, flat, top-level **Task** entity. Each task gets its own git worktree + branch and an agent session rooted in it, so many agents can work the same repo in parallel without collision. This is **sub-project A** of a 3-part v2 (B = workspace presets, C = keyboard quick-switch/open-in-editor), specced and built separately.

This is an **additive** layer: the existing project sidebar + dock (including the just-shipped Plan C activation router) stays intact for non-isolated work. Tasks are a new surface alongside it.

## Product decisions (locked during brainstorming)

1. **Heavyweight task model** (superset-style): a Task is a real entity with a lifecycle (create → run → review → integrate/discard), not a per-tab toggle.
2. **Flat, top-level task list** (superset-style sidebar): tasks are listed globally across all projects/workspaces; the project concept is secondary (a task only records which repo it forked from).
3. **Integration offers Merge-local AND Create-PR** (plus Discard), after diff review; the worktree is removed afterward.

## Goals / Non-goals

**Goals**
- Run 10+ agents in parallel, each in its own worktree+branch, no file collisions.
- A flat Tasks surface: create, monitor status, review diff, integrate (merge/PR) or discard.
- Notify when a task's changes are ready for review.
- Reuse existing infra (tmux persistence, PtyPool, ClaudeCliLauncher, DiffView, simple-git, CLI adapter registry).

**Non-goals (this sub-project)**
- Workspace presets / env-setup automation (sub-project B — hook points only).
- Keyboard quick-switch & open-in-editor (sub-project C — hook points only).
- Replacing the project/dock model. Plan C stays.
- Remote/cloud task state (DevSpace is local-first; no DB).

## Architecture (chosen: reuse infra + TaskService orchestrator)

A worktree run is just a Claude session launched with `cwd = <worktree>` — `ClaudeCliLauncher`/`TmuxChatRunner`/`PtyPool` already accept a `cwd` parameter (`src/main/cli/types.ts:48`, `ClaudeCliLauncher.ts:84`). The only genuinely new piece is the orchestration of worktree + branch + task lifecycle and its UI.

```
RENDERER  components/Tasks/*  ──uses──▶  state/tasks.ts (Zustand)
                                   │
                              lib/api.ts (api.tasks.*)
                                   │  window.api.tasks.*
PRELOAD   preload/index.ts  ──ipcRenderer.invoke(IPC.TASK_*)
                                   │
MAIN      ipc/tasks.ts (registerTasksIpc)
                                   │
          services/TaskService.ts ──┬─ simple-git: worktree add/remove, merge, branch
                                     ├─ ClaudeCliLauncher/PtyPool: session cwd=worktree
                                     ├─ WorkspaceService/pathScope: allowlist worktree path
                                     └─ gh (Bash): create PR
```

Rejected alternative: a separate agent-runner subsystem not built on the dock infra — duplicates PtyPool/tmux/approval-detection and doubles maintenance for no isolation gain (worktrees already provide the isolation).

## Data model

`Task` (new type in `src/shared/types.ts`):

```ts
type TaskStatus =
  | 'setting-up'      // worktree being created
  | 'running'         // agent session live
  | 'awaiting-review' // session idle and a diff exists
  | 'integrating'     // merge/PR in flight
  | 'done'            // merged or PR'd, worktree removed
  | 'discarded'
  | 'error';

interface Task {
  id: string;                 // short base36
  title: string;              // user-given
  sourceRepoPath: string;     // repo the worktree forks from
  baseBranch: string;         // HEAD of sourceRepo at creation time
  branch: string;             // devspace/task/<slug>
  worktreePath: string;       // on-disk worktree location (see Worktree location)
  agent: string;              // cli/registry adapter id (default 'claude')
  status: TaskStatus;
  sessionKey: string;         // task:<id>:claude-cli
  createdAt: number;
  error?: string;
}
```

Flat list, keyed by `id`. `sourceRepoPath` (not a project id) is the link to a repo, so tasks survive even if the source project is not in the active workspace.

## Worktree lifecycle + git semantics

- **Create:** `simple-git(sourceRepoPath).raw(['worktree','add', worktreePath, '-b', branch])`. `baseBranch` is captured from the repo's current HEAD first; `branch` = `devspace/task/<slugified-title>-<id>` (collision-free).
- **Run:** launch the agent session (see Session) with `cwd = worktreePath`.
- **Review:** the **Diff** tab renders `branch` vs `baseBranch` via the existing `DiffView` (`src/renderer/components/Editor/DiffView.tsx`) + `GitStatusService`.
- **Integrate — Merge:** `git -C <sourceRepoPath> merge <branch>` (fast-forward if possible) → on success remove worktree + delete branch.
- **Integrate — Create PR:** `git -C <worktreePath> push -u origin <branch>` then `gh pr create` (via Bash); worktree kept until user confirms removal (they may iterate on PR feedback).
- **Discard:** confirm dialog (branch may hold unmerged work) → `git worktree remove --force <worktreePath>` + `git branch -D <branch>`.
- **Teardown safety:** every merge/discard requires a typed/confirmed dialog — mirrors the existing "close tab kills tmux" confirm convention and `finishing-a-development-branch` discipline.

### Worktree location (pathScope constraint — critical)

`assertInWorkspace` (`src/main/utils/pathScope.ts:45`) confines all `fs:*` access to registered workspace roots. A worktree outside those roots would make the task's FileTree / watcher / diff reads throw "path outside any open workspace".

**Decision:** worktrees live at `~/.devspace/worktrees/<taskId>/` (global, matching the global flat task model) and `pathScope` is **extended to allowlist active worktree paths** — `TaskService` registers a worktree path with `pathScope` on create and removes it on teardown (same shape as `invalidateWorkspaceRootsCache`). This keeps worktrees out of the source repo's working tree (no nested-repo / gitignore hazard) while staying in scope. Each task's FileTree roots at its `worktreePath`.

## Session / agent

- Reuse `ClaudeCliLauncher` + `PtyPool` with `cwd = worktreePath` and a task-scoped session key `task:<id>:claude-cli` (distinct from the dock's `projectId:claude-cli:tabId`). tmux persistence applies unchanged → tasks survive app restart and remounts.
- Agent-agnostic via `cli/registry.ts` — default `claude`; the registry already abstracts the adapter, so other CLI agents are a config choice later ("Universal Compatibility"). YAGNI: ship `claude` first.
- The existing `ApprovalDetector` (`PtyPool.ts:178`) and idle detection drive the **awaiting-review** transition and the "changes ready" notification.

## UI surfaces

- **Tasks panel** — a flat list (new `components/Tasks/TasksPanel.tsx`) shown as an alternate left-sidebar mode (toggle between "Projects" and "Tasks"). Each row: title, source-repo name, status badge, branch. (⌘1-9 jump is wired in sub-project C.)
- **Task detail** — when a task is active: the agent terminal (a `ClaudeCliPane` rooted at the worktree) + a **Diff** sub-tab (DiffView: branch vs base) + action bar **Merge / Create PR / Discard**.
- **Monitoring + notify** — the Tasks panel doubles as the monitor (status across all tasks). When a running task goes idle with a non-empty diff → status `awaiting-review` + an OS/in-app notification ("<title> — changes ready"), reusing the resource-toast event channel (`devspace:resource-toast`) plus an Electron notification.

## Persistence & restart

- Worktrees persist on disk; tmux sessions persist (existing behavior).
- Task metadata → `~/.devspace/tasks.json` (global, because tasks are flat/cross-workspace). Written atomically (`atomicWrite`).
- On boot: load tasks.json, reconcile against `git worktree list` per source repo; prune tasks whose worktree/branch is gone (status → `error` or auto-removed), re-register surviving worktree paths with `pathScope`.

## Coexistence with the existing model (Plan C)

The project sidebar + dock + Plan C activation router are untouched. The left sidebar gains a **mode switch** (Projects | Tasks). Selecting a task activates its terminal+diff; selecting a project behaves exactly as today. No change to `state/activation.ts`, `cliTabs`, or `workspace` stores beyond additive wiring.

## Main / IPC additions

- `src/main/services/TaskService.ts` — lifecycle (create/list/integrate/discard/reconcile), owns worktree git ops + pathScope registration.
- `src/main/ipc/tasks.ts` — `registerTasksIpc()`, invoked in `index.ts` (follows the established `registerXxxIpc()` pattern).
- `src/shared/ipc-channels.ts` — `TASK_*` channel constants.
- `src/shared/types.ts` — `Task`, `TaskStatus`.
- `src/renderer/state/tasks.ts` — Zustand store (list, activeTaskId, actions calling `api.tasks.*`).
- `src/renderer/components/Tasks/*` — `TasksPanel`, `TaskRow`, `TaskDetail`, `NewTaskDialog`.
- `src/renderer/lib/api.ts` + `src/preload/index.ts` — `api.tasks.*` bindings.
- Extend `src/main/utils/pathScope.ts` — register/unregister active worktree paths.
- Reuse: `ClaudeCliLauncher`, `PtyPool`, `GitStatusService`, `DiffView`, `cli/registry`, `atomicWrite`.

Keep new files focused (<500 lines). `TaskService` logic that grows (git ops vs lifecycle vs reconcile) should split into sibling modules rather than bloat one file.

## Testing

- `TaskService` lifecycle on a temp git repo via `simple-git`: create worktree+branch, merge back, discard (worktree+branch removed), reconcile/prune missing worktree. (Vitest, node env.)
- `pathScope` worktree allowlist: a registered worktree path passes `assertInWorkspace`; after teardown it's rejected.
- `state/tasks.ts` reducer/selector tests (status transitions, active task).
- Reuse existing Vitest setup; tests beside code in `__tests__/`.
- **Packaged boot test** before shipping (per the project lesson): create a task, run an agent, review diff, merge — in the built `.app`, not just dev.

## Hook points for B & C (no implementation here)

- **B (presets):** `TaskService.create` exposes a post-worktree-create step where preset `setup` scripts will run with task env vars.
- **C (keyboard):** `TasksPanel` rows are addressable by index for ⌘1-9; "open in editor" can target `worktreePath`.

## Open risks

- **gh availability / auth** for Create-PR — degrade gracefully (disable the button, show why) when `gh` or a remote is absent.
- **Disk usage** — N worktrees = N working copies; surface a count and make discard easy. (No automatic cap this version; log what exists.)
- **Source repo on a dirty/locked index** during merge — detect and surface; never force.
