import { create } from 'zustand';

import { api } from '@renderer/lib/api';
import type { Task } from '@shared/types';

interface TasksState {
  tasks: Task[];
  activeTaskId: string | null;
  setTasks: (tasks: Task[]) => void;
  setActiveTask: (id: string | null) => void;
  refresh: () => Promise<void>;
  create: (opts: {
    title: string;
    sourceRepoPath: string;
    agent: string;
  }) => Promise<void>;
  merge: (id: string) => Promise<void>;
  createPr: (
    id: string,
  ) => Promise<{ ok: boolean; url?: string; error?: string }>;
  discard: (id: string) => Promise<void>;
  dismiss: (id: string) => Promise<void>;
}

function dispatchToast(message: string): void {
  try {
    window.dispatchEvent(
      new CustomEvent('devspace:resource-toast', { detail: { message } }),
    );
  } catch {
    /* no DOM window (tests) — skip */
  }
}

// In-app toast on meaningful task status edges. Renderer-only: the store can't
// import React, so it dispatches the same window CustomEvent the
// ResourceToastHost already listens for. Compared against the PREVIOUS list so
// each fires once — and never on first load (no prior entry) or on a repeat
// push of the same status.
function announceTaskTransitions(prev: Task[], next: Task[]): void {
  const before = new Map(prev.map((t) => [t.id, t.status]));
  for (const t of next) {
    const was = before.get(t.id);
    if (!was || was === t.status) continue;
    if (t.status === 'awaiting-review') {
      dispatchToast(`“${t.title}” — changes ready for review`);
    } else if (t.status === 'done') {
      dispatchToast(`“${t.title}” — merged into ${t.baseBranch}`);
    }
  }
}

export const useTasksStore = create<TasksState>((set, get) => ({
  tasks: [],
  activeTaskId: null,

  setTasks: (tasks) =>
    set((s) => {
      announceTaskTransitions(s.tasks, tasks);
      return {
        tasks,
        // Drop the active selection if a refresh removed that task.
        activeTaskId: tasks.some((t) => t.id === s.activeTaskId)
          ? s.activeTaskId
          : null,
      };
    }),

  setActiveTask: (id) => set({ activeTaskId: id }),

  refresh: async () => get().setTasks(await api.tasks.list()),

  create: async (opts) => {
    const t = await api.tasks.create(opts);
    set((s) => ({ tasks: [...s.tasks, t], activeTaskId: t.id }));
  },

  merge: async (id) => {
    await api.tasks.merge(id);
    await get().refresh();
  },

  createPr: (id) => api.tasks.createPr(id),

  discard: async (id) => {
    await api.tasks.discard(id);
    await get().refresh();
  },

  dismiss: async (id) => {
    await api.tasks.dismiss(id);
    await get().refresh();
  },
}));

// Live updates pushed from main (TASK_CHANGED).
if (typeof window !== 'undefined' && api?.tasks?.onChanged) {
  api.tasks.onChanged((tasks) => useTasksStore.getState().setTasks(tasks));
}
