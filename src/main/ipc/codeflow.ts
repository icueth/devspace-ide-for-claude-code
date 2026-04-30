import { ipcMain, shell } from 'electron';

import { buildGraph } from '@main/services/CodeflowGraphAnalyzer';
import {
  augmentGraph,
  cancelAugment,
  clearAugment,
  loadAugment,
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
import { IPC } from '@shared/ipc-channels';
import { createLogger } from '@shared/logger';
import type { CodeflowAnalyzeOptions, CodeflowStatus } from '@shared/types';

const logger = createLogger('IPC:codeflow');

export function registerCodeflowIpc(): void {
  ipcMain.handle(
    IPC.CODEFLOW_GET_STATUS,
    async (event, projectPath: string): Promise<CodeflowStatus> => {
      // Subscribe the requesting webContents so we can stream progress
      // events back. Subscription is cleaned up on destroy or on the matching
      // unsubscribe call. Multiple subscriptions for the same webContents are
      // de-duplicated by the underlying Set.
      subscribeStatus(projectPath, event.sender);
      return getStatus(projectPath);
    },
  );

  ipcMain.handle(
    IPC.CODEFLOW_ANALYZE,
    async (event, projectPath: string, opts?: CodeflowAnalyzeOptions) => {
      // Re-subscribe defensively in case the renderer skipped status fetch.
      subscribeStatus(projectPath, event.sender);
      try {
        await analyzeProject(projectPath, opts ?? {});
      } catch (err) {
        logger.error('analyze failed:', (err as Error).message);
        // Service writes the error into status; nothing more to do here. We
        // still resolve the IPC call so the renderer doesn't see a rejection
        // on top of the error status it'll receive via the progress channel.
      }
    },
  );

  ipcMain.handle(IPC.CODEFLOW_CANCEL, async (_event, projectPath: string) => {
    await cancelAnalyze(projectPath);
  });

  ipcMain.handle(IPC.CODEFLOW_READ_DOC, async (_event, absPath: string) => {
    return readDoc(absPath);
  });

  ipcMain.handle(IPC.CODEFLOW_LIST_DOCS, async (_event, projectPath: string) => {
    return listProjectDocs(projectPath);
  });

  ipcMain.handle(IPC.CODEFLOW_OPEN_DIR, async (_event, projectPath: string) => {
    const dir = codeflowDirFor(projectPath);
    await shell.openPath(dir);
  });

  ipcMain.handle(IPC.CODEFLOW_BUILD_GRAPH, async (_event, projectPath: string) => {
    return buildGraph(projectPath);
  });

  ipcMain.handle(
    IPC.CODEFLOW_AUGMENT_GRAPH,
    async (event, projectPath: string, graph) => {
      // Stream "Reading…" / "Grep…" beats so the UI can show what Claude is
      // doing rather than a silent spinner. Channel-per-project keeps multi-
      // window setups from cross-talking.
      const send = (message: string) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(IPC.CODEFLOW_AUGMENT_PROGRESS, {
            projectPath,
            message,
          });
        }
      };
      try {
        const softEdges = await augmentGraph(projectPath, graph, send);
        return { ok: true as const, softEdges };
      } catch (err) {
        return { ok: false as const, error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(IPC.CODEFLOW_AUGMENT_CANCEL, async (_event, projectPath: string) => {
    cancelAugment(projectPath);
  });

  ipcMain.handle(
    IPC.CODEFLOW_AUGMENT_LOAD,
    async (_event, projectPath: string, fingerprint: string) => {
      return loadAugment(projectPath, fingerprint);
    },
  );

  ipcMain.handle(IPC.CODEFLOW_AUGMENT_CLEAR, async (_event, projectPath: string) => {
    await clearAugment(projectPath);
  });
}

// Allow the FS IPC layer to forward watcher events here without importing
// CodeflowService directly (which would risk a cycle). The subscribe/unsubscribe
// API is exported by the service.
export { subscribeStatus, unsubscribeStatus };
