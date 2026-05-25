import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// We need to stub WorkspaceService.listWorkspaces() so resolveDraftProject
// finds our temp directory. Mock before importing ForgeService.
let activeWorkspaceList: string[] = [];
vi.mock('@main/services/WorkspaceService', () => ({
  listWorkspaces: async () => ({
    active: null,
    workspaces: activeWorkspaceList.map((p, i) => ({
      id: `ws-${i}`,
      path: p,
      name: path.basename(p),
      lastOpened: Date.now(),
    })),
  }),
}));

// Stub Skills/Agents services — saveDraft delegates to these. We just
// want to confirm saveDraft calls them with the expected slug/body.
const createSkillCalls: Array<{
  scope: string;
  projectPath: string | null;
  slug: string;
}> = [];
const saveSkillCalls: Array<{
  path: string;
  name: string;
  description: string;
  body: string;
}> = [];
vi.mock('@main/services/SkillsService', () => ({
  createSkill: async (
    scope: 'global' | 'project',
    projectPath: string | null,
    slug: string,
  ) => {
    createSkillCalls.push({ scope, projectPath, slug });
    return {
      path: path.join(
        projectPath ?? '/tmp/global',
        '.claude',
        'skills',
        slug,
        'SKILL.md',
      ),
      scope,
      slug,
      name: slug,
      description: 'placeholder',
      extra: {},
      body: 'placeholder',
    };
  },
  saveSkill: async (skill: {
    path: string;
    name: string;
    description: string;
    body: string;
  }) => {
    saveSkillCalls.push({
      path: skill.path,
      name: skill.name,
      description: skill.description,
      body: skill.body,
    });
    return skill;
  },
}));

const createAgentCalls: Array<{
  scope: string;
  projectPath: string | null;
  slug: string;
}> = [];
const saveAgentCalls: Array<{
  path: string;
  name: string;
  description: string;
  body: string;
}> = [];
vi.mock('@main/services/AgentsService', () => ({
  createAgent: async (
    scope: 'global' | 'project',
    projectPath: string | null,
    slug: string,
  ) => {
    createAgentCalls.push({ scope, projectPath, slug });
    return {
      path: path.join(projectPath ?? '/tmp/global', '.claude', 'agents', `${slug}.md`),
      scope,
      slug,
      name: slug,
      description: 'placeholder',
      extra: {},
      body: 'placeholder',
    };
  },
  saveAgent: async (agent: {
    path: string;
    name: string;
    description: string;
    body: string;
  }) => {
    saveAgentCalls.push({
      path: agent.path,
      name: agent.name,
      description: agent.description,
      body: agent.body,
    });
    return agent;
  },
}));

// Stub TmuxChatRunner — generateDraft is exercised by the cancel test
// only; we never want to spawn claude during tests.
vi.mock('@main/services/TmuxChatRunner', () => ({
  newRunId: () => 'test-run-id',
  startChatRun: async () => ({
    sessionName: 'test-session',
    runDir: '/tmp/test-run',
    promise: new Promise(() => undefined), // hangs until cancelled
    detached: false,
    kill: async () => undefined,
  }),
}));

vi.mock('@main/services/ClaudeCliLauncher', () => ({
  resolveClaudeBinary: async () => '/usr/local/bin/claude',
  // Used by ChatLineHandler etc — but not invoked from ForgeService tests.
}));

vi.mock('@main/utils/shellEnv', () => ({
  resolveInteractiveShellEnv: async () => ({}),
}));

import {
  __resetForTests,
  addSuggestion,
  cancelDraft,
  createDraft,
  deleteDraft,
  discoverMatches,
  dismissSuggestion,
  extractGeneratedArtifact,
  generateDraft,
  getDraft,
  getDraftById,
  getSettings,
  init,
  listCatalog,
  listDrafts,
  listStats,
  listSuggestions,
  listUses,
  makeStatsKey,
  profileToSignals,
  proposeFromChat,
  recordSignal,
  recordUse,
  saveDraft,
  scoreCatalogItem,
  setSettings,
  subscribeEvents,
  updateDraft,
} from '@main/services/ForgeService';

