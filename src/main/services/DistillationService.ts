// DistillationService — sub-project 3 (native learning).
//
// Turns recent captured activity (diary + devlog + chat-turn inbox captures +
// recently-updated memory) into durable, retrievable LEARNINGS, distilled by
// REAL Claude via the native BackgroundClaudeRunner (the user's own
// subscription — not the Agent SDK pool, not a hardcoded stub).
//
// Anti-ruflo principle: learnings are plain markdown entries in DevSpace's
// native memory (MemoryService.createEntry → auto-embeds via sub-project 2),
// so they are visible / editable / deletable in the Memory UI and immediately
// semantic-searchable. If a learning is wrong the user prunes it.
//
// Design split (so the heavy MemoryService stays untouched):
//   - gatherActivityDigest / buildDistillPrompt / parseLearnings are PURE-ish
//     and unit-tested (no LLM, no spawn).
//   - distill() is the orchestrator: gather → run `claude -p` (print mode) →
//     parse stdout → semantic de-dupe → createEntry (or route low-confidence
//     to the inbox). It is non-blocking and NEVER throws to the caller; any
//     failure (no claude binary, run failure, unparseable output) is a clean
//     no-op with a status string.
//
// IMPORTANT — why `claude -p` and not BackgroundClaudeRunner: distill needs the
// model's OUTPUT back. BackgroundClaudeRunner spawns `claude --bg --exec` which
// backgrounds the work and returns a stub immediately (the log only echoes the
// run id + prompt, never the response), so the JSON learnings never appear.
// `claude -p` (print / non-interactive) executes the prompt and prints the
// response to stdout synchronously, using the user's normal Claude Code login
// (NOT the Agent SDK credit pool).
//
// The *quality* of Claude's distillation is a judgment call and is NOT
// unit-testable. Tests cover the plumbing (digest bounds, prompt grounding,
// parse tolerance + schema validation, de-dupe decision). Quality is validated
// by a manual run + the user's ability to prune.

import { spawn } from 'node:child_process';

import { resolveClaudeBinary } from '@main/services/ClaudeCliLauncher';
import { enrichedPath } from '@main/utils/setupPaths';
import { createLogger } from '@shared/logger';
import type { MemoryType } from '@shared/types';

import * as Memory from './MemoryService';

const logger = createLogger('Distillation');

// ─── tunables ───────────────────────────────────────────────────────────────

// Hard cap on the activity-digest size handed to Claude. Keeps the prompt
// bounded (token cost + context window) even when a project has a huge diary.
// ~16k chars ≈ a few thousand tokens — plenty of recent context, far below any
// model limit.
const MAX_DIGEST_CHARS = 16_000;
// How many of each source to consider before the char budget trims further.
const MAX_DIARY_ENTRIES = 5;
const MAX_DEVLOG_ENTRIES = 8;
const MAX_INBOX_ITEMS = 10;
const MAX_MEMORY_ENTRIES = 12;
// Per-item body trim so one giant entry can't eat the whole budget.
const MAX_ITEM_CHARS = 1_200;

// Confidence threshold: learnings at/above this are auto-committed as memory
// entries; below it they are routed to the memory inbox for human review
// (reuse the existing inbox rather than auto-committing low-confidence guesses).
const AUTO_COMMIT_CONFIDENCE = 0.6;
// Semantic de-dupe threshold against existing learnings. A candidate whose top
// hybrid-search hit (restricted to learning types) scores at/above this — or
// whose description matches an existing learning verbatim — is treated as a
// duplicate and skipped, so re-runs don't pile up near-identical entries.
const DEDUPE_SCORE_THRESHOLD = 0.6;

// Sentinel markers Claude must wrap its JSON output in. Chosen to be unlikely
// to appear in normal prose and easy to extract from noisy log output.
export const LEARNINGS_START = '<<<LEARNINGS>>>';
export const LEARNINGS_END = '<<<END>>>';

// Hard ceiling for the synchronous `claude -p` run. A safety net so a hung
// claude can't keep distill() pending forever; on timeout we kill the child.
const POLL_TIMEOUT_MS = 5 * 60_000;

// ─── learning schema (Claude's output contract) ─────────────────────────────

