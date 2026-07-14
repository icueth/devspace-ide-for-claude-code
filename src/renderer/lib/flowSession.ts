import { useCliTabsStore } from '@renderer/state/cliTabs';
import { useWorkspaceStore } from '@renderer/state/workspace';
import type { FlowRun } from '@shared/flowTypes';
import type { CliId, DockedProjectMeta } from '@shared/types';

/**
 * Dock the live tmux session behind an interactive flow node.
 *
 * The session was spawned by main's FlowService, not by the dock, so nothing
 * in the renderer knows about it. What makes the dock ATTACH (rather than
 * start a second agent) is that main derives the tmux session name from
 * (projectId, tabId, kind): reproduce those three from the node's sessionKey
 * and the pane's `tmux new-session -A` lands on the running session.
 *
 * sessionKey is the PtyPool key: `${projectId}:${kind}:${tabId}`, where
 * kind = `${cliId}-cli` and tabId = `flow-${runId}-${nodeId}`.
 */

const KEY_RE = /^(.+):(claude|opencode|codex|gemini|antigravity)-cli:([^:]+)$/;

export interface ParsedSessionKey {
  projectId: string;
  cliId: CliId;
  tabId: string;
}

export function parseSessionKey(key: string): ParsedSessionKey | null {
  const m = KEY_RE.exec(key);
  if (!m) return null;
  return { projectId: m[1]!, cliId: m[2] as CliId, tabId: m[3]! };
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * Attach the dock to a running flow node's session. Returns false when the
 * key is unparseable (an older run journal, say) — callers keep the button
 * hidden in that case rather than docking an empty pane.
 */
export function openFlowSession(run: FlowRun, sessionKey: string): boolean {
  const parsed = parseSessionKey(sessionKey);
  if (!parsed) return false;

  // Prefer the workspace's own project record (it carries name + workspaceId);
  // fall back to the run's own projectPath so a flow started against a project
  // outside the active workspace still docks.
  const known = useWorkspaceStore
    .getState()
    .projects.find((p) => p.id === parsed.projectId);
  const project: DockedProjectMeta = known
    ? { id: known.id, name: known.name, path: known.path, workspaceId: known.workspaceId }
    : {
        id: parsed.projectId,
        name: basename(run.projectPath),
        path: run.projectPath,
      };

  const node = run.nodes.find((n) => n.sessionKey === sessionKey);
  useCliTabsStore.getState().attachExternalTab(project, {
    tabId: parsed.tabId,
    cliId: parsed.cliId,
    label: node ? `${node.nodeId} · flow` : 'flow',
  });
  return true;
}