let homeTmp: string;
let projectAbs: string;

beforeEach(async () => {
  homeTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-home-'));
  projectAbs = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-proj-'));
  activeWorkspaceList = [projectAbs];
  createSkillCalls.length = 0;
  saveSkillCalls.length = 0;
  createAgentCalls.length = 0;
  saveAgentCalls.length = 0;
  __resetForTests(homeTmp);
  await init();
});

afterEach(() => {
  __resetForTests();
  fs.rmSync(homeTmp, { recursive: true, force: true });
  fs.rmSync(projectAbs, { recursive: true, force: true });
});

function forgePath(...parts: string[]): string {
  return path.join(projectAbs, '.devspace', 'forge', ...parts);
}

// ─── createDraft / getDraft / listDrafts ───────────────────────────────────

describe('ForgeService.createDraft', () => {
  it('round-trips a skill draft via getDraft', async () => {
    const draft = await createDraft({
      projectPath: projectAbs,
      kind: 'skill',
      scope: 'project',
      slug: 'refactor-css',
      brief: 'Use when the user wants to refactor styles.',
    });
    expect(draft.id).toBeTruthy();
    expect(draft.kind).toBe('skill');
    expect(draft.scope).toBe('project');
    expect(draft.slug).toBe('refactor-css');
    expect(draft.status).toBe('pending');
    expect(draft.messages).toHaveLength(1);
    expect(draft.messages[0]!.role).toBe('user');
    expect(draft.frontmatter.name).toBe('refactor-css');

    const fetched = await getDraft(projectAbs, draft.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(draft.id);
    expect(fetched!.brief).toContain('refactor styles');
  });

  it('listDrafts sorts newest first', async () => {
    const older = await createDraft({
      projectPath: projectAbs,
      kind: 'skill',
      scope: 'project',
      slug: 'first-draft',
      brief: 'first',
    });
    // wait a tick so createdAt differs
    await new Promise((resolve) => setTimeout(resolve, 10));
    const newer = await createDraft({
      projectPath: projectAbs,
      kind: 'agent',
      scope: 'global',
      slug: 'second-draft',
      brief: 'second',
    });
    const drafts = await listDrafts(projectAbs);
    expect(drafts).toHaveLength(2);
    expect(drafts[0]!.id).toBe(newer.id);
    expect(drafts[1]!.id).toBe(older.id);
  });

  it('rejects path traversal slug', async () => {
    await expect(
      createDraft({
        projectPath: projectAbs,
        kind: 'skill',
        scope: 'project',
        slug: '../etc/passwd',
        brief: 'evil',
      }),
    ).rejects.toThrow(/invalid forge slug/);
  });

  it('rejects empty brief', async () => {
    await expect(
      createDraft({
        projectPath: projectAbs,
        kind: 'skill',
        scope: 'project',
        slug: 'no-brief',
        brief: '',
      }),
    ).rejects.toThrow(/brief is required/);
  });

  it('emits a draft_created event to subscribers', async () => {
    const events: { kind: string; draftId?: string }[] = [];
    const unsub = subscribeEvents((ev) => {
      events.push({ kind: ev.kind, draftId: ev.draftId });
    });
    try {
      await createDraft({
        projectPath: projectAbs,
        kind: 'skill',
        scope: 'project',
        slug: 'observable-draft',
        brief: 'pls observe',
      });
    } finally {
      unsub();
    }
    expect(events.some((e) => e.kind === 'draft_created')).toBe(true);
  });
});

// ─── updateDraft ───────────────────────────────────────────────────────────

describe('ForgeService.updateDraft', () => {
  it('preserves untouched fields when patching body only', async () => {
    const draft = await createDraft({
      projectPath: projectAbs,
      kind: 'skill',
      scope: 'project',
      slug: 'patch-me',
      brief: 'initial brief',
    });
    const updated = await updateDraft({
      projectPath: projectAbs,
      draftId: draft.id,
      body: '# Test body',
    });
    expect(updated.brief).toBe('initial brief');
    expect(updated.slug).toBe('patch-me');
    expect(updated.body).toContain('# Test body');
    // frontmatter unchanged
    expect(updated.frontmatter.name).toBe('patch-me');
  });

  it('hardens body — strips <script> tags', async () => {
    const draft = await createDraft({
      projectPath: projectAbs,
      kind: 'skill',
      scope: 'project',
      slug: 'evil-body',
      brief: 'we will try evil',
    });
    const updated = await updateDraft({
      projectPath: projectAbs,
      draftId: draft.id,
      body: 'Hello <script>alert(1)</script> world',
    });
    expect(updated.body).not.toMatch(/<script/i);
    expect(updated.body).toContain('Hello');
    expect(updated.body).toContain('world');
  });

  it('resolves draft by id only (IPC contract path)', async () => {
    const draft = await createDraft({
      projectPath: projectAbs,
      kind: 'skill',
      scope: 'project',
      slug: 'resolve-by-id',
      brief: 'find me',
    });
    const updated = await updateDraft({
      draftId: draft.id,
      userMessage: 'follow up question',
    });
    expect(updated.messages.length).toBeGreaterThanOrEqual(2);
    expect(updated.messages.at(-1)!.content).toBe('follow up question');
  });
});

// ─── saveDraft ─────────────────────────────────────────────────────────────

describe('ForgeService.saveDraft', () => {
  it('writes a SkillDef + creates a baseline stats row', async () => {
    const draft = await createDraft({
      projectPath: projectAbs,
      kind: 'skill',
      scope: 'project',
      slug: 'shippable',
      brief: 'A useful skill',
    });
    await updateDraft({
      projectPath: projectAbs,
      draftId: draft.id,
      body: '# Shippable\n\nUse when the user needs X.',
    });
    const result = await saveDraft(projectAbs, draft.id);
    expect(result.key).toBe('project:skill:shippable');
    expect(result.path.endsWith('SKILL.md')).toBe(true);
    // createSkill + saveSkill should have been called
    expect(createSkillCalls).toHaveLength(1);
    expect(createSkillCalls[0]!.slug).toBe('shippable');
    expect(saveSkillCalls).toHaveLength(1);
    expect(saveSkillCalls[0]!.body).toContain('Shippable');

    // Baseline stats row created.
    const stats = await listStats(projectAbs);
    const row = stats.find((s) => s.key === 'project:skill:shippable');
    expect(row).toBeDefined();
    expect(row!.uses).toBe(0);

    // Draft was deleted after save.
    const after = await getDraft(projectAbs, draft.id);
    expect(after).toBeNull();
  });

  it('refuses to save an empty body', async () => {
    const draft = await createDraft({
      projectPath: projectAbs,
      kind: 'skill',
      scope: 'project',
      slug: 'empty-body',
      brief: 'no body',
    });
    await expect(saveDraft(projectAbs, draft.id)).rejects.toThrow(/body is empty/);
  });
});

// ─── stats: recordUse / recordSignal ───────────────────────────────────────

describe('ForgeService.stats', () => {
  const key = 'project:skill:tracked';

  beforeEach(async () => {
    // Create a baseline stats row by saving a draft.
    const draft = await createDraft({
      projectPath: projectAbs,
      kind: 'skill',
      scope: 'project',
      slug: 'tracked',
      brief: 'observed',
    });
    await updateDraft({
      projectPath: projectAbs,
      draftId: draft.id,
      body: 'tracked body',
    });
    await saveDraft(projectAbs, draft.id);
  });

  it('recordUse increments uses + appends a use event', async () => {
    await recordUse({
      projectPath: projectAbs,
      key,
      threadId: 'thread-A',
      messageId: 'msg-1',
    });
    await recordUse({
      projectPath: projectAbs,
      key,
      threadId: 'thread-A',
      messageId: 'msg-2',
    });
    const stats = await listStats(projectAbs);
    const row = stats.find((s) => s.key === key)!;
    expect(row.uses).toBe(2);
    expect(row.lastUsedAt).not.toBeNull();
    const uses = await listUses({ projectPath: projectAbs, key });
    expect(uses).toHaveLength(2);
    // Newest first.
    expect(uses[0]!.messageId).toBe('msg-2');
  });

  it('recordSignal — thanks/commit/explicit-up bumps useful', async () => {
    await recordUse({
      projectPath: projectAbs,
      key,
      threadId: 'thread-A',
      messageId: 'msg-1',
    });
    await recordSignal({
      projectPath: projectAbs,
      key,
      messageId: 'msg-1',
      signal: 'thanks',
    });
    await recordSignal({
      projectPath: projectAbs,
      key,
      messageId: 'msg-1',
      signal: 'commit',
    });
    await recordSignal({
      projectPath: projectAbs,
      key,
      messageId: 'msg-1',
      signal: 'explicit-up',
    });
    const stats = await listStats(projectAbs);
    const row = stats.find((s) => s.key === key)!;
    expect(row.useful).toBe(3);
    expect(row.explicit.up).toBe(1);
    expect(row.explicit.down).toBe(0);
    expect(row.harmful).toBe(0);
  });

  it('recordSignal — correction/explicit-down bumps harmful', async () => {
    await recordUse({
      projectPath: projectAbs,
      key,
      threadId: 'thread-A',
      messageId: 'msg-1',
    });
    await recordSignal({
      projectPath: projectAbs,
      key,
      messageId: 'msg-1',
      signal: 'correction',
    });
    await recordSignal({
      projectPath: projectAbs,
      key,
      messageId: 'msg-1',
      signal: 'explicit-down',
    });
    const stats = await listStats(projectAbs);
    const row = stats.find((s) => s.key === key)!;
    expect(row.harmful).toBe(2);
    expect(row.explicit.down).toBe(1);
    expect(row.useful).toBe(0);
  });

  it('recordSignal — abandoned bumps ignored', async () => {
    await recordUse({
      projectPath: projectAbs,
      key,
      threadId: 'thread-A',
      messageId: 'msg-1',
    });
    await recordSignal({
      projectPath: projectAbs,
      key,
      messageId: 'msg-1',
      signal: 'abandoned',
    });
    const stats = await listStats(projectAbs);
    const row = stats.find((s) => s.key === key)!;
    expect(row.ignored).toBe(1);
    expect(row.useful).toBe(0);
    expect(row.harmful).toBe(0);
  });

  it('listUses tail-trims to last 500 entries', async () => {
    // Append 600 uses; expect only the last 500 to survive.
    for (let i = 0; i < 510; i++) {
      await recordUse({
        projectPath: projectAbs,
        key,
        threadId: 'thread-X',
        messageId: `msg-${i}`,
      });
    }
    const uses = await listUses({ projectPath: projectAbs, key, limit: 500 });
    expect(uses.length).toBeLessThanOrEqual(500);
    // First (newest) should be msg-509.
    expect(uses[0]!.messageId).toBe('msg-509');
  });

  it('rejects invalid stats keys', async () => {
    await expect(
      recordUse({
        projectPath: projectAbs,
        key: 'bogus',
        threadId: 'thread',
        messageId: 'msg',
      }),
    ).rejects.toThrow(/invalid stats key/);
  });

  // SEC-4 regression: bound free-form ids so a compromised renderer can't
  // bloat uses.jsonl with megabyte-long ids.
  it('rejects oversize threadId / messageId', async () => {
    const longId = 'x'.repeat(129);
    await expect(
      recordUse({
        projectPath: projectAbs,
        key,
        threadId: longId,
        messageId: 'msg',
      }),
    ).rejects.toThrow(/too long/);
    await expect(
      recordUse({
        projectPath: projectAbs,
        key,
        threadId: 'thread',
        messageId: longId,
      }),
    ).rejects.toThrow(/too long/);
  });

  // SEC-1 regression: concurrent recordSignal fan-out across multiple keys
  // must not lose increments. Before the per-project mutex, parallel
  // readStatsFile → mutate → writeStatsFile chains silently clobbered each
  // other.
  it('serializes concurrent recordUse calls without losing increments', async () => {
    // Pre-seed the stats row.
    await recordUse({
      projectPath: projectAbs,
      key,
      threadId: 'thread-seed',
      messageId: 'msg-seed',
    });
    // Fire 20 concurrent recordUse calls.
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        recordUse({
          projectPath: projectAbs,
          key,
          threadId: 'thread-X',
          messageId: `msg-concurrent-${i}`,
        }),
      ),
    );
    const stats = await listStats(projectAbs);
    const row = stats.find((s) => s.key === key)!;
    // 1 seed + 20 concurrent = 21. Any clobber would land below 21.
    expect(row.uses).toBe(21);
  });
});

