import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createThread,
  deleteThread,
  listThreads,
  persistThread,
  threadFile,
  updateThreadConfig,
} from '@main/services/ChatTranscript';

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
