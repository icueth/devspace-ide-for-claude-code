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
    // Drop two thread JSON files directly so we exercise the hydration
    // path rather than the in-memory cache.
    const dir = path.join(tmpRoot, '.devspace', 'chat');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'a.json'),
      JSON.stringify({
        id: 'a',
        projectId: 'proj',
        title: 'older',
        createdAt: 1,
        updatedAt: 100,
        messages: [],
      }),
    );
    fs.writeFileSync(
      path.join(dir, 'b.json'),
      JSON.stringify({
        id: 'b',
        projectId: 'proj',
        title: 'newer',
        createdAt: 2,
        updatedAt: 200,
        messages: [],
      }),
    );

    const threads = await listThreads(tmpRoot);
    expect(threads.map((t) => t.id)).toEqual(['b', 'a']);
  });

  it('skips corrupt thread JSON during hydration without throwing', async () => {
    const dir = path.join(tmpRoot, '.devspace', 'chat');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify({
      id: 'good',
      projectId: 'proj',
      title: 'ok',
      createdAt: 1,
      updatedAt: 1,
      messages: [],
    }));
    fs.writeFileSync(path.join(dir, 'broken.json'), 'not json {');

    const threads = await listThreads(tmpRoot);
    expect(threads.map((t) => t.id)).toEqual(['good']);
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
});
