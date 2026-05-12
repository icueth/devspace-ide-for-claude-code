import { ipcMain } from 'electron';

import {
  assertValidAgentPath,
  createAgent,
  deleteAgent,
  duplicateAgent,
  listAgents,
  readAgent,
  saveAgent,
} from '@main/services/AgentsService';
import { IPC } from '@shared/ipc-channels';
import type { AgentDef, AgentScope } from '@shared/types';

// Every handler that takes a caller-controlled `filePath` runs it through
// `assertValidAgentPath` before forwarding to the service. The service
// layer trusts its inputs; the security boundary lives here.

export function registerAgentsIpc(): void {
  ipcMain.handle(
    IPC.AGENTS_LIST,
    (_event, projectPath: string | null) => listAgents(projectPath),
  );

  ipcMain.handle(IPC.AGENTS_READ, (_event, filePath: string) => {
    assertValidAgentPath(filePath);
    return readAgent(filePath);
  });

  ipcMain.handle(IPC.AGENTS_SAVE, (_event, agent: AgentDef) => {
    assertValidAgentPath(agent.path);
    return saveAgent(agent);
  });

  ipcMain.handle(
    IPC.AGENTS_CREATE,
    (
      _event,
      scope: AgentScope,
      projectPath: string | null,
      slug: string,
    ) => createAgent(scope, projectPath, slug),
  );

  ipcMain.handle(IPC.AGENTS_DELETE, (_event, filePath: string) => {
    assertValidAgentPath(filePath);
    return deleteAgent(filePath);
  });

  ipcMain.handle(
    IPC.AGENTS_DUPLICATE,
    (
      _event,
      filePath: string,
      targetScope: 'global' | 'project',
      projectPath: string | null,
    ) => {
      assertValidAgentPath(filePath);
      return duplicateAgent(filePath, targetScope, projectPath);
    },
  );
}
