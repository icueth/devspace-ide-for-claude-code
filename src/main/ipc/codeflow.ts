import { ipcMain, shell } from 'electron';
import * as path from 'node:path';

import { assertInWorkspace } from '@main/utils/pathScope';
import { buildFunctionGraph } from '@main/services/CodeflowFunctionAnalyzer';
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
  analyzeProject,
  cancelAnalyze,
  codeflowDirFor,
  getStatus,
  listProjectDocs,
  readDoc,
  subscribeStatus,
  unsubscribeStatus,
} from '@main/services/CodeflowService';
import {
  subscribeGraph,
  unsubscribeGraph,
} from '@main/services/CodeflowGraphLive';
import { IPC } from '@shared/ipc-channels';
import { createLogger } from '@shared/logger';
import type { CodeflowAnalyzeOptions, CodeflowStatus } from '@shared/types';

const logger = createLogger('IPC:codeflow');

export function registerCodeflowIpc(): void {
  ipcMain.handle(
    IPC.CODEFLOW_GET_STATUS,
    async (event, projectPath: string): Promise<CodeflowStatus> => {
      const safe = await assertInWorkspace(projectPath);
      // Subscribe the requesting webContents so we can stream progress
      // events back. Subscription is cleaned up on destroy or on the matching
      // unsubscribe call. Multiple subscriptions for the same webContents are
      // de-duplicated by the underlying Set.
      subscribeStatus(safe, event.sender);
      return getStatus(safe);
    },
  );

  ipcMain.handle(
    IPC.CODEFLOW_ANALYZE,
    async (event, projectPath: string, opts?: CodeflowAnalyzeOptions) => {
      const safe = await assertInWorkspace(projectPath);
      // Re-subscribe defensively in case the renderer skipped status fetch.
      subscribeStatus(safe, event.sender);
      try {
        await analyzeProject(safe, opts ?? {});
      } catch (err) {
        logger.error('analyze failed:', (err as Error).message);
        // Service writes the error into status; nothing more to do here. We
        // still resolve the IPC call so the renderer doesn't see a rejection
        // on top of the error status it'll receive via the progress channel.
      }
    },
  );

  ipcMain.handle(IPC.CODEFLOW_CANCEL, async (_event, projectPath: string) => {
    const safe = await assertInWorkspace(projectPath);
    await cancelAnalyze(safe);
  });

  ipcMain.handle(IPC.CODEFLOW_READ_DOC, async (_event, absPath: string) => {
    const safe = await assertInWorkspace(absPath);
    // Codeflow docs only ever live under <project>/.claude/codeflow/.
    // Reject anything else even if it's inside the workspace, to keep this
    // channel from being a generic file-read primitive.
    const parts = safe.split(path.sep);
    if (!parts.includes('.claude') || !parts.includes('codeflow')) {
      throw new Error('CODEFLOW_READ_DOC: path outside .claude/codeflow/');
    }
    return readDoc(safe);
  });

  ipcMain.handle(IPC.CODEFLOW_LIST_DOCS, async (_event, projectPath: string) => {
    const safe = await assertInWorkspace(projectPath);
    return listProjectDocs(safe);
  });

  ipcMain.handle(IPC.CODEFLOW_OPEN_DIR, async (_event, projectPath: string) => {
    const safe = await assertInWorkspace(projectPath);
    const dir = codeflowDirFor(safe);
    await shell.openPath(dir);
  });

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
    IPC.CODEFLOW_AUGMENT_GRAPH,
    async (event, projectPath: string, graph) => {
      const safe = await assertInWorkspace(projectPath);
      // Stream "Reading…" / "Grep…" beats so the UI can show what Claude is
      // doing rather than a silent spinner. Channel-per-project keeps multi-
      // window setups from cross-talking.
      const send = (message: string) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(IPC.CODEFLOW_AUGMENT_PROGRESS, {
            projectPath: safe,
            message,
          });
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

  // v0.33 live graph sync. assertInWorkspace confines projectPath to an open
  // workspace root — without it a crafted renderer call could point the
  // persistent rebuild loop (and its full-tree walk) at any filesystem path.
  ipcMain.handle(
    IPC.CODEFLOW_GRAPH_SUBSCRIBE,
    async (event, projectPath: string) => {
      const safe = await assertInWorkspace(projectPath);
      return subscribeGraph(safe, event.sender);
    },
  );

  ipcMain.handle(
    IPC.CODEFLOW_GRAPH_UNSUBSCRIBE,
    async (event, projectPath: string) => {
      const safe = await assertInWorkspace(projectPath);
      unsubscribeGraph(safe, event.sender);
    },
  );
}

// Allow the FS IPC layer to forward watcher events here without importing
// CodeflowService directly (which would risk a cycle). The subscribe/unsubscribe
// API is exported by the service.
export { subscribeStatus, unsubscribeStatus };
