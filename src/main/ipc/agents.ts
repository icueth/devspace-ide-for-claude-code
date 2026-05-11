import { ipcMain } from 'electron';

import {
  createAgent,
  deleteAgent,
  listAgents,
  readAgent,
  saveAgent,
} from '@main/services/AgentsService';
import { IPC } from '@shared/ipc-channels';
import type { AgentDef, AgentScope } from '@shared/types';

export function registerAgentsIpc(): void {
  ipcMain.handle(
    IPC.AGENTS_LIST,
    (_event, projectPath: string | null) => listAgents(projectPath),
  );

  ipcMain.handle(IPC.AGENTS_READ, (_event, filePath: string) =>
    readAgent(filePath),
  );

  ipcMain.handle(IPC.AGENTS_SAVE, (_event, agent: AgentDef) =>
    saveAgent(agent),
  );

  ipcMain.handle(
    IPC.AGENTS_CREATE,
    (
      _event,
      scope: AgentScope,
      projectPath: string | null,
      slug: string,
    ) => createAgent(scope, projectPath, slug),
  );

  ipcMain.handle(IPC.AGENTS_DELETE, (_event, filePath: string) =>
    deleteAgent(filePath),
  );
}
