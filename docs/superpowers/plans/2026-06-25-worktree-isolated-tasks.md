# Worktree-Isolated Agent Tasks (v2 · Sub-project A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a flat, top-level "Task" layer where each task runs an agent in its own git worktree + branch, with status monitoring, diff review, and merge/PR/discard integration — reusing DevSpace's existing PTY/tmux, ClaudeCliPane, DiffView, and simple-git infra.

**Architecture:** A new main-process `TaskService` owns the worktree+branch lifecycle (via `simple-git`) and registers each live worktree path with an extended `pathScope` allowlist so the existing FileTree/diff/watcher work inside it. Tasks run by reusing `ClaudeCliPane` pointed at the worktree (session key `task:<id>:…`). A new Zustand `tasks` store + `components/Tasks/*` render a flat task list (alternate left-sidebar mode) and a task detail (terminal + diff + Merge/PR/Discard). Metadata persists to a global `~/.devspace/tasks.json`; worktrees + tmux sessions persist on disk. The existing project/dock/Plan C model is untouched.

**Tech Stack:** Electron 40 main (Node), React 19 renderer, Zustand 4, `simple-git`, `gh` CLI (PR), tmux/node-pty (existing), Vitest 3. Spec: `docs/superpowers/specs/2026-06-25-worktree-isolated-tasks-design.md`.

---

## Reference: existing APIs this plan reuses (verified)

- `src/main/utils/pathScope.ts` — `assertInWorkspace(p)`, `invalidateWorkspaceRootsCache()`, `assertGitRef(name)`, `assertRelativePath(p)`. Add a worktree allowlist here (Task 2).
- `ClaudeCliLauncher`/`PtyPool`/`TmuxChatRunner` accept `cwd: string` (`src/main/cli/types.ts:48`). `ClaudeCliPane` props: `projectId, projectPath, tabId, isActive` and spawns/attaches a tmux claude session rooted at `projectPath`.
- `src/renderer/components/Editor/DiffView.tsx` — existing diff renderer.
- `src/main/services/GitStatusService.ts` — `simple-git` usage pattern for git ops.
- IPC pattern: each domain has `src/main/ipc/<domain>.ts` exporting `register<Domain>Ipc()`, invoked once in `src/main/index.ts`; channel names live in `src/shared/ipc-channels.ts` as the `IPC` object; renderer calls go through `src/preload/index.ts` + `src/renderer/lib/api.ts`.
- `src/main/utils/atomicWrite.ts` — atomic JSON file writes.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/shared/types.ts` | `Task`, `TaskStatus` types | Modify (append) |
| `src/shared/ipc-channels.ts` | `TASK_*` channel constants | Modify (append) |
| `src/main/utils/pathScope.ts` | worktree allowlist (`addWorktreeScope`/`removeWorktreeScope`) | Modify |
| `src/main/services/TaskService.ts` | task lifecycle orchestration (create/list/integrate/discard/reconcile) | Create |
| `src/main/services/taskWorktree.ts` | pure-ish git worktree helpers (add/remove/merge/branch via simple-git) | Create |
| `src/main/services/taskStore.ts` | `~/.devspace/tasks.json` load/save (atomic) | Create |
| `src/main/ipc/tasks.ts` | `registerTasksIpc()` | Create |
| `src/main/index.ts` | call `registerTasksIpc()` | Modify |
| `src/preload/index.ts` | `api.tasks.*` bindings | Modify |
| `src/renderer/lib/api.ts` | typed `tasks` client | Modify |
| `src/renderer/state/tasks.ts` | Zustand task store | Create |
| `src/renderer/components/Tasks/TasksPanel.tsx` | flat task list (sidebar mode) | Create |
| `src/renderer/components/Tasks/TaskRow.tsx` | one task row + status badge | Create |
| `src/renderer/components/Tasks/NewTaskDialog.tsx` | create-task form | Create |
| `src/renderer/components/Tasks/TaskDetail.tsx` | terminal + diff + action bar | Create |
| `src/renderer/state/sidebar.ts` | add `mode: 'projects' \| 'tasks'` | Modify |

Tests sit beside code in `__tests__/`.

---

## Phase 1 — Data model + pathScope worktree allowlist

### Task 1: Task types

**Files:**
- Modify: `src/shared/types.ts` (append)

- [ ] **Step 1: Add the types**

```ts
// --- v2 worktree-isolated agent tasks ---
export type TaskStatus =
  | 'setting-up'
  | 'running'
  | 'awaiting-review'
  | 'integrating'
  | 'done'
  | 'discarded'
  | 'error';

