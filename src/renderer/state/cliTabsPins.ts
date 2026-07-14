import type { CliId, CliTab, DockColumn, DockedProjectMeta } from '@shared/types';

/**
 * Pure pin helpers for the CLI dock's column layout (extracted from
 * cliTabs.ts both for the 500-line file cap and so the invariants are
 * unit-testable without booting the zustand store).
 *
 * THE invariant all of these enforce: at most ONE column pins a given
 * (projectId, tabId). The pane→column lookup in ClaudeCliDock is last-wins,
 * so two columns pinning the same pair fight over one pane and the earlier
 * column renders permanently blank.
 */

export interface ColumnPin {
  projectId: string;
  tabId: string;
}

/** Structural subset of the cliTabs store the helpers need. */
export interface PinStateSnapshot {
  tabsByProject: Record<string, CliTab[]>;
  activeTabIdByProject: Record<string, string>;
  dockedOrder: string[];
  activeDockedProjectId: string | null;
  columns: DockColumn[];
}

/** The full persisted dock shape — what the pure reducers below map. */
export interface DockStateSnapshot extends PinStateSnapshot {
  projectsById: Record<string, DockedProjectMeta>;
  activeColumnId: string;
}

export function pinKey(pin: ColumnPin): string {
  return `${pin.projectId}:${pin.tabId}`;
}

function samePin(
  a: ColumnPin | null | undefined,
  b: ColumnPin | null | undefined,
): boolean {
  return !!a && !!b && a.projectId === b.projectId && a.tabId === b.tabId;
}

// PtyPool keys every session `<projectId>:<kind>:<tabId>`; kind = `<cliId>-cli`.
// The pane subscribes by this id, so it must match the launcher's createPty kind.
export function cliSessionId(
  cliId: CliId,
  projectId: string,
  tabId: string,
): string {
  return `${projectId}:${cliId}-cli:${tabId}`;
}

export function claudeCliSessionId(projectId: string, tabId: string): string {
  return cliSessionId('claude', projectId, tabId);
}

/** The column currently showing (projectId, tabId), if any. */
export function findColumnIdPinning(
  columns: DockColumn[],
  projectId: string,
  tabId: string,
): string | null {
  return (
    columns.find((c) => c.pin?.projectId === projectId && c.pin.tabId === tabId)
      ?.id ?? null
  );
}

/**
 * The one way a column acquires a pin: target gets `pin`, and any OTHER
 * column holding the identical pair is stripped to null. A stripped active
 * column is repaired by ClaudeCliDock's defensive auto-pin next render.
 */
export function assignPin(
  columns: DockColumn[],
  targetColumnId: string,
  pin: ColumnPin | null,
): DockColumn[] {
  if (!columns.some((c) => c.id === targetColumnId)) return columns;
  return columns.map((c) => {
    if (c.id === targetColumnId) return { ...c, pin: pin ? { ...pin } : null };
    if (samePin(c.pin, pin)) return { ...c, pin: null };
    return c;
  });
}

/**
 * Drag-drop variant: if the dropped pair is already pinned in a donor
 * column, the donor receives the target's OLD pin instead of null — a drag
 * rearranges panes; it must never leave a column blank.
 */
export function assignPinWithSwap(
  columns: DockColumn[],
  targetColumnId: string,
  pin: ColumnPin | null,
): DockColumn[] {
  const target = columns.find((c) => c.id === targetColumnId);
  if (!target) return columns;
  const oldPin = target.pin;
  return columns.map((c) => {
    if (c.id === targetColumnId) return { ...c, pin: pin ? { ...pin } : null };
    if (samePin(c.pin, pin)) return { ...c, pin: oldPin ? { ...oldPin } : null };
    return c;
  });
}

/**
 * Older builds could persist the same pair in two columns (the bug fixed by
 * assignPin). Sanitize on load — keep the first occurrence, null the rest —
 * so a stale devspace:cliTabs:v1 can't resurrect the blank-column bug.
 */
export function sanitizePersistedColumns(columns: DockColumn[]): DockColumn[] {
  const seen = new Set<string>();
  return columns.map((c) => {
    if (!c.pin) return c;
    const key = pinKey(c.pin);
    if (seen.has(key)) return { ...c, pin: null };
    seen.add(key);
    return c;
  });
}

/**
 * Seed pin for a fresh Split column. Cloning the active pin (old behavior)
 * was a guaranteed duplicate — every Split click blanked the ORIGINAL
 * column. Instead: the active project's first tab not pinned in any column,
 * else any docked project's unpinned active tab, else null.
 */
