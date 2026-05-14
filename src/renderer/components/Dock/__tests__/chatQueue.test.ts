import { beforeEach, describe, expect, it } from 'vitest';

import {
  queueKey,
  useChatQueueStore,
} from '@renderer/state/chatQueue';

// The store is module-level singleton state. Reset between tests so one
// test's enqueues can't leak into another's assertions.
beforeEach(() => {
  useChatQueueStore.setState({ queues: {}, paused: {} });
});

describe('chatQueue store', () => {
  it('enqueue + list returns items in insertion order', () => {
    const s = useChatQueueStore.getState();
    const k = queueKey('/proj', 'thread-1');
    s.enqueue(k, { text: 'first' });
    s.enqueue(k, { text: 'second' });
    s.enqueue(k, { text: 'third' });

    const items = useChatQueueStore.getState().list(k);
    expect(items.map((q) => q.text)).toEqual(['first', 'second', 'third']);
  });

  it('enqueue returns a unique id per call', () => {
    const s = useChatQueueStore.getState();
    const k = queueKey('/proj', 't');
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      ids.add(s.enqueue(k, { text: `msg-${i}` }));
    }
    expect(ids.size).toBe(50);
  });

  it('enqueue carries attachments through to the stored entry', () => {
    const s = useChatQueueStore.getState();
    const k = queueKey('/proj', 't');
    const id = s.enqueue(k, {
      text: 'with attach',
      attachments: ['/proj/src/x.ts', '/proj/img/y.png'],
    });
    const item = useChatQueueStore.getState().list(k).find((q) => q.id === id);
    expect(item).toBeDefined();
    expect(item!.attachments).toEqual(['/proj/src/x.ts', '/proj/img/y.png']);
  });

  it('update replaces text for the matching id and leaves siblings untouched', () => {
    const s = useChatQueueStore.getState();
    const k = queueKey('/proj', 't');
    const aId = s.enqueue(k, { text: 'a' });
    const bId = s.enqueue(k, { text: 'b' });
    s.enqueue(k, { text: 'c' });

    s.update(k, bId, 'b-updated');

    const items = useChatQueueStore.getState().list(k);
    expect(items.map((q) => q.text)).toEqual(['a', 'b-updated', 'c']);
    // Identity of the unchanged head should not have been touched.
    expect(items[0]!.id).toBe(aId);
  });

  it('update on missing id is a no-op', () => {
    const s = useChatQueueStore.getState();
    const k = queueKey('/proj', 't');
    s.enqueue(k, { text: 'only' });
    s.update(k, 'nonexistent-id', 'should not appear');
    expect(useChatQueueStore.getState().list(k).map((q) => q.text)).toEqual(['only']);
  });

  it('remove drops the matching item and preserves order of the rest', () => {
    const s = useChatQueueStore.getState();
    const k = queueKey('/proj', 't');
    s.enqueue(k, { text: 'a' });
    const bId = s.enqueue(k, { text: 'b' });
    s.enqueue(k, { text: 'c' });
    s.enqueue(k, { text: 'd' });

    s.remove(k, bId);
    expect(useChatQueueStore.getState().list(k).map((q) => q.text)).toEqual([
      'a',
      'c',
      'd',
    ]);
  });

  it('remove of the last item collapses the key out of the queues map', () => {
    const s = useChatQueueStore.getState();
    const k = queueKey('/proj', 't');
    const id = s.enqueue(k, { text: 'solo' });
    s.remove(k, id);
    // Empty key should be removed entirely (rather than leaving a `[]`),
    // so iteration over `queues` doesn't trip on stale empty arrays.
    expect(k in useChatQueueStore.getState().queues).toBe(false);
  });

  it('reorder moves an item from one index to another', () => {
    const s = useChatQueueStore.getState();
    const k = queueKey('/proj', 't');
    s.enqueue(k, { text: 'a' });
    s.enqueue(k, { text: 'b' });
    s.enqueue(k, { text: 'c' });
    s.enqueue(k, { text: 'd' });

    // Move 'a' to where 'c' is — drags the others left.
    s.reorder(k, 0, 2);
    expect(useChatQueueStore.getState().list(k).map((q) => q.text)).toEqual([
      'b',
      'c',
      'a',
      'd',
    ]);

    // Now move last item to head.
    s.reorder(k, 3, 0);
    expect(useChatQueueStore.getState().list(k).map((q) => q.text)).toEqual([
      'd',
      'b',
      'c',
      'a',
    ]);
  });

  it('reorder with out-of-range indices is a no-op', () => {
    const s = useChatQueueStore.getState();
    const k = queueKey('/proj', 't');
    s.enqueue(k, { text: 'a' });
    s.enqueue(k, { text: 'b' });

    s.reorder(k, -1, 0);
    s.reorder(k, 0, 99);
    s.reorder(k, 5, 5);

    expect(useChatQueueStore.getState().list(k).map((q) => q.text)).toEqual([
      'a',
      'b',
    ]);
  });

  it('shift pops the head and returns it; returns undefined on empty', () => {
    const s = useChatQueueStore.getState();
    const k = queueKey('/proj', 't');
    expect(s.shift(k)).toBeUndefined();

    s.enqueue(k, { text: 'first' });
    s.enqueue(k, { text: 'second' });

    const head = useChatQueueStore.getState().shift(k);
    expect(head?.text).toBe('first');
    expect(useChatQueueStore.getState().list(k).map((q) => q.text)).toEqual([
      'second',
    ]);

    const head2 = useChatQueueStore.getState().shift(k);
    expect(head2?.text).toBe('second');

    // Queue now empty: returns undefined and key is gone from the map.
    expect(useChatQueueStore.getState().shift(k)).toBeUndefined();
    expect(k in useChatQueueStore.getState().queues).toBe(false);
  });

  it('clear empties only the targeted key', () => {
    const s = useChatQueueStore.getState();
    const k1 = queueKey('/proj', 't1');
    const k2 = queueKey('/proj', 't2');
    s.enqueue(k1, { text: 'a' });
    s.enqueue(k1, { text: 'b' });
    s.enqueue(k2, { text: 'x' });

    s.clear(k1);
    expect(useChatQueueStore.getState().list(k1)).toEqual([]);
    expect(useChatQueueStore.getState().list(k2).map((q) => q.text)).toEqual(['x']);
  });

  it('keys are isolated across projects with the same thread id', () => {
    const s = useChatQueueStore.getState();
    const kA = queueKey('/projA', 'thread-x');
    const kB = queueKey('/projB', 'thread-x');
    s.enqueue(kA, { text: 'a-msg' });
    s.enqueue(kB, { text: 'b-msg' });

    expect(useChatQueueStore.getState().list(kA).map((q) => q.text)).toEqual([
      'a-msg',
    ]);
    expect(useChatQueueStore.getState().list(kB).map((q) => q.text)).toEqual([
      'b-msg',
    ]);
  });

  it('clearProject drops every key for that project but leaves other projects untouched', () => {
    const s = useChatQueueStore.getState();
    s.enqueue(queueKey('/projA', 't1'), { text: 'a1' });
    s.enqueue(queueKey('/projA', 't2'), { text: 'a2' });
    s.enqueue(queueKey('/projB', 't1'), { text: 'b1' });
    s.setPaused(queueKey('/projA', 't1'), true);
    s.setPaused(queueKey('/projB', 't1'), true);

    s.clearProject('/projA');

    const state = useChatQueueStore.getState();
    expect(state.list(queueKey('/projA', 't1'))).toEqual([]);
    expect(state.list(queueKey('/projA', 't2'))).toEqual([]);
    expect(state.list(queueKey('/projB', 't1')).map((q) => q.text)).toEqual(['b1']);
    // Pause flag is per-project too — A's flag is gone, B's survives.
    expect(state.isPaused(queueKey('/projA', 't1'))).toBe(false);
    expect(state.isPaused(queueKey('/projB', 't1'))).toBe(true);
  });

  it('setPaused / isPaused toggle independently per key', () => {
    const s = useChatQueueStore.getState();
    const k1 = queueKey('/proj', 't1');
    const k2 = queueKey('/proj', 't2');

    expect(useChatQueueStore.getState().isPaused(k1)).toBe(false);
    s.setPaused(k1, true);
    expect(useChatQueueStore.getState().isPaused(k1)).toBe(true);
    expect(useChatQueueStore.getState().isPaused(k2)).toBe(false);

    s.setPaused(k1, false);
    expect(useChatQueueStore.getState().isPaused(k1)).toBe(false);
  });

  // v0.16.0 regression — auto-send failure path re-enqueues at the head
  // via unshift so user intent is preserved without re-ordering.
  it('unshift puts a popped item back at the head with its original id', () => {
    const s = useChatQueueStore.getState();
    const k = queueKey('/proj', 't');
    s.enqueue(k, { text: 'first' });
    s.enqueue(k, { text: 'second' });

    const head = useChatQueueStore.getState().shift(k);
    expect(head?.text).toBe('first');
    // Simulate auto-send failing → put it back where it was.
    useChatQueueStore.getState().unshift(k, head!);

    const items = useChatQueueStore.getState().list(k);
    expect(items.map((q) => q.text)).toEqual(['first', 'second']);
    // Original id is preserved so the React key stays stable.
    expect(items[0]!.id).toBe(head!.id);
    expect(items[0]!.createdAt).toBe(head!.createdAt);
  });

  it('unshift on an empty queue creates it', () => {
    const s = useChatQueueStore.getState();
    const k = queueKey('/proj', 't-empty');
    s.unshift(k, {
      id: 'restored',
      text: 'restored',
      createdAt: 1000,
    });
    expect(useChatQueueStore.getState().list(k).map((q) => q.text)).toEqual([
      'restored',
    ]);
  });
});
