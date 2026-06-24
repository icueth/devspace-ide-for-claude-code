import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCliTabsStore } from '../cliTabs';
import { useEditorStore } from '../editor';
import {
  __resetProjectMruForTests,
  deriveProjectIdFromTab,
  markTreeOpen,
  pickEditorTabForProject,
  useWorkspaceStore,
} from '../workspace';

describe('deriveProjectIdFromTab', () => {
  const projects = [
    { id: 'a', path: '/Users/x/Code/projA' },
    { id: 'b', path: '/Users/x/Code/projB' },
    // Nested workspace: projC contains projD as a sub-folder. Longest-prefix
    // match must pick projD, not the enclosing projC, so the sidebar follows
    // the deepest enclosing project.
    { id: 'c', path: '/Users/x/Code/projC' },
    { id: 'd', path: '/Users/x/Code/projC/packages/projD' },
  ];

  it('returns null for empty tab path', () => {
    expect(deriveProjectIdFromTab(null, projects)).toBeNull();
    expect(deriveProjectIdFromTab('', projects)).toBeNull();
    expect(deriveProjectIdFromTab(undefined, projects)).toBeNull();
  });

  it('returns null when no project encloses the tab path', () => {
    expect(deriveProjectIdFromTab('/Users/x/Other/file.ts', projects)).toBeNull();
  });

  it('matches plain absolute file paths via longest-prefix', () => {
    expect(
      deriveProjectIdFromTab('/Users/x/Code/projA/src/index.ts', projects),
    ).toBe('a');
    // Deepest enclosing project wins — projD beats projC even though projC
    // also encloses the path.
    expect(
      deriveProjectIdFromTab(
        '/Users/x/Code/projC/packages/projD/src/x.ts',
        projects,
      ),
    ).toBe('d');
    // File at exactly the project root resolves to that project.
    expect(
      deriveProjectIdFromTab('/Users/x/Code/projA', projects),
    ).toBe('a');
  });

  it('handles synthetic kinds: codeflow / devlog / live-preview', () => {
    expect(
      deriveProjectIdFromTab('codeflow:/Users/x/Code/projA', projects),
    ).toBe('a');
    expect(
      deriveProjectIdFromTab('codeflow:/Users/x/Code/projB', projects),
    ).toBe('b');
    expect(
      deriveProjectIdFromTab('devlog:/Users/x/Code/projC', projects),
    ).toBe('c');
    expect(
      deriveProjectIdFromTab(
        'live-preview:/Users/x/Code/projC/packages/projD',
        projects,
      ),
    ).toBe('d');
  });

  it('synthetic match is exact equality, NOT prefix', () => {
    // A synthetic tab whose embedded path doesn't equal any project root
    // must resolve to null — guards against the (theoretical) case where a
    // synthetic key points at a subfolder of a project; falling back to
    // prefix match would route the sidebar to the wrong project.
    expect(
      deriveProjectIdFromTab('codeflow:/Users/x/Code/projA/extra', projects),
    ).toBeNull();
  });

  it('handles git diff prefix: diff:<absPath>', () => {
    expect(
      deriveProjectIdFromTab(
        'diff:/Users/x/Code/projA/src/index.ts',
        projects,
      ),
    ).toBe('a');
    // diff outside any project root returns null.
    expect(
      deriveProjectIdFromTab('diff:/Users/x/Other/file.ts', projects),
    ).toBeNull();
  });

  it('does not falsely match a path that happens to share a prefix with a project name', () => {
    // Project path is /Users/x/Code/projA — the file path below has projA
    // as a literal substring of a different directory name (projAlpha).
    // Without the trailing-slash check the naive `startsWith(p.path)` would
    // match projA. The implementation guards with `${p.path}/`.
    expect(
      deriveProjectIdFromTab(
        '/Users/x/Code/projAlpha/src/index.ts',
        projects,
      ),
    ).toBeNull();
  });

  it('returns null when projects list is empty', () => {
    expect(
      deriveProjectIdFromTab('/Users/x/Code/projA/index.ts', []),
    ).toBeNull();
    expect(
      deriveProjectIdFromTab('codeflow:/Users/x/Code/projA', []),
    ).toBeNull();
  });
});