export function seedPinForNewColumn(state: PinStateSnapshot): ColumnPin | null {
  const pinned = new Set<string>();
  for (const c of state.columns) if (c.pin) pinned.add(pinKey(c.pin));

  const activeId = state.activeDockedProjectId;
  if (activeId) {
    const tab = (state.tabsByProject[activeId] ?? []).find(
      (t) => !pinned.has(`${activeId}:${t.id}`),
    );
    if (tab) return { projectId: activeId, tabId: tab.id };
  }
  for (const pid of state.dockedOrder) {
    const tabs = state.tabsByProject[pid] ?? [];
    const activeTabId = state.activeTabIdByProject[pid] ?? tabs[0]?.id;
    if (
      activeTabId &&
      tabs.some((t) => t.id === activeTabId) &&
      !pinned.has(`${pid}:${activeTabId}`)
    ) {
      return { projectId: pid, tabId: activeTabId };
    }
  }
  return null;
}

/**
 * removeTab repair: columns pinned to the removed tab fall back to the
 * project's surviving tab — at most ONE of them (and only when no other
 * column already shows the fallback); the rest go null rather than
 * duplicate.
 */
export function retargetColumnsForRemovedTab(
  columns: DockColumn[],
  projectId: string,
  removedTabId: string,
  fallbackTabId: string,
): DockColumn[] {
  const removed: ColumnPin = { projectId, tabId: removedTabId };
  const fallback: ColumnPin = { projectId, tabId: fallbackTabId };
  const fallbackTaken = columns.some((c) => samePin(c.pin, fallback));
  let retargeted = false;
  return columns.map((c) => {
    if (!samePin(c.pin, removed)) return c;
    if (!fallbackTaken && !retargeted) {
      retargeted = true;
      return { ...c, pin: { ...fallback } };
    }
    return { ...c, pin: null };
  });
}

/**
 * undockProject repair: columns pinned to the removed project re-target to
 * `fallbackPin` (the surviving selection's active tab) — exactly one, and
 * only when no surviving column already pins that pair; the rest go null.
 * This is a pure column repair: since the dock→sidebar mirror effect was
 * removed (selection now flows through state/activation.ts), this background
 * re-target can never move the sidebar on its own.
 */
export function retargetColumnsForRemovedProject(
  columns: DockColumn[],
  removedProjectId: string,
  fallbackPin: ColumnPin | null,
): DockColumn[] {
  const fallbackTaken =
    !!fallbackPin && columns.some((c) => samePin(c.pin, fallbackPin));
  let retargeted = false;
  return columns.map((c) => {
    if (c.pin?.projectId !== removedProjectId) return c;
    if (fallbackPin && !fallbackTaken && !retargeted) {
      retargeted = true;
      return { ...c, pin: { ...fallbackPin } };
    }
    return { ...c, pin: null };
  });
}

/**
 * Keep the legacy single-pane selection (activeDockedProjectId +
 * activeTabIdByProject) in lock-step with a pin write. The chip highlight
 * and the idle reaper's protection both read the selection side — letting
 * it drift from the visible pin highlights one tab while the reaper is free
 * to kill it. Mutates `next` (a freshly-built draft inside set()).
 */
export function syncActiveFromPin<
  T extends Pick<PinStateSnapshot, 'activeDockedProjectId' | 'activeTabIdByProject'>,
>(next: T, pin: ColumnPin): T {
  next.activeDockedProjectId = pin.projectId;
  next.activeTabIdByProject = {
    ...next.activeTabIdByProject,
    [pin.projectId]: pin.tabId,
  };
  return next;
}

/**
 * Defensive auto-pin tab choice for `projectId` in column `targetColumnId`:
 * prefer the project's active tab, then any tab not visible in another
 * column (pinning an already-visible tab would steal that pane under
 * setColumnPin's swap semantics), last resort the active tab anyway.
 */
