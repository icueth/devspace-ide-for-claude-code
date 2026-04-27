import { create } from 'zustand';

import { api } from '@renderer/lib/api';
import type { TmuxPane } from '@shared/types';

interface TmuxState {
  panes: TmuxPane[];
  previews: Record<string, string>; // paneId -> last captured output
  lastRefresh: number;
  polling: boolean;
  error: string | null;
  // Session name to scope list-panes to. Set by the rail to the active
  // project's tmux session (e.g. "devspace-cli-<hash>") so we don't pull in
  // panes from every tmux server on the box.
  sessionName: string | null;

  setSessionName: (name: string | null) => void;
  refresh: () => Promise<void>;
  refreshPreview: (paneId: string) => Promise<void>;
  startPolling: (intervalMs?: number) => void;
  stopPolling: () => void;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

export const useTmuxStore = create<TmuxState>((set, get) => ({
  panes: [],
  previews: {},
  lastRefresh: 0,
  polling: false,
  error: null,
  sessionName: null,

  setSessionName(name) {
    set({ sessionName: name });
  },

  async refresh() {
    try {
      const { sessionName } = get();
      const panes = await api.tmux.listPanes(sessionName ?? undefined);
      set({ panes, lastRefresh: Date.now(), error: null });
      // Refresh previews for all panes in parallel (throttled externally by
      // polling interval — so this doesn't hammer tmux every tick).
      await Promise.all(panes.map((p) => get().refreshPreview(p.paneId)));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async refreshPreview(paneId) {
    try {
      const text = await api.tmux.capturePane(paneId, 3);
      set((s) => ({ previews: { ...s.previews, [paneId]: text } }));
    } catch {
      /* ignore capture failures silently — pane may have just exited */
    }
  },

  startPolling(intervalMs = 2500) {
    if (pollTimer) return;
    set({ polling: true });
    void get().refresh();
    pollTimer = setInterval(() => void get().refresh(), intervalMs);
  },

  stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    set({ polling: false });
  },
}));
