import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// LLM IS MOCKED — these tests never spawn real claude. The orchestrator
// (`distill`) takes an injectable deps seam so the BackgroundClaudeRunner +
// MemoryService calls are stubbed. The pure helpers (gather/prompt/parse/dedupe)
// are tested directly. The EmbeddingService is left unmocked: with no model
// present it reports unavailable and semantic paths degrade to keyword-only —
// deterministic for the digest tests, which only exercise keyword data.

import {
  __resetForTests,
  createEntry,
  init,
  listInbox,
  proposeFromTurn,
  search,
  writeDiary,
} from '@main/services/MemoryService';
import {
  buildDistillPrompt,
  distill,
  gatherActivityDigest,
  isDuplicateLearning,
  LEARNINGS_END,
  LEARNINGS_START,
  parseLearnings,
  type ActivityDigest,
  type DistillDeps,
  type Learning,
} from '@main/services/DistillationService';

let tmpRoot: string;
let projectAbs: string;

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devspace-distill-'));
  projectAbs = fs.mkdtempSync(path.join(os.tmpdir(), 'devspace-distill-proj-'));
  __resetForTests(tmpRoot);
  await init();
});

afterEach(() => {
  __resetForTests();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(projectAbs, { recursive: true, force: true });
});

// ─── gatherActivityDigest ────────────────────────────────────────────────────

describe('DistillationService.gatherActivityDigest', () => {
  it('collects diary + memory + capture items most-recent-first', async () => {
    // Diary: an older and a newer date.
    await writeDiary({
      date: '2026-06-01',
      scope: 'project',
      projectPath: projectAbs,
      body: 'Older diary: set up the build pipeline.',
    });
    await writeDiary({
      date: '2026-06-15',
      scope: 'project',
      projectPath: projectAbs,
      body: 'Newer diary: fixed the flaky test by awaiting the embed.',
    });
    // A memory entry.
    await createEntry({
      scope: 'project',
      projectPath: projectAbs,
      type: 'project',
      slug: 'auth-decision',
      description: 'Use JWT for auth',
      body: 'Decided JWT over sessions for the API.',
    });
    // A chat-turn capture into the inbox (decision heuristic fires).
    await proposeFromTurn({
      projectPath: projectAbs,
      threadId: 'thread-1',
      userMessage: "Let's go with pnpm for the monorepo, decided to use it.",
      assistantMessage: 'Sounds good.',
    });

    const digest = await gatherActivityDigest(projectAbs);
    expect(digest.projectPath).toBe(projectAbs);
    expect(digest.items.length).toBeGreaterThanOrEqual(3);

    const sources = new Set(digest.items.map((i) => i.source));
    expect(sources.has('diary')).toBe(true);
    expect(sources.has('memory')).toBe(true);
    expect(sources.has('capture')).toBe(true);

    // Most-recent-first ordering: ts descending.
    for (let i = 1; i < digest.items.length; i++) {
      expect(digest.items[i - 1].ts).toBeGreaterThanOrEqual(digest.items[i].ts);
    }
    // Newer diary should sort ahead of the older diary.
    const diaryItems = digest.items.filter((i) => i.source === 'diary');
    expect(diaryItems[0].label).toContain('2026-06-15');
  });

  it('is bounded by the char budget and flags truncation', async () => {
    // Three diary days, each well over a tiny budget.
    const big = 'x'.repeat(2_000);
    await writeDiary({ date: '2026-06-10', scope: 'project', projectPath: projectAbs, body: big });
    await writeDiary({ date: '2026-06-11', scope: 'project', projectPath: projectAbs, body: big });
    await writeDiary({ date: '2026-06-12', scope: 'project', projectPath: projectAbs, body: big });

    const digest = await gatherActivityDigest(projectAbs, { maxChars: 2_500 });
    // Budget allows only one ~2k-char item before the next would blow it.
    expect(digest.items.length).toBeLessThanOrEqual(2);
    expect(digest.truncated).toBe(true);
  });

  it('returns an empty digest for a project with no activity', async () => {
    const digest = await gatherActivityDigest(projectAbs);
    expect(digest.items).toEqual([]);
    expect(digest.truncated).toBe(false);
  });
});

