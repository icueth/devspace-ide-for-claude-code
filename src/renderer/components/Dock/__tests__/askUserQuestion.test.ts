import { describe, expect, it } from 'vitest';

import {
  allAnswered,
  answeredCount,
  autoSubmitsOnPick,
  buildAnswerText,
  isThreadBusyError,
  needsSubmitButton,
  parseQuestions,
  resolveAnswerOutcome,
  type AskQuestion,
} from '../askUserQuestion';

const pick = (entries: Record<number, string[]>): Record<number, Set<string>> =>
  Object.fromEntries(
    Object.entries(entries).map(([k, v]) => [Number(k), new Set(v)]),
  );

describe('parseQuestions', () => {
  it('returns the questions array', () => {
    const input = { questions: [{ question: 'A' }] };
    expect(parseQuestions(input)).toHaveLength(1);
  });

  it('returns [] for missing / non-array / nullish payloads', () => {
    expect(parseQuestions({})).toEqual([]);
    expect(parseQuestions({ questions: 'nope' })).toEqual([]);
    expect(parseQuestions(null)).toEqual([]);
    expect(parseQuestions(undefined)).toEqual([]);
  });
});

describe('answeredCount / allAnswered', () => {
  const questions: AskQuestion[] = [
    { header: 'A', options: [{ label: 'a1' }, { label: 'a2' }] },
    { header: 'B', multiSelect: true, options: [{ label: 'b1' }] },
  ];

  it('counts only questions with ≥1 pick', () => {
    expect(answeredCount(questions, pick({ 0: ['a1'] }))).toBe(1);
    expect(answeredCount(questions, pick({ 0: ['a1'], 1: ['b1'] }))).toBe(2);
    expect(answeredCount(questions, pick({}))).toBe(0);
  });

  it('is allAnswered only when every question has a pick', () => {
    expect(allAnswered(questions, pick({ 0: ['a1'] }))).toBe(false);
    expect(allAnswered(questions, pick({ 0: ['a1'], 1: ['b1'] }))).toBe(true);
  });

  it('treats an empty question list as not answerable', () => {
    expect(allAnswered([], pick({}))).toBe(false);
  });
});

describe('buildAnswerText', () => {
  it('builds a single-select line with header prefix', () => {
    const questions: AskQuestion[] = [{ header: 'Bandwidth fix' }];
    expect(buildAnswerText(questions, pick({ 0: ['Resize at proxy'] }))).toBe(
      '[Bandwidth fix] Selected: "Resize at proxy"',
    );
  });

  it('joins multiple multi-select picks with commas', () => {
    const questions: AskQuestion[] = [{ header: 'Feat', multiSelect: true }];
    expect(buildAnswerText(questions, pick({ 0: ['X', 'Y'] }))).toBe(
      '[Feat] Selected: "X", "Y"',
    );
  });

  it('omits the header prefix when absent', () => {
    const questions: AskQuestion[] = [{}];
    expect(buildAnswerText(questions, pick({ 0: ['only'] }))).toBe(
      'Selected: "only"',
    );
  });

  it('joins answered questions with newlines and skips empty ones', () => {
    const questions: AskQuestion[] = [
      { header: 'A' },
      { header: 'B' },
      { header: 'C' },
    ];
    expect(
      buildAnswerText(questions, pick({ 0: ['a'], 2: ['c'] })),
    ).toBe('[A] Selected: "a"\n[C] Selected: "c"');
  });

  it('returns empty string when nothing is selected', () => {
    expect(buildAnswerText([{ header: 'A' }], pick({}))).toBe('');
  });
});

describe('autoSubmitsOnPick', () => {
  it('is true for a single single-select question (click = answer)', () => {
    expect(autoSubmitsOnPick([{ header: 'A', options: [{ label: 'a' }] }])).toBe(
      true,
    );
  });

  it('is false for a single multi-select question (needs Submit)', () => {
    expect(autoSubmitsOnPick([{ header: 'A', multiSelect: true }])).toBe(false);
  });

  it('is false when there is more than one question', () => {
    expect(autoSubmitsOnPick([{ header: 'A' }, { header: 'B' }])).toBe(false);
  });

  it('is false for an empty question list', () => {
    expect(autoSubmitsOnPick([])).toBe(false);
  });
});

