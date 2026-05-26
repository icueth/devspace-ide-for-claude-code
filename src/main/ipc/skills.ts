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
import {
  getSeedingEnabled,
  readSeedManifest,
  seedDesignSkills,
  setSeedingEnabled,
} from '@main/services/SkillSeedingService';
import { assertInWorkspace } from '@main/utils/pathScope';
import { IPC } from '@shared/ipc-channels';
import type {
  DesignSeedingReseedResult,
  DesignSeedingStatus,
  SkillDef,
} from '@shared/types';

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
    async (
      _event,
      scope: 'global' | 'project',
      projectPath: string | null,
      slug: string,
    ) => {
      // Project scope writes under <projectPath>/.claude/skills — confine
      // that path to an open workspace. Global scope uses ~/.claude and
      // carries no projectPath to validate.
      if (scope === 'project' && projectPath) {
        await assertInWorkspace(projectPath);
      }
      return createSkill(scope, projectPath, slug);
    },
  );

  ipcMain.handle(IPC.SKILLS_DELETE, (_event, filePath: string) => {
    assertValidSkillPath(filePath);
    return deleteSkill(filePath);
  });

  ipcMain.handle(
    IPC.SKILLS_DUPLICATE,
    async (
      _event,
      filePath: string,
      targetScope: 'global' | 'project',
      projectPath: string | null,
    ) => {
      assertValidSkillPath(filePath);
      if (targetScope === 'project' && projectPath) {
        await assertInWorkspace(projectPath);
      }
      return duplicateSkill(filePath, targetScope, projectPath);
    },
  );

  // v0.31: bundled design-skill seeding controls. The seeder runs on boot
  // (best-effort, default on); these handlers surface its status and let the
  // user toggle on-launch seeding or re-seed manually from Settings.
  ipcMain.handle(
    IPC.DESIGN_SEEDING_STATUS,
    async (): Promise<DesignSeedingStatus> => {
      const [enabled, manifest] = await Promise.all([
        getSeedingEnabled(),
        readSeedManifest(),
      ]);
      return {
        enabled,
        packVersion: manifest?.packVersion ?? null,
        seededAt: manifest?.seededAt ?? null,
        skillCount: manifest?.managedSlugs.length ?? 0,
        systemCount: manifest?.managedSystems.length ?? 0,
      };
    },
  );

  ipcMain.handle(
    IPC.DESIGN_SEEDING_SET_ENABLED,
    (_event, enabled: boolean) => {
      if (typeof enabled !== 'boolean') {
        throw new Error('design-seeding:set-enabled requires a boolean');
      }
      return setSeedingEnabled(enabled);
    },
  );

  ipcMain.handle(
    IPC.DESIGN_SEEDING_RESEED,
    async (): Promise<DesignSeedingReseedResult> => {
      // Manual re-seed forces a refresh regardless of the version stamp; we
      // pass enabled:true so it seeds even if on-launch seeding is toggled
      // off (the button is an explicit "do it now" action). The pref is left
      // unchanged.
      const r = await seedDesignSkills({ enabled: true, force: true });
      return {
        status: r.status,
        seededSkills: r.seededSkills,
        seededSystems: r.seededSystems,
        skippedCollisions: r.skippedCollisions.length,
        removedStale: r.removedStale,
      };
    },
  );
}
