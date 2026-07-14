// The lead chat backend against a mocked runner and a real temp project dir:
// prompt-stuffing shape, the one-turn-per-project busy lock, the 200-message
// history cap, and what a failed turn looks like to the panel.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The runner is the only thing here that would touch tmux / claude / the app
// paths. Mocked out entirely — everything else (the store, the prompt, the lock)
// is the real thing.
vi.mock('@main/services/flowChatRunner', () => ({
  runLeadTurn: vi.fn(async () => ({ ok: true, text: 'mocked' })),
}));

import { createFlowChatService, type FlowChatService } from '../FlowChatService';
import { HISTORY_CAP, chatFile, loadChat, saveChat } from '../flowChatStore';
import type { FlowChatEvent, FlowChatMessage } from '@shared/flowTypes';

let proj: string;
let svc: FlowChatService;
let events: FlowChatEvent[];
let prompts: string[];
// Per-turn control: the test decides when (and how) a turn answers.
let answer: (r: { ok: boolean; text: string; error?: string }) => void;
let pending: Promise<{ ok: boolean; text: string; error?: string }>;

const armTurn = (): void => {
  pending = new Promise((res) => {
    answer = res;
  });
};

const make = (id = 0): FlowChatService => {
  let n = id;
  return createFlowChatService({
    onEvent: (e) => events.push(e),
    now: () => 1_000,
    idgen: () => `m${n++}`,
    runTurn: async (_projectPath, prompt) => {
      prompts.push(prompt);
      return pending;
    },
  });
};

beforeEach(async () => {
  proj = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'flowchat-'));
  events = [];
  prompts = [];
  armTurn();
  svc = make();
});

afterEach(async () => {
  await fs.promises.rm(proj, { recursive: true, force: true });
});

describe('send — the turn lifecycle', () => {
  it('persists the user message and pushes busy BEFORE the model answers', async () => {
    const res = await svc.send(proj, 'hi lead');
    expect(res).toEqual({ ok: true });

    // send does NOT wait for the model: the user bubble + the typing indicator
    // are already out, and the panel is responsive.
    expect(events).toEqual([
      {
        projectPath: proj,
        message: { id: 'm0', role: 'user', text: 'hi lead', at: 1_000 },
        busy: true,
      },
    ]);
    expect(svc.isBusy(proj)).toBe(true);
    expect(await loadChat(proj)).toHaveLength(1);

    answer({ ok: true, text: '  hello back  ' });
    await svc.whenIdle(proj);

    expect(events[1]).toEqual({
      projectPath: proj,
      message: { id: 'm1', role: 'lead', text: 'hello back', at: 1_000 },
      busy: false,
    });
    expect(svc.isBusy(proj)).toBe(false);

    const history = await loadChat(proj);
    expect(history.map((m) => [m.role, m.text])).toEqual([
      ['user', 'hi lead'],
      ['lead', 'hello back'],
    ]);
  });

  it('writes the history to <project>/.devspace/flows/chat.json', async () => {
    await svc.send(proj, 'hi');
    answer({ ok: true, text: 'yo' });
    await svc.whenIdle(proj);

    expect(chatFile(proj)).toBe(path.join(proj, '.devspace', 'flows', 'chat.json'));
    const raw = JSON.parse(await fs.promises.readFile(chatFile(proj), 'utf8'));
    expect(Array.isArray(raw)).toBe(true);
    expect(raw).toHaveLength(2);
  });

  it('rejects an empty message', async () => {
    expect(await svc.send(proj, '   ')).toEqual({ ok: false, error: 'message required' });
    expect(events).toEqual([]);
  });
});

describe('busy lock', () => {
  it('refuses a second turn while one is in flight', async () => {
    await svc.send(proj, 'first');
    const second = await svc.send(proj, 'second');

    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/busy/);
    expect(prompts).toHaveLength(1); // the second turn never started
    expect(await loadChat(proj)).toHaveLength(1); // …and never wrote a message

    answer({ ok: true, text: 'done' });
    await svc.whenIdle(proj);

    // The lock releases with the turn.
    armTurn();
    expect((await svc.send(proj, 'third')).ok).toBe(true);
  });

  it('claims the lock synchronously — two racing sends cannot both start', async () => {
    // Both calls are issued before either has awaited anything, which is exactly
    // what two IPC handlers landing in the same tick look like.
    const [a, b] = await Promise.all([svc.send(proj, 'one'), svc.send(proj, 'two')]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(prompts).toHaveLength(1);
  });

  it('locks per project, not globally', async () => {
    const other = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'flowchat2-'));
    try {
      await svc.send(proj, 'first');
      expect((await svc.send(other, 'other project')).ok).toBe(true);
      expect(prompts).toHaveLength(2);
    } finally {
      answer({ ok: true, text: 'x' });
      await svc.whenIdle(proj);
      await svc.whenIdle(other);
      await fs.promises.rm(other, { recursive: true, force: true });
    }
  });

  it('releases the lock when the runner throws', async () => {
    const boom = createFlowChatService({
      onEvent: (e) => events.push(e),
      runTurn: async () => {
        throw new Error('tmux exploded');
      },
    });
    await boom.send(proj, 'hi');
    await boom.whenIdle(proj);

    expect(boom.isBusy(proj)).toBe(false);
    const history = await loadChat(proj);
    expect(history[1].error).toBe(true);
    expect(history[1].text).toMatch(/tmux exploded/);
  });
});

