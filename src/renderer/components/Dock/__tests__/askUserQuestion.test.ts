import { describe, expect, it } from 'vitest';

import {
  allAnswered,
  answeredCount,
  autoSubmitsOnPick,
  buildAnswerText,
  needsSubmitButton,
  parseQuestions,
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