// ─── buildDistillPrompt ──────────────────────────────────────────────────────

describe('DistillationService.buildDistillPrompt', () => {
  function makeDigest(items: ActivityDigest['items']): ActivityDigest {
    return { projectPath: projectAbs, generatedAt: Date.now(), items, truncated: false };
  }

  it('contains the sentinel markers and the grounding rule', () => {
    const prompt = buildDistillPrompt(
      makeDigest([
        { source: 'diary', label: 'diary 2026-06-15', text: 'fixed the embed race', ts: 1 },
      ]),
    );
    expect(prompt).toContain(LEARNINGS_START);
    expect(prompt).toContain(LEARNINGS_END);
    // Grounding rule — must forbid inventing learnings.
    expect(prompt).toMatch(/grounding/i);
    expect(prompt).toMatch(/must be directly supported/i);
    // The digest content is embedded.
    expect(prompt).toContain('fixed the embed race');
  });

  it('renders an empty-digest marker when there are no items', () => {
    const prompt = buildDistillPrompt(makeDigest([]));
    expect(prompt).toContain('(no recent activity)');
  });
});

// ─── parseLearnings ──────────────────────────────────────────────────────────

describe('DistillationService.parseLearnings', () => {
  function wrap(json: string, noise = true): string {
    const pre = noise ? '# claude --bg --exec ...\nsome log line\n' : '';
    const post = noise ? '\n# exited 0\n' : '';
    return `${pre}${LEARNINGS_START}\n${json}\n${LEARNINGS_END}${post}`;
  }

  it('parses a valid learnings block out of noisy log output', () => {
    const json = JSON.stringify([
      { kind: 'lesson', title: 'Await fire-and-forget embeds in tests', body: 'They race the assertion otherwise.', confidence: 0.9 },
      { kind: 'preference', title: 'Use pnpm', body: 'The repo is a pnpm monorepo.', confidence: 0.8 },
      { kind: 'workflow', title: 'Release flow', body: 'bump → build → tag.', confidence: 0.7 },
    ]);
    const out = parseLearnings(wrap(json));
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ kind: 'lesson', confidence: 0.9 });
    expect(out.map((l) => l.kind)).toEqual(['lesson', 'preference', 'workflow']);
  });

  it('tolerates a code fence / stray brackets around the JSON array', () => {
    const json = '```json\n' + JSON.stringify([
      { kind: 'lesson', title: 'T', body: 'B', confidence: 0.5 },
    ]) + '\n```';
    const out = parseLearnings(wrap(json));
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('T');
  });

  it('returns [] for malformed JSON (never throws)', () => {
    const out = parseLearnings(wrap('[ { kind: not valid json } ]'));
    expect(out).toEqual([]);
  });

  it('returns [] when no sentinels are present', () => {
    expect(parseLearnings('just some log output, no learnings here')).toEqual([]);
  });

  it('drops individual elements that fail schema validation', () => {
    const json = JSON.stringify([
      { kind: 'lesson', title: 'Valid', body: 'ok', confidence: 0.9 },
      { kind: 'bogus', title: 'Bad kind', body: 'x', confidence: 0.9 }, // invalid kind
      { kind: 'lesson', title: '', body: 'empty title', confidence: 0.9 }, // empty title
      { kind: 'lesson', title: 'No confidence', body: 'x' }, // missing confidence
      { kind: 'preference', title: 'Also valid', body: 'y', confidence: 1.5 }, // clamped to 1
    ]);
    const out = parseLearnings(wrap(json));
    expect(out).toHaveLength(2);
    expect(out.map((l) => l.title)).toEqual(['Valid', 'Also valid']);
    // confidence clamped into [0,1].
    expect(out[1].confidence).toBe(1);
  });

  it('uses the LAST start sentinel so an echoed prompt does not break parsing', () => {
    // The runner log echoes the prompt (which contains the marker literal),
    // then Claude's real output appears after it.
    const echoedPrompt = `${LEARNINGS_START}\n[ ... ]\n${LEARNINGS_END}\n`;
    const realJson = JSON.stringify([
      { kind: 'lesson', title: 'Real', body: 'real body', confidence: 0.9 },
    ]);
    const log = echoedPrompt + wrap(realJson);
    const out = parseLearnings(log);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Real');
  });
});