export interface Task {
  id: string;
  title: string;
  sourceRepoPath: string;
  baseBranch: string;
  branch: string;
  worktreePath: string;
  agent: string; // cli/registry adapter id
  status: TaskStatus;
  // MUST equal what ClaudeCliPane composes for (projectId=id, tabId='agent'),
  // i.e. `<id>:claude-cli:agent`, so the detail pane ATTACHES to the session
  // TaskService pre-launched (tmux new-session -A) instead of spawning a 2nd.
  sessionKey: string;
  createdAt: number;
  error?: string;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit` → Expected: no new errors (pre-existing `tsconfig.json` baseUrl deprecation is fine).

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(tasks): Task + TaskStatus shared types"
```

### Task 2: pathScope worktree allowlist

**Files:**
- Modify: `src/main/utils/pathScope.ts`
- Test: `src/main/utils/__tests__/pathScope.worktree.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, describe, expect, it } from 'vitest';
import {
  addWorktreeScope,
  assertInWorkspace,
  removeWorktreeScope,
} from '../pathScope';

const WT = '/tmp/devspace-test-wt/task-abc';

afterEach(() => removeWorktreeScope(WT));

describe('pathScope worktree allowlist', () => {
  it('allows a path under a registered worktree even when no workspace contains it', async () => {
    addWorktreeScope(WT);
    await expect(assertInWorkspace(`${WT}/src/index.ts`)).resolves.toBe(
      `${WT}/src/index.ts`,
    );
  });

  it('rejects the worktree path again after it is removed', async () => {
    addWorktreeScope(WT);
    removeWorktreeScope(WT);
    await expect(assertInWorkspace(`${WT}/src/index.ts`)).rejects.toThrow(
      /outside any open workspace/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/utils/__tests__/pathScope.worktree.test.ts`
Expected: FAIL — `addWorktreeScope` is not exported.

- [ ] **Step 3: Implement the allowlist**

In `pathScope.ts`, after the `cachedRoots` declarations add:

```ts
// v2 — active task worktrees live outside workspace roots (~/.devspace/worktrees).
// TaskService registers each live worktree here so the FileTree/diff/watcher can
// read inside it; unregistered on teardown. Module-level Set (not cached) because
// it changes on explicit lifecycle events, not a TTL.
const worktreeScopes = new Set<string>();

export function addWorktreeScope(p: string): void {
  worktreeScopes.add(path.resolve(p));
}

export function removeWorktreeScope(p: string): void {
  worktreeScopes.delete(path.resolve(p));
}
```

Then in `assertInWorkspace`, after the workspace-roots loop and before the throw:

```ts
  for (const root of roots) {
    if (isUnder(resolved, root)) return resolved;
  }
  for (const wt of worktreeScopes) {
    if (isUnder(resolved, wt)) return resolved;
  }
  throw new Error(`path outside any open workspace: ${p}`);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/utils/__tests__/pathScope.worktree.test.ts` → Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/utils/pathScope.ts src/main/utils/__tests__/pathScope.worktree.test.ts
git commit -m "feat(tasks): pathScope worktree allowlist for isolated runs"
```

---

## Phase 2 — Worktree git helpers + TaskService lifecycle

### Task 3: Worktree git helpers (`taskWorktree.ts`)

**Files:**
- Create: `src/main/services/taskWorktree.ts`
- Test: `src/main/services/__tests__/taskWorktree.test.ts`

- [ ] **Step 1: Write the failing test** (real temp git repo)

```ts
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  addWorktree,
  currentBranch,
  mergeBranch,
  removeWorktree,
} from '../taskWorktree';

let repo: string;
let wtRoot: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'devspace-repo-'));
  wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devspace-wt-'));
  const run = (c: string) => execSync(c, { cwd: repo, stdio: 'ignore' });
  run('git init -q');
  run('git config user.email t@t.t');
  run('git config user.name t');
  run('git checkout -q -b main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  run('git add -A');
  run('git commit -qm init');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(wtRoot, { recursive: true, force: true });
});

