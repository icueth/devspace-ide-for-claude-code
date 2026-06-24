import { useCliTabsStore } from '@renderer/state/cliTabs';
import { useWorkspaceStore } from '@renderer/state/workspace';

// Gesture origin for a dock/sidebar selection. Carrying it explicitly is what
// lets us delete the dock→sidebar reactive mirror effect and its heuristic
// guards (isDefensiveAutoPinTransition / isUndockRetargetTransition) — the
// effect had to GUESS whether a state change came from the user or a
// background echo; the gesture now just says so.
//
// NOTE: editor file-tab / FileTree / Quick Open opens are deliberately NOT
// routed here — they stay on the existing editor→sidebar follow + markTreeOpen
// path in App.tsx, which is one-directional and self-terminating.
export type ActivationSource =
  | 'sidebar' // project row / Welcome card (always current workspace)
  | 'dock-chip' // CLI tab chip click (may be cross-workspace)
  | 'dock-pane' // mousedown inside a pane / focus-column button / drop
  | 'system' // background event (idle pty close, undock repair)
  | 'boot'; // persisted-state restore

export interface ActivationIntent {
  source: ActivationSource;
  projectId?: string | null;
  tabId?: string; // dock tab to focus (dock gestures)
  columnId?: string; // dock column to focus (dock gestures)
}

// The workspace that owns a (possibly cross-workspace) docked project.
// Current-workspace projects win; otherwise fall back to the cross-workspace
// chip metadata persisted in cliTabs.projectsById. Returns null if unknown.
export function workspaceIdForProject(projectId: string): string | null {
  const ws = useWorkspaceStore.getState();
  const inWs = ws.projects.find((p) => p.id === projectId);
  if (inWs) return inWs.workspaceId;
  return useCliTabsStore.getState().projectsById[projectId]?.workspaceId ?? null;
}

// The single imperative entry point for dock/sidebar selection. Synchronous
// except for the cross-workspace rescan (await setActive). No reactive effect
// runs after it — it sets project + dock itself.
export async function activate(intent: ActivationIntent): Promise<void> {
  const ws = useWorkspaceStore.getState();
  const projectId = intent.projectId ?? null;
  if (!projectId) return;

  // Cross-workspace (Plan C): clicking a chip from another workspace switches
  // the whole workspace first, then verifies the project survived the rescan.
  const targetWs = workspaceIdForProject(projectId);
  if (targetWs && targetWs !== ws.active?.id) {
    await useWorkspaceStore.getState().setActive(targetWs);
    const after = useWorkspaceStore.getState();
    if (!after.projects.some((p) => p.id === projectId)) return;
    // D1: collapse splits so a column still pinned to the workspace we just
    // left can't keep rendering a stale pane.
    if (intent.tabId) {
      useCliTabsStore.getState().focusSingleProject(projectId, intent.tabId);
    }
  }

  const cli = useCliTabsStore.getState();
  if (intent.columnId) cli.setActiveColumn(intent.columnId);
  if (intent.tabId) cli.setActiveTab(projectId, intent.tabId);

  // Selection + editor policy by source. activateProject restores the
  // project's MRU editor tab (user intent); setActiveProject is the plain
  // mirror that never moves the editor (pane focus, background repairs).
  const ws2 = useWorkspaceStore.getState();
  if (intent.source === 'sidebar' || intent.source === 'dock-chip') {
    ws2.activateProject(projectId);
  } else {
    ws2.setActiveProject(projectId);
  }
}
