import type { WorkbenchDestination } from './WorkbenchRail';

interface ShellRouteState {
  current: WorkbenchDestination;
  settingsOpen: boolean;
  dockFull: boolean;
  sidebarMode: 'projects' | 'tasks';
}

export function resolveShellDestination({
  current,
  settingsOpen,
  dockFull,
  sidebarMode,
}: ShellRouteState): WorkbenchDestination {
  if (settingsOpen) return 'settings';
  if (dockFull) return 'sessions';
  if (current === 'settings' || current === 'sessions') {
    return sidebarMode === 'tasks' ? 'tasks' : 'workspace';
  }
  return current;
}

export function resolveEditorDestination(
  current: WorkbenchDestination,
  activeTabKind: string | null,
): WorkbenchDestination {
  if (activeTabKind === 'codeflow') return 'codeflow';
  return current === 'codeflow' ? 'workspace' : current;
}
