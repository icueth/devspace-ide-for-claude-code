import { ipcMain } from 'electron';

import {
  loadLlmConfig,
  saveLlmConfig,
} from '@main/services/LlmConfigService';
import {
  completeForEditor,
  editForSelection,
  testLlm,
} from '@main/services/LlmClient';
import { IPC } from '@shared/ipc-channels';
import type {
  LlmCompleteRequest,
  LlmConfig,
  LlmEditRequest,
} from '@shared/types';

export function registerLlmIpc(): void {
  ipcMain.handle(IPC.LLM_GET_CONFIG, () => loadLlmConfig());

  ipcMain.handle(IPC.LLM_SET_CONFIG, async (_e, next: LlmConfig) => {
    return saveLlmConfig(next);
  });

  ipcMain.handle(IPC.LLM_TEST, async (_e, candidate: LlmConfig) => {
    // The Settings UI tests the form's CURRENT value, which may not have
    // been saved yet — accept the candidate config as the test target so
    // users don't have to commit an unverified API key first.
    return testLlm(candidate);
  });

  ipcMain.handle(
    IPC.LLM_COMPLETE,
    async (_e, req: LlmCompleteRequest) => {
      const config = await loadLlmConfig();
      // Editor-side gates this too, but defense in depth: the autocomplete
      // path should be a strict no-op when the master switch is off so a
      // stale renderer can't accidentally burn tokens.
      if (!config.autocompleteEnabled || !config.apiKey) {
        return { text: '', latencyMs: 0 };
      }
      return completeForEditor(config, req);
    },
  );

  ipcMain.handle(IPC.LLM_EDIT, async (_e, req: LlmEditRequest) => {
    // Cmd+K is explicitly user-triggered, so we don't gate on the
    // autocomplete master switch — only on the API key being set.
    const config = await loadLlmConfig();
    if (!config.apiKey) {
      return {
        text: '',
        latencyMs: 0,
        error: 'No LLM API key configured. Open Settings → LLM to set one.',
      };
    }
    return editForSelection(config, req);
  });
}
