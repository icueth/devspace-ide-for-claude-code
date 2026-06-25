import { describe, expect, it } from 'vitest';

import { useSidebarStore } from '../sidebar';

describe('sidebar mode', () => {
  it('toggles between projects and tasks', () => {
    useSidebarStore.setState({ mode: 'projects' });
    useSidebarStore.getState().setMode('tasks');
    expect(useSidebarStore.getState().mode).toBe('tasks');
    useSidebarStore.getState().setMode('projects');
    expect(useSidebarStore.getState().mode).toBe('projects');
  });
});
