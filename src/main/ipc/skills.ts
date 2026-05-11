import { ipcMain } from 'electron';

import {
  createSkill,
  deleteSkill,
  listSkills,
  readSkill,
  saveSkill,
} from '@main/services/SkillsService';
import { IPC } from '@shared/ipc-channels';
import type { SkillDef } from '@shared/types';

export function registerSkillsIpc(): void {
  ipcMain.handle(
    IPC.SKILLS_LIST,
    (_event, projectPath: string | null, includePlugins?: boolean) =>
      listSkills(projectPath, { includePlugins }),
  );

  ipcMain.handle(IPC.SKILLS_READ, (_event, filePath: string) =>
    readSkill(filePath),
  );

  ipcMain.handle(IPC.SKILLS_SAVE, (_event, skill: SkillDef) =>
    saveSkill(skill),
  );

  ipcMain.handle(
    IPC.SKILLS_CREATE,
    (
      _event,
      scope: 'global' | 'project',
      projectPath: string | null,
      slug: string,
    ) => createSkill(scope, projectPath, slug),
  );

  ipcMain.handle(IPC.SKILLS_DELETE, (_event, filePath: string) =>
    deleteSkill(filePath),
  );
}
