import { pinForActiveSelection, type DockStateSnapshot } from '@renderer/state/cliTabsPins';
import type { CliId, CliTab } from '@shared/types';

/**
 * Docking a tab whose tmux session ALREADY exists (Agent Flow's interactive
 * nodes spawn theirs in main, outside the dock).
 *
 * The attach is entirely a matter of naming: main derives the tmux session
 * name from (projectId, tabId, kind = `${cliId}-cli`), so a CliTab carrying the
 * spawner's tabId + cliId makes the pane's `tmux new-session -A` ATTACH to the
 * live agent instead of starting a second one beside it. Everything here just
 * protects that identity — hence `tabId` verbatim, never a fresh shortId().
 *
 * Pure half lives here (same split as cliTabsPins.ts) so the store action stays
 * a thin set()+persist() wrapper and cliTabs.ts doesn't grow another reducer.
 */

export interface AttachExternalTabOpts {
  tabId: string;
  cliId: CliId;
  cliProfileId?: string;
  authProfileId?: string;
  label?: string;
}

export function makeExternalTab(
  projectId: string,
  opts: AttachExternalTabOpts,
): CliTab {
  return {
    id: opts.tabId,
    projectId,
    label: opts.label ?? 'Flow',
    createdAt: Date.now(),
    // 'claude' is the store's implicit default (undefined) — keep the
    // convention so cliKind() / cliSessionId() resolve identically for an
    // attached tab and a normally-created one.
    cliId: opts.cliId === 'claude' ? undefined : opts.cliId,
    cliProfileId: opts.cliProfileId,
    authProfileId: opts.authProfileId,
  };
}

/**
 * Upsert `tab` under its project, select it, and pin it into the active
 * column. Idempotent: re-attaching an already-docked session just focuses it
 * (the tab list is keyed by id, so no duplicate pane can appear).
 * Caller must have docked the project first — a tab has no chip to live under
 * otherwise (same precondition as addTab).
 */
export function attachExternalTabState(
  prev: DockStateSnapshot,
  projectId: string,
  tab: CliTab,
): DockStateSnapshot {
  const tabs = prev.tabsByProject[projectId] ?? [];
  return {
    ...prev,
    tabsByProject: {
      ...prev.tabsByProject,
      [projectId]: tabs.some((t) => t.id === tab.id) ? tabs : [...tabs, tab],
    },
    activeTabIdByProject: { ...prev.activeTabIdByProject, [projectId]: tab.id },
    activeDockedProjectId: projectId,
    columns: pinForActiveSelection(prev, projectId, tab.id),
  };
}
