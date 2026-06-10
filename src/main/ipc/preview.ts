import { ipcMain } from 'electron';
import * as path from 'node:path';

import { list, readHtml, subscribe, unsubscribe } from '@main/services/PreviewService';
import { assertInWorkspace } from '@main/utils/pathScope';
import { IPC } from '@shared/ipc-channels';
import type { PreviewFileInfo } from '@shared/preview';

// All handlers validate `projectPath` before touching the service. The
// renderer sits across an IPC boundary — even though it's "ours", the
// boundary is the only place to enforce policy. Mirrors the
// `assertProjectPath` guard in ipc/devserver.ts.
function assertProjectPath(value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error('projectPath is required');
  }
  if (!path.isAbsolute(value)) {
    throw new Error('projectPath must be absolute');
  }
  if (value.split(/[\\/]/).some((seg) => seg === '..')) {
    throw new Error('projectPath must not contain ..');
  }
  return path.resolve(value);
}

export function registerPreviewIpc(): void {
  ipcMain.handle(
    IPC.PREVIEW_LIST,
    async (_event, projectPath: string): Promise<PreviewFileInfo[]> =>
      list(await assertInWorkspace(assertProjectPath(projectPath))),
  );

  ipcMain.handle(
    IPC.PREVIEW_READ_HTML,
    async (_event, projectPath: string, htmlPath: string): Promise<string> =>
      // Containment (htmlPath ⊆ <project>/.devspace/preview/), symlink and
      // size guards all live in the service — keep that the single source of
      // truth so internal callers get the same protection. The project root
      // itself is confined to an open workspace (matches fs.ts/codeflow.ts).
      readHtml(await assertInWorkspace(assertProjectPath(projectPath)), htmlPath),
  );

  ipcMain.handle(IPC.PREVIEW_SUBSCRIBE, async (event, projectPath: string) => {
    // Subscribe the requesting webContents so add/change/unlink events for
    // this project's preview dir stream back to it. Idempotent per
    // (project, sender) inside the service.
    subscribe(await assertInWorkspace(assertProjectPath(projectPath)), event.sender);
  });

  ipcMain.handle(IPC.PREVIEW_UNSUBSCRIBE, async (event, projectPath: string) => {
    // Same path-scoping as PREVIEW_SUBSCRIBE — only workspace projects can
    // hold a watcher, so only they can be unsubscribed. Idempotent no-op
    // when no watcher exists (e.g. the subscribe was skipped because the
    // project has no .devspace dir, or WORKSPACE_CLOSE already tore it
    // down via closeWatchersForProject).
    unsubscribe(await assertInWorkspace(assertProjectPath(projectPath)), event.sender);
  });
}
