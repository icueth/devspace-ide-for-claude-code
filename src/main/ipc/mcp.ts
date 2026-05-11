import { ipcMain } from 'electron';

import {
  createMcpServer,
  deleteMcpServer,
  listMcpServers,
  renameMcpServer,
  saveMcpServer,
} from '@main/services/McpService';
import { IPC } from '@shared/ipc-channels';
import type { McpScope, McpServer, McpServerEntry } from '@shared/types';

export function registerMcpIpc(): void {
  ipcMain.handle(IPC.MCP_LIST, (_event, projectPath: string | null) =>
    listMcpServers(projectPath),
  );

  ipcMain.handle(IPC.MCP_SAVE, (_event, entry: McpServerEntry) =>
    saveMcpServer(entry),
  );

  ipcMain.handle(
    IPC.MCP_RENAME,
    (
      _event,
      scope: McpScope,
      filePath: string,
      oldName: string,
      newName: string,
    ) => renameMcpServer(scope, filePath, oldName, newName),
  );

  ipcMain.handle(
    IPC.MCP_DELETE,
    (_event, scope: McpScope, filePath: string, name: string) =>
      deleteMcpServer(scope, filePath, name),
  );

  ipcMain.handle(
    IPC.MCP_CREATE,
    (
      _event,
      scope: McpScope,
      projectPath: string | null,
      name: string,
      server: McpServer,
    ) => createMcpServer(scope, projectPath, name, server),
  );
}