// ─── isDuplicateLearning (de-dupe decision) ──────────────────────────────────

describe('DistillationService.isDuplicateLearning', () => {
  it('flags a verbatim description match as duplicate', () => {
    const dup = isDuplicateLearning('Use pnpm for the monorepo', [
      { description: 'use pnpm for the monorepo', score: 0.1 },
    ]);
    expect(dup).toBe(true);
  });

  it('flags a high-score (semantically similar) hit as duplicate', () => {
    const dup = isDuplicateLearning('Always await the embed in tests', [
      { description: 'Different wording but same idea', score: 0.85 },
    ]);
    expect(dup).toBe(true);
  });

  it('does not flag low-score, non-matching hits', () => {
    const dup = isDuplicateLearning('A brand new lesson', [
      { description: 'something unrelated', score: 0.2 },
    ]);
    expect(dup).toBe(false);
  });

  it('is not a duplicate when there are no hits', () => {
    expect(isDuplicateLearning('Anything', [])).toBe(false);
  });
});

// ─── distill orchestrator (deps injected — no real claude) ───────────────────

describe('DistillationService.distill (orchestrator, mocked LLM)', () => {
  // Build a deps object that fakes the runner producing a given log, and wires
  // the real-ish MemoryService search/createEntry. sleep/now are stubbed so no
  // wall-clock waiting occurs.
  function makeDeps(overrides: Partial<DistillDeps> = {}): Partial<DistillDeps> {
    return {
      // Force a non-empty digest so distill proceeds to the run.
      gather: vi.fn(async () => ({
        projectPath: projectAbs,
        generatedAt: Date.now(),
        items: [{ source: 'diary' as const, label: 'd', text: 'activity', ts: 1 }],
        truncated: false,
      })),
      startRun: vi.fn(async () => ({
        runId: 'run-1',
        command: 'claude',
        status: 'running' as const,
        startedAt: Date.now(),
        exitCode: null,
        logPath: '/tmp/x.log',
        logBytes: 0,
      })),
      sleep: vi.fn(async () => undefined),
      now: () => Date.now(),
      ...overrides,
    };
  }

  function logWith(learnings: Array<Partial<Learning>>): string {
    return `${LEARNINGS_START}\n${JSON.stringify(learnings)}\n${LEARNINGS_END}\n# exited 0\n`;
  }

  it('creates high-confidence learnings as memory entries (auto-commit)', async () => {
    const deps = makeDeps({
      readLog: vi.fn(async () => ({
        text: logWith([
          { kind: 'lesson', title: 'Await embeds in tests', body: 'They race otherwise.', confidence: 0.9 },
          { kind: 'preference', title: 'Use pnpm', body: 'pnpm monorepo.', confidence: 0.85 },
        ]),
        bytes: 100,
        status: 'done' as const,
      })),
      // Real services for the persistence side.
      search,
      createEntry,
    });

    const summary = await distill(projectAbs, deps);
    expect(summary.status).toBe('ok');
    expect(summary.created).toBe(2);
    expect(summary.inboxed).toBe(0);
    expect(summary.skippedDup).toBe(0);

    // The lesson persisted under the new 'lesson' type; the preference under
    // 'feedback'. Verify they are now searchable.
    const lessonHits = await search({
      query: 'await embeds tests',
      scope: 'project',
      projectPath: projectAbs,
      mode: 'keyword',
    });
    expect(lessonHits.some((h) => h.entry.type === 'lesson')).toBe(true);
    const prefHits = await search({
      query: 'pnpm',
      scope: 'project',
      projectPath: projectAbs,
      mode: 'keyword',
    });
    expect(prefHits.some((h) => h.entry.type === 'feedback')).toBe(true);
  });

  it('routes low-confidence learnings to the inbox, not memory', async () => {
    const deps = makeDeps({
      readLog: vi.fn(async () => ({
        text: logWith([
          { kind: 'lesson', title: 'Shaky guess about caching', body: 'Maybe cache here.', confidence: 0.3 },
        ]),
        bytes: 100,
        status: 'done' as const,
      })),
      search,
      createEntry,
    });

    const summary = await distill(projectAbs, deps);
    expect(summary.status).toBe('ok');
    expect(summary.created).toBe(0);
    expect(summary.inboxed).toBe(1);

    const inbox = await listInbox(projectAbs);
    expect(inbox.length).toBeGreaterThanOrEqual(1);
  });

  it('skips a learning that duplicates an existing one (de-dupe)', async () => {
    // Seed an existing learning with the SAME title.
    await createEntry({
      scope: 'project',
      projectPath: projectAbs,
      type: 'lesson',
      description: 'Await embeds in tests',
      body: 'Existing.',
    });

    const deps = makeDeps({
      readLog: vi.fn(async () => ({
        text: logWith([
          { kind: 'lesson', title: 'Await embeds in tests', body: 'Dup attempt.', confidence: 0.9 },
        ]),
        bytes: 100,
        status: 'done' as const,
      })),
      // search returns the seeded entry as a hit; isDuplicateLearning sees the
      // verbatim description match and skips.
      search,
      createEntry,
    });

    const summary = await distill(projectAbs, deps);
    expect(summary.status).toBe('ok');
    expect(summary.created).toBe(0);
    expect(summary.skippedDup).toBe(1);
  });

  it('no-ops cleanly when there is no activity', async () => {
    const deps = makeDeps({
      gather: vi.fn(async () => ({
        projectPath: projectAbs,
        generatedAt: Date.now(),
        items: [],
        truncated: false,
      })),
    });
    const summary = await distill(projectAbs, deps);
    expect(summary.status).toBe('no-activity');
    expect(summary.created).toBe(0);
  });

  it('reports no-claude when the background run fails to start', async () => {
    const deps = makeDeps({
      startRun: vi.fn(async () => ({
        runId: 'run-x',
        command: 'claude',
        status: 'failed' as const,
        startedAt: Date.now(),
        exitCode: null,
        logPath: '/tmp/x.log',
        logBytes: 0,
      })),
    });
    const summary = await distill(projectAbs, deps);
    expect(summary.status).toBe('no-claude');
  });

  it('reports run-failed when the run ends in failure', async () => {
    const deps = makeDeps({
      readLog: vi.fn(async () => ({ text: '', bytes: 0, status: 'failed' as const })),
    });
    const summary = await distill(projectAbs, deps);
    expect(summary.status).toBe('run-failed');
  });

  it('reports unparseable when Claude emits no usable learnings', async () => {
    const deps = makeDeps({
      readLog: vi.fn(async () => ({
        text: 'I could not find any durable learnings.\n# exited 0\n',
        bytes: 50,
        status: 'done' as const,
      })),
    });
    const summary = await distill(projectAbs, deps);
    expect(summary.status).toBe('unparseable');
  });

  it('never throws — a thrown dep is caught and returns an error summary', async () => {
    const deps = makeDeps({
      gather: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const summary = await distill(projectAbs, deps);
    expect(summary.status).toBe('error');
    expect(summary.message).toContain('boom');
  });
});
