import { beforeEach, describe, expect, it } from 'vitest';

import { useTasksStore } from '../tasks';
import type { Task } from '@shared/types';

const task = (id: string): Task => ({
  id,
  title: id,
  sourceRepoPath: '/r',
  baseBranch: 'main',
  branch: `devspace/task/${id}`,
  worktreePath: `/w/${id}`,
  agent: 'claude',
  status: 'running',
  sessionKey: `${id}:claude-cli:agent`,
  createdAt: 1,
});

beforeEach(() => useTasksStore.setState({ tasks: [], activeTaskId: null }));

describe('tasks store', () => {
  it('setTasks replaces the list', () => {
    useTasksStore.getState().setTasks([task('a')]);
    expect(useTasksStore.getState().tasks).toHaveLength(1);
  });

  it('setTasks clears activeTaskId when that task is gone after a refresh', () => {
    useTasksStore.setState({ tasks: [task('a')], activeTaskId: 'a' });
    useTasksStore.getState().setTasks([task('b')]);
    expect(useTasksStore.getState().activeTaskId).toBeNull();
  });

  it('setTasks keeps activeTaskId when that task survives', () => {
    useTasksStore.setState({ tasks: [task('a')], activeTaskId: 'a' });
    useTasksStore.getState().setTasks([task('a'), task('b')]);
    expect(useTasksStore.getState().activeTaskId).toBe('a');
  });
});
