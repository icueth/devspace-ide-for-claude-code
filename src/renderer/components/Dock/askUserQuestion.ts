// Pure helpers for the AskUserQuestion answer card. Kept out of the
// React component so the answer-building + readiness logic is unit
// testable (mirrors the chatEvents.ts / atMention.ts split).

/**
 * What happened when the card tried to resume the turn with the user's
 * answer. v0.28.2 fix: replaces the prior fire-and-forget void path that
 * lied "✓ Answer sent" even when the answer was silently parked in the
 * textarea or swallowed by a null submitter.
 *   - 'sent'   → reached api.chat.send; backend is resuming
 *   - 'parked' → text dropped in textarea; user must press Send to submit
 *   - 'failed' → couldn't even park (real bug; surface inline error)
 */
export type AnswerOutcome = 'sent' | 'parked' | 'failed';

/**
 * Decide which AnswerOutcome to surface given the runtime state. Pure
 * decision (no side effects) so the card's status row stays in sync with
 * what actually happened in the submitter. Caller runs the matching side
 * effect (chat.send / append / nothing).
 */
export function resolveAnswerOutcome(opts: {
  /** A thread is selected — required for api.chat.send to have a target. */
  hasActiveThread: boolean;
  /** A previous send is still in flight; safer to park than race. */
  isSending: boolean;
  /** Textarea appender is wired — fallback target when send isn't possible. */
  hasAppender: boolean;
  /** True iff the actual submit call threw (network/IPC failure). */
  sendThrew: boolean;
}): AnswerOutcome {
  if (opts.sendThrew || !opts.hasActiveThread || opts.isSending) {
    return opts.hasAppender ? 'parked' : 'failed';
  }
  return 'sent';
}

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
