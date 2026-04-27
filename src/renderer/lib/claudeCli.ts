import { api } from '@renderer/lib/api';
import { useCliTabsStore } from '@renderer/state/cliTabs';
import { useWorkspaceStore } from '@renderer/state/workspace';

/**
 * Send `@<relative-path> ` to the active project's Claude CLI pane so the
 * user can add file context without having to type the path manually. Used
 * by the file-tree and editor-tab context menus.
 *
 * Paths outside the active project are sent as-is (absolute). If no project
 * is active we silently no-op — the menu item hides itself in that case.
 */
export function addFileToClaudeCli(absPath: string): void {
  const ws = useWorkspaceStore.getState();
  const projectId = ws.activeProjectId;
  if (!projectId) return;
  const project = ws.projects.find((p) => p.id === projectId);
  if (!project) return;

  const sessionId = useCliTabsStore.getState().getActiveSessionId(projectId);
  if (!sessionId) return;

  const root = project.path.replace(/\/$/, '');
  const relPath =
    absPath === root
      ? '.'
      : absPath.startsWith(`${root}/`)
        ? absPath.slice(root.length + 1)
        : absPath;

  void api.pty.write(sessionId, `@${relPath} `);
}