// The three learning kinds Claude may emit. 'preference' maps to the existing
// 'feedback' memory type (which feeds the inject preamble); 'lesson'/'workflow'
// map to the new memory types added in sub-project 3.
export type LearningKind = 'lesson' | 'preference' | 'workflow';

export interface Learning {
  kind: LearningKind;
  title: string;
  body: string;
  // 0..1 — Claude's self-reported confidence. Drives auto-commit vs inbox.
  confidence: number;
}

// ─── digest model ───────────────────────────────────────────────────────────

export interface DigestItem {
  // Where this snippet came from — surfaced to Claude so it can attribute and
  // ground its learnings.
  source: 'diary' | 'devlog' | 'capture' | 'memory';
  // Short human label (date, devlog title, signal, memory description).
  label: string;
  // Trimmed text content.
  text: string;
  // Recency key (ms epoch) for most-recent-first ordering across sources.
  ts: number;
}

export interface ActivityDigest {
  projectPath: string;
  generatedAt: number;
  items: DigestItem[];
  // True when the char budget forced us to drop items.
  truncated: boolean;
}

export interface DistillSummary {
  // Outcome status — drives the renderer's result chip.
  status:
    | 'ok'
    | 'no-activity'
    | 'no-claude'
    | 'run-failed'
    | 'unparseable'
    | 'error';
  created: number;
  inboxed: number;
  skippedDup: number;
  // Human-readable note (e.g. why it no-op'd).
  message?: string;
}

// ─── 1. gather: build the bounded activity digest (pure-ish) ─────────────────

// Trim a body to a single bounded snippet, collapsing whitespace so the digest
// stays compact and the char budget is meaningful.
function trimItemText(raw: string): string {
  const collapsed = (raw ?? '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim();
  if (collapsed.length <= MAX_ITEM_CHARS) return collapsed;
  return `${collapsed.slice(0, MAX_ITEM_CHARS)}…`;
}

/**
 * Gather a bounded, most-recent-first activity digest for a project from:
 * recent diary entries, recent devlog (log/result), chat-turn inbox captures,
 * and recently-updated memory entries. Pulls data via MemoryService /
 * DevlogService so the heavy lifting (and embeddings) stays where it lives.
 *
 * Bounded by per-source counts and a global char budget; sets `truncated` when
 * the budget forced drops. Never throws — a failed source is simply skipped.
 */
export async function gatherActivityDigest(
  projectPath: string,
  opts: { maxChars?: number } = {},
): Promise<ActivityDigest> {
  const maxChars = Math.max(1_000, Math.min(64_000, opts.maxChars ?? MAX_DIGEST_CHARS));
  const collected: DigestItem[] = [];

  // Diary — newest-first; listDiary already sorts desc by date.
  try {
    const diary = await Memory.listDiary({ scope: 'project', projectPath });
    for (const d of diary.slice(0, MAX_DIARY_ENTRIES)) {
      const text = trimItemText(d.body);
      if (!text) continue;
      collected.push({
        source: 'diary',
        label: `diary ${d.date}`,
        text,
        // Diary recency: parse the YYYY-MM-DD as a stable ts (fallback updatedAt).
        ts: Date.parse(`${d.date}T00:00:00Z`) || d.updatedAt,
      });
    }
  } catch (err) {
    logger.warn(`digest diary read failed: ${(err as Error).message}`);
  }

  // Devlog — recent log + result entries. listEntries omits the body, so we
  // round-trip getEntry for the full text (capped by MAX_DEVLOG_ENTRIES).
  try {
    // Lazy import keeps DevlogService out of the module graph for tests that
    // only exercise the pure helpers / mock this function.
    const Devlog = await import('./DevlogService');
    const log = await Devlog.listEntries({ projectPath, type: 'log' });
    const result = await Devlog.listEntries({ projectPath, type: 'result' });
    const merged = [...log, ...result]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_DEVLOG_ENTRIES);
    for (const e of merged) {
      let text = e.body ?? '';
      if (!text) {
        try {
          const full = await Devlog.getEntry({ projectPath, entryId: e.id });
          text = full?.body ?? e.preview ?? '';
        } catch {
          text = e.preview ?? '';
        }
      }
      const trimmed = trimItemText(text);
      if (!trimmed) continue;
      collected.push({
        source: 'devlog',
        label: `devlog ${e.type}: ${e.title}`,
        text: trimmed,
        ts: e.createdAt,
      });
    }
  } catch (err) {
    logger.warn(`digest devlog read failed: ${(err as Error).message}`);
  }

  // Chat-turn captures — the memory inbox (proposeFromTurn source).
  try {
    const inbox = await Memory.listInbox(projectPath);
    for (const item of inbox.slice(0, MAX_INBOX_ITEMS)) {
      const text = trimItemText(`${item.suggestedDescription}\n${item.body}`);
      if (!text) continue;
      collected.push({
        source: 'capture',
        label: `capture (${item.signal})`,
        text,
        ts: item.createdAt,
      });
    }
  } catch (err) {
    logger.warn(`digest inbox read failed: ${(err as Error).message}`);
  }

  // Recently-updated memory — listEntries sorts pinned-first then updatedAt
  // desc. We re-sort strictly by updatedAt so "recent" means recent.
  try {
    const entries = await Memory.listEntries({ scope: 'project', projectPath });
    const recent = [...entries]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_MEMORY_ENTRIES);
    for (const e of recent) {
      const text = trimItemText(`${e.description}\n${e.body ?? e.preview ?? ''}`);
      if (!text) continue;
      collected.push({
        source: 'memory',
        label: `memory (${e.type}): ${e.description}`,
        text,
        ts: e.updatedAt,
      });
    }
  } catch (err) {
    logger.warn(`digest memory read failed: ${(err as Error).message}`);
  }

  // Global most-recent-first ordering across all sources.
  collected.sort((a, b) => b.ts - a.ts);

  // Apply the char budget: keep items (already recency-sorted) until the budget
  // is exhausted, then mark truncated.
  const items: DigestItem[] = [];
  let used = 0;
  let truncated = false;
  for (const it of collected) {
    const cost = it.label.length + it.text.length + 8;
    if (used + cost > maxChars) {
      truncated = true;
      break;
    }
    items.push(it);
    used += cost;
  }

  return {
    projectPath,
    generatedAt: Date.now(),
    items,
    truncated,
  };
}

