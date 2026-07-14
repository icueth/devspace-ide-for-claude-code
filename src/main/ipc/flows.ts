import { BrowserWindow, ipcMain } from 'electron';

import { createFlowService } from '@main/services/FlowService';
import { startFlowControlSocket } from '@main/services/flowControl';
import { assertInWorkspace } from '@main/utils/pathScope';
import type { FlowChangedEvent, FlowGraph } from '@shared/flowTypes';
import { IPC } from '@shared/ipc-channels';

// Agent Flow IPC. Graph CRUD for the canvas + run control; FLOW_CHANGED is the
// single main → renderer push (flow list changed, and/or a run transitioned).
//
// There is deliberately NO run channel: runs start from chat only (the control
// socket / MCP), so the renderer cannot trigger one even by accident.

export function registerFlowsIpc(): void {
  // Every run transition (queued → running → done/failed/…) lands here and is
  // broadcast to all windows, so the canvas overlay follows the engine live.
  const push = (event: FlowChangedEvent): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(IPC.FLOW_CHANGED, event);
    }
  };

  const svc = createFlowService({
    onRunChanged: (run) => push({ projectPath: run.projectPath, run }),
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

  // chat→flow bridge: the socket the bundled MCP server relays run_flow /
  // flow_status / send_flow / stop_flow through. `onMutate` is a no-op because
  // every run transition already reaches the renderer via onRunChanged above,
  // and no socket op mutates the flow LIST in phase 1 (no create/delete op).
  startFlowControlSocket(svc, () => undefined);
}
