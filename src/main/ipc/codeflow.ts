import { ipcMain } from 'electron';

import { assertInWorkspace } from '@main/utils/pathScope';
// Functions view is powered by the bundled graphify binary (graphify→
// CodeflowFunctionGraph adapter); query/path/explain run one-shot against the
// cached graph.json.
import {
  buildFunctionGraph,
  query as graphifyQuery,
  type GraphifyQueryMode,
} from '@main/services/GraphifyDriver';
import { buildGraph } from '@main/services/CodeflowGraphAnalyzer';
import {
  augmentFunctionGraph,
  augmentGraph,
  cancelAugment,
  cancelFunctionAugment,
  clearAugment,
  loadAugment,
  loadFunctionAugment,
} from '@main/services/CodeflowGraphAugment';
import {
  subscribeGraph,
  unsubscribeGraph,
} from '@main/services/CodeflowGraphLive';
import { IPC } from '@shared/ipc-channels';

export function registerCodeflowIpc(): void {
  ipcMain.handle(IPC.CODEFLOW_BUILD_GRAPH, async (_event, projectPath: string) => {
    const safe = await assertInWorkspace(projectPath);
    return buildGraph(safe);
  });

  ipcMain.handle(
    IPC.CODEFLOW_BUILD_FUNCTION_GRAPH,
    async (_event, projectPath: string) => {
      const safe = await assertInWorkspace(projectPath);
      return buildFunctionGraph(safe);
    },
  );

  ipcMain.handle(
    IPC.CODEFLOW_QUERY,
    async (_event, projectPath: string, mode: string, args: unknown): Promise<string> => {
      const safe = await assertInWorkspace(projectPath);
      // Validate at the boundary: mode is a known verb, args is string[].
      if (mode !== 'query' && mode !== 'path' && mode !== 'explain') {
        throw new Error(`CODEFLOW_QUERY: invalid mode "${mode}"`);
      }
      if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
        throw new Error('CODEFLOW_QUERY: args must be a string array');
      }
      return graphifyQuery(safe, mode as GraphifyQueryMode, args as string[]);
    },
  );

  ipcMain.handle(
    IPC.CODEFLOW_AUGMENT_GRAPH,
    async (event, projectPath: string, graph) => {
      const safe = await assertInWorkspace(projectPath);
      const send = (message: string) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(IPC.CODEFLOW_AUGMENT_PROGRESS, { projectPath: safe, message });
        }
      };
      try {
        const softEdges = await augmentGraph(safe, graph, send);
        return { ok: true as const, softEdges };
      } catch (err) {
        return { ok: false as const, error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(IPC.CODEFLOW_AUGMENT_CANCEL, async (_event, projectPath: string) => {
    const safe = await assertInWorkspace(projectPath);
    cancelAugment(safe);
  });

  ipcMain.handle(
    IPC.CODEFLOW_AUGMENT_LOAD,
    async (_event, projectPath: string, fingerprint: string) => {
      const safe = await assertInWorkspace(projectPath);
      return loadAugment(safe, fingerprint);
    },
  );

  ipcMain.handle(IPC.CODEFLOW_AUGMENT_CLEAR, async (_event, projectPath: string) => {
    const safe = await assertInWorkspace(projectPath);
    await clearAugment(safe);
  });

  ipcMain.handle(
    IPC.CODEFLOW_AUGMENT_FUNCTIONS,
    async (event, projectPath: string, graph) => {
      const safe = await assertInWorkspace(projectPath);
      const send = (message: string) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(IPC.CODEFLOW_AUGMENT_FUNCTIONS_PROGRESS, {
            projectPath: safe,
            message,
          });
        }
      };
      try {
        const softEdges = await augmentFunctionGraph(safe, graph, send);
        return { ok: true as const, softEdges };
      } catch (err) {
        return { ok: false as const, error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    IPC.CODEFLOW_AUGMENT_FUNCTIONS_CANCEL,
    async (_event, projectPath: string) => {
      const safe = await assertInWorkspace(projectPath);
      cancelFunctionAugment(safe);
    },
  );

  ipcMain.handle(
    IPC.CODEFLOW_AUGMENT_FUNCTIONS_LOAD,
    async (_event, projectPath: string, fingerprint: string) => {
      const safe = await assertInWorkspace(projectPath);
      return loadFunctionAugment(safe, fingerprint);
    },
  );

  // Live graph sync. assertInWorkspace confines projectPath to an open
  // workspace root — without it a crafted renderer call could point the
  // persistent rebuild loop (and its full-tree walk) at any filesystem path.
  ipcMain.handle(IPC.CODEFLOW_GRAPH_SUBSCRIBE, async (event, projectPath: string) => {
    const safe = await assertInWorkspace(projectPath);
    return subscribeGraph(safe, event.sender);
  });

  ipcMain.handle(IPC.CODEFLOW_GRAPH_UNSUBSCRIBE, async (event, projectPath: string) => {
    const safe = await assertInWorkspace(projectPath);
    unsubscribeGraph(safe, event.sender);
  });
}