// ─── 2. buildDistillPrompt (pure) ────────────────────────────────────────────

/**
 * Build the prompt handed to Claude. Hands over the digest and asks for a few
 * high-quality, GROUNDED learnings emitted as a JSON array between sentinel
 * markers. The grounding rule (only what's supported by the digest, no
 * inventing) is explicit so hallucinated learnings are discouraged at the
 * source — the de-dupe + user pruning are the downstream guards.
 *
 * PURE: same digest in → same prompt out. No IO.
 */
export function buildDistillPrompt(digest: ActivityDigest): string {
  const body = digest.items
    .map(
      (it, i) =>
        `[${i + 1}] (${it.source}) ${it.label}\n${it.text}`,
    )
    .join('\n\n---\n\n');

  return [
    'You are distilling durable LEARNINGS from a developer\'s recent activity',
    'on one project. Below is a bounded, most-recent-first digest of their',
    'diary entries, devlog, captured chat moments, and recent memory notes.',
    '',
    'Produce a FEW (0–5) high-quality, durable learnings that will help future',
    'work on this project. Each learning is one of:',
    "  - 'lesson'      — a non-obvious insight / gotcha / thing that went wrong",
    "                    or right and why (so it isn't repeated/relearned).",
    "  - 'preference'  — a way the developer wants work done (style, process,",
    '                    tooling) that should shape future behavior.',
    "  - 'workflow'    — a recurring multi-step procedure worth shortcutting.",
    '',
    'STRICT GROUNDING RULE: every learning MUST be directly supported by the',
    'digest below. Do NOT invent, generalize beyond the evidence, or restate',
    'generic best practices. If the digest does not support any durable',
    'learning, return an EMPTY array. Few and high-quality beats many.',
    '',
    'Output ONLY a JSON array between the exact sentinel markers below, with no',
    'prose before or after the closing marker. Each element:',
    '  { "kind": "lesson"|"preference"|"workflow",',
    '    "title": short imperative title (<= 80 chars),',
    '    "body": 1-3 sentences explaining the learning and why it matters,',
    '    "confidence": number 0..1 (how strongly the digest supports this) }',
    '',
    `${LEARNINGS_START}`,
    '[ ... ]',
    `${LEARNINGS_END}`,
    '',
    '=== ACTIVITY DIGEST ===',
    body || '(no recent activity)',
    '=== END DIGEST ===',
  ].join('\n');
}

