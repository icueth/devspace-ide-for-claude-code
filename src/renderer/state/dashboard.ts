import { create } from 'zustand';

// v0.19: Dashboard UI state — ephemeral selection/filter/search state for
// the cross-project memory dashboard. Not persisted: the dashboard is a
// one-shot exploration surface, and re-opening it should default to the
// "Home" view (the most useful entry point) rather than restoring the
// last filter the user happened to leave behind. Search state is also
// reset because a stale search query against a freshly-rebuilt index
// would be misleading.

export type DashboardView = 'home' | 'all' | 'inbox' | 'timeline' | 'settings';

interface DashboardState {
  // Which sidebar selection drives the main panel.
  currentView: DashboardView;
  // When set, filters the All / Timeline views to a single project. The
  // hash is `MemoryProject.hash` (SHA-1 of the project abspath). null =
  // cross-project ("show everything").
  selectedProjectHash: string | null;
  // When set, filters to entries tagged with this tag. Lowercased on
  // store. null = no tag filter.
  selectedTag: string | null;
  // Live search input. Owners of the All view debounce this (250ms) into
  // an `api.memory.search` call. Empty = no search active.
  searchQuery: string;
  // When set, the side-drawer EntryEditor renders on top of the main
  // panel and edits the entry with this id. The synthetic id `new` opens
  // the editor in create mode (caller passes the desired scope/type).
  editingEntryId: string | null;

  setView: (view: DashboardView) => void;
  setProjectFilter: (hash: string | null) => void;
  setTagFilter: (tag: string | null) => void;
  setSearchQuery: (query: string) => void;
  startEditing: (id: string | null) => void;
  // Convenience: jump to a view AND clear the orthogonal filters so the
  // user doesn't end up with a stale project filter overriding a sidebar
  // click. (Used by sidebar's project-row click → "go to All entries
  // filtered by this project".)
  selectProject: (hash: string | null) => void;
  selectTag: (tag: string | null) => void;
}

export const useDashboardStore = create<DashboardState>((set) => ({
  currentView: 'home',
  selectedProjectHash: null,
  selectedTag: null,
  searchQuery: '',
  editingEntryId: null,

  setView: (view) => set({ currentView: view }),
  setProjectFilter: (hash) => set({ selectedProjectHash: hash }),
  setTagFilter: (tag) =>
    set({ selectedTag: tag ? tag.toLowerCase() : null }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  startEditing: (id) => set({ editingEntryId: id }),

  selectProject: (hash) =>
    set({
      currentView: 'all',
      selectedProjectHash: hash,
      // Project + tag filters are AND'd, but for the click-from-sidebar
      // flow we reset the tag — the user almost certainly wants a fresh
      // view of the project, not the previous tag's intersection.
      selectedTag: null,
      editingEntryId: null,
    }),
  selectTag: (tag) =>
    set({
      currentView: 'all',
      selectedTag: tag ? tag.toLowerCase() : null,
      // Tag filters are usually narrower than project filters, so we
      // keep the current project filter intact — clicking a tag inside
      // a project view should narrow further, not jump cross-project.
      editingEntryId: null,
    }),
}));
