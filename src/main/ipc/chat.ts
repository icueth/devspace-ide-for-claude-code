import { ipcMain } from 'electron';

import {
  cancelActive,
  createThread,
  deleteThread,
  getProjectConfig,
  listThreads,
  sendMessage,
  setProjectConfig,
  subscribe,
  updateThreadConfig,
} from '@main/services/ChatService';
import { IPC } from '@shared/ipc-channels';
import type { ChatConfig, ChatSendRequest } from '@shared/types';

export function registerChatIpc(): void {
  ipcMain.handle(IPC.CHAT_LIST_THREADS, (event, projectPath: string) => {
    // Auto-subscribe the requesting webContents so it receives streaming
    // events for this project's threads going forward.
    subscribe(projectPath, event.sender);
    return listThreads(projectPath);
  });

  ipcMain.handle(
    IPC.CHAT_CREATE_THREAD,
    (_event, projectPath: string, title?: string) => {
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

  ipcMain.handle(IPC.CHAT_CANCEL, (_event, projectPath: string) => {
    cancelActive(projectPath);
  });

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
}
