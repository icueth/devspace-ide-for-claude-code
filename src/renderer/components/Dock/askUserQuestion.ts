// Pure helpers for the AskUserQuestion answer card. Kept out of the
// React component so the answer-building + readiness logic is unit
// testable (mirrors the chatEvents.ts / atMention.ts split).

export type AskQuestion = {
  question?: string;
  header?: string;
  multiSelect?: boolean;
  options?: Array<{ label?: string; description?: string }>;
};

export type AskUserQuestionPayload = {
  questions?: AskQuestion[];
};

/** Normalize a tool_use input into a guaranteed array of questions. */
export function parseQuestions(input: unknown): AskQuestion[] {
  const payload = input as AskUserQuestionPayload | null | undefined;
  return Array.isArray(payload?.questions) ? payload!.questions! : [];
}

/** Count of questions that have at least one selected option. */
export function answeredCount(
  questions: AskQuestion[],
  selected: Record<number, Set<string>>,
): number {
  return questions.reduce(
    (n, _q, i) => n + ((selected[i]?.size ?? 0) > 0 ? 1 : 0),
    0,
  );
}

/**
 * True only when EVERY question has at least one pick. An empty question
 * list is never "answered" (nothing to submit).
 */
export function allAnswered(
  questions: AskQuestion[],
  selected: Record<number, Set<string>>,
): boolean {
  if (questions.length === 0) return false;
  return answeredCount(questions, selected) === questions.length;
}

/**
 * True when a single click fully answers the prompt, so the card should
 * SEND the answer immediately on pick — the common 1-question single-select
 * case (matches native AskUserQuestion "click = answer"). v0.26.x fix: the
 * card previously only appended text, so clicking never resumed the turn.
 */
export function autoSubmitsOnPick(questions: AskQuestion[]): boolean {
  return questions.length === 1 && !questions[0]?.multiSelect;
}

/**
 * True when picks must be gathered behind an explicit Submit button —
 * multi-select questions (any number of picks) or multiple questions that
 * must all be answered before a single send.
 */
export function needsSubmitButton(questions: AskQuestion[]): boolean {
  return questions.length > 1 || questions.some((q) => !!q.multiSelect);
}

/**
 * Build the resume message from the user's picks — one line per answered
 * question: `[Header] Selected: "A", "B"`. Questions with no pick are
 * skipped; the header prefix is omitted when absent. Returns '' when
 * nothing is selected.
 */
export function buildAnswerText(
  questions: AskQuestion[],
  selected: Record<number, Set<string>>,
): string {
  const lines: string[] = [];
  questions.forEach((q, i) => {
    const picks = Array.from(selected[i] ?? []);
    if (picks.length === 0) return;
    const header = q.header ? `[${q.header}] ` : '';
    const body = picks.map((p) => `"${p}"`).join(', ');
    lines.push(`${header}Selected: ${body}`);
  });
  return lines.join('\n');
}
