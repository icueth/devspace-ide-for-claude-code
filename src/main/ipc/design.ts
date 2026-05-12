import { ipcMain } from 'electron';

import {
  cancelDesign,
  createDesign,
  deleteDesign,
  followUp,
  getProfile,
  getScreen,
  listMessages,
  listScreens,
  listSkills,
  listSystems,
  readHtml,
  rebuildProfile,
  regenerateDesign,
  saveEdits,
  subscribeEvents,
} from '@main/services/DesignService';
import { IPC } from '@shared/ipc-channels';
import type {
  CreateDesignInput,
  DesignFollowUpInput,
  DesignSaveEditsInput,
  RegenerateDesignInput,
} from '@shared/design';

export function registerDesignIpc(): void {
  ipcMain.handle(IPC.DESIGN_LIST, (event, projectPath: string) => {
    // Auto-subscribe so the requesting webContents starts receiving
    // streaming design events for this project the moment it asks for
    // the list. Mirrors the chat panel pattern.
    subscribeEvents(projectPath, event.sender);
    return listScreens(projectPath);
  });

  ipcMain.handle(
    IPC.DESIGN_GET,
    (_event, projectPath: string, screenId: string) =>
      getScreen(projectPath, screenId),
  );

  ipcMain.handle(IPC.DESIGN_CREATE, (event, input: CreateDesignInput) => {
    subscribeEvents(input.projectPath, event.sender);
    return createDesign(input);
  });

  ipcMain.handle(
    IPC.DESIGN_REGENERATE,
    (event, input: RegenerateDesignInput) => {
      subscribeEvents(input.projectPath, event.sender);
      return regenerateDesign(input);
    },
  );

  ipcMain.handle(
    IPC.DESIGN_SAVE_EDITS,
    (event, input: DesignSaveEditsInput) => {
      // Auto-subscribe so the editing renderer reliably receives the
      // 'screen_updated' event emitted by saveEdits, even if the user
      // never opened the design list panel in this session.
      subscribeEvents(input.projectPath, event.sender);
      return saveEdits(input);
    },
  );

  ipcMain.handle(
    IPC.DESIGN_DELETE,
    (_event, projectPath: string, screenId: string) =>
      deleteDesign(projectPath, screenId),
  );

  ipcMain.handle(
    IPC.DESIGN_CANCEL,
    (_event, projectPath: string, screenId: string) =>
      cancelDesign(projectPath, screenId),
  );

  ipcMain.handle(
    IPC.DESIGN_LIST_SKILLS,
    (_event, projectPath: string | null) => listSkills(projectPath),
  );

  ipcMain.handle(
    IPC.DESIGN_LIST_SYSTEMS,
    (_event, projectPath: string | null) => listSystems(projectPath),
  );

  ipcMain.handle(
    IPC.DESIGN_READ_HTML,
    (_event, projectPath: string, screenId: string, versionId?: string) =>
      readHtml(projectPath, screenId, versionId),
  );

  ipcMain.handle(IPC.DESIGN_SUBSCRIBE, (event, projectPath: string) => {
    subscribeEvents(projectPath, event.sender);
  });

  // ─── v0.10: chat-style transcript + project profile ──────────────────────
  ipcMain.handle(IPC.DESIGN_FOLLOW_UP, (event, input: DesignFollowUpInput) => {
    // Auto-subscribe so the renderer reliably receives the streaming
    // message_* events emitted while the follow-up generates.
    subscribeEvents(input.projectPath, event.sender);
    return followUp(input);
  });

  ipcMain.handle(
    IPC.DESIGN_LIST_MESSAGES,
    (_event, projectPath: string, screenId: string) =>
      listMessages(projectPath, screenId),
  );

  ipcMain.handle(
    IPC.DESIGN_GET_PROFILE,
    (_event, projectPath: string) => getProfile(projectPath),
  );

  ipcMain.handle(
    IPC.DESIGN_REBUILD_PROFILE,
    (_event, projectPath: string) => rebuildProfile(projectPath),
  );
}
