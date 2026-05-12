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
});
