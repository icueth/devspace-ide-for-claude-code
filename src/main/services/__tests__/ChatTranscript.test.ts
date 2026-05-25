import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createThread,
  deleteThread,
  getThread,
  listThreads,
  persistThread,
  threadFile,
  updateThreadConfig,
} from '@main/services/ChatTranscript';
import type { ChatMessage } from '@shared/types';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devspace-chat-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('ChatTranscript thread CRUD', () => {
  it('creates a thread and persists it under .devspace/chat', async () => {
    const thread = await createThread(tmpRoot, 'first chat');

    expect(thread.id).toMatch(/.+/);
    expect(thread.title).toBe('first chat');
    expect(thread.messages).toEqual([]);

    const onDisk = JSON.parse(
      fs.readFileSync(threadFile(tmpRoot, thread.id), 'utf8'),
    );
    expect(onDisk.id).toBe(thread.id);
    expect(onDisk.title).toBe('first chat');
  });

  it("falls back to 'New chat' when title is blank or whitespace", async () => {
    const t1 = await createThread(tmpRoot);
    const t2 = await createThread(tmpRoot, '   ');
    expect(t1.title).toBe('New chat');
    expect(t2.title).toBe('New chat');
  });

  it('listThreads hydrates from disk and sorts newest first', async () => {
    // UUIDs are required — non-UUID filenames are rejected at hydrate time
    // as a defense against hostile project drops (see B5 in v0.11.2 audit).
    const idA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const idB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const dir = path.join(tmpRoot, '.devspace', 'chat');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${idA}.json`),
      JSON.stringify({
        id: idA,
        projectId: 'proj',
        title: 'older',
        createdAt: 1,
        updatedAt: 100,
        messages: [],
      }),
    );
    fs.writeFileSync(
      path.join(dir, `${idB}.json`),
      JSON.stringify({
        id: idB,
        projectId: 'proj',
        title: 'newer',
        createdAt: 2,
        updatedAt: 200,
        messages: [],
      }),
    );

    const threads = await listThreads(tmpRoot);
    expect(threads.map((t) => t.id)).toEqual([idB, idA]);
  });

  it('quarantines corrupt thread JSON during hydration without throwing', async () => {
    const goodId = '11111111-1111-1111-1111-111111111111';
    const brokenId = '22222222-2222-2222-2222-222222222222';
    const dir = path.join(tmpRoot, '.devspace', 'chat');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${goodId}.json`), JSON.stringify({
      id: goodId,
      projectId: 'proj',
      title: 'ok',
      createdAt: 1,
      updatedAt: 1,
      messages: [],
    }));
    fs.writeFileSync(path.join(dir, `${brokenId}.json`), 'not json {');

    const threads = await listThreads(tmpRoot);
    expect(threads.map((t) => t.id)).toEqual([goodId]);
    // The broken file is renamed instead of silently dropped so the user
    // can recover and we get visibility next time they ask about it.
    const remaining = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(remaining).toEqual([`${goodId}.json`]);
    const quarantined = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(brokenId) && f.includes('.corrupt-'));
    expect(quarantined.length).toBe(1);
  });

  it('rejects non-UUID filenames and quarantines id-mismatch threads', async () => {
    const fakeId = '33333333-3333-3333-3333-333333333333';
    const dir = path.join(tmpRoot, '.devspace', 'chat');
    fs.mkdirSync(dir, { recursive: true });
    // Filename is a UUID but the body claims a different id — hostile.
    fs.writeFileSync(
      path.join(dir, `${fakeId}.json`),
      JSON.stringify({
        id: '../../../etc/passwd',
        projectId: 'proj',
        title: 'pwn',
        createdAt: 1,
        updatedAt: 1,
        messages: [],
      }),
    );
    // Filename is not a UUID — should be skipped entirely.
    fs.writeFileSync(path.join(dir, 'evil.json'), JSON.stringify({
      id: 'evil',
      projectId: 'proj',
      title: 'x',
      messages: [],
    }));

    const threads = await listThreads(tmpRoot);
    expect(threads).toEqual([]);
  });

  it('updateThreadConfig writes the config and bumps updatedAt', async () => {
    const thread = await createThread(tmpRoot, 'cfg');
    const before = thread.updatedAt;

    await new Promise((r) => setTimeout(r, 2)); // ensure ts difference
    const updated = await updateThreadConfig(tmpRoot, thread.id, {
      model: 'sonnet-4-6',
      allowedTools: ['Read', 'Grep'],
    });

    expect(updated.config).toEqual({
      model: 'sonnet-4-6',
      allowedTools: ['Read', 'Grep'],
    });
    expect(updated.updatedAt).toBeGreaterThan(before);

    const onDisk = JSON.parse(
      fs.readFileSync(threadFile(tmpRoot, thread.id), 'utf8'),
    );
    expect(onDisk.config.model).toBe('sonnet-4-6');
  });

  it('updateThreadConfig with null clears an existing config', async () => {
    const thread = await createThread(tmpRoot);
    await updateThreadConfig(tmpRoot, thread.id, { model: 'opus' });
    const cleared = await updateThreadConfig(tmpRoot, thread.id, null);
    expect(cleared.config).toBeUndefined();
  });

  it('deleteThread removes the file and drops it from listThreads', async () => {
    const thread = await createThread(tmpRoot, 'kill me');
    expect(fs.existsSync(threadFile(tmpRoot, thread.id))).toBe(true);

    await deleteThread(tmpRoot, thread.id);

    expect(fs.existsSync(threadFile(tmpRoot, thread.id))).toBe(false);
    const remaining = await listThreads(tmpRoot);
    expect(remaining.find((t) => t.id === thread.id)).toBeUndefined();
  });

  it('persistThread roundtrips an in-memory thread to disk', async () => {
    const thread = await createThread(tmpRoot);
    thread.messages.push({
      id: 'm1',
      role: 'user',
      content: 'hi',
      toolCalls: [],
      createdAt: 1,
      status: 'done',
    });
    await persistThread(tmpRoot, thread);

    const onDisk = JSON.parse(
      fs.readFileSync(threadFile(tmpRoot, thread.id), 'utf8'),
    );
    expect(onDisk.messages).toHaveLength(1);
    expect(onDisk.messages[0].content).toBe('hi');
  });

  it('persistThread is atomic — failure leaves prior valid file intact', async () => {
    // First write a known-good thread, then attempt a write that fails
    // mid-flight by passing a value JSON.stringify can't serialize. The
    // tmp+rename pattern means the failed write never replaces the good
    // file, so listThreads still finds the original.
    const thread = await createThread(tmpRoot, 'before');
    thread.title = 'after';

    // Inject an unserialisable value to force JSON.stringify to throw.
    const bigint = BigInt(1) as unknown as string;
    const sabotaged = { ...thread, evil: bigint };
    await expect(persistThread(tmpRoot, sabotaged)).rejects.toBeTruthy();

    // The good file must still be present and readable. No `.tmp` files
    // should be left behind in the threads dir.
    const onDisk = JSON.parse(
      fs.readFileSync(threadFile(tmpRoot, thread.id), 'utf8'),
    );
    expect(onDisk.title).toBe('before');
    const dir = path.dirname(threadFile(tmpRoot, thread.id));
    const stragglers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(stragglers).toEqual([]);
  });
});

