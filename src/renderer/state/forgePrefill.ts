import { create } from 'zustand';

// v0.25: tiny store that bridges the chat → Settings flow.
// ChatPanel's `/skill <brief>` and `/agent <brief>` slash commands write
// into this store + dispatch `devspace:open-settings` with the matching
// tab. SkillsSettings / AgentsSettings each subscribe in a one-shot
// effect — when their `pending` is set on mount they open the Generate
// dialog with the brief pre-filled, then call `consume()` to clear it
// so re-opening Settings later doesn't replay the prompt.

export type ForgeKind = 'skill' | 'agent';

interface ForgePrefillState {
  pending: { kind: ForgeKind; brief: string } | null;
  set: (kind: ForgeKind, brief: string) => void;
  consume: () => void;
}

export const useForgePrefillStore = create<ForgePrefillState>((set) => ({
  pending: null,
  set: (kind, brief) => set({ pending: { kind, brief } }),
  consume: () => set({ pending: null }),
}));
