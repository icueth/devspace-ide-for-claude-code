# Tab ↔ Sidebar ↔ Workspace Sync (Plan C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the CLI dock chips, the left sidebar (project list + FileTree), and the active workspace stay in perfect lock-step — clicking any dock chip selects its project AND switches the workspace if the chip belongs to another one; selecting a project/workspace in the sidebar focuses its dock — by replacing today's web of bidirectional reactive mirror effects with one synchronous activation router that carries explicit gesture origin.

**Architecture:** Today "active project" is duplicated across three independent stores (`workspace.activeProjectId`, `cliTabs.activeColumnId`+`activeDockedProjectId`, `editor.activeTabPath`) and reconciled by edge-triggered mirror effects running in BOTH directions. Those effects can't tell a real user gesture from a background echo, so the codebase has accreted heuristic guards (`isDefensiveAutoPinTransition`, `isUndockRetargetTransition`, `markTreeOpen`/`lastTreeOpenPath`) that are necessarily incomplete — every new background trigger needs a new guard. Plan C makes `workspace.activeProjectId` the single source of truth and introduces `state/activation.ts#activate(intent)`: one function every gesture calls with an explicit `source`. The router sets project + dock + editor (and switches workspace for cross-workspace chips) in one synchronous pass. All three reactive mirror effects and all three heuristic guards are deleted — origin is now carried by the gesture, not guessed from state.

**Tech Stack:** TypeScript, React 19, Zustand 4, Vitest 3, electron-vite. Renderer-only change (no main-process IPC changes). Files stay under 500 lines per project convention; new orchestration goes in its own module (`state/activation.ts`).

---

## Plan C — Confirmed behavior (from design conversation)

