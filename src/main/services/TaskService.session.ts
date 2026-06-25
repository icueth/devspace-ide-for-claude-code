import { launchClaudeCli } from '@main/services/ClaudeCliLauncher';
import { killClaudeCliSessionTree } from '@main/services/PtyPool';

// sessionKey is `<projectId>:claude-cli:<tabId>` (see TaskService). For a task,
// projectId = task.id and tabId = 'agent', so the detail pane —
// ClaudeCliPane(projectId=task.id, tabId='agent') — composes the same key and
// ATTACHES (tmux new-session -A) instead of spawning a second session.
function parseSessionKey(sessionKey: string): {
  projectId: string;
  tabId: string;
} {
  const marker = ':claude-cli:';
  const i = sessionKey.indexOf(marker);
  if (i < 0) return { projectId: sessionKey, tabId: 'agent' };
  return {
    projectId: sessionKey.slice(0, i),
    tabId: sessionKey.slice(i + marker.length),
  };
}

// Eager background launch: the agent runs even before the user opens the task
// detail (the "10+ agents in parallel" value). launchClaudeCli reuses an
// existing session if present, so a later pane mount just attaches. The
// worktree cwd must already be pathScope-allowlisted by TaskService.create.
export async function launchClaudeInWorktree(
  sessionKey: string,
  cwd: string,
): Promise<void> {
  const { projectId, tabId } = parseSessionKey(sessionKey);
  await launchClaudeCli({ projectId, tabId, cwd });
}

export async function killWorktreeSession(sessionKey: string): Promise<void> {
  const { projectId, tabId } = parseSessionKey(sessionKey);
  await killClaudeCliSessionTree(projectId, tabId);
}
