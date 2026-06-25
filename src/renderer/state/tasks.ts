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
}

export const useTasksStore = create<TasksState>((set, get) => ({
  tasks: [],
  activeTaskId: null,

  setTasks: (tasks) =>
    set((s) => ({
      tasks,
      // Drop the active selection if a refresh removed that task.
      activeTaskId: tasks.some((t) => t.id === s.activeTaskId)
        ? s.activeTaskId
        : null,
    })),

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
}));

// Live updates pushed from main (TASK_CHANGED).
if (typeof window !== 'undefined' && api?.tasks?.onChanged) {
  api.tasks.onChanged((tasks) => useTasksStore.getState().setTasks(tasks));
}