describe('taskWorktree', () => {
  it('currentBranch reads HEAD branch', async () => {
    expect(await currentBranch(repo)).toBe('main');
  });

  it('addWorktree creates an isolated checkout on a new branch', async () => {
    const wt = path.join(wtRoot, 'task-1');
    await addWorktree(repo, wt, 'devspace/task/t1');
    expect(fs.existsSync(path.join(wt, 'a.txt'))).toBe(true);
    expect(await currentBranch(wt)).toBe('devspace/task/t1');
  });

  it('mergeBranch fast-forwards the task branch back into base', async () => {
    const wt = path.join(wtRoot, 'task-2');
    await addWorktree(repo, wt, 'devspace/task/t2');
    fs.writeFileSync(path.join(wt, 'b.txt'), 'two\n');
    execSync('git add -A && git commit -qm work', { cwd: wt, stdio: 'ignore' });
    await mergeBranch(repo, 'devspace/task/t2');
    expect(fs.existsSync(path.join(repo, 'b.txt'))).toBe(true);
  });

  it('removeWorktree deletes the worktree and (force) its branch', async () => {
    const wt = path.join(wtRoot, 'task-3');
    await addWorktree(repo, wt, 'devspace/task/t3');
    await removeWorktree(repo, wt, 'devspace/task/t3');
    expect(fs.existsSync(wt)).toBe(false);
    const branches = execSync('git branch', { cwd: repo }).toString();
    expect(branches).not.toContain('devspace/task/t3');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/services/__tests__/taskWorktree.test.ts`
Expected: FAIL — cannot import `../taskWorktree`.

- [ ] **Step 3: Implement `taskWorktree.ts`**

```ts
import { simpleGit } from 'simple-git';

import { assertGitRef } from '@main/utils/pathScope';

// Thin, testable wrappers around `git worktree`/merge for the task lifecycle.
// Branch names are validated with assertGitRef to block flag/`..` injection.

export async function currentBranch(repoPath: string): Promise<string> {
  const b = (await simpleGit(repoPath).revparse(['--abbrev-ref', 'HEAD'])).trim();
  return b;
}

export async function addWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  assertGitRef(branch);
  await simpleGit(repoPath).raw(['worktree', 'add', worktreePath, '-b', branch]);
}

export async function mergeBranch(
  repoPath: string,
  branch: string,
): Promise<void> {
  assertGitRef(branch);
  await simpleGit(repoPath).raw(['merge', '--no-edit', branch]);
}

export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  assertGitRef(branch);
  const git = simpleGit(repoPath);
  await git.raw(['worktree', 'remove', '--force', worktreePath]);
  await git.raw(['branch', '-D', branch]).catch(() => undefined);
}

export async function listWorktrees(repoPath: string): Promise<string[]> {
  const out = await simpleGit(repoPath).raw(['worktree', 'list', '--porcelain']);
  return out
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim());
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/services/__tests__/taskWorktree.test.ts` → Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/services/taskWorktree.ts src/main/services/__tests__/taskWorktree.test.ts
git commit -m "feat(tasks): git worktree helpers (add/merge/remove/list)"
```

### Task 4: Task metadata store (`taskStore.ts`)

**Files:**
- Create: `src/main/services/taskStore.ts`
- Test: `src/main/services/__tests__/taskStore.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadTasks, saveTasks, type TasksFile } from '../taskStore';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspace-tasks-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const file = () => path.join(dir, 'tasks.json');

describe('taskStore', () => {
  it('loadTasks returns empty when the file is missing', async () => {
    expect(await loadTasks(file())).toEqual({ tasks: [] });
  });

  it('round-trips tasks through save/load', async () => {
    const data: TasksFile = {
      tasks: [
        {
          id: 'abc',
          title: 'T',
          sourceRepoPath: '/r',
          baseBranch: 'main',
          branch: 'devspace/task/t',
          worktreePath: '/w',
          agent: 'claude',
          status: 'running',
          sessionKey: 'task:abc:claude-cli',
          createdAt: 1,
        },
      ],
    };
    await saveTasks(file(), data);
    expect(await loadTasks(file())).toEqual(data);
  });

  it('loadTasks tolerates corrupt JSON', async () => {
    fs.writeFileSync(file(), '{not json');
    expect(await loadTasks(file())).toEqual({ tasks: [] });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/services/__tests__/taskStore.test.ts` → Expected: FAIL (no module).

- [ ] **Step 3: Implement `taskStore.ts`**

```ts
import * as fs from 'node:fs';

import { atomicWrite } from '@main/utils/atomicWrite';
import type { Task } from '@shared/types';

export interface TasksFile {
  tasks: Task[];
}

export async function loadTasks(filePath: string): Promise<TasksFile> {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<TasksFile>;
    if (Array.isArray(parsed.tasks)) return { tasks: parsed.tasks };
  } catch {
    /* missing or corrupt — fall through to empty */
  }
  return { tasks: [] };
}

export async function saveTasks(
  filePath: string,
  data: TasksFile,
): Promise<void> {
  await atomicWrite(filePath, JSON.stringify(data, null, 2));
}
```

> If `atomicWrite`'s signature differs (verify in `src/main/utils/atomicWrite.ts`), adapt this one call site; the test pins the behavior.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/services/__tests__/taskStore.test.ts` → Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/services/taskStore.ts src/main/services/__tests__/taskStore.test.ts
git commit -m "feat(tasks): global tasks.json persistence (atomic, corruption-tolerant)"
```

### Task 5: TaskService lifecycle

**Files:**
- Create: `src/main/services/TaskService.ts`
- Test: `src/main/services/__tests__/TaskService.test.ts`

- [ ] **Step 1: Write the failing test** (lifecycle on a temp repo, session launch stubbed)

```ts
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTaskService } from '../TaskService';

let repo: string;
let home: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'devspace-repo-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspace-home-'));
  const run = (c: string) => execSync(c, { cwd: repo, stdio: 'ignore' });
  run('git init -q'); run('git config user.email t@t.t'); run('git config user.name t');
  run('git checkout -q -b main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  run('git add -A'); run('git commit -qm init');
});
afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

