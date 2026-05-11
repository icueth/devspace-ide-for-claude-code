import { ipcMain } from 'electron';

import {
  deleteTeam,
  getTeam,
  listTeams,
  saveTeam,
} from '@main/services/TeamsService';
import { IPC } from '@shared/ipc-channels';
import type { TeamDef, TeamScope } from '@shared/types';

export function registerTeamsIpc(): void {
  ipcMain.handle(IPC.TEAMS_LIST, (_event, projectPath: string | null) =>
    listTeams(projectPath),
  );

  ipcMain.handle(
    IPC.TEAMS_GET,
    (_event, projectPath: string | null, teamId: string) =>
      getTeam(projectPath, teamId),
  );

  ipcMain.handle(
    IPC.TEAMS_SAVE,
    (
      _event,
      scope: TeamScope,
      projectPath: string | null,
      team: TeamDef,
    ) => saveTeam(scope, projectPath, team),
  );

  ipcMain.handle(
    IPC.TEAMS_DELETE,
    (
      _event,
      scope: TeamScope,
      projectPath: string | null,
      teamId: string,
    ) => deleteTeam(scope, projectPath, teamId),
  );
}