// ─── 3. parseLearnings (pure, well-tested) ───────────────────────────────────

function clampConfidence(x: unknown): number | null {
  if (typeof x !== 'number' || !Number.isFinite(x)) return null;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function isLearningKind(x: unknown): x is LearningKind {
  return x === 'lesson' || x === 'preference' || x === 'workflow';
}

/**
 * Extract the JSON learnings block from (possibly noisy) log text and validate
 * each entry against the schema. Tolerant of surrounding log noise: finds the
 * LAST start sentinel and the first end sentinel after it, then JSON.parses the
 * slice. Malformed JSON → returns []. Individual malformed elements are dropped
 * (not fatal). Titles/bodies are trimmed; over-long titles are clipped.
 *
 * PURE: text in → validated learnings out. No IO.
 */
export function parseLearnings(logText: string): Learning[] {
  if (typeof logText !== 'string' || !logText) return [];

  // Use the LAST start marker in case the prompt echo (which also contains the
  // marker literal) appears earlier in the log — Claude's real output comes
  // after the echoed prompt.
  const startIdx = logText.lastIndexOf(LEARNINGS_START);
  if (startIdx === -1) return [];
  const afterStart = startIdx + LEARNINGS_START.length;
  const endIdx = logText.indexOf(LEARNINGS_END, afterStart);
  if (endIdx === -1) return [];

  const block = logText.slice(afterStart, endIdx).trim();
  if (!block) return [];

  // The block may carry leading/trailing log decoration around the JSON array.
  // Narrow to the outermost [ … ] so stray "# exited 0" style log lines (or a
  // code fence) don't break JSON.parse.
  const firstBracket = block.indexOf('[');
  const lastBracket = block.lastIndexOf(']');
  if (firstBracket === -1 || lastBracket === -1 || lastBracket < firstBracket) {
    return [];
  }
  const jsonSlice = block.slice(firstBracket, lastBracket + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch {
    return []; // malformed JSON → drop the whole block (never throw)
  }
  if (!Array.isArray(parsed)) return [];

  const out: Learning[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue;
    const obj = raw as Record<string, unknown>;
    if (!isLearningKind(obj.kind)) continue;
    const title = typeof obj.title === 'string' ? obj.title.trim() : '';
    const bodyText = typeof obj.body === 'string' ? obj.body.trim() : '';
    if (!title || !bodyText) continue;
    const confidence = clampConfidence(obj.confidence);
    if (confidence === null) continue;
    out.push({
      kind: obj.kind,
      title: title.slice(0, 200),
      body: bodyText.slice(0, 4_000),
      confidence,
    });
  }
  return out;
}

// ─── de-dupe decision (pure, injected for testability) ───────────────────────

// Minimal shape of a search hit the de-dupe decision needs — decoupled from the
// full MemorySearchHit so the decision is trivially unit-testable.
export interface DedupeHit {
  description: string;
  score: number;
}

/**
 * Decide whether a candidate learning duplicates an existing learning, given
 * the search hits returned for it (restricted to learning types). A duplicate
 * is: a verbatim description match, OR a top hit at/above the score threshold.
 *
 * PURE: candidate + hits in → boolean out. The actual semantic search happens
 * in distill() and is injected here, so this decision is testable without an
 * embedder.
 */
export function isDuplicateLearning(
  candidateTitle: string,
  hits: DedupeHit[],
): boolean {
  const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const candidate = norm(candidateTitle);
  for (const h of hits) {
    if (norm(h.description) === candidate) return true;
    if (h.score >= DEDUPE_SCORE_THRESHOLD) return true;
  }
  return false;
}

// ─── 4. distill — orchestrator (never throws to caller) ──────────────────────

// Map a learning kind to the persisted MemoryType. 'preference' reuses the
// existing 'feedback' type (which feeds the inject preamble — consumer #2).
function memoryTypeForKind(kind: LearningKind): MemoryType {
  switch (kind) {
    case 'preference':
      return 'feedback';
    case 'workflow':
      return 'workflow';
    case 'lesson':
    default:
      return 'lesson';
  }
}

// Result of running `claude -p`: the captured stdout (`text`) plus an ok flag.
// NEVER throws — every failure mode (binary absent, non-zero exit, timeout,
// spawn error) resolves to `{ ok:false, text:'', error }` so distill() can map
// it to a clean status without a try/catch around the call site.
export interface RunClaudeResult {
  ok: boolean;
  text: string;
  error?: string;
}

/**
 * Run a prompt through `claude -p` (print / non-interactive mode) and return
 * its stdout. The prompt is written to the child's stdin (so arbitrary length /
 * special chars are safe — no shell quoting), then stdin is closed. Captures
 * stdout + stderr; resolves `{ ok: code===0, text: stdout }` on exit, or an
 * error result on non-zero exit / timeout / missing binary. Bounded by
 * POLL_TIMEOUT_MS; on timeout the child is killed.
 *
 * Uses the user's normal Claude Code login (same auth as interactive `claude`),
 * NOT the Agent SDK credit pool.
 */
export async function runClaudePrint(prompt: string): Promise<RunClaudeResult> {
  const claudeBin = await resolveClaudeBinary();
  if (!claudeBin) {
    return { ok: false, text: '', error: 'claude not found' };
  }

  return new Promise<RunClaudeResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (r: RunClaudeResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(claudeBin, ['-p'], {
        env: { ...process.env, PATH: enrichedPath() },
      });
    } catch (err) {
      finish({ ok: false, text: '', error: (err as Error).message });
      return;
    }

    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish({ ok: false, text: '', error: 'timed out' });
    }, POLL_TIMEOUT_MS);

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('error', (err) => {
      finish({ ok: false, text: '', error: err.message });
    });
    child.on('close', (code) => {
      finish({
        ok: code === 0,
        text: stdout,
        error: code !== 0 ? stderr || `exit ${code}` : undefined,
      });
    });

    // Feed the prompt via stdin then close it.
    try {
      child.stdin?.write(prompt);
      child.stdin?.end();
    } catch (err) {
      logger.warn(`distill stdin write failed: ${(err as Error).message}`);
      // Don't settle here — let the child's own exit/error drive the result.
    }
  });
}

