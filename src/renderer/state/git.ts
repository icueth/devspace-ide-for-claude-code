import { create } from 'zustand';

import { api } from '@renderer/lib/api';
import type { GitSnapshot } from '@shared/types';

interface GitState {
  byProject: Record<string, GitSnapshot | undefined>;
  loading: Record<string, boolean>;
  error: Record<string, string | undefined>;
  _inflight: Record<string, Promise<void> | undefined>;
  _lastRun: Record<string, number | undefined>;

  refresh: (projectId: string, cwd: string, force?: boolean) => Promise<void>;
}

const MIN_GIT_INTERVAL_MS = 400;

export const useGitStore = create<GitState>((set, get) => ({
  byProject: {},
  loading: {},
  error: {},
  _inflight: {},
  _lastRun: {},

  async refresh(projectId, cwd, force = false) {
    // Coalesce concurrent refreshes so rapid events (save → save → refresh)
    // don't pile up simple-git processes.
    const existing = get()._inflight[projectId];
    if (existing) return existing;
    // Time-debounce: skip if a fresh result is under MIN_GIT_INTERVAL_MS old.
    const last = get()._lastRun[projectId] ?? 0;
    if (!force && Date.now() - last < MIN_GIT_INTERVAL_MS) return;

    const task = (async () => {
      set((s) => ({ loading: { ...s.loading, [projectId]: true } }));
      try {
        const snapshot = await api.git.status(cwd);
        set((s) => ({
          byProject: { ...s.byProject, [projectId]: snapshot },
          loading: { ...s.loading, [projectId]: false },
          error: { ...s.error, [projectId]: undefined },
        }));
      } catch (err) {
        set((s) => ({
          loading: { ...s.loading, [projectId]: false },
          error: { ...s.error, [projectId]: (err as Error).message },
        }));
      } finally {
        set((s) => ({
          _inflight: { ...s._inflight, [projectId]: undefined },
          _lastRun: { ...s._lastRun, [projectId]: Date.now() },
        }));
      }
    })();

    set((s) => ({ _inflight: { ...s._inflight, [projectId]: task } }));
    return task;
  },
}));