// ─── suggestions ───────────────────────────────────────────────────────────

describe('ForgeService.suggestions', () => {
  it('addSuggestion dedups by (kind, slug, reason)', async () => {
    const a = await addSuggestion({
      projectPath: projectAbs,
      reason: 'repeated-question',
      suggestedKind: 'skill',
      suggestedSlug: 'q-dedup',
      suggestedBrief: 'first',
      evidence: ['evidence-a'],
    });
    const b = await addSuggestion({
      projectPath: projectAbs,
      reason: 'repeated-question',
      suggestedKind: 'skill',
      suggestedSlug: 'q-dedup',
      suggestedBrief: 'second (should be ignored)',
      evidence: ['evidence-b'],
    });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    const list = await listSuggestions(projectAbs);
    expect(list).toHaveLength(1);
    expect(list[0]!.suggestedBrief).toContain('first');
  });

  it('enforces the daily suggestion cap', async () => {
    // Default cap is 3. Use unique slugs so we don't trip dedup.
    await setSettings({ maxSuggestionsPerDay: 2 }, projectAbs);
    await addSuggestion({
      projectPath: projectAbs,
      reason: 'repeated-question',
      suggestedKind: 'skill',
      suggestedSlug: 'cap-a',
      suggestedBrief: 'a',
      evidence: [],
    });
    await addSuggestion({
      projectPath: projectAbs,
      reason: 'repeated-question',
      suggestedKind: 'skill',
      suggestedSlug: 'cap-b',
      suggestedBrief: 'b',
      evidence: [],
    });
    const overflow = await addSuggestion({
      projectPath: projectAbs,
      reason: 'repeated-question',
      suggestedKind: 'skill',
      suggestedSlug: 'cap-c',
      suggestedBrief: 'c',
      evidence: [],
    });
    expect(overflow).toBeNull();
    const list = await listSuggestions(projectAbs);
    expect(list).toHaveLength(2);
  });

  it('dismissSuggestion removes the entry', async () => {
    const s = await addSuggestion({
      projectPath: projectAbs,
      reason: 'repeated-question',
      suggestedKind: 'skill',
      suggestedSlug: 'to-dismiss',
      suggestedBrief: 'pls dismiss',
      evidence: [],
    });
    expect(s).not.toBeNull();
    await dismissSuggestion(projectAbs, s!.id);
    const list = await listSuggestions(projectAbs);
    expect(list).toHaveLength(0);
  });

  it('proposeFromChat detects repeated-question patterns', async () => {
    const now = Date.now();
    const messages = [
      { role: 'user' as const, content: 'How do I refactor my CSS files?', ts: now - 30000 },
      { role: 'assistant' as const, content: 'You can run prettier.', ts: now - 25000 },
      { role: 'user' as const, content: 'How do I refactor CSS files in this project?', ts: now - 20000 },
      { role: 'assistant' as const, content: 'Try eslint --fix.', ts: now - 15000 },
      { role: 'user' as const, content: 'How can I refactor my CSS in the project?', ts: now - 10000 },
    ];
    await proposeFromChat({ projectPath: projectAbs, threadId: 'thread-A', messages });
    const list = await listSuggestions(projectAbs);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0]!.reason).toBe('repeated-question');
  });

  it('proposeFromChat detects repeated-boilerplate', async () => {
    const now = Date.now();
    const block = '```\nimport { foo } from "bar";\nfunction baz() { return foo(); }\nconst extra = "padding for length over 80 chars";\n```';
    const messages = [
      { role: 'user' as const, content: `Please help: ${block}`, ts: now - 30000 },
      { role: 'assistant' as const, content: 'ok', ts: now - 25000 },
      { role: 'user' as const, content: `Again: ${block}`, ts: now - 20000 },
      { role: 'assistant' as const, content: 'ok again', ts: now - 15000 },
      { role: 'user' as const, content: `Same: ${block}`, ts: now - 10000 },
    ];
    await proposeFromChat({ projectPath: projectAbs, threadId: 'thread-B', messages });
    const list = await listSuggestions(projectAbs);
    expect(list.some((s) => s.reason === 'repeated-boilerplate')).toBe(true);
  });

  // v0.25 SEC regression: listSuggestions sanitizes the on-disk file. A
  // hostile project clone could plant a suggestions.json with invalid /
  // attacker-controlled fields; we drop bad entries rather than surface
  // them in the renderer (where the brief feeds into ForgeGenerateDialog).
  it('listSuggestions drops entries with invalid kind, reason, slug, or oversized brief', async () => {
    const forgeDir = path.join(projectAbs, '.devspace', 'forge');
    fs.mkdirSync(forgeDir, { recursive: true });
    const planted = {
      suggestions: [
        // Valid — should survive
        {
          id: 'ok-1',
          projectPath: projectAbs,
          reason: 'repeated-question',
          suggestedKind: 'skill',
          suggestedSlug: 'good-slug',
          suggestedBrief: 'a valid brief',
          evidence: [],
          createdAt: Date.now(),
        },
        // Invalid reason
        {
          id: 'bad-reason',
          projectPath: projectAbs,
          reason: 'invented-reason',
          suggestedKind: 'skill',
          suggestedSlug: 'x',
          suggestedBrief: 'b',
          evidence: [],
          createdAt: Date.now(),
        },
        // Invalid kind
        {
          id: 'bad-kind',
          projectPath: projectAbs,
          reason: 'repeated-question',
          suggestedKind: 'something-else',
          suggestedSlug: 'x',
          suggestedBrief: 'b',
          evidence: [],
          createdAt: Date.now(),
        },
        // Invalid slug — uppercase, spaces
        {
          id: 'bad-slug',
          projectPath: projectAbs,
          reason: 'repeated-question',
          suggestedKind: 'skill',
          suggestedSlug: 'Bad Slug!',
          suggestedBrief: 'b',
          evidence: [],
          createdAt: Date.now(),
        },
        // Oversized brief — should drop
        {
          id: 'big-brief',
          projectPath: projectAbs,
          reason: 'repeated-question',
          suggestedKind: 'skill',
          suggestedSlug: 'x',
          suggestedBrief: 'x'.repeat(10000),
          evidence: [],
          createdAt: Date.now(),
        },
      ],
      dailyCount: {},
    };
    fs.writeFileSync(
      path.join(forgeDir, 'suggestions.json'),
      JSON.stringify(planted),
      'utf8',
    );
    const list = await listSuggestions(projectAbs);
    expect(list.map((s) => s.id)).toEqual(['ok-1']);
  });

  it('proposeFromChat is a no-op when autoSuggest is off', async () => {
    await setSettings({ autoSuggest: 'off' }, projectAbs);
    const now = Date.now();
    const messages = [
      { role: 'user' as const, content: 'How do I refactor my CSS?', ts: now - 30000 },
      { role: 'user' as const, content: 'How do I refactor CSS in project?', ts: now - 20000 },
      { role: 'user' as const, content: 'How can I refactor CSS now?', ts: now - 10000 },
    ];
    await proposeFromChat({ projectPath: projectAbs, threadId: 'thread-A', messages });
    const list = await listSuggestions(projectAbs);
    expect(list).toHaveLength(0);
  });
});

