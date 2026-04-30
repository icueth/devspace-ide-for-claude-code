import { api } from '@renderer/lib/api';
import { useCliTabsStore } from '@renderer/state/cliTabs';
import { useWorkspaceStore } from '@renderer/state/workspace';

/**
 * Send `@<relative-path> ` to the active project's Claude CLI pane so the
 * user can add file context without having to type the path manually. Used
 * by the file-tree and editor-tab context menus.
 *
 * Three things have to be true for the write to actually land in a Claude
 * CLI pane:
 *   1. The project is docked (a CliTab exists in the cliTabs store).
 *   2. A PTY session is running for that tab.
 *   3. The user is sending to the right session id.
 *
 * The previous implementation only checked (3), via `getActiveSessionId`,
 * which returns a synthetic id even when no PTY is running — so right-
 * clicking *before* the user opened the Claude CLI dock silently no-op'd.
 *
 * We now ensure (1) and (2) up front: dockProject() guarantees a tab
 * exists, and `api.pty.create` with `kind: 'claude-cli'` is idempotent
 * (the launcher returns the existing session or spawns a new one). After
 * that returns we know the PTY is alive and we can write into it.
 *
 * Paths outside the active project are sent as-is (absolute). If no
 * project is active we silently no-op — the menu item hides itself in
 * that case.
 */
export async function addFileToClaudeCli(absPath: string): Promise<void> {
  const ws = useWorkspaceStore.getState();
  const projectId = ws.activeProjectId;
  if (!projectId) return;
  const project = ws.projects.find((p) => p.id === projectId);
  if (!project) return;

  // Make sure the project is docked + has at least one CLI tab. Returns
  // the active tab so we can pin the PTY to that exact tabId.
  const tab = useCliTabsStore.getState().dockProject(project);

  // Idempotent — if the PTY already exists the launcher reuses it,
  // otherwise it spawns one and we wait for the session to be ready
  // before sending the write.
  let session;
  try {
    session = await api.pty.create({
      projectId,
      kind: 'claude-cli',
      tabId: tab.id,
      cwd: project.path,
    });
  } catch (err) {
    console.error('[addFileToClaudeCli] failed to ensure PTY:', err);
    return;
  }

  const root = project.path.replace(/\/$/, '');
  const relPath =
    absPath === root
      ? '.'
      : absPath.startsWith(`${root}/`)
        ? absPath.slice(root.length + 1)
        : absPath;

  void api.pty.write(session.sessionId, `@${relPath} `);
}
