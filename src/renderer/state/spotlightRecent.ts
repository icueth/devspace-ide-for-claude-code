// v0.30.8 — Per-workspace recent-items LRU for the Spotlight palette.
//
// Lives in localStorage so reopening DevSpace surfaces "what I touched last"
// immediately. Capped at 20 items per workspace and scoped to workspace IDs
// (not project IDs) so opening different projects within the same workspace
// keeps a shared recents trail — matching how users actually mentally group
// their work.
//
// Items can be either file paths or command IDs. Stale items (deleted file,
// removed command) are filtered out at resolve time by spotlightProviders'
// `filterRecents`, NOT here — the store stays cheap and write-only.

import { create } from 'zustand';

import type { RecentItem } from '@renderer/components/CommandPalette/spotlightProviders';

const STORAGE_KEY = 'devspace:spotlight:recents:v1';
const PER_WORKSPACE_CAP = 20;

interface PersistedShape {
  // workspaceId → ordered list (most recent first)
  byWorkspace: Record<string, RecentItem[]>;
}

function readDisk(): PersistedShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { byWorkspace: {} };
    const parsed = JSON.parse(raw) as unknown;
    // Defensive validation — corrupted/forged localStorage shouldn't crash
    // the renderer. Fall back to empty rather than throwing.
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('byWorkspace' in parsed) ||
      typeof (parsed as { byWorkspace: unknown }).byWorkspace !== 'object'
    ) {
      return { byWorkspace: {} };
    }
    const byWs = (parsed as PersistedShape).byWorkspace;
    const out: Record<string, RecentItem[]> = {};
    for (const [ws, items] of Object.entries(byWs)) {
      if (!Array.isArray(items)) continue;
      const clean: RecentItem[] = [];
      for (const it of items) {
        if (!it || typeof it !== 'object') continue;
        const kind = (it as { kind?: unknown }).kind;
        const at = (it as { at?: unknown }).at;
        if (typeof at !== 'number') continue;
        if (kind === 'file') {
          const rel = (it as { relPath?: unknown }).relPath;
          if (typeof rel === 'string' && rel.length > 0) {
            clean.push({ kind: 'file', relPath: rel, at });
          }
        } else if (kind === 'command') {
          const cmdId = (it as { commandId?: unknown }).commandId;
          if (typeof cmdId === 'string' && cmdId.length > 0) {
            clean.push({ kind: 'command', commandId: cmdId, at });
          }
        }
      }
      if (clean.length > 0) out[ws] = clean.slice(0, PER_WORKSPACE_CAP);
    }
    return { byWorkspace: out };
  } catch {
    return { byWorkspace: {} };
  }
}

function writeDisk(state: PersistedShape): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota or disabled storage — silently ignore. Recents are nice-to-have,
    // not load-bearing.
  }
}

interface SpotlightRecentStore {
  byWorkspace: Record<string, RecentItem[]>;
  recordFile: (workspaceId: string, relPath: string) => void;
  recordCommand: (workspaceId: string, commandId: string) => void;
  getRecents: (workspaceId: string) => RecentItem[];
  clearWorkspace: (workspaceId: string) => void;
}

// Helper: prepend item, dedupe (same key wins newer), cap.
function bumpToFront(prev: RecentItem[], next: RecentItem): RecentItem[] {
  const filtered = prev.filter((p) => {
    if (p.kind !== next.kind) return true;
    if (p.kind === 'file' && next.kind === 'file') return p.relPath !== next.relPath;
    if (p.kind === 'command' && next.kind === 'command') return p.commandId !== next.commandId;
    return true;
  });
  return [next, ...filtered].slice(0, PER_WORKSPACE_CAP);
}

export const useSpotlightRecentStore = create<SpotlightRecentStore>((set, get) => ({
  byWorkspace: readDisk().byWorkspace,
  recordFile: (workspaceId, relPath) => {
    if (!workspaceId || !relPath) return;
    set((s) => {
      const prev = s.byWorkspace[workspaceId] ?? [];
      const next = bumpToFront(prev, { kind: 'file', relPath, at: Date.now() });
      const updated = { ...s.byWorkspace, [workspaceId]: next };
      writeDisk({ byWorkspace: updated });
      return { byWorkspace: updated };
    });
  },
  recordCommand: (workspaceId, commandId) => {
    if (!workspaceId || !commandId) return;
    set((s) => {
      const prev = s.byWorkspace[workspaceId] ?? [];
      const next = bumpToFront(prev, { kind: 'command', commandId, at: Date.now() });
      const updated = { ...s.byWorkspace, [workspaceId]: next };
      writeDisk({ byWorkspace: updated });
      return { byWorkspace: updated };
    });
  },
  getRecents: (workspaceId) => get().byWorkspace[workspaceId] ?? [],
  clearWorkspace: (workspaceId) => {
    set((s) => {
      if (!s.byWorkspace[workspaceId]) return s;
      const { [workspaceId]: _, ...rest } = s.byWorkspace;
      writeDisk({ byWorkspace: rest });
      return { byWorkspace: rest };
    });
  },
}));

// Exported for testability — the store's bump/cap rules are pure and worth
// pinning independently of localStorage side effects.
export const __test = { bumpToFront, PER_WORKSPACE_CAP };