// v0.27 performance split: listThreads ships lightweight metadata only, and
// the full transcript is fetched lazily per-thread via getThread. These
// tests pin that contract — the list must NOT carry `messages`, and the
// derived counts / flags must be correct.
describe('ChatTranscript metadata + lazy getThread (v0.27)', () => {
  function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
    return {
      id: '00000000-0000-0000-0000-00000000000a',
      role: 'user',
      content: 'hi',
      toolCalls: [],
      createdAt: 1,
      status: 'done',
      ...overrides,
    };
  }

  it('listThreads returns metadata with NO messages field and an accurate messageCount', async () => {
    const thread = await createThread(tmpRoot, 'meta thread');
    thread.messages.push(makeMessage());
    thread.messages.push(
      makeMessage({
        id: '00000000-0000-0000-0000-00000000000b',
        role: 'assistant',
        content: 'hello',
      }),
    );
    await persistThread(tmpRoot, thread);

    const metas = await listThreads(tmpRoot);
    const meta = metas.find((m) => m.id === thread.id);
    expect(meta).toBeDefined();
    // The whole point of the split: no transcript shipped in the list.
    expect((meta as unknown as Record<string, unknown>).messages).toBeUndefined();
    expect(meta!.messageCount).toBe(2);
    expect(meta!.title).toBe('meta thread');
    expect(meta!.hasActiveRun).toBe(false);
  });

  it('listThreads sets hasActiveRun true when the thread carries an in-flight run', async () => {
    const thread = await createThread(tmpRoot, 'running');
    // Mirror the on-disk shape ChatService persists for a live tmux run.
    thread.activeRun = {
      runId: 'run-1',
      sessionName: 'devspace-chatrun-1',
      runDir: threadFile(tmpRoot, thread.id),
      startedAt: Date.now(),
      assistantMessageId: '00000000-0000-0000-0000-00000000000b',
      kind: 'solo',
    };
    await persistThread(tmpRoot, thread);

    const metas = await listThreads(tmpRoot);
    const meta = metas.find((m) => m.id === thread.id);
    expect(meta!.hasActiveRun).toBe(true);
  });

  it('listThreads carries the per-thread config when present', async () => {
    const thread = await createThread(tmpRoot, 'cfg meta');
    await updateThreadConfig(tmpRoot, thread.id, { model: 'opus' });

    const metas = await listThreads(tmpRoot);
    const meta = metas.find((m) => m.id === thread.id);
    expect(meta!.config).toEqual({ model: 'opus' });
  });

  it('getThread returns the full thread WITH messages', async () => {
    const thread = await createThread(tmpRoot, 'full');
    thread.messages.push(makeMessage({ content: 'first' }));
    await persistThread(tmpRoot, thread);

    const full = await getThread(tmpRoot, thread.id);
    expect(full).not.toBeNull();
    expect(full!.id).toBe(thread.id);
    expect(full!.messages).toHaveLength(1);
    expect(full!.messages[0]!.content).toBe('first');
  });

  it('getThread throws on a non-UUID threadId (path-traversal guard)', async () => {
    await expect(getThread(tmpRoot, '../../etc/passwd')).rejects.toThrow(
      /invalid threadId/,
    );
    await expect(getThread(tmpRoot, 'not-a-uuid')).rejects.toThrow(
      /invalid threadId/,
    );
  });

  it('getThread returns null for a well-formed but unknown threadId', async () => {
    // Touch the project so it hydrates, then ask for an id that isn't there.
    await createThread(tmpRoot, 'present');
    const missing = await getThread(
      tmpRoot,
      '99999999-9999-9999-9999-999999999999',
    );
    expect(missing).toBeNull();
  });

  // v0.29 BLOCKER B1 regression — orphaned 'streaming' message sweep.
  // The LLM path has no equivalent to the Claude tmux activeRun resume,
  // so an app crash mid-stream would leave the assistant message stuck
  // at status='streaming' forever, locking the renderer composer.
  it("flips orphaned 'streaming' assistant messages to 'error' on hydrate", async () => {
    const id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const dir = path.join(tmpRoot, '.devspace', 'chat');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${id}.json`),
      JSON.stringify({
        id,
        projectId: path.basename(tmpRoot),
        title: 'orphaned',
        createdAt: 1,
        updatedAt: 2,
        // No activeRun — LLM thread that died mid-stream.
        messages: [
          { id: 'u1', role: 'user', content: 'hi', toolCalls: [], createdAt: 1, status: 'done' },
          {
            id: 'a1',
            role: 'assistant',
            content: 'partial',
            toolCalls: [],
            createdAt: 2,
            status: 'streaming',
          },
        ],
      }),
    );

    const list = await listThreads(tmpRoot);
    expect(list).toHaveLength(1);

    // Sweep should have flipped status + persisted. Re-read fresh from disk.
    const reloaded = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
    const assistant = reloaded.messages[1];
    expect(assistant.status).toBe('error');
    expect(assistant.error).toBe('interrupted');
    expect(assistant.content).toBe('partial');  // partial text preserved
  });

  it("does NOT sweep streaming messages when thread.activeRun is set (Claude resume case)", async () => {
    // Tmux runs DO have a resume path — sweeping them would race with
    // resumeActiveRuns re-attaching to the still-running tmux session.
    const id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const dir = path.join(tmpRoot, '.devspace', 'chat');
    fs.mkdirSync(dir, { recursive: true });
    const runDir = path.join(dir, 'runs', 'r1');
    fs.writeFileSync(
      path.join(dir, `${id}.json`),
      JSON.stringify({
        id,
        projectId: path.basename(tmpRoot),
        title: 'resumable',
        createdAt: 1,
        updatedAt: 2,
        activeRun: {
          runId: 'r1',
          sessionName: 'devspace-chatrun-r1',
          runDir,
          startedAt: 2,
          assistantMessageId: 'a1',
          kind: 'solo',
        },
        messages: [
          { id: 'u1', role: 'user', content: 'hi', toolCalls: [], createdAt: 1, status: 'done' },
          {
            id: 'a1',
            role: 'assistant',
            content: 'partial',
            toolCalls: [],
            createdAt: 2,
            status: 'streaming',
          },
        ],
      }),
    );

    await listThreads(tmpRoot);

    const reloaded = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
    const assistant = reloaded.messages[1];
    // Status untouched — the resume path owns this.
    expect(assistant.status).toBe('streaming');
    expect(assistant.error).toBeUndefined();
  });
});

// v0.30.3 regression: per-thread active-run lock. Before this release
// the project carried a single `activeRunHandle` + `activeLlmRunHandle`
// pair plus `activeThreadId`, so any in-flight run blocked sendMessage
// on every other thread in the same project ("a chat turn is already
// running for this project"). Now the lock is keyed by threadId, which
// lets a Claude thread A continue streaming while the user kicks off
// thread B on OpenCode. These tests pin the new state shape so that
// invariant can't silently regress.
describe('ProjectState per-thread active-run maps (v0.30.3)', () => {
  it('getState seeds empty per-thread Maps (not single handles)', async () => {
    // Lazy import so we exercise the same module-level singleton the
    // production code does (states are keyed by resolved projectPath).
    const { getState } = await import('@main/services/ChatTranscript');
    const state = getState(tmpRoot);
    expect(state.activeRunsByThread).toBeInstanceOf(Map);
    expect(state.activeLlmRunsByThread).toBeInstanceOf(Map);
    expect(state.activeRunsByThread.size).toBe(0);
    expect(state.activeLlmRunsByThread.size).toBe(0);
    // Type-level pin: legacy fields must NOT exist anymore. If a future
    // contributor re-introduces them as a "convenience", typecheck will
    // pass but this access compiles to undefined and the assertion fails.
    expect((state as unknown as { activeRunHandle?: unknown }).activeRunHandle).toBeUndefined();
    expect((state as unknown as { activeLlmRunHandle?: unknown }).activeLlmRunHandle).toBeUndefined();
    expect((state as unknown as { activeThreadId?: unknown }).activeThreadId).toBeUndefined();
  });

  it('deleteThread kills ONLY the target thread; sibling thread entries survive', async () => {
    const { getState, deleteThread } = await import('@main/services/ChatTranscript');
    const threadA = await createThread(tmpRoot, 'A');
    const threadB = await createThread(tmpRoot, 'B');
    const state = getState(tmpRoot);

    // Simulate two in-flight runs (one per thread). The kill stub flips
    // a flag so we can prove the right handle was targeted.
    let killedA = false;
    let killedB = false;
    const handleA = {
      promise: new Promise(() => {}),
      kill: async () => {
        killedA = true;
      },
      sessionName: 'sess-A',
      runDir: '/tmp/A',
      detached: false,
    };
    const handleB = {
      promise: new Promise(() => {}),
      kill: async () => {
        killedB = true;
      },
      sessionName: 'sess-B',
      runDir: '/tmp/B',
      detached: false,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    state.activeRunsByThread.set(threadA.id, handleA as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    state.activeRunsByThread.set(threadB.id, handleB as any);

    await deleteThread(tmpRoot, threadA.id);

    // Only A was killed; B's run keeps streaming (the user's other tab).
    expect(killedA).toBe(true);
    expect(killedB).toBe(false);
    expect(state.activeRunsByThread.has(threadA.id)).toBe(false);
    expect(state.activeRunsByThread.has(threadB.id)).toBe(true);
  });
});