export function pickAutoPinTab(
  state: Pick<PinStateSnapshot, 'columns' | 'tabsByProject' | 'activeTabIdByProject'>,
  targetColumnId: string,
  projectId: string,
): string | null {
  const tabs = state.tabsByProject[projectId] ?? [];
  if (tabs.length === 0) return null;
  const pinnedElsewhere = new Set<string>();
  for (const c of state.columns) {
    if (c.id !== targetColumnId && c.pin) pinnedElsewhere.add(pinKey(c.pin));
  }
  const preferredRaw = state.activeTabIdByProject[projectId];
  const preferred =
    preferredRaw && tabs.some((t) => t.id === preferredRaw)
      ? preferredRaw
      : tabs[0]!.id;
  if (!pinnedElsewhere.has(`${projectId}:${preferred}`)) return preferred;
  return (
    tabs.find((t) => !pinnedElsewhere.has(`${projectId}:${t.id}`))?.id ??
    preferred
  );
}

/**
 * v0.36.1: session ids the idle reaper must NOT close — every (project,
 * tab) visible in some dock column. Deduped via Set: transient duplicate
 * pins would otherwise produce a multiset, breaking the length-based
 * unordered equality used to skip redundant IPC pushes.
 */
export function computePinnedSessionIds(
  state: Pick<PinStateSnapshot, 'columns' | 'tabsByProject'>,
): string[] {
  const out = new Set<string>();
  for (const col of state.columns) {
    if (!col.pin) continue;
    const tabs = state.tabsByProject[col.pin.projectId];
    const tab = tabs?.find((t) => t.id === col.pin!.tabId);
    if (!tab || tab.awaitingCliChoice) continue;
    out.add(cliSessionId(tab.cliId ?? 'claude', col.pin.projectId, col.pin.tabId));
  }
  return [...out];
}

// beta.25: every open (project, tab) session id — the FULL live set, not just
// the column-visible/pinned ones. Main's boot reconcile keeps these (+ live
// tasks + attached) and prunes the rest as orphans.
export function computeAllSessionIds(
  state: Pick<PinStateSnapshot, 'tabsByProject'>,
): string[] {
  const out = new Set<string>();
  for (const [projectId, tabs] of Object.entries(state.tabsByProject)) {
    for (const t of tabs) {
      if (!t.awaitingCliChoice) {
        out.add(cliSessionId(t.cliId ?? 'claude', projectId, t.id));
      }
    }
  }
  return [...out];
}

export function arraysEqualUnordered(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  for (const x of b) if (!set.has(x)) return false;
  return true;
}

/**
 * Pin the active column to the user's last chip click. Falls back to the
 * first column if the active id has been removed. assignPin (not a raw
 * map) so a chip already pinned in another column is stripped there
 * instead of duplicating.
 */
export function pinForActiveSelection(
  prev: Pick<DockStateSnapshot, 'columns' | 'activeColumnId'>,
  projectId: string,
  tabId: string,
): DockColumn[] {
  const activeId = prev.columns.some((c) => c.id === prev.activeColumnId)
    ? prev.activeColumnId
    : prev.columns[0]?.id;
  if (!activeId) return prev.columns;
  return assignPin(prev.columns, activeId, { projectId, tabId });
}

/* ------------------------------------------------------------------ *
 * Pure reducers for the column-mutating store actions. Each returns a
 * fresh snapshot (or null for a no-op); the store wraps them with
 * set() + persist() + the PTY side effects.
 * ------------------------------------------------------------------ */

/**
 * undockProject: drop the project's tabs/meta/order entry, then use ONE
 * fallback convention for both the selection and the pin repair — keep the
 * previous selection if it survives the removal, else the last project of
 * the NEW docked order. Previously the selection fell back to LAST docked
 * while the nulled columns were later repaired by the defensive auto-pin
 * to a DIFFERENT convention (first docked / tabs[0]), so the chip
 * highlight and the visible pane diverged. The caller must NOT touch the
 * workspace store: this is a background pane repair, and with the dock→sidebar
 * mirror effect gone (state/activation.ts owns selection) it never moves the
 * sidebar.
 */
export function undockProjectState(
  prev: DockStateSnapshot,
  projectId: string,
): DockStateSnapshot {
  const tabsByProject = { ...prev.tabsByProject };
  delete tabsByProject[projectId];
  const activeTabIdByProject = { ...prev.activeTabIdByProject };
  delete activeTabIdByProject[projectId];
  const projectsById = { ...prev.projectsById };
  delete projectsById[projectId];
  const dockedOrder = prev.dockedOrder.filter((id) => id !== projectId);
  const fallback =
    prev.activeDockedProjectId &&
    dockedOrder.includes(prev.activeDockedProjectId)
      ? prev.activeDockedProjectId
      : (dockedOrder[dockedOrder.length - 1] ?? null);
  const fallbackTabId = fallback
    ? (activeTabIdByProject[fallback] ?? tabsByProject[fallback]?.[0]?.id)
    : undefined;
  const columns = retargetColumnsForRemovedProject(
    prev.columns,
    projectId,
    fallback && fallbackTabId
      ? { projectId: fallback, tabId: fallbackTabId }
      : null,
  );
  return {
    tabsByProject,
    activeTabIdByProject,
    projectsById,
    dockedOrder,
    activeDockedProjectId: fallback,
    columns,
    activeColumnId: prev.activeColumnId,
  };
}

