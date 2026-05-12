import { ipcMain } from 'electron';

import {
  assertValidSkillPath,
  createSkill,
  deleteSkill,
  duplicateSkill,
  listSkills,
  readSkill,
  saveSkill,
} from '@main/services/SkillsService';
import { IPC } from '@shared/ipc-channels';
import type { SkillDef } from '@shared/types';

// Every handler that takes a caller-controlled `filePath` runs it through
// `assertValidSkillPath` before forwarding to the service. Critically,
// SKILLS_DELETE recursively removes the parent directory — that path
// MUST be validated here.

export function registerSkillsIpc(): void {
  ipcMain.handle(
    IPC.SKILLS_LIST,
    (_event, projectPath: string | null, includePlugins?: boolean) =>
      listSkills(projectPath, { includePlugins }),
  );

  ipcMain.handle(IPC.SKILLS_READ, (_event, filePath: string) => {
    assertValidSkillPath(filePath);
    return readSkill(filePath);
  });

  ipcMain.handle(IPC.SKILLS_SAVE, (_event, skill: SkillDef) => {
    assertValidSkillPath(skill.path);
    return saveSkill(skill);
  });

  ipcMain.handle(
    IPC.SKILLS_CREATE,
    (
      _event,
      scope: 'global' | 'project',
      projectPath: string | null,
      slug: string,
    ) => createSkill(scope, projectPath, slug),
  );

  ipcMain.handle(IPC.SKILLS_DELETE, (_event, filePath: string) => {
    assertValidSkillPath(filePath);
    return deleteSkill(filePath);
  });

  ipcMain.handle(
    IPC.SKILLS_DUPLICATE,
    (
      _event,
      filePath: string,
      targetScope: 'global' | 'project',
      projectPath: string | null,
    ) => {
      assertValidSkillPath(filePath);
      return duplicateSkill(filePath, targetScope, projectPath);
    },
  );
}
