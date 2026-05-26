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
import { assertInWorkspace } from '@main/utils/pathScope';
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
    async (
      _event,
      scope: AgentScope,
      projectPath: string | null,
      slug: string,
    ) => {
      // Project scope writes under <projectPath>/.claude/agents — confine
      // that path to an open workspace. Global scope uses ~/.claude and
      // carries no projectPath to validate.
      if (scope === 'project' && projectPath) {
        await assertInWorkspace(projectPath);
      }
      return createAgent(scope, projectPath, slug);
    },
  );

  ipcMain.handle(IPC.AGENTS_DELETE, (_event, filePath: string) => {
    assertValidAgentPath(filePath);
    return deleteAgent(filePath);
  });

  ipcMain.handle(
    IPC.AGENTS_DUPLICATE,
    async (
      _event,
      filePath: string,
      targetScope: 'global' | 'project',
      projectPath: string | null,
    ) => {
      assertValidAgentPath(filePath);
      if (targetScope === 'project' && projectPath) {
        await assertInWorkspace(projectPath);
      }
      return duplicateAgent(filePath, targetScope, projectPath);
    },
  );
}
