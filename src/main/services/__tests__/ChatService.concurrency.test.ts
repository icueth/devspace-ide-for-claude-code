import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { abortIfCancelledDuringStart } from '@main/services/ChatService';
import type { ProjectState } from '@main/services/ChatTranscript';
import type { ChatMessage, ChatThread } from '@shared/types';

// v0.35.2 regression: the chat spawn-window race. The active-run Maps are
// populated only AFTER the spawn resolves, so a cancel/delete arriving in
// that window was silently lost (lost cancel, zombie thread, double-send).
// `abortIfCancelledDuringStart` is the post-spawn hook each run calls before
// registering its handle. These pin its three branches.

function makeState(projectPath: string): ProjectState {
  return {
    projectPath,
    threads: new Map<string, ChatThread>(),
    activeRunsByThread: new Map(),
    activeLlmRunsByThread: new Map(),
    startingThreads: new Set<string>(),
    cancelDuringStart: new Set<string>(),
    subscribers: new Set(),
    hydrationPromise: Promise.resolve(),
  } as unknown as ProjectState;
}

function makeThread(id: string): ChatThread {
  return {
    id,
    projectId: 'p',
    title: 't',
    createdAt: 0,
    updatedAt: 0,
    messages: [],
  } as ChatThread;
}

function makeAssistant(): ChatMessage {
  return {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    role: 'assistant',
    content: '',
    toolCalls: [],
    createdAt: 0,
    status: 'streaming',
  };
}

const ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devspace-abort-'));
});
afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('abortIfCancelledDuringStart', () => {
  it('passes through (false, no kill) when the thread is live and not cancelled', async () => {
    const state = makeState(tmpRoot);
    const thread = makeThread(ID);
    state.threads.set(ID, thread);
    let killed = false;
    const aborted = await abortIfCancelledDuringStart(state, thread, makeAssistant(), {
      kill: async () => {
        killed = true;
      },
    });
    expect(aborted).toBe(false);
    expect(killed).toBe(false);
  });

  it('aborts + kills + finalizes cancelled when a cancel landed during start', async () => {
    const state = makeState(tmpRoot);
    const thread = makeThread(ID);
    state.threads.set(ID, thread);
    state.cancelDuringStart.add(ID);
    const assistant = makeAssistant();
    let killed = false;
    const aborted = await abortIfCancelledDuringStart(state, thread, assistant, {
      kill: async () => {
        killed = true;
      },
    });
    expect(aborted).toBe(true);
    expect(killed).toBe(true);
    expect(assistant.status).toBe('cancelled');
    // The pending-cancel flag is consumed so a later step can't re-trigger.
    expect(state.cancelDuringStart.has(ID)).toBe(false);
  });

  it('aborts + kills but does NOT persist when the thread was deleted mid-start', async () => {
    const state = makeState(tmpRoot);
    const thread = makeThread(ID);
    // thread intentionally NOT in state.threads → treated as deleted.
    const assistant = makeAssistant();
    let killed = false;
    const aborted = await abortIfCancelledDuringStart(state, thread, assistant, {
      kill: async () => {
        killed = true;
      },
    });
    expect(aborted).toBe(true);
    expect(killed).toBe(true);
    // A deleted thread must not be finalized/persisted (no zombie resurrection).
    expect(assistant.status).toBe('streaming');
    expect(fs.existsSync(path.join(tmpRoot, '.devspace'))).toBe(false);
  });
});
