import { create } from 'zustand';

import { api } from '@renderer/lib/api';
import type { FlowChatEvent, FlowChatMessage } from '@shared/flowTypes';

/**
 * Lead-chat store. Same shape as the flows store: main owns the transcript
 * (`<project>/.devspace/flows/chat.json`) and pushes FLOW_CHAT_EVENT, so the
 * renderer keeps no durable copy that could drift from the file.
 *
 * One turn is in flight per project — `send` returns immediately and the
 * lead's reply lands later as a push. `busy` is mirrored from main (not merely
 * set locally) so every window shows the same typing indicator, including the
 * one that didn't send.
 */

function uid(): string {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface FlowChatState {
  projectPath: string | null;
  messages: FlowChatMessage[];
  busy: boolean;
  /** Last send rejection ("lead is busy") — cleared on the next attempt. */
  error: string | null;
  loading: boolean;

  loadHistory: (projectPath: string) => Promise<void>;
  /** Resolves false when main refused the turn; the panel restores the draft. */
  send: (text: string) => Promise<boolean>;
  clear: () => Promise<void>;
  applyEvent: (evt: FlowChatEvent) => void;
}

export const useFlowChatStore = create<FlowChatState>((set, get) => ({
  projectPath: null,
  messages: [],
  busy: false,
  error: null,
  loading: false,

  async loadHistory(projectPath) {
    set({ projectPath, loading: true, error: null });
    const messages = await api.flows.chat
      .history(projectPath)
      .catch(() => [] as FlowChatMessage[]);
    // A newer project may have been selected while we awaited.
    if (get().projectPath !== projectPath) return;
    set({ messages, loading: false });
  },

  async send(text) {
    const body = text.trim();
    const { projectPath, busy } = get();
    if (!body || !projectPath) return false;
    // The busy lock is the store's, not the composer's: a second window could
    // otherwise fire a turn main would only reject.
    if (busy) {
      set({ error: 'The lead is still working on the previous message.' });
      return false;
    }

    // Optimistic bubble — the user must see their message land instantly, even
    // though main is the one that assigns the durable id.
    const optimistic: FlowChatMessage = {
      id: uid(),
      role: 'user',
      text: body,
      at: Date.now(),
    };
    set({ messages: [...get().messages, optimistic], busy: true, error: null });

    let res: { ok: boolean; error?: string };
    try {
      res = await api.flows.chat.send(projectPath, body);
    } catch (err) {
      res = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (res.ok) return true;

    // Refused (busy / not a workspace / spawn failed): main never persisted the
    // message, so leaving the bubble would show a turn that does not exist.
    set((s) => ({
      messages: s.messages.filter((m) => m.id !== optimistic.id),
      busy: false,
      error: res.error ?? 'The lead could not start a turn.',
    }));
    return false;
  },

  async clear() {
    const { projectPath } = get();
    if (!projectPath) return;
    set({ messages: [], error: null });
    try {
      await api.flows.chat.clear(projectPath);
    } catch (err) {
      console.error('[flowChat] clear failed:', err);
    }
  },

  applyEvent(evt) {
    const s = get();
    if (evt.projectPath !== s.projectPath) return;

    // An event with neither message nor busy is main's "history changed
    // wholesale" signal (FLOW_CHAT_CLEAR) — reload rather than merge, so a
    // second window drops its copy too.
    if (!evt.message && evt.busy === undefined) {
      void get().loadHistory(evt.projectPath);
      return;
    }
    const next: Partial<FlowChatState> = {};

    if (evt.message) {
      const msg = evt.message;
      // Main's copy is authoritative. The optimistic user bubble carries a
      // renderer-side id, so an echoed user message would duplicate it —
      // reconcile on (role, text) for user turns and on id for lead turns.
      const dupe = s.messages.some(
        (m) =>
          m.id === msg.id ||
          (msg.role === 'user' && m.role === 'user' && m.text === msg.text),
      );
      if (!dupe) next.messages = [...s.messages, msg];
      // A lead reply ends the turn even if main forgot to clear busy.
      if (msg.role === 'lead') next.busy = false;
    }
    if (evt.busy !== undefined) next.busy = evt.busy;

    set(next);
  },
}));

// Live pushes from main (FLOW_CHAT_EVENT): the lead's reply + the busy flag.
// Subscribed once at module init — same shape as the flows store.
if (typeof window !== 'undefined' && api?.flows?.chat?.onChanged) {
  api.flows.chat.onChanged((evt) => useFlowChatStore.getState().applyEvent(evt));
}