// ─── catalog + discover ────────────────────────────────────────────────────

describe('ForgeService.catalog', () => {
  it('listCatalog returns the bundled static set', async () => {
    const catalog = await listCatalog();
    expect(catalog.length).toBeGreaterThanOrEqual(30);
    // Sanity-check a known entry.
    const vitest = catalog.find((c) => c.slug === 'testing-automation');
    expect(vitest).toBeDefined();
    expect(vitest!.matches).toContain('vitest');
  });

  it('discoverMatches scores against a ProjectProfile-ish signal set', async () => {
    // We can't easily fake the underlying buildProjectProfile output for
    // a temp project (it requires package.json + deps). Instead, exercise
    // scoreCatalogItem directly with a hand-rolled signal set.
    const signals = new Set(['next', 'tailwind', 'typescript', 'vitest']);
    const catalog = await listCatalog();
    const scored = catalog
      .map((item) => ({ item, score: scoreCatalogItem(item, signals) }))
      .sort((a, b) => b.score - a.score);
    expect(scored[0]!.score).toBeGreaterThan(0);
    // testing-automation should score because it matches vitest.
    const tApi = scored.find((s) => s.item.slug === 'testing-automation');
    expect(tApi!.score).toBeGreaterThan(0);
  });

  it('discoverMatches returns 8 fallbacks when no profile is detectable', async () => {
    // safeBuildProfile always returns null now (the rich profile builder was
    // removed), so signals is empty; the fallback path returns the top-8 by
    // matches.length.
    const matches = await discoverMatches(projectAbs);
    expect(matches.length).toBe(8);
  });

  it('profileToSignals normalizes evidence strings', () => {
    const sig = profileToSignals({
      projectPath: '/x',
      framework: 'next',
      styling: 'tailwind',
      packageManager: 'pnpm',
      typescript: true,
      summary: 'x',
      evidence: ['vitest.config.ts', 'playwright.config.ts'],
      builtAt: Date.now(),
    });
    expect(sig.has('next')).toBe(true);
    expect(sig.has('tailwind')).toBe(true);
    expect(sig.has('typescript')).toBe(true);
    expect(sig.has('vitest')).toBe(true);
    expect(sig.has('playwright')).toBe(true);
  });
});