function makeService() {
  return createTaskService({
    homeDir: home,
    now: () => 1000,
    idgen: () => 'abc',
    launchSession: vi.fn(async () => undefined),
    killSession: vi.fn(async () => undefined),
  });
}

describe('TaskService', () => {
  it('create builds a worktree+branch, persists, and launches a session', async () => {
    const svc = makeService();
    const task = await svc.create({ title: 'Fix bug', sourceRepoPath: repo, agent: 'claude' });
    expect(task.branch).toBe('devspace/task/fix-bug-abc');
    expect(task.baseBranch).toBe('main');
    expect(fs.existsSync(task.worktreePath)).toBe(true);
    expect(svc.list()).toHaveLength(1);
    expect((svc as any).deps.launchSession).toHaveBeenCalledWith(
      task.sessionKey,
      task.worktreePath,
      'claude',
    );
  });

  it('discard removes the worktree, kills the session, and drops the task', async () => {
    const svc = makeService();
    const task = await svc.create({ title: 'X', sourceRepoPath: repo, agent: 'claude' });
    await svc.discard(task.id);
    expect(fs.existsSync(task.worktreePath)).toBe(false);
    expect(svc.list()).toHaveLength(0);
  });

  it('merge integrates the branch and removes the worktree', async () => {
    const svc = makeService();
    const task = await svc.create({ title: 'Y', sourceRepoPath: repo, agent: 'claude' });
    fs.writeFileSync(path.join(task.worktreePath, 'b.txt'), 'two\n');
    execSync('git add -A && git commit -qm work', { cwd: task.worktreePath, stdio: 'ignore' });
    await svc.merge(task.id);
    expect(fs.existsSync(path.join(repo, 'b.txt'))).toBe(true);
    expect(svc.list()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/services/__tests__/TaskService.test.ts` → Expected: FAIL (no module).

- [ ] **Step 3: Implement `TaskService.ts`**

```ts
import * as path from 'node:path';

import { addWorktreeScope, removeWorktreeScope } from '@main/utils/pathScope';
import type { Task } from '@shared/types';

import { loadTasks, saveTasks } from './taskStore';
import {
  addWorktree,
  currentBranch,
  mergeBranch,
  removeWorktree,
} from './taskWorktree';

export interface TaskServiceDeps {
  homeDir: string;
  now: () => number;
  idgen: () => string;
  // Reuse the existing PTY/tmux launch path with cwd = worktree.
  launchSession: (sessionKey: string, cwd: string, agent: string) => Promise<void>;
  killSession: (sessionKey: string) => Promise<void>;
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'task';
}

export function createTaskService(deps: TaskServiceDeps) {
  const tasksFile = path.join(deps.homeDir, '.devspace', 'tasks.json');
  const worktreesDir = path.join(deps.homeDir, '.devspace', 'worktrees');
  let tasks: Task[] = [];

  async function persist() {
    await saveTasks(tasksFile, { tasks });
  }

  return {
    deps, // exposed for tests/wiring

    async init() {
      tasks = (await loadTasks(tasksFile)).tasks;
      for (const t of tasks) addWorktreeScope(t.worktreePath);
    },

    list(): Task[] {
      return tasks;
    },

    async create(opts: { title: string; sourceRepoPath: string; agent: string }): Promise<Task> {
      const id = deps.idgen();
      const branch = `devspace/task/${slug(opts.title)}-${id}`;
      const worktreePath = path.join(worktreesDir, id);
      const baseBranch = await currentBranch(opts.sourceRepoPath);
      const task: Task = {
        id,
        title: opts.title,
        sourceRepoPath: opts.sourceRepoPath,
        baseBranch,
        branch,
        worktreePath,
        agent: opts.agent,
        status: 'setting-up',
        sessionKey: `${id}:claude-cli:agent`, // ClaudeCliPane(projectId=id, tabId='agent') attaches to this
        createdAt: deps.now(),
      };
      tasks = [...tasks, task];
      await persist();
      try {
        await addWorktree(opts.sourceRepoPath, worktreePath, branch);
        addWorktreeScope(worktreePath);
        await deps.launchSession(task.sessionKey, worktreePath, opts.agent);
        return this._set(id, { status: 'running' });
      } catch (e) {
        return this._set(id, { status: 'error', error: (e as Error).message });
      }
    },

    async merge(id: string): Promise<void> {
      const t = this._get(id);
      if (!t) return;
      this._set(id, { status: 'integrating' });
      await mergeBranch(t.sourceRepoPath, t.branch);
      await this._teardown(t);
    },

    async discard(id: string): Promise<void> {
      const t = this._get(id);
      if (!t) return;
      await this._teardown(t);
    },

    _get(id: string): Task | undefined {
      return tasks.find((t) => t.id === id);
    },

    _set(id: string, patch: Partial<Task>): Task {
      tasks = tasks.map((t) => (t.id === id ? { ...t, ...patch } : t));
      void persist();
      return this._get(id)!;
    },

    async _teardown(t: Task): Promise<void> {
      await deps.killSession(t.sessionKey).catch(() => undefined);
      await removeWorktree(t.sourceRepoPath, t.worktreePath, t.branch).catch(() => undefined);
      removeWorktreeScope(t.worktreePath);
      tasks = tasks.filter((x) => x.id !== t.id);
      await persist();
    },
  };
}

export type TaskService = ReturnType<typeof createTaskService>;
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/services/__tests__/TaskService.test.ts` → Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/services/TaskService.ts src/main/services/__tests__/TaskService.test.ts
git commit -m "feat(tasks): TaskService lifecycle (create/merge/discard) + persistence"
```

---

## Phase 3 — IPC wiring (main ↔ preload ↔ renderer)

### Task 6: IPC channels + handler

**Files:**
- Modify: `src/shared/ipc-channels.ts` (append `TASK_*`)
- Create: `src/main/ipc/tasks.ts`
- Modify: `src/main/index.ts` (instantiate service + `registerTasksIpc()`)

- [ ] **Step 1: Add channels** to the `IPC` object in `ipc-channels.ts`:

```ts
  TASK_LIST: 'task:list',
  TASK_CREATE: 'task:create',
  TASK_MERGE: 'task:merge',
  TASK_CREATE_PR: 'task:create-pr',
  TASK_DISCARD: 'task:discard',
  TASK_CHANGED: 'task:changed', // main → renderer push on any list change
```

- [ ] **Step 2: Implement `registerTasksIpc()`** in `src/main/ipc/tasks.ts`:

```ts
import { execFile } from 'node:child_process';
import * as os from 'node:os';
import { promisify } from 'node:util';

import { ipcMain, type BrowserWindow } from 'electron';

import { IPC } from '@shared/ipc-channels';
import { createTaskService } from '@main/services/TaskService';
import { launchClaudeInWorktree, killWorktreeSession } from '@main/services/TaskService.session';

const pexec = promisify(execFile);

export function registerTasksIpc(getWindow: () => BrowserWindow | null): void {
  const svc = createTaskService({
    homeDir: os.homedir(),
    now: () => Date.now(),
    idgen: () => Math.random().toString(36).slice(2, 8),
    launchSession: launchClaudeInWorktree,
    killSession: killWorktreeSession,
  });
  void svc.init();

  const push = () => getWindow()?.webContents.send(IPC.TASK_CHANGED, svc.list());

  ipcMain.handle(IPC.TASK_LIST, () => svc.list());
  ipcMain.handle(IPC.TASK_CREATE, async (_e, opts) => { const t = await svc.create(opts); push(); return t; });
  ipcMain.handle(IPC.TASK_MERGE, async (_e, id: string) => { await svc.merge(id); push(); });
  ipcMain.handle(IPC.TASK_DISCARD, async (_e, id: string) => { await svc.discard(id); push(); });
  ipcMain.handle(IPC.TASK_CREATE_PR, async (_e, id: string) => {
    const t = svc.list().find((x) => x.id === id);
    if (!t) return { ok: false, error: 'task not found' };
    try {
      await pexec('git', ['-C', t.worktreePath, 'push', '-u', 'origin', t.branch]);
      const { stdout } = await pexec('gh', ['pr', 'create', '--fill', '--head', t.branch], { cwd: t.worktreePath });
      push();
      return { ok: true, url: stdout.trim() };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
}
```

> `TaskService.session.ts` (create it) holds `launchClaudeInWorktree(sessionKey, cwd, agent)` and `killWorktreeSession(sessionKey)` — thin adapters over the SAME `PtyPool`/`ClaudeCliLauncher` path the dock uses, with `cwd` = worktree. Model them on how `ClaudeCliPane`/`registerPtyIpc` spawn a `claude-cli` PTY today (read those during implementation and mirror the call, substituting the session key + cwd).

- [ ] **Step 3: Wire into `index.ts`** — add `registerTasksIpc(() => mainWindow)` alongside the other `registerXxxIpc()` calls in `app.whenReady()`.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit` → Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc-channels.ts src/main/ipc/tasks.ts src/main/services/TaskService.session.ts src/main/index.ts
git commit -m "feat(tasks): IPC handlers + session adapter wiring"
```

### Task 7: preload + renderer api client

**Files:**
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/lib/api.ts`

- [ ] **Step 1: preload** — add to the exposed `api` object (mirroring existing domains):

```ts
  tasks: {
    list: () => ipcRenderer.invoke(IPC.TASK_LIST),
    create: (opts: { title: string; sourceRepoPath: string; agent: string }) =>
      ipcRenderer.invoke(IPC.TASK_CREATE, opts),
    merge: (id: string) => ipcRenderer.invoke(IPC.TASK_MERGE, id),
    createPr: (id: string) => ipcRenderer.invoke(IPC.TASK_CREATE_PR, id),
    discard: (id: string) => ipcRenderer.invoke(IPC.TASK_DISCARD, id),
    onChanged: (cb: (tasks: Task[]) => void) => {
      const h = (_e: unknown, t: Task[]) => cb(t);
      ipcRenderer.on(IPC.TASK_CHANGED, h);
      return () => ipcRenderer.removeListener(IPC.TASK_CHANGED, h);
    },
  },
```

- [ ] **Step 2: renderer `api.ts`** — add the same typed surface under `api.tasks`, matching the preload shape (follow the file's existing typed-client + stub-fallback pattern).

- [ ] **Step 3: Typecheck** → `npx tsc --noEmit` → no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/preload/index.ts src/renderer/lib/api.ts
git commit -m "feat(tasks): preload + renderer api.tasks client"
```

---

## Phase 4 — Renderer store + UI

### Task 8: tasks Zustand store

**Files:**
- Create: `src/renderer/state/tasks.ts`
- Test: `src/renderer/state/__tests__/tasks.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTasksStore } from '../tasks';

beforeEach(() => useTasksStore.setState({ tasks: [], activeTaskId: null }));

describe('tasks store', () => {
  it('setTasks replaces the list', () => {
    useTasksStore.getState().setTasks([{ id: 'a' } as any]);
    expect(useTasksStore.getState().tasks).toHaveLength(1);
  });

  it('setActiveTask clears when the id is gone after a refresh', () => {
    useTasksStore.setState({ tasks: [{ id: 'a' } as any], activeTaskId: 'a' });
    useTasksStore.getState().setTasks([{ id: 'b' } as any]);
    expect(useTasksStore.getState().activeTaskId).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails** → `npx vitest run src/renderer/state/__tests__/tasks.test.ts` → FAIL (no module).

- [ ] **Step 3: Implement `tasks.ts`**

```ts
import { create } from 'zustand';

import { api } from '@renderer/lib/api';
import type { Task } from '@shared/types';

interface TasksState {
  tasks: Task[];
  activeTaskId: string | null;
  setTasks: (tasks: Task[]) => void;
  setActiveTask: (id: string | null) => void;
  refresh: () => Promise<void>;
  create: (opts: { title: string; sourceRepoPath: string; agent: string }) => Promise<void>;
  merge: (id: string) => Promise<void>;
  createPr: (id: string) => Promise<{ ok: boolean; url?: string; error?: string }>;
  discard: (id: string) => Promise<void>;
}

export const useTasksStore = create<TasksState>((set, get) => ({
  tasks: [],
  activeTaskId: null,
  setTasks: (tasks) =>
    set((s) => ({
      tasks,
      activeTaskId: tasks.some((t) => t.id === s.activeTaskId) ? s.activeTaskId : null,
    })),
  setActiveTask: (id) => set({ activeTaskId: id }),
  refresh: async () => get().setTasks(await api.tasks.list()),
  create: async (opts) => {
    const t = await api.tasks.create(opts);
    get().setTasks([...get().tasks, t]);
    set({ activeTaskId: t.id });
  },
  merge: async (id) => { await api.tasks.merge(id); await get().refresh(); },
  createPr: (id) => api.tasks.createPr(id),
  discard: async (id) => { await api.tasks.discard(id); await get().refresh(); },
}));

// Live updates pushed from main.
if (typeof window !== 'undefined' && api?.tasks?.onChanged) {
  api.tasks.onChanged((tasks) => useTasksStore.getState().setTasks(tasks));
}
```

- [ ] **Step 4: Run to verify it passes** → PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/state/tasks.ts src/renderer/state/__tests__/tasks.test.ts
git commit -m "feat(tasks): renderer tasks store with live push updates"
```

### Task 9: Sidebar mode toggle

**Files:**
- Modify: `src/renderer/state/sidebar.ts`
- Test: `src/renderer/state/__tests__/sidebar.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { useSidebarStore } from '../sidebar';

describe('sidebar mode', () => {
  it('defaults to projects and toggles to tasks', () => {
    useSidebarStore.setState({ mode: 'projects' });
    useSidebarStore.getState().setMode('tasks');
    expect(useSidebarStore.getState().mode).toBe('tasks');
  });
});
```

- [ ] **Step 2: Run to verify it fails** → FAIL (`setMode`/`mode` missing).

- [ ] **Step 3: Implement** — add `mode: 'projects' | 'tasks'` (default `'projects'`, persisted like the existing collapse flags) and `setMode(m)` to the sidebar store, following its current persistence pattern.

- [ ] **Step 4: Run to verify it passes** → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/state/sidebar.ts src/renderer/state/__tests__/sidebar.test.ts
git commit -m "feat(tasks): sidebar projects|tasks mode toggle"
```

### Task 10: Tasks UI components (manual-verified)

UI rendering is verified by running the app, not unit tests. Each component is small and reuses existing primitives.

**Files:**
- Create: `src/renderer/components/Tasks/TaskRow.tsx`, `TasksPanel.tsx`, `NewTaskDialog.tsx`, `TaskDetail.tsx`
- Modify: the sidebar host (where `ProjectList` renders) to switch on `sidebar.mode`; the main content host to render `TaskDetail` when `mode==='tasks'` and a task is active.

- [ ] **Step 1: `TaskRow.tsx`** — props `{ task: Task; active: boolean; onClick: () => void }`. Renders title, source-repo basename, branch, and a status badge (color per `TaskStatus`). Match `ProjectRow`/`TabChip` styling.

- [ ] **Step 2: `TasksPanel.tsx`** — subscribes `useTasksStore`; renders a "+ New task" button (opens `NewTaskDialog`) and the flat `TaskRow` list; `onClick` → `setActiveTask(id)`. Calls `refresh()` on mount.

- [ ] **Step 3: `NewTaskDialog.tsx`** — fields: title (text) + source repo (a `<select>` of `useWorkspaceStore` projects, value = `project.path`) + agent (default `claude`). Submit → `useTasksStore.create({ title, sourceRepoPath, agent })`. Reuse the Radix dialog pattern from `CliTabBar`'s `ConfirmDialog`.

- [ ] **Step 4: `TaskDetail.tsx`** — for the active task:
  - Terminal: `<ClaudeCliPane projectId={task.id} projectPath={task.worktreePath} tabId="agent" isActive />` (reuses the existing pane; session rooted at the worktree). *Verify during implementation that `ClaudeCliPane` uses `projectPath` as the spawn `cwd`; if it derives cwd elsewhere, pass the worktree path through that channel instead.*
  - Diff sub-tab: render `DiffView` for `task.branch` vs `task.baseBranch` in `task.worktreePath` (follow how the editor opens a `diff:` view today).
  - Action bar: **Merge** (`store.merge`, confirm), **Create PR** (`store.createPr`, show returned url/error; disable when no remote/`gh`), **Discard** (`store.discard`, confirm).

- [ ] **Step 5: Host wiring** — in the sidebar host swap `ProjectList` ↔ `TasksPanel` on `sidebar.mode`; add a small Projects|Tasks segmented toggle near `WorkspacePicker`. In the main content area, when `mode==='tasks'` and `activeTaskId`, render `TaskDetail`.

- [ ] **Step 6: Typecheck + build**

Run: `npx tsc --noEmit && pnpm build` → Expected: clean.

- [ ] **Step 7: Manual verify (dev)**

`pnpm dev`: toggle to Tasks → New task on a real repo → confirm a worktree appears under `~/.devspace/worktrees/<id>`, the agent terminal runs there (`pwd` inside it), edit a file → Diff sub-tab shows it → Merge lands it in the source repo and the worktree is removed.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/components/Tasks src/renderer/components/Sidebar src/renderer/App.tsx
git commit -m "feat(tasks): flat Tasks panel + task detail (terminal/diff/integrate)"
```

---

## Phase 5 — Monitoring, reconcile, verification

### Task 11: Boot reconcile (prune dead worktrees)

**Files:**
- Modify: `src/main/services/TaskService.ts` (`init` reconcile)
- Test: extend `src/main/services/__tests__/TaskService.test.ts`

- [ ] **Step 1: Write the failing test** — a persisted task whose worktree dir was deleted is pruned to status `error` (kept, not crashed) on `init`:

```ts
it('init marks tasks whose worktree vanished as error', async () => {
  const svc = makeService();
  const t = await svc.create({ title: 'Z', sourceRepoPath: repo, agent: 'claude' });
  fs.rmSync(t.worktreePath, { recursive: true, force: true });
  const svc2 = makeService(); // fresh instance, same home → reloads tasks.json
  await svc2.init();
  expect(svc2.list().find((x) => x.id === t.id)?.status).toBe('error');
});
```

- [ ] **Step 2: Run to verify it fails** → FAIL (init doesn't reconcile).

- [ ] **Step 3: Implement** — in `init()`, after loading: for each task, if `!fs.existsSync(task.worktreePath)` set `status:'error', error:'worktree missing'`; else `addWorktreeScope`. Persist once.

- [ ] **Step 4: Run to verify it passes** → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/services/TaskService.ts src/main/services/__tests__/TaskService.test.ts
git commit -m "feat(tasks): reconcile dead worktrees on boot"
```

### Task 12: awaiting-review status + notification

**Files:**
- Modify: `src/main/ipc/tasks.ts` or `TaskService.session.ts` (idle hook)
- Modify: `TaskService.ts` (`markAwaitingReview(id)`)

- [ ] **Step 1: Implement** — reuse the existing PTY idle signal (the same one the dock's idle reaper uses) for a task session: when a `running` task's session goes idle, call `svc.markAwaitingReview(id)` → set `status:'awaiting-review'`, `push()`, and `getWindow()?.webContents.send` a `devspace:resource-toast`-style message plus an Electron `new Notification({ title: 'Changes ready', body: task.title })`. (No new test — depends on live PTY; covered by the dev/packaged smoke.)

- [ ] **Step 2: Typecheck** → clean.

- [ ] **Step 3: Commit**

```bash
git add src/main/services src/main/ipc/tasks.ts
git commit -m "feat(tasks): awaiting-review status + changes-ready notification"
```

### Task 13: Full verification

- [ ] **Step 1:** `pnpm test` → all pass (new: pathScope.worktree, taskWorktree, taskStore, TaskService, tasks store, sidebar).
- [ ] **Step 2:** `pnpm build && npx tsc --noEmit` → clean.
- [ ] **Step 3: Dev smoke** — create 2 tasks on the same repo simultaneously; edit different files in each; confirm no collision; merge one, discard the other; confirm worktrees removed and `~/.devspace/tasks.json` consistent.
- [ ] **Step 4: Packaged boot test** — `pnpm dist:mac:arm64`, launch the `.app`, repeat Step 3 in the packaged artifact (per the project lesson: native modules/asar behave differently packaged).
- [ ] **Step 5: Commit** any fixes.

---

## Self-Review

**Spec coverage:** data model → Task 1; worktree location + pathScope → Task 2; worktree git lifecycle → Tasks 3,5; persistence → Task 4; reconcile → Task 11; session reuse (cwd=worktree) → Tasks 5,6,10; flat Tasks UI + detail + integrate(merge/PR/discard) → Tasks 6,10; coexistence via sidebar mode → Task 9; monitoring/notify → Task 12; testing + packaged boot → Task 13; B/C hook points (create exposes post-worktree step; rows index-addressable) → noted, not built. ✅
**Placeholder scan:** Two deliberate "verify during implementation" notes (atomicWrite signature in Task 4; ClaudeCliPane cwd channel + the `TaskService.session.ts` PTY adapter in Tasks 6/10) — these are explicit "read this existing file and mirror it" instructions, not vague TODOs, because the exact private spawn signature wasn't read while authoring. Everything else is concrete code. UI rendering (Task 10) is manual-verified by design (not unit-testable).
**Type consistency:** `Task`/`TaskStatus` (Task 1) used unchanged across service, store, IPC, UI. `createTaskService(deps)` shape matches its test and the IPC instantiation. `api.tasks.*` shape identical in preload (Task 7), store (Task 8). Session key format `task:<id>:claude-cli` consistent (model + service + detail pane uses `tabId="agent"` → the pane composes the actual PTY key; ensure the session adapter and the pane agree on the key during Task 6/10 — called out there).
