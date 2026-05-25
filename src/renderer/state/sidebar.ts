import { create } from 'zustand';

// localStorage keys for collapse state. Kept as two separate keys (rather
// than a single JSON blob) so the values stay trivially hydratable on the
// initial render and we don't risk a JSON.parse blip blocking the first
// paint.
const LS_KEY_LEFT = 'devspace.sidebar.left.collapsed';
const LS_KEY_RIGHT = 'devspace.sidebar.right.collapsed';

// Tracks whether the user has manually toggled the left sidebar AT LEAST
// once this session. Persisted so user intent survives reloads.
const LS_KEY_LEFT_TOUCHED = 'devspace.sidebar.left.userTouched';

function readBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === '1' || raw === 'true') return true;
    if (raw === '0' || raw === 'false') return false;
    return fallback;
  } catch {
    return fallback;
  }
}

function writeBool(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* ignore */
  }
}

interface SidebarState {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  leftUserTouched: boolean;
  toggleLeft: () => void;
  toggleRight: () => void;
  setLeft: (collapsed: boolean) => void;
  setRight: (collapsed: boolean) => void;
}

export const useSidebarStore = create<SidebarState>((set, get) => ({
  leftCollapsed: readBool(LS_KEY_LEFT, false),
  rightCollapsed: readBool(LS_KEY_RIGHT, false),
  leftUserTouched: readBool(LS_KEY_LEFT_TOUCHED, false),

  toggleLeft() {
    set((s) => {
      const next = !s.leftCollapsed;
      writeBool(LS_KEY_LEFT, next);
      writeBool(LS_KEY_LEFT_TOUCHED, true);
      return { leftCollapsed: next, leftUserTouched: true };
    });
  },
  toggleRight() {
    set((s) => {
      const next = !s.rightCollapsed;
      writeBool(LS_KEY_RIGHT, next);
      return { rightCollapsed: next };
    });
  },
  setLeft(collapsed) {
    writeBool(LS_KEY_LEFT, collapsed);
    writeBool(LS_KEY_LEFT_TOUCHED, true);
    set({ leftCollapsed: collapsed, leftUserTouched: true });
  },
  setRight(collapsed) {
    writeBool(LS_KEY_RIGHT, collapsed);
    set({ rightCollapsed: collapsed });
  },
}));
