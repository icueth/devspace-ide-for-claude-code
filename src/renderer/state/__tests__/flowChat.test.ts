import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FlowChatMessage } from '@shared/flowTypes';

// The store talks to main through the bridge — mock it so the tests assert the
// send/lock protocol instead of hitting the (rejecting) stub.
vi.mock('@renderer/lib/api', () => ({
  api: {
    flows: {
      chat: {
        send: vi.fn(async () => ({ ok: true })),
        history: vi.fn(async () => [] as FlowChatMessage[]),
        clear: vi.fn(async () => undefined),
        onChanged: vi.fn(() => () => undefined),
      },
    },
  },
}));

const { api } = await import('@renderer/lib/api');
const { useFlowChatStore } = await import('../flowChat');

const leadMsg = (id: string, text = 'on it'): FlowChatMessage => ({
  id,
  role: 'lead',
  text,
  at: 1000,
});

const userMsg = (id: string, text: string): FlowChatMessage => ({
  id,
  role: 'user',
  text,
  at: 2000,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.flows.chat.send).mockResolvedValue({ ok: true });
  useFlowChatStore.setState({
    projectPath: '/p',
    messages: [],
    busy: false,
    error: null,
    loading: false,
    pendingUser: null,
  });
});

describe('flowChat — send', () => {
  it('shows an optimistic user bubble and locks the turn', async () => {
    const ok = await useFlowChatStore.getState().send('add a CSV export button');

    expect(ok).toBe(true);
    expect(api.flows.chat.send).toHaveBeenCalledWith('/p', 'add a CSV export button');

    const s = useFlowChatStore.getState();
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({ role: 'user', text: 'add a CSV export button' });
    // Busy stays true until main pushes the reply — the turn is in flight.
    expect(s.busy).toBe(true);
  });

  it('refuses a second send while a turn is in flight', async () => {
    await useFlowChatStore.getState().send('first');
    expect(api.flows.chat.send).toHaveBeenCalledTimes(1);

    const ok = await useFlowChatStore.getState().send('second');

    expect(ok).toBe(false);
    // The lock is the store's: main never even sees the second message.
    expect(api.flows.chat.send).toHaveBeenCalledTimes(1);
    expect(useFlowChatStore.getState().messages).toHaveLength(1);
    expect(useFlowChatStore.getState().error).toMatch(/still working/i);
  });

  it('reverts the optimistic bubble when main refuses the turn', async () => {
    vi.mocked(api.flows.chat.send).mockResolvedValue({
      ok: false,
      error: 'lead is busy',
    });

    const ok = await useFlowChatStore.getState().send('hello');

    expect(ok).toBe(false);
    const s = useFlowChatStore.getState();
    // Main never persisted it — leaving the bubble would show a turn that does
    // not exist in chat.json.
    expect(s.messages).toHaveLength(0);
    expect(s.busy).toBe(false);
    expect(s.error).toBe('lead is busy');
  });

  it('reverts when the bridge throws, too', async () => {
    vi.mocked(api.flows.chat.send).mockRejectedValue(new Error('EPIPE'));

    const ok = await useFlowChatStore.getState().send('hello');

    expect(ok).toBe(false);
    expect(useFlowChatStore.getState().messages).toHaveLength(0);
    expect(useFlowChatStore.getState().busy).toBe(false);
    expect(useFlowChatStore.getState().error).toBe('EPIPE');
  });

  it('ignores empty and whitespace-only input', async () => {
    expect(await useFlowChatStore.getState().send('   ')).toBe(false);
    expect(api.flows.chat.send).not.toHaveBeenCalled();
  });

  it('trims the body before sending', async () => {
    await useFlowChatStore.getState().send('  ship it  ');
    expect(api.flows.chat.send).toHaveBeenCalledWith('/p', 'ship it');
  });
});