// Injectable dependency seam — production wires the real `claude -p` runner +
// MemoryService; tests inject mocks so no real claude is ever spawned.
export interface DistillDeps {
  gather: typeof gatherActivityDigest;
  // Run the distill prompt through real Claude and return its stdout. The
  // default wires `runClaudePrint`; tests inject a stub returning {ok,text}.
  runClaude: (prompt: string) => Promise<RunClaudeResult>;
  search: typeof Memory.search;
  createEntry: typeof Memory.createEntry;
  // Routes a low-confidence learning to the inbox for human review.
  addToInbox: (input: {
    projectPath: string;
    learning: Learning;
  }) => Promise<void>;
}

// Default inbox router: reuse the chat-turn capture path so low-confidence
// learnings land in the SAME inbox the user already triages. We synthesize a
// turn whose user message is the learning so proposeFromTurn captures it as a
// 'manual'-style proposal. proposeFromTurn requires a threadId + the
// correction/decision heuristics; to guarantee capture regardless of phrasing
// we instead create the entry directly is NOT what we want for low-confidence —
// so we add a dedicated inbox item via createEntry into a holding type would
// auto-commit. Therefore we route through proposeFromTurn with the learning
// framed as a decision so it reliably enters the inbox.
async function defaultAddToInbox(input: {
  projectPath: string;
  learning: Learning;
}): Promise<void> {
  const { projectPath, learning } = input;
  // Frame as a "decided to" statement so proposeFromTurn's DECISION heuristic
  // fires and the learning enters the inbox as a reviewable proposal rather
  // than an auto-committed entry.
  const userMessage = `Decided to note this learning: ${learning.title}. ${learning.body}`;
  await Memory.proposeFromTurn({
    projectPath,
    threadId: 'distill',
    userMessage,
    assistantMessage: '',
  });
}

