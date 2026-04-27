import { create } from 'zustand';

import type { PromptRequest } from '@renderer/components/CommandPalette/PromptDialog';

interface PromptState {
  request: PromptRequest | null;
  ask: (r: PromptRequest) => void;
  dismiss: () => void;
}

export const usePromptStore = create<PromptState>((set) => ({
  request: null,
  ask: (request) => set({ request }),
  dismiss: () => set({ request: null }),
}));