describe('flowChat — applyEvent', () => {
  it('appends the lead reply and releases the busy lock', async () => {
    await useFlowChatStore.getState().send('do the thing');
    expect(useFlowChatStore.getState().busy).toBe(true);

    useFlowChatStore
      .getState()
      .applyEvent({ projectPath: '/p', message: leadMsg('l1'), busy: false });

    const s = useFlowChatStore.getState();
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'lead']);
    expect(s.busy).toBe(false);
  });

  it('mirrors a busy flag with no message (another window started a turn)', () => {
    useFlowChatStore.getState().applyEvent({ projectPath: '/p', busy: true });
    expect(useFlowChatStore.getState().busy).toBe(true);
    expect(useFlowChatStore.getState().messages).toHaveLength(0);
  });

  it('ignores pushes for a different project', () => {
    useFlowChatStore
      .getState()
      .applyEvent({ projectPath: '/other', message: leadMsg('l1'), busy: true });

    const s = useFlowChatStore.getState();
    expect(s.messages).toHaveLength(0);
    expect(s.busy).toBe(false);
  });

  it('does not duplicate a message already in the transcript', () => {
    useFlowChatStore.getState().applyEvent({ projectPath: '/p', message: leadMsg('l1') });
    useFlowChatStore.getState().applyEvent({ projectPath: '/p', message: leadMsg('l1') });
    expect(useFlowChatStore.getState().messages).toHaveLength(1);
  });

  it('reconciles main\'s echo of the user message against the optimistic bubble', async () => {
    await useFlowChatStore.getState().send('add tests');
    // Main persisted the same text under ITS id — the optimistic bubble carries
    // a renderer-side one, so an id-only check would double the message.
    useFlowChatStore.getState().applyEvent({
      projectPath: '/p',
      message: userMsg('server-1', 'add tests'),
    });

    const s = useFlowChatStore.getState();
    const users = s.messages.filter((m) => m.role === 'user');
    expect(users).toHaveLength(1);
    // …and it is MAIN's copy that survives: the durable id is the one the next
    // event (and the next reload) will match on.
    expect(users[0].id).toBe('server-1');
    expect(s.pendingUser).toBeNull();
  });

  // The window that did NOT send has no optimistic bubble to reconcile, so every
  // message main pushes is new to it. Reconciling on (role, text) across the
  // whole transcript — the phase-2 rule — silently swallowed the second one:
  // typing "again" twice showed up once in every other window.
  it('keeps a message the user genuinely sent twice', () => {
    const store = useFlowChatStore.getState();
    store.applyEvent({ projectPath: '/p', message: userMsg('server-1', 'again'), busy: true });
    store.applyEvent({ projectPath: '/p', message: userMsg('server-2', 'again'), busy: true });

    const s = useFlowChatStore.getState();
    expect(s.messages.map((m) => m.id)).toEqual(['server-1', 'server-2']);
  });

  it('reconciles only the pending bubble, then goes back to matching on id', async () => {
    await useFlowChatStore.getState().send('again');
    useFlowChatStore
      .getState()
      .applyEvent({ projectPath: '/p', message: userMsg('server-1', 'again') });
    // A second "again" — from this window's next turn or another window's — is a
    // real second message, not an echo of the first.
    useFlowChatStore
      .getState()
      .applyEvent({ projectPath: '/p', message: userMsg('server-2', 'again') });

    expect(useFlowChatStore.getState().messages.map((m) => m.id)).toEqual([
      'server-1',
      'server-2',
    ]);
  });

  it('drops the pending bubble when main refuses the turn', async () => {
    vi.mocked(api.flows.chat.send).mockResolvedValue({ ok: false, error: 'busy' });
    await useFlowChatStore.getState().send('nope');
    expect(useFlowChatStore.getState().pendingUser).toBeNull();
  });

  it('releases busy on a lead reply even if main omitted the flag', async () => {
    await useFlowChatStore.getState().send('x');
    useFlowChatStore.getState().applyEvent({ projectPath: '/p', message: leadMsg('l9') });
    expect(useFlowChatStore.getState().busy).toBe(false);
  });
});

describe('flowChat — clear', () => {
  it('empties the transcript and tells main', async () => {
    await useFlowChatStore.getState().send('x');
    await useFlowChatStore.getState().clear();

    expect(api.flows.chat.clear).toHaveBeenCalledWith('/p');
    expect(useFlowChatStore.getState().messages).toHaveLength(0);
  });
});