/**
 * removeTab (non-last-tab case — the caller undocks when no tab survives):
 * drop the tab, move the project's selection to its last surviving tab,
 * and re-target pinned columns via retargetColumnsForRemovedTab.
 */
export function removeTabState(
  prev: DockStateSnapshot,
  projectId: string,
  removedTabId: string,
): DockStateSnapshot | null {
  const tabs = (prev.tabsByProject[projectId] ?? []).filter(
    (t) => t.id !== removedTabId,
  );
  if (tabs.length === 0) return null;
  const fallbackTabId = tabs[tabs.length - 1]!.id;
  const activeTabIdByProject = { ...prev.activeTabIdByProject };
  if (activeTabIdByProject[projectId] === removedTabId) {
    activeTabIdByProject[projectId] = fallbackTabId;
  }
  return {
    ...prev,
    tabsByProject: { ...prev.tabsByProject, [projectId]: tabs },
    activeTabIdByProject,
    columns: retargetColumnsForRemovedTab(
      prev.columns,
      projectId,
      removedTabId,
      fallbackTabId,
    ),
  };
}

/** addColumn — see seedPinForNewColumn for the duplicate-free seeding. */
export function addColumnState(
  prev: DockStateSnapshot,
  newId: string,
): DockStateSnapshot {
  return {
    ...prev,
    columns: [...prev.columns, { id: newId, pin: seedPinForNewColumn(prev) }],
    activeColumnId: newId,
  };
}

/**
 * splitForTab: append a blank column, then assignPin so a column that
 * already pinned this pair is stripped (it would otherwise fight the new
 * column for the pane). The new column is what the user is now looking at,
 * so the selection syncs to its pin (chip highlight + reaper protection).
 */
export function splitForTabState(
  prev: DockStateSnapshot,
  newId: string,
  pin: ColumnPin,
): DockStateSnapshot {
  const next: DockStateSnapshot = {
    ...prev,
    columns: assignPin([...prev.columns, { id: newId, pin: null }], newId, pin),
    activeColumnId: newId,
  };
  return syncActiveFromPin(next, pin);
}

/**
 * removeColumn: the surviving active column's pin is now what's on screen,
 * so the selection syncs to it — but only when it points at a live tab;
 * null/dangling pins are left for the defensive auto-pin + setColumnPin
 * sync to converge next render.
 */
export function removeColumnState(
  prev: DockStateSnapshot,
  columnId: string,
): DockStateSnapshot | null {
  if (prev.columns.length <= 1) return null;
  const idx = prev.columns.findIndex((c) => c.id === columnId);
  if (idx < 0) return null;
  const columns = prev.columns.filter((c) => c.id !== columnId);
  const activeColumnId =
    prev.activeColumnId === columnId
      ? (columns[Math.max(0, idx - 1)]?.id ?? columns[0]!.id)
      : prev.activeColumnId;
  const next: DockStateSnapshot = { ...prev, columns, activeColumnId };
  const survivor = columns.find((c) => c.id === activeColumnId);
  if (
    survivor?.pin &&
    prev.tabsByProject[survivor.pin.projectId]?.some(
      (t) => t.id === survivor.pin!.tabId,
    )
  ) {
    syncActiveFromPin(next, survivor.pin);
  }
  return next;
}

/**
 * setColumnPin: SWAP semantics for the drag-drop path (see
 * assignPinWithSwap). The selection syncs to non-null pins only — null
 * writes are background repairs (undock, dedup) and must not clobber
 * activeDockedProjectId.
 */
export function setColumnPinState(
  prev: DockStateSnapshot,
  columnId: string,
  pin: ColumnPin | null,
): DockStateSnapshot | null {
  const columns = assignPinWithSwap(prev.columns, columnId, pin);
  if (columns === prev.columns) return null; // unknown column id
  const next: DockStateSnapshot = { ...prev, columns };
  return pin ? syncActiveFromPin(next, pin) : next;
}
