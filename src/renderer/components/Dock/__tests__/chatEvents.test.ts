import { describe, expect, it } from 'vitest';

import {
  applyEvent,
  capLoaded,
  MAX_LOADED_THREADS,
} from '@renderer/components/Dock/chatEvents';
import type { ChatEvent, ChatMessage, ChatThread } from '@shared/types';

// These tests pin the identity contract that makes `memo(MessageBubble)`
// correct: the streaming (last) message must get a FRESH object identity on
// every mutating event, while finalized (prior) messages must keep theirs.
// If applyEvent ever reverts to mutating the last message in place, memoized
// bubbles would freeze mid-stream — and these tests would fail.

function assistantMsg(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    toolCalls: [],
    createdAt: 1,
    status: 'streaming',
    ...overrides,
  };
}

function userMsg(id: string, content: string): ChatMessage {
  return { id, role: 'user', content, toolCalls: [], createdAt: 1, status: 'done' };
}

function thread(messages: ChatMessage[]): ChatThread {
  return {
    id: 't1',
    projectId: 'p1',
    title: 'T',
    createdAt: 1,
    updatedAt: 1,
    messages,
  };
}

function ev(partial: Partial<ChatEvent> & { kind: ChatEvent['kind'] }): ChatEvent {
  return { ts: 100, ...partial };
}

describe('applyEvent identity invariants', () => {
  it('gives the last (streaming) message a fresh identity, keeps prior ones', () => {
    const prior = assistantMsg('a0', { content: 'done', status: 'done' });
    const user = userMsg('u1', 'hi');
    const streaming = assistantMsg('a1');
    const before = thread([prior, user, streaming]);

    const after = applyEvent(before, 't1', ev({ kind: 'text_delta', text: 'Hello' }));

    // Fresh thread + messages array.
    expect(after).not.toBe(before);
    expect(after.messages).not.toBe(before.messages);
    // Last message identity changed (the fix).
    expect(after.messages[2]).not.toBe(streaming);
    expect(after.messages[2].content).toBe('Hello');
    // Prior messages keep identity → memoized bubbles skip re-render.
    expect(after.messages[0]).toBe(prior);
    expect(after.messages[1]).toBe(user);
    // Original object was not mutated.
    expect(streaming.content).toBe('');
  });

  it('appends text and mirrors into a fresh text segment', () => {
    const before = thread([assistantMsg('a1')]);
    const a = applyEvent(before, 't1', ev({ kind: 'text_delta', text: 'foo' }));
    const b = applyEvent(a, 't1', ev({ kind: 'text_delta', text: 'bar' }));

    expect(b.messages[0].content).toBe('foobar');
    expect(b.messages[0].segments).toHaveLength(1);
    const seg = b.messages[0].segments![0];
    expect(seg.kind).toBe('text');
    if (seg.kind === 'text') expect(seg.text).toBe('foobar');
    // The segment object is replaced (new identity), not mutated in place.
    const segA = a.messages[0].segments![0];
    expect(b.messages[0].segments![0]).not.toBe(segA);
  });

  it('tool_result replaces only the matching call, preserving others', () => {
    const start = thread([assistantMsg('a1')]);
    const withTools = applyEvent(
      applyEvent(start, 't1', ev({ kind: 'tool_use', toolUseId: 'x', toolName: 'Read' })),
      't1',
      ev({ kind: 'tool_use', toolUseId: 'y', toolName: 'Edit' }),
    );
    const callXBefore = withTools.messages[0].toolCalls[0];
    const callYBefore = withTools.messages[0].toolCalls[1];

    const after = applyEvent(
      withTools,
      't1',
      ev({ kind: 'tool_result', toolUseId: 'y', toolResult: 'ok' }),
    );

    expect(after.messages[0].toolCalls[1].result).toBe('ok');
    // Changed call gets a fresh identity; the untouched call keeps its own.
    expect(after.messages[0].toolCalls[1]).not.toBe(callYBefore);
    expect(after.messages[0].toolCalls[0]).toBe(callXBefore);
  });

  it('returns the same thread untouched when the threadId does not match', () => {
    const before = thread([assistantMsg('a1')]);
    const after = applyEvent(before, 'other-thread', ev({ kind: 'text_delta', text: 'x' }));
    expect(after).toBe(before);
  });

  it('done flips streaming → done on a fresh message object', () => {
    const streaming = assistantMsg('a1', { content: 'hi' });
    const before = thread([streaming]);
    const after = applyEvent(before, 't1', ev({ kind: 'done' }));
    expect(after.messages[0].status).toBe('done');
    expect(after.messages[0]).not.toBe(streaming);
    expect(streaming.status).toBe('streaming'); // original untouched
  });
});

// v0.27: the lazily-loaded full-transcript cache must stay bounded so opening
// many threads in one session doesn't reaccumulate every transcript in memory.
describe('capLoaded — bounds the renderer full-thread cache', () => {
  function loadedMap(n: number): Record<string, ChatThread> {
    const m: Record<string, ChatThread> = {};
    for (let i = 0; i < n; i++) m[`t${i}`] = thread([]);
    return m;
  }

  it('returns the map unchanged when at or under the cap', () => {
    const m = loadedMap(MAX_LOADED_THREADS);
    expect(capLoaded(m, 't0')).toBe(m);
  });

  it('evicts oldest-inserted entries down to the cap', () => {
    const m = loadedMap(MAX_LOADED_THREADS + 3);
    const out = capLoaded(m, `t${MAX_LOADED_THREADS + 2}`);
    expect(Object.keys(out)).toHaveLength(MAX_LOADED_THREADS);
    // The three oldest (t0, t1, t2) are gone.
    expect(out['t0']).toBeUndefined();
    expect(out['t1']).toBeUndefined();
    expect(out['t2']).toBeUndefined();
  });

  it('never evicts the active thread even when it is the oldest', () => {
    const m = loadedMap(MAX_LOADED_THREADS + 2);
    const out = capLoaded(m, 't0'); // t0 is the oldest but is active
    expect(Object.keys(out)).toHaveLength(MAX_LOADED_THREADS);
    expect(out['t0']).toBeDefined();
  });
});
