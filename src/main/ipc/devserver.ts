import { ipcMain } from 'electron';
import * as path from 'node:path';

import {
  detectDevServer,
  getDevServerStatus,
  installDependencies,
  refreshDevServer,
  startDevServer,
  stopDevServer,
  subscribeDevServerEvents,
  unsubscribeDevServerEvents,
} from '@main/services/DevServerService';
import { IPC } from '@shared/ipc-channels';
import type { DevServerInstallInput, DevServerStartInput } from '@shared/design';

// All IPC handlers validate `projectPath` against this shape before
// touching the service. The renderer is on the other side of an IPC
// boundary — even though it's "ours", the boundary is the only place
// to enforce policy (an XSS in a webview can never call these channels
// directly since the webview has no preload, but a renderer-side bug
// could still drive these with bad input).
function assertProjectPath(value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error('projectPath is required');
  }
  if (!path.isAbsolute(value)) {
    throw new Error('projectPath must be absolute');
  }
  // Reject path traversal segments. `path.resolve` would silently fix
  // them, but if a `..` shows up here it indicates renderer-side
  // confusion (or worse) — fail loud so we notice.
  if (value.split(/[\\/]/).some((seg) => seg === '..')) {
    throw new Error('projectPath must not contain ..');
  }
  return path.resolve(value);
}

export function registerDevServerIpc(): void {
  ipcMain.handle(IPC.DEVSERVER_DETECT, (_event, projectPath: string) => {
    // Detect is a pure read — do NOT auto-subscribe here. The renderer
    // calls SUBSCRIBE explicitly when it wants to start receiving
    // events. Auto-subscribing every read accumulated stale subscribers.
    return detectDevServer(assertProjectPath(projectPath));
  });

  ipcMain.handle(IPC.DEVSERVER_START, (event, input: DevServerStartInput) => {
    if (!input || typeof input !== 'object') {
      throw new Error('DEVSERVER_START requires an input object');
    }
    const safe: DevServerStartInput = {
      ...input,
      projectPath: assertProjectPath(input.projectPath),
    };
    // Starting an action — subscribe the sender so it gets the
    // resulting status_changed / url_resolved stream.
    subscribeDevServerEvents(safe.projectPath, event.sender);
    return startDevServer(safe);
  });

  ipcMain.handle(IPC.DEVSERVER_STOP, (_event, projectPath: string) => {
    return stopDevServer(assertProjectPath(projectPath));
  });

  ipcMain.handle(IPC.DEVSERVER_STATUS, (_event, projectPath: string) => {
    // Status is a pure read — no auto-subscribe.
    return getDevServerStatus(assertProjectPath(projectPath));
  });

  ipcMain.handle(IPC.DEVSERVER_SUBSCRIBE, (event, projectPath: string) => {
    subscribeDevServerEvents(assertProjectPath(projectPath), event.sender);
  });

  ipcMain.handle(IPC.DEVSERVER_UNSUBSCRIBE, (event, projectPath: string) => {
    unsubscribeDevServerEvents(assertProjectPath(projectPath), event.sender);
  });

  ipcMain.handle(IPC.DEVSERVER_REFRESH, (event, projectPath: string) => {
    // Subscribe the sender so the synthesized status_changed reaches the
    // tab that asked to refresh.
    const safe = assertProjectPath(projectPath);
    subscribeDevServerEvents(safe, event.sender);
    return refreshDevServer(safe);
  });

  ipcMain.handle(IPC.DEVSERVER_INSTALL, (event, input: DevServerInstallInput) => {
    if (!input || typeof input !== 'object') {
      throw new Error('DEVSERVER_INSTALL requires an input object');
    }
    const safe: DevServerInstallInput = {
      ...input,
      projectPath: assertProjectPath(input.projectPath),
    };
    // Stream install_progress events back to the renderer that initiated.
    subscribeDevServerEvents(safe.projectPath, event.sender);
    return installDependencies(safe);
  });
}
