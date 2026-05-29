import { create } from 'zustand';

// Tiny store that bridges a "generate from a brief" trigger → Settings.
// The Command Palette commands "Generate a skill/agent from a brief…"
// (App.tsx) write into this store + dispatch `devspace:open-settings`
// with the matching tab. SkillsSettings / AgentsSettings each subscribe
// in a one-shot effect — when their `pending` is set they open the
// Generate dialog with the brief pre-filled, then call `consume()` to
// clear it so re-opening Settings later doesn't replay the prompt.
// (Replaced the v0.25 chat `/skill` `/agent` slash-command writer when
// Chat mode was removed.)

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