function defaultDeps(): DistillDeps {
  return {
    gather: gatherActivityDigest,
    runClaude: (p) => runClaudePrint(p),
    search: Memory.search,
    createEntry: Memory.createEntry,
    addToInbox: defaultAddToInbox,
  };
}

/**
 * Orchestrate a distillation run for one project:
 *   gather → run `claude -p` → parseLearnings(stdout) → semantic de-dupe →
 *   createEntry each (auto-embeds) OR route low-confidence to the inbox.
 *
 * Non-blocking and NEVER throws to the caller — every failure path returns a
 * DistillSummary with a status, so the IPC handler / UI can show a clear note
 * without corrupting memory.
 */
export async function distill(
  projectPath: string,
  overrides: Partial<DistillDeps> = {},
): Promise<DistillSummary> {
  const deps = { ...defaultDeps(), ...overrides };
  try {
    if (typeof projectPath !== 'string' || !projectPath) {
      return { status: 'error', created: 0, inboxed: 0, skippedDup: 0, message: 'projectPath required' };
    }

    const digest = await deps.gather(projectPath, {});
    if (digest.items.length === 0) {
      return {
        status: 'no-activity',
        created: 0,
        inboxed: 0,
        skippedDup: 0,
        message: 'No recent activity to learn from.',
      };
    }

    const prompt = buildDistillPrompt(digest);

    // Run the prompt through real Claude (`claude -p`) and get stdout back.
    // runClaude NEVER throws — a missing binary / non-zero exit / timeout all
    // resolve to { ok:false, error }, which we map to 'no-claude'.
    const run = await deps.runClaude(prompt);
    if (!run.ok) {
      return {
        status: 'no-claude',
        created: 0,
        inboxed: 0,
        skippedDup: 0,
        message: `Could not run Claude: ${run.error ?? 'unknown error'}`,
      };
    }

    const learnings = parseLearnings(run.text);
    if (learnings.length === 0) {
      return {
        status: 'unparseable',
        created: 0,
        inboxed: 0,
        skippedDup: 0,
        message: 'Claude returned no usable learnings.',
      };
    }

    let created = 0;
    let inboxed = 0;
    let skippedDup = 0;

    for (const learning of learnings) {
      // Semantic de-dupe against existing learnings (lesson/workflow/feedback).
      // hybrid mode blends keyword + cosine so a near-identical prior learning
      // scores high. Failures here degrade to "not a duplicate" (never block).
      let dup = false;
      try {
        const hits = await deps.search({
          query: `${learning.title} ${learning.body}`,
          scope: 'project',
          projectPath,
          types: ['lesson', 'workflow', 'feedback'],
          mode: 'hybrid',
          limit: 5,
        });
        dup = isDuplicateLearning(
          learning.title,
          hits.map((h) => ({ description: h.entry.description, score: h.score })),
        );
      } catch (err) {
        logger.warn(`distill de-dupe search failed: ${(err as Error).message}`);
      }
      if (dup) {
        skippedDup += 1;
        continue;
      }

      // Low-confidence → inbox (don't auto-commit). High-confidence → entry.
      if (learning.confidence < AUTO_COMMIT_CONFIDENCE) {
        try {
          await deps.addToInbox({ projectPath, learning });
          inboxed += 1;
        } catch (err) {
          logger.warn(`distill inbox route failed: ${(err as Error).message}`);
        }
        continue;
      }

      try {
        await deps.createEntry({
          scope: 'project',
          projectPath,
          type: memoryTypeForKind(learning.kind),
          description: learning.title,
          body: learning.body,
          tags: ['distilled'],
        });
        created += 1;
      } catch (err) {
        logger.warn(`distill createEntry failed: ${(err as Error).message}`);
      }
    }

    return {
      status: 'ok',
      created,
      inboxed,
      skippedDup,
      message:
        created + inboxed + skippedDup === 0
          ? 'No new learnings.'
          : `Created ${created}, inboxed ${inboxed}, skipped ${skippedDup} duplicate(s).`,
    };
  } catch (err) {
    // Last-resort guard: distillation must NEVER throw to its caller.
    logger.warn(`distill failed: ${(err as Error).message}`);
    return {
      status: 'error',
      created: 0,
      inboxed: 0,
      skippedDup: 0,
      message: (err as Error).message,
    };
  }
}
