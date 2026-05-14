import { create } from 'zustand';

// localStorage keys for collapse state. Kept as two separate keys (rather
// than a single JSON blob) so the values stay trivially hydratable on the
// initial render and we don't risk a JSON.parse blip blocking the first
// paint.
const LS_KEY_LEFT = 'devspace.sidebar.left.collapsed';
const LS_KEY_RIGHT = 'devspace.sidebar.right.collapsed';

// Tracks whether the user has manually toggled the left sidebar AT LEAST
// once this session. The "auto-collapse on first Design tab when window is
// narrow" rule respects user intent — once they've expressed a preference
// we never override it again for this app boot.
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
  /**
   * Called when entering a Design tab. Auto-collapses the LEFT sidebar
   * the first time this happens IF:
   *   • the user hasn't manually toggled it before this session, AND
   *   • the viewport is narrow (< 1400px)
   * Returns true when the auto-collapse fired so the caller can decide
   * whether to surface a hint. No-op otherwise.
   */
  autoCollapseForDesignIfNarrow: (viewportWidth: number) => boolean;
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
  autoCollapseForDesignIfNarrow(viewportWidth) {
    const s = get();
    if (s.leftUserTouched) return false;
    if (viewportWidth >= 1400) return false;
    if (s.leftCollapsed) return false;
    // v0.14 code-review MED-4: DO NOT persist the auto-collapse. If we
    // wrote `LS_KEY_LEFT='1'` without `LS_KEY_LEFT_TOUCHED=true`, the
    // next boot would read `leftCollapsed=true, leftUserTouched=false`
    // and the auto-collapse check above would short-circuit on
    // `s.leftCollapsed` — sidebar stays sticky-collapsed across reboots
    // even on a wide monitor, with no user gesture to explain it.
    // Keeping the change in-memory only means a fresh boot on a wide
    // screen gets the default expanded sidebar back.
    set({ leftCollapsed: true });
    return true;
  },
}));