// ─── settings ──────────────────────────────────────────────────────────────

describe('ForgeService.settings', () => {
  it('round-trips settings + clamps negative maxSuggestionsPerDay to 0', async () => {
    const updated = await setSettings(
      { maxSuggestionsPerDay: -5, implicitThanks: false },
      projectAbs,
    );
    expect(updated.maxSuggestionsPerDay).toBe(0);
    expect(updated.implicitThanks).toBe(false);
    const fetched = await getSettings(projectAbs);
    expect(fetched.maxSuggestionsPerDay).toBe(0);
    expect(fetched.implicitThanks).toBe(false);
  });

  it('caps maxSuggestionsPerDay at 50', async () => {
    const updated = await setSettings(
      { maxSuggestionsPerDay: 9999 },
      projectAbs,
    );
    expect(updated.maxSuggestionsPerDay).toBe(50);
  });
});

// ─── cancel mid-generation ─────────────────────────────────────────────────

describe('ForgeService.cancel', () => {
  it('cancel stamps the draft as error and clears the in-flight handle', async () => {
    const draft = await createDraft({
      projectPath: projectAbs,
      kind: 'skill',
      scope: 'project',
      slug: 'cancellable',
      brief: 'cancel me',
    });
    // Kick off generation — startChatRun is stubbed to a never-resolving
    // promise so the runner hangs until cancelDraft fires the abort.
    await generateDraft(projectAbs, draft.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await cancelDraft(projectAbs, draft.id);
    // Drain microtasks so the cancel handler can stamp the draft.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = await getDraft(projectAbs, draft.id);
    expect(after).not.toBeNull();
    expect(after!.status).toBe('error');
    expect(after!.errorMessage).toContain('cancel');
  });
});

// ─── extractGeneratedArtifact ──────────────────────────────────────────────

describe('ForgeService.extractGeneratedArtifact', () => {
  it('parses fenced markdown block with frontmatter', () => {
    const raw = [
      'Here is your skill:',
      '',
      '```markdown',
      '---',
      'name: my-skill',
      'description: "Use when the user wants my skill"',
      '---',
      '',
      '# My Skill',
      '',
      'Helpful content here.',
      '```',
      '',
      'Done.',
    ].join('\n');
    const out = extractGeneratedArtifact(raw, 'skill');
    expect(out.frontmatter.name).toBe('my-skill');
    expect(out.frontmatter.description).toContain('Use when');
    expect(out.body).toContain('# My Skill');
  });

  it('falls back to bare frontmatter when no fence is present', () => {
    const raw = '---\nname: bare\ndescription: just bare\n---\n\n# body\n';
    const out = extractGeneratedArtifact(raw, 'skill');
    expect(out.frontmatter.name).toBe('bare');
    expect(out.body).toContain('# body');
  });
});

// ─── getDraftById (single-arg IPC contract) ────────────────────────────────

describe('ForgeService.getDraftById', () => {
  it('resolves a draft when projectPath is omitted', async () => {
    const draft = await createDraft({
      projectPath: projectAbs,
      kind: 'skill',
      scope: 'project',
      slug: 'lookup-by-id',
      brief: 'find me',
    });
    const fetched = await getDraftById(draft.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(draft.id);
  });

  it('returns null when the draftId does not exist', async () => {
    const fetched = await getDraftById('00000000-0000-0000-0000-000000000000');
    expect(fetched).toBeNull();
  });
});

// ─── deleteDraft ───────────────────────────────────────────────────────────

describe('ForgeService.deleteDraft', () => {
  it('removes the draft file', async () => {
    const draft = await createDraft({
      projectPath: projectAbs,
      kind: 'skill',
      scope: 'project',
      slug: 'to-be-removed',
      brief: 'gone soon',
    });
    expect(fs.existsSync(forgePath('drafts', `${draft.id}.json`))).toBe(true);
    await deleteDraft(projectAbs, draft.id);
    expect(fs.existsSync(forgePath('drafts', `${draft.id}.json`))).toBe(false);
  });

  it('is idempotent — deleting a missing draft does not throw', async () => {
    await expect(
      deleteDraft(projectAbs, '00000000-0000-0000-0000-000000000000'),
    ).resolves.toBeUndefined();
  });
});

// ─── makeStatsKey ──────────────────────────────────────────────────────────

describe('ForgeService.makeStatsKey', () => {
  it('builds canonical keys', () => {
    expect(makeStatsKey('project', 'skill', 'refactor-css')).toBe(
      'project:skill:refactor-css',
    );
    expect(makeStatsKey('global', 'agent', 'test-runner')).toBe(
      'global:agent:test-runner',
    );
  });

  it('rejects an invalid scope/kind/slug', () => {
    expect(() => makeStatsKey('bad' as never, 'skill', 'x')).toThrow();
    expect(() => makeStatsKey('project', 'bad' as never, 'x')).toThrow();
    expect(() => makeStatsKey('project', 'skill', '../etc')).toThrow();
  });
});
