// Renderer helper that appends a file reference (`@<rel> `) to the active
// project's main chat input. Mirrors `addFileToClaudeCli` in shape but
// targets the ChatPanel surface instead of the raw CLI PTY.
//
// Why a bridge instead of writing the input directly? ChatPanel owns the
// composer state (input string + textarea ref + thread bookkeeping). Going
// through the existing chatBridge means we get focus, scroll-into-view,
// and IME-safe caret handling for free — same path as the Design → Chat
// "Discuss in main chat" flow.
//
// Three preconditions for the append to actually land in the input:
//   1. The project is docked (a CliTab exists). dockProject() handles it.
//   2. The pane is in chat mode, not terminal mode. Default is chat, so
//      this is true for nearly all users. If they switched to terminal,
//      the chat input isn't mounted and the bridge silently no-ops —
//      that's acceptable since the menu item is "Add to Chat" and the
//      user explicitly chose chat as the destination.
//   3. A ChatPanel is subscribed to the bridge. Subscription happens on
//      mount, so this is satisfied as soon as #1 + #2 hold.

import { emitChatPrefill } from '@renderer/lib/chatBridge';
import { useCliTabsStore } from '@renderer/state/cliTabs';
import { useWorkspaceStore } from '@renderer/state/workspace';

export function addFileToChat(absPath: string): void {
  const ws = useWorkspaceStore.getState();
  const projectId = ws.activeProjectId;
  if (!projectId) return;
  const project = ws.projects.find((p) => p.id === projectId);
  if (!project) return;

  // Ensure the project has a chat dock tab open — if not, dockProject
  // creates one. Mirror addFileToClaudeCli's UX so the right-click works
  // even before the user has opened the chat panel.
  useCliTabsStore.getState().dockProject(project);

  // Emit on the bridge. ChatPanel's listener resolves the absolute path
  // against its `projectPath` prop and appends `@<rel> ` to the input.
  emitChatPrefill({
    projectPath: project.path,
    text: '',         // ignored when attachPath is set
    attachPath: absPath,
  });
}