describe('needsSubmitButton', () => {
  it('is false for the auto-submit single single-select case', () => {
    expect(needsSubmitButton([{ header: 'A' }])).toBe(false);
  });

  it('is true when any question is multi-select', () => {
    expect(needsSubmitButton([{ header: 'A', multiSelect: true }])).toBe(true);
  });

  it('is true when there are multiple questions', () => {
    expect(needsSubmitButton([{ header: 'A' }, { header: 'B' }])).toBe(true);
  });
});

describe('resolveAnswerOutcome (regression: card status must match reality)', () => {
  // v0.28.2 root cause: card showed "✓ Answer sent" while the submitter
  // silently parked text in the textarea (or did nothing at all because
  // submitter was null). These cases pin the truth table so the card never
  // lies again.
  const base = {
    hasActiveThread: true,
    isSending: false,
    hasAppender: true,
    sendThrew: false,
  };

  it('returns sent on the happy path', () => {
    expect(resolveAnswerOutcome(base)).toBe('sent');
  });

  it('returns parked when send threw but appender is available', () => {
    expect(resolveAnswerOutcome({ ...base, sendThrew: true })).toBe('parked');
  });

  it('returns parked when no active thread (card visible but threadId missing)', () => {
    expect(resolveAnswerOutcome({ ...base, hasActiveThread: false })).toBe(
      'parked',
    );
  });

  it('returns parked when a previous send is still in flight', () => {
    expect(resolveAnswerOutcome({ ...base, isSending: true })).toBe('parked');
  });

  it('returns failed when neither send nor appender is possible', () => {
    expect(
      resolveAnswerOutcome({
        ...base,
        sendThrew: true,
        hasAppender: false,
      }),
    ).toBe('failed');
    expect(
      resolveAnswerOutcome({
        ...base,
        hasActiveThread: false,
        hasAppender: false,
      }),
    ).toBe('failed');
  });

  it('never returns sent when any guard rejects, even with appender', () => {
    // The bug was the opposite: optimistic "sent" while in fact parked.
    // Make sure no guard-rejection branch can leak through as 'sent'.
    const guards = [
      { sendThrew: true },
      { hasActiveThread: false },
      { isSending: true },
    ];
    for (const g of guards) {
      expect(resolveAnswerOutcome({ ...base, ...g })).not.toBe('sent');
    }
  });
});

describe('isThreadBusyError (v0.35.3: retryable answer-submit lock race)', () => {
  it('matches the backend per-thread lock rejection', () => {
    expect(
      isThreadBusyError(new Error('a chat turn is already running for this thread')),
    ).toBe(true);
    // Case-insensitive, tolerant of surrounding context.
    expect(
      isThreadBusyError(new Error('Error: Already Running For This Thread (x)')),
    ).toBe(true);
  });

  it('does NOT match unrelated send failures (must fail fast, never retry)', () => {
    expect(isThreadBusyError(new Error('thread not found: abc'))).toBe(false);
    expect(isThreadBusyError(new Error('ENOSPC: no space left on device'))).toBe(false);
    expect(isThreadBusyError(new Error('a chat turn is already running for this project'))).toBe(
      false,
    );
    expect(isThreadBusyError(undefined)).toBe(false);
    expect(isThreadBusyError(null)).toBe(false);
    expect(isThreadBusyError('plain string')).toBe(false);
  });
});

describe('auto-submit answer text (regression: click must send)', () => {
  // The single-select click builds its send text from a one-pick snapshot,
  // not from flushed component state. Pin that the format stays the canonical
  // `[Header] Selected: "label"` so the resumed turn reads cleanly.
  it('formats a single clicked option as the resume message', () => {
    const questions: AskQuestion[] = [
      { header: 'Bandwidth fix', options: [{ label: 'Resize at proxy' }] },
    ];
    const snapshot = { 0: new Set(['Resize at proxy']) };
    expect(buildAnswerText(questions, snapshot)).toBe(
      '[Bandwidth fix] Selected: "Resize at proxy"',
    );
  });
});