describe('prompt stuffing', () => {
  it('carries the whole conversation forward (continuity without --resume)', async () => {
    await svc.send(proj, 'run the feature pipeline');
    answer({ ok: true, text: 'which one — pipeline or hotfix?' });
    await svc.whenIdle(proj);

    armTurn();
    await svc.send(proj, 'the pipeline');
    const p = prompts[1];

    expect(p).toContain('run the feature pipeline'); // earlier user turn
    expect(p).toContain('which one — pipeline or hotfix?'); // earlier lead turn
    expect(p).toContain('## The user just said');
    expect(p.indexOf('the pipeline')).toBeGreaterThan(p.indexOf('## Conversation so far'));
  });

  it('includes the lead preamble: the tools, ask-don\'t-guess, and the language rule', async () => {
    await svc.send(proj, 'hi');
    const p = prompts[0];

    expect(p).toContain(proj); // the lead knows which project it leads
    expect(p).toContain('list_flows');
    expect(p).toContain('run_flow');
    expect(p).toContain('flow_status');
    expect(p).toContain('send_flow');
    expect(p).toContain('stop_flow');
    expect(p).toMatch(/ASK, DO NOT GUESS/);
    expect(p).toMatch(/Never invent a flow name/);
    expect(p).toMatch(/Reply in the user's language/);
  });
});

describe('history cap + clear', () => {
  it('keeps only the newest 200 messages', async () => {
    const seed: FlowChatMessage[] = Array.from({ length: 260 }, (_, i) => ({
      id: `s${i}`,
      role: i % 2 === 0 ? 'user' : 'lead',
      text: `msg ${i}`,
      at: i,
    }));
    await saveChat(proj, seed);
    expect(await loadChat(proj)).toHaveLength(HISTORY_CAP);

    await svc.send(proj, 'newest');
    answer({ ok: true, text: 'ok' });
    await svc.whenIdle(proj);

    const history = await loadChat(proj);
    expect(history).toHaveLength(HISTORY_CAP);
    expect(history[history.length - 1].text).toBe('ok');
    expect(history[history.length - 2].text).toBe('newest');
    expect(history.some((m) => m.text === 'msg 0')).toBe(false); // oldest dropped
  });

  it('clear removes the file, and a missing file reads as an empty chat', async () => {
    await svc.send(proj, 'hi');
    answer({ ok: true, text: 'yo' });
    await svc.whenIdle(proj);

    await svc.clear(proj);
    expect(await svc.history(proj)).toEqual([]);
    await expect(svc.clear(proj)).resolves.toBeUndefined(); // idempotent
  });

  it('survives a corrupt / hand-edited history file', async () => {
    await fs.promises.mkdir(path.dirname(chatFile(proj)), { recursive: true });
    await fs.promises.writeFile(chatFile(proj), '{not json');
    expect(await svc.history(proj)).toEqual([]);

    await fs.promises.writeFile(chatFile(proj), JSON.stringify([{ junk: true }, null]));
    expect(await svc.history(proj)).toEqual([]); // shape-checked, not crashed
  });
});

describe('a failed turn', () => {
  it('renders as a lead message flagged error, with a readable reason', async () => {
    await svc.send(proj, 'hi');
    answer({ ok: false, text: '', error: 'claude exited 1' });
    await svc.whenIdle(proj);

    const lead = (await loadChat(proj))[1];
    expect(lead.role).toBe('lead');
    expect(lead.error).toBe(true);
    expect(lead.text).toMatch(/claude exited 1/);
    expect(events.at(-1)?.busy).toBe(false); // the typing indicator always clears
  });

  it('treats an exit-0 turn that said nothing as a failure', async () => {
    await svc.send(proj, 'hi');
    answer({ ok: true, text: '   ' });
    await svc.whenIdle(proj);

    const lead = (await loadChat(proj))[1];
    expect(lead.error).toBe(true);
    expect(lead.text).toMatch(/no output/);
  });
});