1. **"tab" = the CLI dock chips** (`cliTabs` store), not editor file tabs.
2. **Cross-workspace chips stay visible** — chips for projects from every workspace the user has docked remain in the dock tab bar (today's behavior, kept).
3. **Click a chip of another workspace → switch the whole workspace.** The sidebar rescans to that chip's workspace and highlights that project. `activeProjectId` is therefore ALWAYS a project in the current workspace — the perfect-sync invariant.
4. **Select a workspace in the picker → its dock chip becomes active.**
5. **Root project is the single default anchor** (`isWorkspaceRoot`, auto-activated on first visit). Each detected sub-project (sidebar "All" section) docks its own chip when activated. This is unchanged and orthogonal to the sync refactor.
6. **FileTree file/folder clicks never dock** — they open the file in the editor only (today's `markTreeOpen` rule), now expressed as `source: 'filetree'`.
7. **Empty workspaces already work** (`ProjectScanner.ts:187-200`) — verify only, no code.

## Decisions baked in (confirm during review; each is reversible)

- **D1 — Columns collapse to one on a cross-workspace switch.** Split columns pinned to the OLD workspace's projects would otherwise keep rendering stale cross-workspace panes (their tabs still exist in `tabsByProject`). On a cross-workspace switch we collapse to a single column pinned to the newly-activated project. Same-workspace activations leave splits intact.
- **D2 — Cross-workspace chips show a small workspace-name label** so multiple workspaces' chips are distinguishable in one tab bar. Label is hidden for chips of the current workspace.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/renderer/state/activation.ts` | **New.** `activate(intent)` router + `ActivationSource`/`ActivationIntent` types + `workspaceIdForProject()` helper. The only cross-store orchestration point. | Create |
| `src/renderer/state/workspace.ts` | Source of truth for `activeProjectId`. Simplify `followTab` (drop tree guard); add `recordTabMru`; delete `markTreeOpen`/`lastTreeOpenPath`, `isDefensiveAutoPinTransition`, `isUndockRetargetTransition`, `deriveProjectIdFromDockColumn`. | Modify |
| `src/renderer/state/cliTabs.ts` | Dock state. Add `focusSingleProject(projectId, tabId)` (D1 collapse). | Modify |
| `src/renderer/App.tsx` | Delete the editor→sidebar effect (`:132`), the dock→sidebar effect (`:163`), the `dockFollowKey` selector, and module refs `lastFollowedTabPath`/`lastFollowedDockKey`. | Modify |
| `src/renderer/components/Dock/ClaudeCliDock.tsx` | Delete the sidebar→dock mirror effect (`:79`) + `lastMirroredActiveRef`/`bootMirrorDoneRef`. Rewire chip-drop, pane-mousedown, column-focus to `activate()`. | Modify |
| `src/renderer/components/Dock/CliTabBar.tsx` | `handleSelect` → `activate({source:'dock-chip'})`. Add workspace label (D2). | Modify |
| `src/renderer/components/Sidebar/ProjectList.tsx` | Rows → `activate({source:'sidebar'})`. | Modify |
| `src/renderer/components/Welcome/Welcome.tsx` | Project card → `activate({source:'sidebar'})`. | Modify |
| `src/renderer/components/Editor/EditorTabs.tsx` | Tab click → `activate({source:'editor-tab'})`. | Modify |
| `src/renderer/state/__tests__/workspace.test.ts` | Drop tests for deleted helpers; keep `deriveProjectIdFromTab`/`pickEditorTabForProject`/eviction. | Modify |
| `src/renderer/state/__tests__/activation.test.ts` | **New.** Router behavior table (all sources, cross-workspace switch, collapse). | Create |

---

## Task 1: Characterization tests — lock the behavior we must preserve

Before refactoring, capture the user-visible contract as tests against the *router we are about to build*, so the refactor is TDD-driven rather than guess-and-check.

**Files:**
- Create: `src/renderer/state/__tests__/activation.test.ts`

- [ ] **Step 1: Write the failing test file (behavior table)**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCliTabsStore } from '@renderer/state/cliTabs';
import { useWorkspaceStore, __resetProjectMruForTests } from '@renderer/state/workspace';
import { activate, workspaceIdForProject } from '@renderer/state/activation';
import type { Project } from '@shared/types';

// Two workspaces: wsA (root + sub), wsB (root). Cross-workspace = a chip in wsB
// while wsA is active.
const PROJECTS_A: Project[] = [
  { id: 'a-root', name: 'A', path: '/ws/a', workspaceId: 'wsA', vcs: 'git', detectedRuntime: [], isWorkspaceRoot: true },
  { id: 'a-sub', name: 'sub', path: '/ws/a/sub', workspaceId: 'wsA', vcs: 'none', detectedRuntime: [] },
];
const PROJECTS_B: Project[] = [
  { id: 'b-root', name: 'B', path: '/ws/b', workspaceId: 'wsB', vcs: 'git', detectedRuntime: [], isWorkspaceRoot: true },
];

function seedActiveWorkspace(projects: Project[], wsId: string, wsPath: string) {
  useWorkspaceStore.setState({
    active: { id: wsId, name: wsId, path: wsPath, lastOpened: 0 },
    known: [
      { id: 'wsA', name: 'wsA', path: '/ws/a', lastOpened: 0 },
      { id: 'wsB', name: 'wsB', path: '/ws/b', lastOpened: 0 },
    ],
    projects,
    activeProjectId: projects[0]!.id,
    openedProjectIds: [projects[0]!.id],
  });
}

beforeEach(() => {
  localStorage.clear();
  __resetProjectMruForTests();
  useCliTabsStore.setState(useCliTabsStore.getInitialState?.() ?? {});
  seedActiveWorkspace(PROJECTS_A, 'wsA', '/ws/a');
});

describe('activate — same-workspace selection', () => {
  it('sidebar source activates the project and docks it', async () => {
    await activate({ source: 'sidebar', projectId: 'a-sub' });
    expect(useWorkspaceStore.getState().activeProjectId).toBe('a-sub');
    expect(useCliTabsStore.getState().projectsById['a-sub']).toBeTruthy();
  });

  it('dock-pane source moves the sidebar but NOT the editor', async () => {
    await activate({ source: 'dock-pane', projectId: 'a-sub' });
    expect(useWorkspaceStore.getState().activeProjectId).toBe('a-sub');
  });

  it('filetree source records MRU but never switches project', async () => {
    await activate({ source: 'filetree', editorPath: '/ws/a/sub/file.ts' });
    expect(useWorkspaceStore.getState().activeProjectId).toBe('a-root'); // unchanged
  });
});

describe('activate — cross-workspace chip switches the workspace (Plan C)', () => {
  it('switches active workspace to the chip owner, then activates the project', async () => {
    // wsA active; dock a wsB chip (cross-workspace) without switching.
    useCliTabsStore.getState().dockProject({ id: 'b-root', name: 'B', path: '/ws/b', workspaceId: 'wsB' });
    // setActive is the async rescan boundary — stub it to load wsB's projects.
    const setActive = vi.fn(async (id: string) => {
      if (id === 'wsB') seedActiveWorkspace(PROJECTS_B, 'wsB', '/ws/b');
    });
    useWorkspaceStore.setState({ setActive });

    await activate({ source: 'dock-chip', projectId: 'b-root', tabId: 't1' });

    expect(setActive).toHaveBeenCalledWith('wsB');
    expect(useWorkspaceStore.getState().active?.id).toBe('wsB');
    expect(useWorkspaceStore.getState().activeProjectId).toBe('b-root');
  });
});

describe('workspaceIdForProject', () => {
  it('resolves from current workspace projects first', () => {
    expect(workspaceIdForProject('a-sub')).toBe('wsA');
  });
  it('falls back to docked cross-workspace metadata', () => {
    useCliTabsStore.getState().dockProject({ id: 'b-root', name: 'B', path: '/ws/b', workspaceId: 'wsB' });
    expect(workspaceIdForProject('b-root')).toBe('wsB');
  });
});
```

- [ ] **Step 2: Run to confirm it fails (module not yet created)**

Run: `npx vitest run src/renderer/state/__tests__/activation.test.ts`
Expected: FAIL — `Cannot find module '@renderer/state/activation'`.

- [ ] **Step 3: Commit the failing test**

```bash
git add src/renderer/state/__tests__/activation.test.ts
git commit -m "test(sync): characterize activation router behavior (Plan C)"
```

---

## Task 2: Build the activation router

**Files:**
- Create: `src/renderer/state/activation.ts`
- Modify: `src/renderer/state/workspace.ts` (add `recordTabMru`; export it)

- [ ] **Step 1: Add `recordTabMru` to the workspace store**

In `workspace.ts`, add to the `WorkspaceState` interface (near `followTab`, ~line 300):

```ts
  // Record a tab as a project's MRU WITHOUT switching project — used by the
  // FileTree-open path (browsing files inside the active project's tree).
  recordTabMru: (tabPath: string) => void;
```

And implement it in the store body (next to `followTab`):

```ts
  recordTabMru(tabPath) {
    const derived = deriveProjectIdFromTab(tabPath, get().projects);
    if (derived) mruTabByProject.set(derived, tabPath);
  },
```

- [ ] **Step 2: Simplify `followTab` — remove the tree guard**

The FileTree case now routes through `activate({source:'filetree'})`, so `followTab` no longer needs `markTreeOpen`/`lastTreeOpenPath`. Replace the body of `followTab` (`workspace.ts:586-607`) with:

```ts
  followTab(tabPath) {
    const derived = deriveProjectIdFromTab(tabPath, get().projects);
    if (!derived) return;
    mruTabByProject.set(derived, tabPath);
    if (derived !== get().activeProjectId) {
      get().setActiveProject(derived);
    }
  },
```

Also delete `lastTreeOpenPath` (`:160`), `markTreeOpen` (`:162-166`), and the `lastTreeOpenPath = null` line inside `setActiveProject` (`:466`) and `__resetProjectMruForTests` (`:199`).

- [ ] **Step 3: Create the router**

```ts
// src/renderer/state/activation.ts
import { useCliTabsStore } from '@renderer/state/cliTabs';
import { deriveProjectIdFromTab, useWorkspaceStore } from '@renderer/state/workspace';

// Gesture origin — the information the old mirror effects had to GUESS from
// state. Carrying it explicitly is what lets us delete every heuristic guard.
export type ActivationSource =
  | 'sidebar' // project row / Welcome card
  | 'dock-chip' // CLI tab chip click
  | 'dock-pane' // mousedown inside a pane / focus-column button
  | 'editor-tab' // editor file-tab click
  | 'filetree' // file/folder opened from the tree (never docks)
  | 'system' // background event (idle pty close, undock repair)
  | 'boot'; // persisted-state restore

export interface ActivationIntent {
  source: ActivationSource;
  projectId?: string | null;
  tabId?: string; // dock tab to focus (dock-chip)
  columnId?: string; // dock column to focus (dock-pane)
  editorPath?: string; // editor/filetree path → project derived from it
}

// The workspace that owns a (possibly cross-workspace) docked project.
// Current-workspace projects win; otherwise fall back to the cross-workspace
// chip metadata persisted in cliTabs.projectsById.
export function workspaceIdForProject(projectId: string): string | null {
  const ws = useWorkspaceStore.getState();
  const inWs = ws.projects.find((p) => p.id === projectId);
  if (inWs) return inWs.workspaceId;
  return useCliTabsStore.getState().projectsById[projectId]?.workspaceId ?? null;
}

// The ONE entry point for every selection gesture. Synchronous except for the
// cross-workspace rescan (await setActive). No reactive effect runs after it —
// it sets project + dock + editor itself.
export async function activate(intent: ActivationIntent): Promise<void> {
  const ws = useWorkspaceStore.getState();

  // FileTree open: record MRU, never switch/dock (replaces markTreeOpen).
  if (intent.source === 'filetree') {
    if (intent.editorPath) ws.recordTabMru(intent.editorPath);
    return;
  }

  // Resolve the target project (explicit id, or derived from an editor path).
  const projectId =
    intent.projectId ??
    (intent.editorPath ? deriveProjectIdFromTab(intent.editorPath, ws.projects) : null);
  if (!projectId) return;

  // Cross-workspace? Switch the whole workspace first (Plan C), then verify the
  // project survived the rescan before continuing.
  const targetWs = workspaceIdForProject(projectId);
  if (targetWs && targetWs !== ws.active?.id) {
    await useWorkspaceStore.getState().setActive(targetWs);
    const after = useWorkspaceStore.getState();
    if (!after.projects.some((p) => p.id === projectId)) return;
    // D1: collapse splits so no stale cross-workspace pane lingers.
    if (intent.tabId) {
      useCliTabsStore.getState().focusSingleProject(projectId, intent.tabId);
    }
  }

  const cli = useCliTabsStore.getState();
  if (intent.columnId) cli.setActiveColumn(intent.columnId);
  if (intent.tabId) cli.setActiveTab(projectId, intent.tabId);

  // Selection + editor policy by source.
  const ws2 = useWorkspaceStore.getState();
  switch (intent.source) {
    case 'sidebar':
    case 'dock-chip':
      ws2.activateProject(projectId); // also restores the project's MRU editor tab
      break;
    case 'editor-tab':
      ws2.followTab(intent.editorPath ?? ''); // records MRU + setActiveProject, no editor move
      break;
    case 'dock-pane':
    case 'system':
    case 'boot':
      ws2.setActiveProject(projectId); // plain mirror, never moves the editor
      break;
  }
}
```

- [ ] **Step 4: Add `focusSingleProject` to cliTabs (D1)**

In `cliTabs.ts`, add to `CliTabsState` (near `setActiveDockedProject`):

```ts
  // Collapse the dock to a single column pinned to (projectId, tabId). Used on
  // a cross-workspace switch so split columns don't keep showing panes from the
  // workspace we just left.
  focusSingleProject: (projectId: string, tabId: string) => void;
```

Implement:

```ts
    focusSingleProject(projectId, tabId) {
      set((prev) => {
        const next: PersistedShape = {
          ...prev,
          columns: [{ id: prev.activeColumnId, pin: { projectId, tabId } }],
          activeColumnId: prev.activeColumnId,
          activeDockedProjectId: projectId,
          activeTabIdByProject: { ...prev.activeTabIdByProject, [projectId]: tabId },
        };
        persist(next);
        return next;
      });
    },
```

- [ ] **Step 5: Run the router tests**

Run: `npx vitest run src/renderer/state/__tests__/activation.test.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/state/activation.ts src/renderer/state/cliTabs.ts src/renderer/state/workspace.ts
git commit -m "feat(sync): activation router as single source of truth (Plan C)"
```

---

## Task 3: Rewire gesture sites to the router

Each sub-step is one call-site swap. After each, run `npx vitest run` to confirm nothing regressed, then commit.

- [ ] **Step 1: ProjectList rows** — `ProjectList.tsx:119, 141, 179`

Replace the `useWorkspaceStore((s) => s.activateProject)` import (`:44`) usage. Each `onClick={() => activateProject(id)}` becomes:

```tsx
onClick={() => void activate({ source: 'sidebar', projectId: rootProject.id })}
// …
onClick={() => void activate({ source: 'sidebar', projectId: p.id })}
```

Add `import { activate } from '@renderer/state/activation';` and drop the now-unused `activateProject` selector.

- [ ] **Step 2: Welcome card** — `Welcome.tsx:110`

```tsx
onPickProject={(id) => void activate({ source: 'sidebar', projectId: id })}
```

- [ ] **Step 3: Editor tabs** — `EditorTabs.tsx:58-70`

```tsx
onClick={() => {
  setActive(tab.path, pane);
  void activate({ source: 'editor-tab', editorPath: tab.path });
}}
```

Replace the `followTab` import with `import { activate } from '@renderer/state/activation';`.

- [ ] **Step 4: FileTree open** — wherever the tree opens a file (the former `markTreeOpen` call site)

Replace the `markTreeOpen(path)` + editor-open sequence with an `activate({ source: 'filetree', editorPath: path })` call alongside the editor open. (Grep `openFileInEditor`/`editor.open` inside `FileTree.tsx`/`FileTreeRow.tsx` for the exact site; `markTreeOpen` no longer exists.)

- [ ] **Step 5: CliTabBar chip select** — `CliTabBar.tsx:74-89`

```tsx
const handleSelect = (projectId: string, tabId: string): void => {
  const owner = findColumnIdPinning(columns, projectId, tabId);
  void activate({ source: 'dock-chip', projectId, tabId, columnId: owner ?? undefined });
};
```

The router now does `setActiveColumn`/`setActiveTab`/workspace-switch internally, so the manual sequence is removed. Drop the `activateProject`/`setActiveColumn`/`setActiveTab` direct calls from `handleSelect` only (other handlers keep theirs).

- [ ] **Step 6: ClaudeCliDock pane mousedown + column focus + drops** — `ClaudeCliDock.tsx:214, 264-270, 305, 360-363`

Pane mousedown (`:360`):

```tsx
onMouseDown={() => {
  if (visible && columns[colIdx]) {
    const pin = columns[colIdx]!.pin;
    void activate({ source: 'dock-pane', projectId: pin?.projectId, columnId: columns[colIdx]!.id });
  }
}}
```

Column-focus button (`:214`): `onClick={() => activate({ source: 'dock-pane', projectId: col.pin?.projectId, columnId: col.id })}`.
Column drop (`:263-270`) and split drop (`:302-306`): after `setColumnPin`/`splitForTab`, replace the `activateProject(pin.projectId)` guard-comment block with `void activate({ source: 'dock-chip', projectId: pin.projectId, tabId: pin.tabId, columnId: col.id })`.

- [ ] **Step 7: Run tests + typecheck after each swap; commit once all sites are green**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, no type errors.

```bash
git add src/renderer/components
git commit -m "refactor(sync): route all selection gestures through activate()"
```

---

## Task 4: Delete the reactive mirror effects and heuristic guards

Now that every gesture calls the router, the effects that reconciled the stores after the fact are dead. Deleting them is what actually removes the ping-pong + the lost-update bugs.

**Files:** `App.tsx`, `ClaudeCliDock.tsx`, `workspace.ts`, `workspace.test.ts`

- [ ] **Step 1: App.tsx — delete both follow effects + their refs**

Delete: module refs `lastFollowedTabPath`/`lastFollowedDockKey` (`:66-67`); the editor→sidebar effect (`:131-137`); the `dockFollowKey` selector (`:157-162`) and the dock→sidebar effect (`:163-196`); the imports `deriveProjectIdFromDockColumn`, `isDefensiveAutoPinTransition`, `isUndockRetargetTransition` (`:54-56`).

- [ ] **Step 2: ClaudeCliDock.tsx — delete the sidebar→dock mirror effect**

Delete `lastMirroredActiveRef`/`bootMirrorDoneRef` (`:74-78`) and the effect (`:79-104`). Keep the `dockProject`-on-`openedProjectIds` effect (`:55-66`) and the defensive auto-pin (`:121-161`) — the auto-pin is now a pure visual repair that can no longer move the sidebar (no mirror effect listens to it).

- [ ] **Step 3: workspace.ts — delete the now-unused helpers**

Delete `deriveProjectIdFromDockColumn` (`:70-80`), `isDefensiveAutoPinTransition` (`:90-102`), `isUndockRetargetTransition` (`:113-131`). Keep `deriveProjectIdFromTab`, `pickEditorTabForProject`, `mruTabByProject`, eviction logic.

- [ ] **Step 4: workspace.test.ts — drop tests for deleted helpers**

Delete the `describe('deriveProjectIdFromDockColumn')` (`:119-162`), `describe('isDefensiveAutoPinTransition')` (`:253-274`), `describe('isUndockRetargetTransition')` (`:276-314`) blocks, and the FileTree-tree-guard `followTab` tests (`:510-535`) — that path is now `source:'filetree'` covered in `activation.test.ts`.

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS. No references to the deleted symbols remain (`grep -rn "isDefensiveAutoPin\|isUndockRetarget\|deriveProjectIdFromDockColumn\|markTreeOpen\|lastFollowedDockKey" src` returns nothing).

- [ ] **Step 6: Commit**

```bash
git add src/renderer
git commit -m "refactor(sync): delete bidirectional mirror effects + heuristic guards"
```

---

## Task 5: Cross-workspace chip label (D2)

**Files:** `CliTabBar.tsx` (+ `TabChip.tsx` if the label renders inside the chip)

- [ ] **Step 1: Compute the active workspace id and label cross-workspace chips**

In `CliTabBar.tsx`, read `const activeWsId = useWorkspaceStore((s) => s.active?.id);` and `const known = useWorkspaceStore((s) => s.known);`. For each docked project whose `workspaceId !== activeWsId`, pass a `workspaceLabel={known.find((w) => w.id === p.workspaceId)?.name}` prop to its chip; render it as a small dimmed prefix/badge. Current-workspace chips pass `undefined` (no label).

- [ ] **Step 2: Manual verification**

Run the app (`pnpm dev`). Dock a project in workspace A, switch to workspace B and dock one there. Both chips show in the bar; the A chip carries an "A" badge while B is active. Clicking the A chip rescans to A and the badge moves to B.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/Dock
git commit -m "feat(dock): label cross-workspace chips by workspace name"
```

---

## Task 6: Empty-workspace verification (no code)

Empty-workspace support already exists (`ProjectScanner.ts:187-200`, tested at `ProjectScanner.test.ts:19`). Confirm it still holds end-to-end and interacts correctly with Plan C.

- [ ] **Step 1: Unit test still green**

Run: `npx vitest run src/main/services/__tests__/ProjectScanner.test.ts`
Expected: PASS, including "returns the workspace itself as a project when the folder is empty".

- [ ] **Step 2: Manual** — In `pnpm dev`, create a brand-new empty folder, "Open folder…". Expect: one "Root" project, a Claude dock at root, FileTree renders, no `git init` needed. Switching to it from another workspace's chip (cross-workspace) works.

---

## Task 7: Full verification before completion

Per the project lesson "Boot-test the real packaged .app before shipping" — dev + vitest is not sufficient for this dock-heavy change.

- [ ] **Step 1: Full suite + build**

Run: `pnpm test && pnpm build && npx tsc --noEmit`
Expected: all tests pass, build succeeds, no type errors.

- [ ] **Step 2: Dev smoke — the sync matrix**

`pnpm dev`, then verify each direction:
- Sidebar row (Root/Open/All) click → dock chip + FileTree + git follow.
- Dock chip click (same workspace) → sidebar highlight + FileTree follow.
- Dock chip click (other workspace) → workspace rescans, sidebar shows that workspace, that project active.
- Editor file-tab click → sidebar follows; FileTree file click → does NOT dock.
- Workspace picker switch → dock activates that workspace's last project.
- Idle-pty auto-close / close-project → sidebar does NOT jump (no background mirror).

- [ ] **Step 3: Packaged-app boot test**

Build the DMG/.app (`pnpm dist` or project's package script), launch it, and re-run the Step 2 matrix in the packaged artifact.

- [ ] **Step 4: Final commit / branch ready for review**

```bash
git add -A && git commit -m "test(sync): verify Plan C sync matrix + packaged boot"
```

---

## Self-Review

**Spec coverage:** Plan C rules 1-7 → Tasks 2-3 (router + gestures), Task 2 cross-workspace branch (rule 3), Task 5 (rule 2 distinguishability), Task 4 (rule 6 filetree), Task 6 (rule 7 empty). ✅
**Placeholder scan:** FileTree open site (Task 3 Step 4) is the one site needing a grep at execution time because `markTreeOpen`'s caller wasn't read in this plan — flagged explicitly, not silently TODO'd. All other steps carry concrete code. 
**Type consistency:** `activate(intent)`/`ActivationIntent`/`workspaceIdForProject` names match across Tasks 1-3; `focusSingleProject(projectId, tabId)` signature matches between cliTabs (Task 2 Step 4) and the router call (Task 2 Step 3). ✅
**Open decisions:** D1 (collapse splits on cross-workspace switch) and D2 (chip label style) are called out at the top for review — both reversible.