describe('deriveProjectIdFromTab — html-preview tabs', () => {
  const projects = [
    { id: 'a', path: '/Users/x/Code/projA' },
    { id: 'b', path: '/Users/x/Code/projB' },
  ];

  it('attributes html-preview tabs via the embedded file path', () => {
    // Tab key embeds the FILE path (under <project>/.devspace/preview/),
    // not the project path — longest-prefix match must still resolve it.
    expect(
      deriveProjectIdFromTab(
        'html-preview:/Users/x/Code/projA/.devspace/preview/login.html',
        projects,
      ),
    ).toBe('a');
  });

  it('returns null for html-preview files outside every project', () => {
    expect(
      deriveProjectIdFromTab('html-preview:/Users/x/Other/p.html', projects),
    ).toBeNull();
  });
});

describe('pickEditorTabForProject', () => {
  const projects = [
    { id: 'a', path: '/Users/x/Code/projA' },
    { id: 'b', path: '/Users/x/Code/projB' },
    // Nested: projD lives inside projB — attribution of a path can shift to
    // the deeper project once it is scanned.
    { id: 'd', path: '/Users/x/Code/projB/packages/projD' },
  ];
  const tab = (path: string) => ({ path });

  it('returns the MRU tab when it is open and still owned by the project', () => {
    const mru = new Map([['b', '/Users/x/Code/projB/src/b2.ts']]);
    const tabs = [
      tab('/Users/x/Code/projA/a.ts'),
      tab('/Users/x/Code/projB/src/b1.ts'),
      tab('/Users/x/Code/projB/src/b2.ts'),
    ];
    expect(pickEditorTabForProject('b', mru, tabs, projects)).toBe(
      '/Users/x/Code/projB/src/b2.ts',
    );
  });

  it('falls back to the last-opened owned tab when the MRU tab was closed', () => {
    const mru = new Map([['b', '/Users/x/Code/projB/closed.ts']]);
    const tabs = [
      tab('/Users/x/Code/projB/src/b1.ts'),
      tab('/Users/x/Code/projA/a.ts'),
      tab('/Users/x/Code/projB/src/b2.ts'),
    ];
    expect(pickEditorTabForProject('b', mru, tabs, projects)).toBe(
      '/Users/x/Code/projB/src/b2.ts',
    );
  });

  it('rejects an MRU tab whose attribution shifted to a nested project', () => {
    // MRU[b] points inside projD (scanned after the MRU was recorded) —
    // activating it for b would bounce the sidebar to d. Must fall back.
    const mru = new Map([['b', '/Users/x/Code/projB/packages/projD/x.ts']]);
    const tabs = [
      tab('/Users/x/Code/projB/packages/projD/x.ts'),
      tab('/Users/x/Code/projB/src/b1.ts'),
    ];
    expect(pickEditorTabForProject('b', mru, tabs, projects)).toBe(
      '/Users/x/Code/projB/src/b1.ts',
    );
  });

  it('matches synthetic tabs (codeflow:) as owned', () => {
    const mru = new Map<string, string>();
    const tabs = [
      tab('/Users/x/Code/projA/a.ts'),
      tab('codeflow:/Users/x/Code/projB'),
    ];
    expect(pickEditorTabForProject('b', mru, tabs, projects)).toBe(
      'codeflow:/Users/x/Code/projB',
    );
  });

  it('returns null when no open tab belongs to the project', () => {
    const mru = new Map<string, string>();
    const tabs = [tab('/Users/x/Code/projA/a.ts')];
    expect(pickEditorTabForProject('b', mru, tabs, projects)).toBeNull();
  });
});

