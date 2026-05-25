import { ipcMain } from 'electron';

import {
  cancelActive,
  createThread,
  deleteThread,
  getProjectConfig,
  getThread,
  listThreads,
  sendMessage,
  setProjectConfig,
  subscribe,
  updateThreadConfig,
} from '@main/services/ChatService';
import {
  deleteProfile,
  listProfiles,
  upsertProfile,
} from '@main/services/LlmChatProfilesService';
import { listProfiles as listCliProfiles } from '@main/services/CliProfilesService';
import { IPC } from '@shared/ipc-channels';
import type {
  ChatConfig,
  ChatSendRequest,
  LlmChatProfile,
} from '@shared/types';

export function registerChatIpc(): void {
  ipcMain.handle(IPC.CHAT_LIST_THREADS, (event, projectPath: string) => {
    // Auto-subscribe the requesting webContents so it receives streaming
    // events for this project's threads going forward.
    subscribe(projectPath, event.sender);
    return listThreads(projectPath);
  });

  ipcMain.handle(
    IPC.CHAT_GET_THREAD,
    (event, projectPath: string, threadId: string) => {
      // Lazy full-thread fetch. Subscribe too (symmetric with
      // list-threads) so opening a thread the renderer reached without a
      // prior list call still wires up the streaming event stream.
      subscribe(projectPath, event.sender);
      return getThread(projectPath, threadId);
    },
  );

  ipcMain.handle(
    IPC.CHAT_CREATE_THREAD,
    async (
      _event,
      projectPath: string,
      title?: string,
      llmProfileId?: string,
      // v0.30: optional non-Claude CLI profile binding. Mutually exclusive
      // with llmProfileId — a thread is bound to exactly one of (Claude
      // default, LLM HTTP profile, CLI runtime profile). Empty/undefined
      // strings are treated as not-set.
      cliProfileId?: string,
    ) => {
      const trimmedLlmId =
        typeof llmProfileId === 'string' && llmProfileId.trim()
          ? llmProfileId.trim()
          : '';
      const trimmedCliId =
        typeof cliProfileId === 'string' && cliProfileId.trim()
          ? cliProfileId.trim()
          : '';

      if (trimmedLlmId && trimmedCliId) {
        throw new Error(
          'createThread: llmProfileId and cliProfileId are mutually exclusive',
        );
      }

      // v0.29: when an LLM profile is pinned, validate its existence
      // BEFORE creating the thread so a hand-crafted IPC call with a
      // bogus id can't strand a thread in an unrunnable state. Empty
      // string / undefined = default Claude path.
      if (trimmedLlmId) {
        const profiles = await listProfiles();
        const exists = profiles.some((p) => p.id === trimmedLlmId);
        if (!exists) {
          throw new Error(`unknown llmProfileId: ${trimmedLlmId}`);
        }
        return createThread(projectPath, title, trimmedLlmId);
      }

      // v0.30: CLI profile binding. Look the profile up to resolve its
      // cliId (currently always 'opencode' — the allowlist in
      // CliProfilesService gates the set). createThread receives a
      // typed binding so the ChatThread.cliId field is set from a
      // source that we KNOW matches the persisted profile.
      if (trimmedCliId) {
        const cliProfiles = await listCliProfiles();
        const profile = cliProfiles.find((p) => p.id === trimmedCliId);
        if (!profile) {
          throw new Error(`unknown cliProfileId: ${trimmedCliId}`);
        }
        if (profile.cliId !== 'opencode') {
          throw new Error(
            `unsupported cliId for v0.30 thread binding: ${profile.cliId}`,
          );
        }
        return createThread(projectPath, title, undefined, {
          profileId: profile.id,
          cliId: profile.cliId,
        });
      }

      return createThread(projectPath, title);
    },
  );

  ipcMain.handle(
    IPC.CHAT_DELETE_THREAD,
    (_event, projectPath: string, threadId: string) => {
      return deleteThread(projectPath, threadId);
    },
  );

  ipcMain.handle(IPC.CHAT_SEND, (event, req: ChatSendRequest) => {
    subscribe(req.projectId, event.sender);
    return sendMessage(req);
  });

  ipcMain.handle(
    IPC.CHAT_CANCEL,
    (_event, projectPath: string, threadId?: string) => {
      return cancelActive(projectPath, threadId);
    },
  );

  ipcMain.handle(IPC.CHAT_SUBSCRIBE, (event, projectPath: string) => {
    subscribe(projectPath, event.sender);
  });

  ipcMain.handle(IPC.CHAT_GET_CONFIG, (_event, projectPath: string) => {
    return getProjectConfig(projectPath);
  });

  ipcMain.handle(
    IPC.CHAT_SET_CONFIG,
    (_event, projectPath: string, cfg: ChatConfig) => {
      return setProjectConfig(projectPath, cfg);
    },
  );

  ipcMain.handle(
    IPC.CHAT_UPDATE_THREAD_CONFIG,
    (_event, projectPath: string, threadId: string, cfg: ChatConfig | null) => {
      return updateThreadConfig(projectPath, threadId, cfg);
    },
  );

  // v0.29: chat-only LLM profiles. Storage lives in
  // ~/.devspace/llm-chat-profiles.json (separate from llm-config.json
  // which powers editor autocomplete). The chat panel's provider
  // dropdown reads these; selecting one pins it onto a new thread's
  // llmProfileId so the thread routes to LlmChatRunner.
  ipcMain.handle(IPC.LLM_CHAT_PROFILES_LIST, () => listProfiles());

  ipcMain.handle(
    IPC.LLM_CHAT_PROFILES_UPSERT,
    (_event, payload: Partial<LlmChatProfile>) => {
      if (!payload || typeof payload !== 'object') {
        throw new Error('upsert: payload must be an object');
      }
      return upsertProfile(payload);
    },
  );

  ipcMain.handle(IPC.LLM_CHAT_PROFILES_DELETE, (_event, id: string) => {
    if (typeof id !== 'string' || !id.trim()) {
      throw new Error('delete: id must be a non-empty string');
    }
    return deleteProfile(id);
  });
}
