import { ipcMain } from 'electron';

import {
  approvePlan,
  cancelDesign,
  createDesign,
  deleteApp,
  deleteDesign,
  extractTokens,
  followUp,
  getApp,
  getProfile,
  getScreen,
  getTokens,
  listApps,
  listMessages,
  listScreens,
  listSkills,
  listSystems,
  planApp,
  readHtml,
  rebuildProfile,
  regenerateDesign,
  runBatch,
  saveEdits,
  setTokens,
  subscribeEvents,
  updatePlan,
} from '@main/services/DesignService';
import { IPC } from '@shared/ipc-channels';
import type {
  ApprovePlanInput,
  CreateDesignInput,
  DesignFollowUpInput,
  DesignSaveEditsInput,
  ExtractProjectTokensInput,
  PlanAppInput,
  RegenerateDesignInput,
  SetProjectTokensInput,
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

  // ─── v0.15: multi-screen app planning ────────────────────────────────────
  ipcMain.handle(IPC.DESIGN_PLAN_APP, (event, input: PlanAppInput) => {
    // Auto-subscribe so the renderer reliably receives app_plan_*
    // lifecycle events emitted while the planner runs.
    subscribeEvents(input.projectPath, event.sender);
    return planApp(input);
  });

  ipcMain.handle(IPC.DESIGN_APPROVE_PLAN, (event, input: ApprovePlanInput) => {
    subscribeEvents(input.projectPath, event.sender);
    return approvePlan(input);
  });

  ipcMain.handle(IPC.DESIGN_LIST_APPS, (event, projectPath: string) => {
    subscribeEvents(projectPath, event.sender);
    return listApps(projectPath);
  });

  ipcMain.handle(
    IPC.DESIGN_GET_APP,
    (_event, projectPath: string, appId: string) => getApp(projectPath, appId),
  );

  ipcMain.handle(IPC.DESIGN_UPDATE_PLAN, (event, input: ApprovePlanInput) => {
    subscribeEvents(input.projectPath, event.sender);
    return updatePlan(input);
  });

  ipcMain.handle(
    IPC.DESIGN_DELETE_APP,
    (_event, projectPath: string, appId: string) =>
      deleteApp(projectPath, appId),
  );

  ipcMain.handle(
    IPC.DESIGN_RUN_BATCH,
    (event, projectPath: string, appId: string) => {
      subscribeEvents(projectPath, event.sender);
      return runBatch(projectPath, appId);
    },
  );

  // ─── v0.15: project-wide tokens ──────────────────────────────────────────
  ipcMain.handle(IPC.DESIGN_GET_TOKENS, (_event, projectPath: string) =>
    getTokens(projectPath),
  );

  ipcMain.handle(
    IPC.DESIGN_SET_TOKENS,
    (event, input: SetProjectTokensInput) => {
      subscribeEvents(input.projectPath, event.sender);
      return setTokens(input);
    },
  );

  ipcMain.handle(
    IPC.DESIGN_EXTRACT_TOKENS,
    (event, input: ExtractProjectTokensInput) => {
      subscribeEvents(input.projectPath, event.sender);
      return extractTokens(input);
    },
  );
}
