import { BrowserWindow, ipcMain } from 'electron';

import { createFlowChatService } from '@main/services/FlowChatService';
import { createFlowService } from '@main/services/FlowService';
import { startFlowControlSocket } from '@main/services/flowControl';
import { assertInWorkspace } from '@main/utils/pathScope';
import type { FlowChangedEvent, FlowChatEvent, FlowGraph } from '@shared/flowTypes';
import { IPC } from '@shared/ipc-channels';

// Agent Flow IPC. Graph CRUD for the canvas + run control; FLOW_CHANGED is the
// single main → renderer push (flow list changed, and/or a run transitioned).
//
// There is deliberately NO run channel: runs start from chat only (the control
// socket / MCP), so the renderer cannot trigger one even by accident — the chat
// below (FLOW_CHAT_*) is that chat, and it reaches the engine the same way any
// other claude does: through the flow-control socket's MCP tools.

// A broadcast, not a reply: a chat turn outlives its invoke (send returns as
// soon as the message is queued), and a second window must see the same
// conversation. Same reason FLOW_CHANGED is a push.
function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

export function registerFlowsIpc(): void {
  // Every run transition (queued → running → done/failed/…) lands here and is
  // broadcast to all windows, so the canvas overlay follows the engine live.
  const push = (event: FlowChangedEvent): void => {
    broadcast(IPC.FLOW_CHANGED, event);
  };

  const svc = createFlowService({
    onRunChanged: (run) => push({ projectPath: run.projectPath, run }),
  });

  const chat = createFlowChatService({
    onEvent: (event: FlowChatEvent) => broadcast(IPC.FLOW_CHAT_EVENT, event),
  });

  // Re-read the flow list from disk and push it — used after every mutation so
  // a second window (or the flow the chat agent just ran) stays in sync.
  const pushFlows = async (projectPath: string): Promise<void> => {
    push({ projectPath, flows: await svc.list(projectPath) });
  };

  ipcMain.handle(IPC.FLOW_LIST, async (_e, projectPath: string) => {
    return svc.list(await assertInWorkspace(projectPath));
  });

  ipcMain.handle(IPC.FLOW_SAVE, async (_e, projectPath: string, graph: FlowGraph) => {
    const dir = await assertInWorkspace(projectPath);
    await svc.save(dir, graph);
    await pushFlows(dir);
  });

  ipcMain.handle(IPC.FLOW_DELETE, async (_e, projectPath: string, id: string) => {
    const dir = await assertInWorkspace(projectPath);
    await svc.remove(dir, id);
    await pushFlows(dir);
  });

  ipcMain.handle(IPC.FLOW_RUNS, async (_e, projectPath: string) => {
    return svc.runs(await assertInWorkspace(projectPath));
  });

  ipcMain.handle(IPC.FLOW_STOP, async (_e, runId: string) => svc.stopRun(runId));

  ipcMain.handle(
    IPC.FLOW_SEND,
    async (_e, runId: string, nodeId: string, text: string) =>
      svc.sendToNode(runId, nodeId, text),
  );

  // ── lead chat (phase 2) ───────────────────────────────────────────────────
  // SEND returns as soon as the user's message is persisted — the lead's reply
  // arrives later as a FLOW_CHAT_EVENT push (one turn in flight per project).
  ipcMain.handle(IPC.FLOW_CHAT_HISTORY, async (_e, projectPath: string) => {
    return chat.history(await assertInWorkspace(projectPath));
  });

  ipcMain.handle(IPC.FLOW_CHAT_SEND, async (_e, projectPath: string, text: string) => {
    return chat.send(await assertInWorkspace(projectPath), text);
  });

  ipcMain.handle(IPC.FLOW_CHAT_CLEAR, async (_e, projectPath: string) => {
    const dir = await assertInWorkspace(projectPath);
    await chat.clear(dir);
    broadcast(IPC.FLOW_CHAT_EVENT, { projectPath: dir } satisfies FlowChatEvent);
  });

  // chat→flow bridge: the socket the bundled MCP server relays run_flow /
  // flow_status / send_flow / stop_flow through. `onMutate` is a no-op because
  // every run transition already reaches the renderer via onRunChanged above,
  // and no socket op mutates the flow LIST in phase 1 (no create/delete op).
  startFlowControlSocket(svc, () => undefined);
}
