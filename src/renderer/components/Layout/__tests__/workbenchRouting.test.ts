import { describe, expect, it } from 'vitest';

import {
  resolveEditorDestination,
  resolveShellDestination,
} from '../workbenchRouting';

describe('workbench routing', () => {
  it('gives Settings priority over every other work surface', () => {
    expect(
      resolveShellDestination({
        current: 'sessions',
        settingsOpen: true,
        dockFull: true,
        sidebarMode: 'projects',
      }),
    ).toBe('settings');
  });

  it('treats a full dock as the Sessions work surface', () => {
    expect(
      resolveShellDestination({
        current: 'workspace',
        settingsOpen: false,
        dockFull: true,
        sidebarMode: 'projects',
      }),
    ).toBe('sessions');
  });

  it('restores the sidebar destination after leaving Settings or Sessions', () => {
    expect(
      resolveShellDestination({
        current: 'settings',
        settingsOpen: false,
        dockFull: false,
        sidebarMode: 'tasks',
      }),
    ).toBe('tasks');
  });

  it('does not overwrite Git with a sidebar synchronization', () => {
    expect(
      resolveShellDestination({
        current: 'git',
        settingsOpen: false,
        dockFull: false,
        sidebarMode: 'projects',
      }),
    ).toBe('git');
  });

  it('follows Codeflow tabs and returns to Workspace for regular tabs', () => {
    expect(resolveEditorDestination('workspace', 'codeflow')).toBe('codeflow');
    expect(resolveEditorDestination('codeflow', 'text')).toBe('workspace');
  });

  it('follows Agent Flows tabs and returns to Workspace when leaving them', () => {
    expect(resolveEditorDestination('workspace', 'flows')).toBe('flows');
    expect(resolveEditorDestination('flows', 'text')).toBe('workspace');
  });

  it('switches directly between the two editor-backed destinations', () => {
    expect(resolveEditorDestination('codeflow', 'flows')).toBe('flows');
    expect(resolveEditorDestination('flows', 'codeflow')).toBe('codeflow');
  });

  it('leaves non-editor destinations alone regardless of the active tab', () => {
    expect(resolveEditorDestination('git', 'text')).toBe('git');
    expect(resolveEditorDestination('sessions', null)).toBe('sessions');
  });
});
