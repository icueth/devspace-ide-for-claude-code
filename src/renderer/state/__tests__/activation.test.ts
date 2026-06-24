import { beforeEach, describe, expect, it, vi } from 'vitest';

import { activate, workspaceIdForProject } from '../activation';
import { useCliTabsStore } from '../cliTabs';
import { useEditorStore } from '../editor';
import { __resetProjectMruForTests, useWorkspaceStore } from '../workspace';

// Two workspaces. wsA (root + sub) is active; wsB (root) is a cross-workspace
// chip docked while wsA is active.
const PROJECTS_A = [
  {
    id: 'a-root',
    name: 'A',
    path: '/ws/a',
    workspaceId: 'wsA',
    vcs: 'git' as const,
    detectedRuntime: [],
    isWorkspaceRoot: true,
  },
  {
    id: 'a-sub',
    name: 'sub',
    path: '/ws/a/sub',
    workspaceId: 'wsA',
    vcs: 'none' as const,
    detectedRuntime: [],
  },
];
const PROJECTS_B = [
  {
    id: 'b-root',
    name: 'B',
    path: '/ws/b',
    workspaceId: 'wsB',
    vcs: 'git' as const,
    detectedRuntime: [],
    isWorkspaceRoot: true,
  },
];

function seedActiveWorkspace(
  projects: typeof PROJECTS_A | typeof PROJECTS_B,
  wsId: string,
  wsPath: string,
): void {
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

function resetCliTabs(): void {
  useCliTabsStore.setState({
    tabsByProject: {},
    activeTabIdByProject: {},
    projectsById: {},
    dockedOrder: [],
    activeDockedProjectId: null,
    columns: [{ id: 'col-0', pin: null }],
    activeColumnId: 'col-0',
  });
}

beforeEach(() => {
  __resetProjectMruForTests();
  resetCliTabs();
  useEditorStore.setState({
    tabs: [],
    activeTabPath: null,
    splitTabs: [],
    splitActivePath: null,
  });
  seedActiveWorkspace(PROJECTS_A, 'wsA', '/ws/a');
});

describe('activate — same-workspace selection', () => {
  it('sidebar source activates the project and docks it', async () => {
    await activate({ source: 'sidebar', projectId: 'a-sub' });
    expect(useWorkspaceStore.getState().activeProjectId).toBe('a-sub');
    expect(useCliTabsStore.getState().projectsById['a-sub']).toBeTruthy();
  });

  it('dock-pane source moves the sidebar', async () => {
    await activate({ source: 'dock-pane', projectId: 'a-sub' });
    expect(useWorkspaceStore.getState().activeProjectId).toBe('a-sub');
  });
});

describe('activate — cross-workspace chip switches the workspace (Plan C)', () => {
  it('switches active workspace to the chip owner, then activates the project', async () => {
    // Dock a wsB chip (cross-workspace) while wsA is active.
    useCliTabsStore
      .getState()
      .dockProject({ id: 'b-root', name: 'B', path: '/ws/b', workspaceId: 'wsB' });
    // setActive is the async rescan boundary — stub it to load wsB.
    const setActive = vi.fn(async (id: string) => {
      if (id === 'wsB') seedActiveWorkspace(PROJECTS_B, 'wsB', '/ws/b');
    });
    useWorkspaceStore.setState({ setActive });

    await activate({ source: 'dock-chip', projectId: 'b-root', tabId: 't1' });

    expect(setActive).toHaveBeenCalledWith('wsB');
    expect(useWorkspaceStore.getState().active?.id).toBe('wsB');
    expect(useWorkspaceStore.getState().activeProjectId).toBe('b-root');
  });

  it('aborts cleanly if the project is gone after the rescan', async () => {
    useCliTabsStore
      .getState()
      .dockProject({ id: 'b-root', name: 'B', path: '/ws/b', workspaceId: 'wsB' });
    // Rescan loads a workspace WITHOUT b-root (folder deleted).
    const setActive = vi.fn(async () => {
      seedActiveWorkspace(PROJECTS_A, 'wsB', '/ws/b'); // wrong projects on purpose
    });
    useWorkspaceStore.setState({ setActive });

    await activate({ source: 'dock-chip', projectId: 'b-root', tabId: 't1' });
    expect(useWorkspaceStore.getState().activeProjectId).not.toBe('b-root');
  });
});

describe('workspaceIdForProject', () => {
  it('resolves from current workspace projects first', () => {
    expect(workspaceIdForProject('a-sub')).toBe('wsA');
  });
  it('falls back to docked cross-workspace metadata', () => {
    useCliTabsStore
      .getState()
      .dockProject({ id: 'b-root', name: 'B', path: '/ws/b', workspaceId: 'wsB' });
    expect(workspaceIdForProject('b-root')).toBe('wsB');
  });
  it('returns null for an unknown project', () => {
    expect(workspaceIdForProject('nope')).toBeNull();
  });
});
