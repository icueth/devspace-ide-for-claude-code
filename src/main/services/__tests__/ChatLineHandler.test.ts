import { describe, expect, it } from 'vitest';

import {
  type ClaudeStreamEvent,
  makeSoloLineHandler,
  makeStepLineHandler,
  parseStreamLine,
} from '@main/services/ChatLineHandler';
import type { ProjectState } from '@main/services/ChatTranscript';
import type { ChatMessage, ChatThread, TeamStep } from '@shared/types';

function emptyState(): ProjectState {
  return {
    projectPath: '/tmp/devspace-test',
    threads: new Map(),
    activeRunHandle: null,
    activeThreadId: null,
    subscribers: new Set(),
    hydrationPromise: Promise.resolve(),
  };
}

function freshAssistant(): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: '',
    toolCalls: [],
    createdAt: 0,
    status: 'streaming',
  };
}

function freshThread(): ChatThread {
  return {
    id: 'thread-1',
    projectId: 'proj',
    title: 'New chat',
    createdAt: 0,
    updatedAt: 0,
    messages: [],
  };
}

function freshStep(): TeamStep {
  return {
    agentSlug: 'reviewer',
    agentName: 'Reviewer',
    status: 'running',
    content: '',
    toolCalls: [],
  };
}

function asLine(e: ClaudeStreamEvent): string {
  return JSON.stringify(e);
}

describe('parseStreamLine', () => {
  it('returns the parsed event for valid JSON', () => {
    expect(parseStreamLine('{"type":"assistant"}')).toEqual({ type: 'assistant' });
  });

  it('returns null for malformed JSON instead of throwing', () => {
    expect(parseStreamLine('not json')).toBeNull();
    expect(parseStreamLine('')).toBeNull();
    expect(parseStreamLine('{"unclosed":')).toBeNull();
  });
});

describe('makeSoloLineHandler', () => {
  it('appends text deltas to assistant.content across multiple events', () => {
    const state = emptyState();
    const thread = freshThread();
    const assistant = freshAssistant();
    const handle = makeSoloLineHandler(state, thread, assistant);

    handle(
      asLine({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hello ' }] },
      }),
    );
    handle(
      asLine({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'world' }] },
      }),
    );

    expect(assistant.content).toBe('hello world');
  });

  it('accumulates thinking blocks separately from content', () => {
    const state = emptyState();
    const thread = freshThread();
    const assistant = freshAssistant();
    const handle = makeSoloLineHandler(state, thread, assistant);

    handle(
      asLine({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'reasoning…' },
            { type: 'text', text: 'answer' },
          ],
        },
      }),
    );

    expect(assistant.thinking).toBe('reasoning…');
    expect(assistant.content).toBe('answer');
  });

  it('records tool_use and matches the subsequent tool_result by id', () => {
    const state = emptyState();
    const thread = freshThread();
    const assistant = freshAssistant();
    const handle = makeSoloLineHandler(state, thread, assistant);

    handle(
      asLine({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-abc',
              name: 'Read',
              input: { path: '/etc/hosts' },
            },
          ],
        },
      }),
    );
    handle(
      asLine({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-abc',
              content: 'file contents',
              is_error: false,
            },
          ],
        },
      }),
    );

    expect(assistant.toolCalls).toHaveLength(1);
    expect(assistant.toolCalls[0]).toMatchObject({
      id: 'tool-abc',
      name: 'Read',
      result: 'file contents',
      isError: false,
    });
  });

  it('flattens array-form tool_result.content to a single string', () => {
    const state = emptyState();
    const thread = freshThread();
    const assistant = freshAssistant();
    const handle = makeSoloLineHandler(state, thread, assistant);

    handle(
      asLine({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 't', name: 'Grep', input: {} }],
        },
      }),
    );
    handle(
      asLine({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't',
              content: [
                { type: 'text', text: 'foo' },
                { type: 'text', text: 'bar' },
                { type: 'image', text: 'dropped' },
              ],
              is_error: true,
            },
          ],
        },
      }),
    );

    expect(assistant.toolCalls[0]!.result).toBe('foobar');
    expect(assistant.toolCalls[0]!.isError).toBe(true);
  });

  it('captures usage from result events', () => {
    const state = emptyState();
    const thread = freshThread();
    const assistant = freshAssistant();
    const handle = makeSoloLineHandler(state, thread, assistant);

    handle(
      asLine({
        type: 'result',
        usage: { input_tokens: 1234, output_tokens: 567 },
      }),
    );

    expect(assistant.usage).toEqual({ input: 1234, output: 567 });
  });

  it('ignores malformed lines silently', () => {
    const state = emptyState();
    const thread = freshThread();
    const assistant = freshAssistant();
    const handle = makeSoloLineHandler(state, thread, assistant);

    expect(() => handle('not json at all')).not.toThrow();
    expect(assistant.content).toBe('');
    expect(assistant.toolCalls).toHaveLength(0);
  });

  it('generates a tool id when claude omits one', () => {
    const state = emptyState();
    const thread = freshThread();
    const assistant = freshAssistant();
    const handle = makeSoloLineHandler(state, thread, assistant);

    handle(
      asLine({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Read', input: { path: 'x' } }],
        },
      }),
    );

    expect(assistant.toolCalls[0]!.id).toMatch(/.+/);
  });
});