describe('workspace store — MAX_OPEN eviction is recency-based', () => {
  const proj = (n: number) => ({
    id: `p${n}`,
    name: `p${n}`,
    path: `/Users/x/Code/p${n}`,
    workspaceId: 'ws',
    vcs: 'git' as const,
    detectedRuntime: [],
  });
  const projects = Array.from({ length: 9 }, (_, i) => proj(i + 1));

  beforeEach(() => {
    __resetProjectMruForTests();
    (globalThis as { window?: unknown }).window = {};
    useWorkspaceStore.setState({
      active: { id: 'ws', name: 'ws', path: '/Users/x/Code', lastOpened: 0 },
      projects,
      activeProjectId: null,
      openedProjectIds: [],
    });
    useCliTabsStore.setState({
      tabsByProject: {},
      activeTabIdByProject: {},
      projectsById: {},
      dockedOrder: [],
      activeDockedProjectId: null,
      columns: [{ id: 'col-0', pin: null }],
      activeColumnId: 'col-0',
    });
    useEditorStore.setState({
      tabs: [],
      activeTabPath: null,
      splitTabs: [],
      splitActivePath: null,
    });
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  const open = (...ns: number[]) => {
    for (const n of ns) useWorkspaceStore.getState().setActiveProject(`p${n}`);
  };

  it('evicts the least-recently-activated project, not the first-opened', () => {
    open(1, 2, 3, 4, 5, 6, 7, 8);
    open(1); // refresh p1's recency — the old shift() would still evict it
    open(9);
    const ids = useWorkspaceStore.getState().openedProjectIds;
    expect(ids).toContain('p1');
    expect(ids).not.toContain('p2');
    expect(ids).toHaveLength(8);
  });

  it('re-activating an open project does not reorder openedProjectIds', () => {
    open(1, 2, 3);
    open(1);
    expect(useWorkspaceStore.getState().openedProjectIds).toEqual([
      'p1',
      'p2',
      'p3',
    ]);
  });

  it('skips projects pinned in a dock column and evicts the next-oldest', () => {
    open(1, 2, 3, 4, 5, 6, 7, 8);
    // p1 is the oldest, but a dock column keeps it visible.
    useCliTabsStore.setState({
      columns: [{ id: 'col-0', pin: { projectId: 'p1', tabId: 't1' } }],
    });
    open(9);
    const ids = useWorkspaceStore.getState().openedProjectIds;
    expect(ids).toContain('p1');
    expect(ids).not.toContain('p2');
  });

  it('announces eviction via a devspace:resource-toast window event naming the project', () => {
    // Eviction is the only teardown without a confirm dialog — the store
    // must at least dispatch a toast event so the user learns why a
    // project vanished. Stub a dispatch-capable window for this test.
    const dispatchEvent = vi.fn();
    (globalThis as { window?: unknown }).window = { dispatchEvent };
    open(1, 2, 3, 4, 5, 6, 7, 8);
    expect(dispatchEvent).not.toHaveBeenCalled(); // under the cap: silent
    open(9); // evicts p1 (least recently activated)
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    const ev = dispatchEvent.mock.calls[0]![0] as CustomEvent<{
      message: string;
    }>;
    expect(ev.type).toBe('devspace:resource-toast');
    expect(ev.detail.message).toBe('Closed p1 — project limit (8) reached');
  });
});

describe('workspace store — sidebar/tab sync actions', () => {
  const projA = {
    id: 'a',
    name: 'projA',
    path: '/Users/x/Code/projA',
    workspaceId: 'ws',
    vcs: 'git' as const,
    detectedRuntime: [],
  };
  const projB = {
    id: 'b',
    name: 'projB',
    path: '/Users/x/Code/projB',
    workspaceId: 'ws',
    vcs: 'git' as const,
    detectedRuntime: [],
  };

  beforeEach(() => {
    __resetProjectMruForTests();
    useWorkspaceStore.setState({
      active: { id: 'ws', name: 'ws', path: '/Users/x/Code', lastOpened: 0 },
      projects: [projA, projB],
      activeProjectId: 'a',
      openedProjectIds: ['a'],
    });
    useEditorStore.setState({
      tabs: [],
      activeTabPath: null,
      splitTabs: [],
      splitActivePath: null,
    });
  });

  const editorTab = (path: string) => ({
    path,
    name: path.split('/').pop() ?? path,
    kind: 'text' as const,
    content: '',
    savedContent: '',
    loading: false,
  });

  it('followTab switches the active project to the tab owner and records MRU', () => {
    const bTab = '/Users/x/Code/projB/src/index.ts';
    useEditorStore.setState({
      tabs: [editorTab(bTab)],
      activeTabPath: bTab,
    });
    useWorkspaceStore.getState().followTab(bTab);
    expect(useWorkspaceStore.getState().activeProjectId).toBe('b');
    // MRU recorded: activating b later restores this tab.
    useEditorStore.setState({ activeTabPath: null });
    useWorkspaceStore.getState().activateProject('b');
    expect(useEditorStore.getState().activeTabPath).toBe(bTab);
  });

  it('followTab on a same-project tab updates MRU without a project switch', () => {
    const a1 = '/Users/x/Code/projA/one.ts';
    const a2 = '/Users/x/Code/projA/two.ts';
    useEditorStore.setState({
      tabs: [editorTab(a1), editorTab(a2)],
      activeTabPath: a2,
    });
    useWorkspaceStore.getState().followTab(a2);
    expect(useWorkspaceStore.getState().activeProjectId).toBe('a');
    useEditorStore.setState({ activeTabPath: a1 });
    useWorkspaceStore.getState().activateProject('a');
    expect(useEditorStore.getState().activeTabPath).toBe(a2);
  });

  it('followTab is a no-op for unattributable tabs', () => {
    useWorkspaceStore.getState().followTab('/Users/x/Other/file.ts');
    expect(useWorkspaceStore.getState().activeProjectId).toBe('a');
  });

  // Nested/monorepo layout: the workspace root is a project AND a sub-folder is
  // its own detected project. The FileTree is always rooted at the active
  // project, so clicking a file under the nested sub-project must NOT yank the
  // active project into the child and dock a CLI chip for it. The distinction
  // is gesture origin (markTreeOpen), not path topology — see lastTreeOpenPath.
  const parent = {
    id: 'p',
    name: 'mono',
    path: '/Users/x/Code/mono',
    workspaceId: 'ws',
    vcs: 'git' as const,
    detectedRuntime: [],
  };
  const child = {
    id: 'c',
    name: 'child',
    path: '/Users/x/Code/mono/packages/child',
    workspaceId: 'ws',
    vcs: 'git' as const,
    detectedRuntime: [],
  };
  const childFile = '/Users/x/Code/mono/packages/child/index.ts';

  it('followTab from a FileTree click never switches into a nested sub-project', () => {
    useWorkspaceStore.setState({
      projects: [parent, child],
      activeProjectId: 'p',
      openedProjectIds: ['p'],
    });
    // FileTree click on a file that longest-prefix-attributes to the nested
    // child: tagged via markTreeOpen → stays on the parent, no dock.
    markTreeOpen(childFile);
    useWorkspaceStore.getState().followTab(childFile);
    expect(useWorkspaceStore.getState().activeProjectId).toBe('p');
  });

  it('followTab from a non-tree gesture still follows into a nested sub-project', () => {
    useWorkspaceStore.setState({
      projects: [parent, child],
      activeProjectId: 'p',
      openedProjectIds: ['p'],
    });
    // No markTreeOpen → a genuine editor-tab click / Quick Open on the same
    // child file still moves the sidebar+dock to the child (shipped follow).
    useWorkspaceStore.getState().followTab(childFile);
    expect(useWorkspaceStore.getState().activeProjectId).toBe('c');
  });

  it('a real project switch clears the in-tree browse context', () => {
    useWorkspaceStore.setState({
      projects: [parent, child],
      activeProjectId: 'p',
      openedProjectIds: ['p'],
    });
    // Browse a child file from the tree (suppressed, stays on parent)…
    markTreeOpen(childFile);
    useWorkspaceStore.getState().followTab(childFile);
    expect(useWorkspaceStore.getState().activeProjectId).toBe('p');
    // …then a non-tree gesture on a parent file clears the browse context…
    useWorkspaceStore.getState().followTab('/Users/x/Code/mono/readme.md');
    expect(useWorkspaceStore.getState().activeProjectId).toBe('p');
    // …so a subsequent genuine tab click on the child file now follows.
    useWorkspaceStore.getState().followTab(childFile);
    expect(useWorkspaceStore.getState().activeProjectId).toBe('c');
  });

  it('activateProject falls back to the last-opened owned tab when MRU is gone', () => {
    const b1 = '/Users/x/Code/projB/b1.ts';
    useEditorStore.setState({
      tabs: [editorTab('/Users/x/Code/projA/a.ts'), editorTab(b1)],
      activeTabPath: '/Users/x/Code/projA/a.ts',
    });
    useWorkspaceStore.getState().activateProject('b');
    expect(useWorkspaceStore.getState().activeProjectId).toBe('b');
    expect(useEditorStore.getState().activeTabPath).toBe(b1);
  });

  it('activateProject leaves the editor untouched when the project owns no tabs', () => {
    const aTab = '/Users/x/Code/projA/a.ts';
    useEditorStore.setState({
      tabs: [editorTab(aTab)],
      activeTabPath: aTab,
    });
    useWorkspaceStore.getState().activateProject('b');
    expect(useWorkspaceStore.getState().activeProjectId).toBe('b');
    // No b-owned tab → keep showing the current tab; the edge-triggered
    // follow effect must NOT revert the sidebar back to a.
    expect(useEditorStore.getState().activeTabPath).toBe(aTab);
  });

  it('plain setActiveProject never moves the editor (background mirrors stay hands-off)', () => {
    const aTab = '/Users/x/Code/projA/a.ts';
    const bTab = '/Users/x/Code/projB/b.ts';
    useEditorStore.setState({
      tabs: [editorTab(aTab), editorTab(bTab)],
      activeTabPath: aTab,
    });
    useWorkspaceStore.getState().followTab(bTab); // MRU[b] = bTab
    useWorkspaceStore.getState().setActiveProject('a');
    useWorkspaceStore.getState().setActiveProject('b');
    // Even though MRU[b] exists, the plain mirror must not steal the tab.
    expect(useEditorStore.getState().activeTabPath).toBe(aTab);
  });

  it('activateProject leaves the editor alone when the MRU tab is visible in the split pane', () => {
    const aTab = '/Users/x/Code/projA/a.ts';
    const bMru = '/Users/x/Code/projB/b-mru.ts';
    const bOld = '/Users/x/Code/projB/b-old.ts';
    useEditorStore.setState({
      tabs: [editorTab(aTab), editorTab(bOld), editorTab(bMru)],
      activeTabPath: bMru,
    });
    useWorkspaceStore.getState().followTab(bMru); // MRU[b] = bMru
    // Move the MRU tab to the split pane (drag-to-split).
    useEditorStore.setState({
      tabs: [editorTab(aTab), editorTab(bOld)],
      activeTabPath: aTab,
      splitTabs: [editorTab(bMru)],
      splitActivePath: bMru,
    });
    useWorkspaceStore.getState().activateProject('b');
    // bMru is already visible on the right — activating bOld on the left
    // would cover the user's newest tab with an older one.
    expect(useEditorStore.getState().activeTabPath).toBe(aTab);
  });

  it('closeProject closes diff:/html-preview: tabs of the project too', () => {
    (globalThis as { window?: unknown }).window = {};
    try {
      const file = '/Users/x/Code/projA/src/a.ts';
      const diff = 'diff:/Users/x/Code/projA/src/a.ts';
      const preview = 'html-preview:/Users/x/Code/projA/.devspace/preview/p.html';
      const bTab = '/Users/x/Code/projB/b.ts';
      useEditorStore.setState({
        tabs: [editorTab(file), editorTab(diff), editorTab(preview), editorTab(bTab)],
        activeTabPath: file,
      });
      useWorkspaceStore.setState({ openedProjectIds: ['a', 'b'] });
      useWorkspaceStore.getState().closeProject('a');
      const remaining = useEditorStore.getState().tabs.map((t) => t.path);
      // The previous inline predicate missed diff:/html-preview: keys — a
      // surviving tab would fire followTab and re-dock the closed project.
      expect(remaining).toEqual([bTab]);
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  it('followTab on a split-pane-owned tab switches the sidebar without touching the left pane', () => {
    // EditorTabs now calls followTab for BOTH panes — clicking a right-pane
    // tab must move the sidebar to that tab's project, and because followTab
    // never touches the editor (and activateProject short-circuits on a
    // split-visible MRU), the left pane keeps its tab.
    const aTab = '/Users/x/Code/projA/a.ts';
    const bSplit = '/Users/x/Code/projB/split.ts';
    useEditorStore.setState({
      tabs: [editorTab(aTab)],
      activeTabPath: aTab,
      splitTabs: [editorTab(bSplit)],
      splitActivePath: bSplit,
    });
    useWorkspaceStore.getState().followTab(bSplit);
    expect(useWorkspaceStore.getState().activeProjectId).toBe('b');
    expect(useEditorStore.getState().activeTabPath).toBe(aTab);
    // MRU recorded: a later explicit activation of b also leaves the left
    // pane alone, since the MRU tab is already visible on the right.
    useWorkspaceStore.getState().activateProject('b');
    expect(useEditorStore.getState().activeTabPath).toBe(aTab);
  });

  it('tab-click flow does not steal the clicked tab', () => {
    const b1 = '/Users/x/Code/projB/b1.ts';
    const b2 = '/Users/x/Code/projB/b2.ts';
    useEditorStore.setState({
      tabs: [editorTab(b1), editorTab(b2)],
      activeTabPath: b1,
    });
    useWorkspaceStore.getState().followTab(b1); // older MRU
    useEditorStore.setState({ activeTabPath: b2 });
    // User clicks b2 → followTab must record b2 BEFORE any MRU pick runs.
    useWorkspaceStore.getState().followTab(b2);
    useWorkspaceStore.getState().activateProject('b');
    expect(useEditorStore.getState().activeTabPath).toBe(b2);
  });
});
