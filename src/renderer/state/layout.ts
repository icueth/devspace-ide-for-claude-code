import { create } from 'zustand';

const LS_KEY = 'devspace:layout:v2';

// Team UI modes:
//   off   — Agents rail hidden, normal layout
//   team  — Agents rail visible between editor and CLI
//   focus — Agents rail visible; sidebar + editor hidden, CLI full-width
export type TeamMode = 'off' | 'team' | 'focus';

interface LayoutState {
  sidebarWidth: number;
  dockWidth: number;
  bottomHeight: number;
  bottomOpen: boolean;
  dockFull: boolean;
  editorFontSize: number;
  wordWrap: boolean;
  showHiddenFiles: boolean;
  teamMode: TeamMode;
  setSidebarWidth: (w: number) => void;
  setDockWidth: (w: number) => void;
  setBottomHeight: (h: number) => void;
  toggleBottom: () => void;
  setBottomOpen: (open: boolean) => void;
  toggleDockFull: () => void;
  setDockFull: (v: boolean) => void;
  adjustSidebarWidth: (delta: number) => void;
  adjustDockWidth: (delta: number) => void;
  adjustBottomHeight: (delta: number) => void;
  adjustEditorFontSize: (delta: number) => void;
  resetEditorFontSize: () => void;
  toggleWordWrap: () => void;
  toggleShowHidden: () => void;
  setTeamMode: (m: TeamMode) => void;
  cycleTeamMode: () => void;
  persist: () => void;
}

// Dock can now grow all the way to the sidebar — the previous 900px cap
// was arbitrary. Use a very permissive upper bound and let flex do the rest.
const DOCK_MAX = 4096;

function readInitial(): Pick<
  LayoutState,
  | 'sidebarWidth'
  | 'dockWidth'
  | 'bottomHeight'
  | 'bottomOpen'
  | 'dockFull'
  | 'editorFontSize'
  | 'wordWrap'
  | 'showHiddenFiles'
  | 'teamMode'
> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LayoutState>;
      const tm = parsed.teamMode;
      return {
        sidebarWidth: clamp(parsed.sidebarWidth ?? 288, 160, 600),
        dockWidth: clamp(parsed.dockWidth ?? 440, 260, DOCK_MAX),
        bottomHeight: clamp(parsed.bottomHeight ?? 240, 120, 800),
        bottomOpen: parsed.bottomOpen ?? false,
        dockFull: parsed.dockFull ?? false,
        editorFontSize: clamp(parsed.editorFontSize ?? 13, 10, 28),
        wordWrap: parsed.wordWrap ?? false,
        showHiddenFiles: parsed.showHiddenFiles ?? true,
        teamMode: tm === 'team' || tm === 'focus' ? tm : 'off',
      };
    }
  } catch {
    /* ignore */
  }
  return {
    sidebarWidth: 288,
    dockWidth: 440,
    bottomHeight: 240,
    bottomOpen: false,
    dockFull: false,
    editorFontSize: 13,
    wordWrap: false,
    showHiddenFiles: true,
    teamMode: 'off',
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  ...readInitial(),

  setSidebarWidth(w) {
    set({ sidebarWidth: clamp(w, 160, 600) });
  },
  setDockWidth(w) {
    set({ dockWidth: clamp(w, 260, DOCK_MAX) });
  },
  toggleDockFull() {
    set((s) => ({ dockFull: !s.dockFull }));
  },
  setDockFull(v) {
    set({ dockFull: v });
  },
  setBottomHeight(h) {
    set({ bottomHeight: clamp(h, 120, 800) });
  },
  toggleBottom() {
    set((s) => ({ bottomOpen: !s.bottomOpen }));
  },
  setBottomOpen(open) {
    set({ bottomOpen: open });
  },
  adjustSidebarWidth(delta) {
    set((s) => ({ sidebarWidth: clamp(s.sidebarWidth + delta, 160, 600) }));
  },
  adjustDockWidth(delta) {
    set((s) => ({ dockWidth: clamp(s.dockWidth + delta, 260, DOCK_MAX) }));
  },
  adjustBottomHeight(delta) {
    set((s) => ({ bottomHeight: clamp(s.bottomHeight + delta, 120, 800) }));
  },
  adjustEditorFontSize(delta) {
    set((s) => ({ editorFontSize: clamp(s.editorFontSize + delta, 10, 28) }));
  },
  resetEditorFontSize() {
    set({ editorFontSize: 13 });
  },
  toggleWordWrap() {
    set((s) => ({ wordWrap: !s.wordWrap }));
  },
  toggleShowHidden() {
    set((s) => ({ showHiddenFiles: !s.showHiddenFiles }));
  },
  setTeamMode(m) {
    set({ teamMode: m });
    get().persist();
  },
  cycleTeamMode() {
    set((s) => ({
      teamMode: s.teamMode === 'off' ? 'team' : s.teamMode === 'team' ? 'focus' : 'off',
    }));
    get().persist();
  },
  persist() {
    try {
      const {
        sidebarWidth,
        dockWidth,
        bottomHeight,
        bottomOpen,
        dockFull,
        editorFontSize,
        wordWrap,
        showHiddenFiles,
        teamMode,
      } = get();
      localStorage.setItem(
        LS_KEY,
        JSON.stringify({
          sidebarWidth,
          dockWidth,
          bottomHeight,
          bottomOpen,
          dockFull,
          editorFontSize,
          wordWrap,
          showHiddenFiles,
          teamMode,
        }),
      );
    } catch {
      /* ignore */
    }
  },
}));