describe('makeStepLineHandler', () => {
  it('routes content into the step target instead of the assistant message', () => {
    const state = emptyState();
    const thread = freshThread();
    const step = freshStep();
    const handle = makeStepLineHandler(state, thread, step, 2);

    handle(
      asLine({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'step output' }] },
      }),
    );

    expect(step.content).toBe('step output');
  });

  it('builds chronological segments for the step target', () => {
    const state = emptyState();
    const thread = freshThread();
    const step = freshStep();
    const handle = makeStepLineHandler(state, thread, step, 0);

    handle(
      asLine({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'plan: ' },
            { type: 'tool_use', id: 't1', name: 'Read', input: {} },
            { type: 'text', text: 'done.' },
          ],
        },
      }),
    );

    expect(step.segments).toBeDefined();
    expect(step.segments).toHaveLength(3);
    expect(step.segments![0]).toMatchObject({ kind: 'text', text: 'plan: ' });
    expect(step.segments![1]).toMatchObject({
      kind: 'tool_group',
      toolUseIds: ['t1'],
    });
    expect(step.segments![2]).toMatchObject({ kind: 'text', text: 'done.' });
  });
});

describe('segments — chronological assembly', () => {
  it('a single text block produces one text segment containing that text', () => {
    const state = emptyState();
    const thread = freshThread();
    const assistant = freshAssistant();
    const handle = makeSoloLineHandler(state, thread, assistant);

    handle(
      asLine({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'just text' }] },
      }),
    );

    expect(assistant.segments).toBeDefined();
    expect(assistant.segments).toHaveLength(1);
    const seg = assistant.segments![0]!;
    expect(seg.kind).toBe('text');
    if (seg.kind === 'text') {
      expect(seg.text).toBe('just text');
      expect(seg.id).toMatch(/.+/);
    }
  });

  it('text → tool_use → text produces three segments in that order', () => {
    const state = emptyState();
    const thread = freshThread();
    const assistant = freshAssistant();
    const handle = makeSoloLineHandler(state, thread, assistant);

    handle(
      asLine({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'analyzing… ' },
            { type: 'tool_use', id: 't-1', name: 'Read', input: { path: '/x' } },
            { type: 'text', text: 'found it.' },
          ],
        },
      }),
    );

    expect(assistant.segments).toHaveLength(3);
    expect(assistant.segments![0]).toMatchObject({
      kind: 'text',
      text: 'analyzing… ',
    });
    expect(assistant.segments![1]).toMatchObject({
      kind: 'tool_group',
      toolUseIds: ['t-1'],
    });
    expect(assistant.segments![2]).toMatchObject({
      kind: 'text',
      text: 'found it.',
    });
  });

  it('back-to-back text blocks coalesce into one text segment', () => {
    const state = emptyState();
    const thread = freshThread();
    const assistant = freshAssistant();
    const handle = makeSoloLineHandler(state, thread, assistant);

    handle(
      asLine({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hello ' }] },
      }),
    );
    handle(
      asLine({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'world' }] },
      }),
    );

    expect(assistant.segments).toHaveLength(1);
    expect(assistant.segments![0]).toMatchObject({
      kind: 'text',
      text: 'hello world',
    });
  });

  it('back-to-back tool_use blocks coalesce into one tool_group with multiple ids', () => {
    const state = emptyState();
    const thread = freshThread();
    const assistant = freshAssistant();
    const handle = makeSoloLineHandler(state, thread, assistant);

    handle(
      asLine({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'a', name: 'Read', input: {} },
            { type: 'tool_use', id: 'b', name: 'Grep', input: {} },
          ],
        },
      }),
    );

    expect(assistant.segments).toHaveLength(1);
    expect(assistant.segments![0]).toMatchObject({
      kind: 'tool_group',
      toolUseIds: ['a', 'b'],
    });
  });

  it('thinking blocks do not break a run of text segments', () => {
    const state = emptyState();
    const thread = freshThread();
    const assistant = freshAssistant();
    const handle = makeSoloLineHandler(state, thread, assistant);

    handle(
      asLine({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'before ' },
            { type: 'thinking', thinking: 'pondering…' },
            { type: 'text', text: 'after' },
          ],
        },
      }),
    );

    expect(assistant.segments).toHaveLength(1);
    expect(assistant.segments![0]).toMatchObject({
      kind: 'text',
      text: 'before after',
    });
    expect(assistant.thinking).toBe('pondering…');
  });

  it('content stays in sync as the concatenation of all text segments', () => {
    const state = emptyState();
    const thread = freshThread();
    const assistant = freshAssistant();
    const handle = makeSoloLineHandler(state, thread, assistant);

    handle(
      asLine({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'one ' },
            { type: 'tool_use', id: 't1', name: 'Read', input: {} },
            { type: 'text', text: 'two ' },
            { type: 'tool_use', id: 't2', name: 'Edit', input: {} },
            { type: 'text', text: 'three' },
          ],
        },
      }),
    );

    const concatenated = assistant
      .segments!.filter((s): s is Extract<typeof s, { kind: 'text' }> => s.kind === 'text')
      .map((s) => s.text)
      .join('');
    expect(assistant.content).toBe(concatenated);
    expect(assistant.content).toBe('one two three');
  });

  it('attaches diffStats to file-mutating tool calls', () => {
    const state = emptyState();
    const thread = freshThread();
    const assistant = freshAssistant();
    const handle = makeSoloLineHandler(state, thread, assistant);

    handle(
      asLine({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'edit-1',
              name: 'Edit',
              input: {
                file_path: '/tmp/devspace-test/src/foo.ts',
                old_string: 'a\nb',
                new_string: 'a\nb\nc\nd',
              },
            },
          ],
        },
      }),
    );

    expect(assistant.toolCalls[0]!.diffStats).toEqual({
      additions: 4,
      deletions: 2,
      path: 'src/foo.ts',
    });
  });

  it('broadcasts diffStats on the tool_use stream event for file-mutating tools', () => {
    // Regression for 0.16.2: in 0.16.0/0.16.1 the diffStats chip only
    // appeared after a thread reload because the live broadcast event
    // omitted the field. Renderer's tool_use reducer then created a
    // toolCall without diffStats. Pin the field on the broadcast.
    const state = emptyState();
    const events: unknown[] = [];
    // Fake WebContents subscriber capturing every broadcast payload.
    const fakeWc = {
      isDestroyed: () => false,
      send: (_channel: string, payload: unknown) => events.push(payload),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    state.subscribers.add(fakeWc as any);

    const thread = freshThread();
    const assistant = freshAssistant();
    const handle = makeSoloLineHandler(state, thread, assistant);

    handle(
      asLine({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'edit-1',
              name: 'Edit',
              input: {
                file_path: '/tmp/devspace-test/src/foo.ts',
                old_string: 'a\nb',
                new_string: 'a\nb\nc\nd',
              },
            },
          ],
        },
      }),
    );

    const toolUseBroadcast = events.find(
      (e): e is { event: { kind: string; diffStats?: unknown } } =>
        typeof e === 'object' &&
        e !== null &&
        'event' in e &&
        (e as { event: { kind: string } }).event.kind === 'tool_use',
    );
    expect(toolUseBroadcast).toBeDefined();
    expect(toolUseBroadcast!.event.diffStats).toEqual({
      additions: 4,
      deletions: 2,
      path: 'src/foo.ts',
    });
  });

  it('leaves diffStats undefined for non-file-mutating tools', () => {
    const state = emptyState();
    const thread = freshThread();
    const assistant = freshAssistant();
    const handle = makeSoloLineHandler(state, thread, assistant);

    handle(
      asLine({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'read-1',
              name: 'Read',
              input: { file_path: '/etc/hosts' },
            },
          ],
        },
      }),
    );

    expect(assistant.toolCalls[0]!.diffStats).toBeUndefined();
  });

  it('toolCalls ids match the union of all tool_group.toolUseIds in order', () => {
    const state = emptyState();
    const thread = freshThread();
    const assistant = freshAssistant();
    const handle = makeSoloLineHandler(state, thread, assistant);

    handle(
      asLine({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'plan ' },
            { type: 'tool_use', id: 't1', name: 'Read', input: {} },
            { type: 'tool_use', id: 't2', name: 'Read', input: {} },
            { type: 'text', text: 'review ' },
            { type: 'tool_use', id: 't3', name: 'Edit', input: {} },
          ],
        },
      }),
    );

    const idsFromSegments = assistant
      .segments!.filter(
        (s): s is Extract<typeof s, { kind: 'tool_group' }> => s.kind === 'tool_group',
      )
      .flatMap((s) => s.toolUseIds);
    const idsFromToolCalls = assistant.toolCalls.map((c) => c.id);
    expect(idsFromSegments).toEqual(['t1', 't2', 't3']);
    expect(idsFromToolCalls).toEqual(idsFromSegments);
  });
});
