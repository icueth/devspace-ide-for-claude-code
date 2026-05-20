import { describe, expect, it } from 'vitest';

import {
  allAnswered,
  answeredCount,
  buildAnswerText,
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
