import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __resetForTests,
  appendDailyLog,
  buildInjectPreamble,
  createEntry,
  deleteEntry,
  getEntry,
  getSettings,
  init,
  listEntries,
  pruneByRetention,
  setSettings,
  subscribeEvents,
  updateEntry,
} from '@main/services/DevlogService';

// Each test gets a unique project dir (mkdtemp) + an isolated fake
// homedir for the global defaults file. Both are torn down in
// afterEach so the suite stays hermetic against fs leaks. The
// service is reset between tests so the in-memory settings cache
// doesn't bleed across tests either.

let homeTmp: string;
let projectAbs: string;

beforeEach(async () => {
  homeTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devlog-test-home-'));
  projectAbs = fs.mkdtempSync(path.join(os.tmpdir(), 'devlog-test-proj-'));
  __resetForTests(homeTmp);
  await init();
});

afterEach(() => {
  __resetForTests();
  fs.rmSync(homeTmp, { recursive: true, force: true });
  fs.rmSync(projectAbs, { recursive: true, force: true });
});

function devlogPath(...parts: string[]): string {
  return path.join(projectAbs, '.devspace', 'devlog', ...parts);
}

describe('DevlogService.createEntry', () => {
  it('round-trips a plan via getEntry, preserving title + body + status', async () => {
    const entry = await createEntry({
      projectPath: projectAbs,
      type: 'plan',
      title: 'Design Studio Tier 1',
      body: 'Goal: ship tier 1 by Friday.\n\n- step 1\n- step 2',
    });
    expect(entry.type).toBe('plan');
    expect(entry.title).toBe('Design Studio Tier 1');
    // Plans default to in_progress when status not supplied.
    expect(entry.status).toBe('in_progress');
    expect(entry.id.startsWith('plan/')).toBe(true);
    const fetched = await getEntry({
      projectPath: projectAbs,
      entryId: entry.id,
    });
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe(entry.title);
    expect(fetched!.body).toContain('Goal: ship tier 1');
    expect(fetched!.status).toBe('in_progress');
  });

  it('writes the file under plans/ with date prefix + ascii kebab slug', async () => {
    const entry = await createEntry({
      projectPath: projectAbs,
      type: 'plan',
      title: 'Refactor Dashboard Tabs',
      body: '',
    });
    expect(entry.filename.endsWith('-refactor-dashboard-tabs.md')).toBe(true);
    expect(fs.existsSync(devlogPath('plans', entry.filename))).toBe(true);
  });

  it('writes agent entries with a HHMM time prefix', async () => {
    // 5-arg Date constructor uses LOCAL time so the test runs identically
    // in any timezone (the service uses local-tz ymd/hhmm for filename).
    const fixedNow = new Date(2026, 4, 18, 14, 30, 0);
    const entry = await createEntry({
      projectPath: projectAbs,
      type: 'agent',
      title: 'backend-developer',
      body: 'Built DevlogService.',
      subagentType: 'backend-developer',
      durationMs: 184000,
      verdict: 'success',
      now: fixedNow,
    });
    expect(entry.filename).toMatch(/^2026-05-18-1430-backend-developer\.md$/);
    expect(entry.durationMs).toBe(184000);
    expect(entry.verdict).toBe('success');
    expect(entry.subagentType).toBe('backend-developer');
  });

  it('rejects empty titles', async () => {
    await expect(
      createEntry({
        projectPath: projectAbs,
        type: 'plan',
        title: '   ',
        body: '',
      }),
    ).rejects.toThrow(/title is required/);
  });

  it('dedupes slug collisions within the same date', async () => {
    const fixedNow = new Date('2026-05-18T10:00:00Z');
    const a = await createEntry({
      projectPath: projectAbs,
      type: 'plan',
      title: 'Same Title',
      body: '',
      now: fixedNow,
    });
    const b = await createEntry({
      projectPath: projectAbs,
      type: 'plan',
      title: 'Same Title',
      body: '',
      now: fixedNow,
    });
    expect(a.filename).not.toBe(b.filename);
    expect(b.filename).toMatch(/-same-title-2\.md$/);
  });

  it('emits an entry_created event to subscribers', async () => {
    const events: { kind: string; entryId?: string }[] = [];
    const listener = (ev: { kind: string; entryId?: string }) =>
      events.push(ev);
    const unsub = subscribeEvents(listener);
    try {
      await createEntry({
        projectPath: projectAbs,
        type: 'result',
        title: 'Released 0.24.0',
        body: '',
        version: '0.24.0',
      });
    } finally {
      unsub();
    }
    const created = events.find((e) => e.kind === 'entry_created');
    expect(created).toBeDefined();
    expect(created!.entryId!.startsWith('result/')).toBe(true);
  });
});

describe('DevlogService.listEntries', () => {
  it('sorts by createdAt desc and filters by type', async () => {
    const old = await createEntry({
      projectPath: projectAbs,
      type: 'plan',
      title: 'Old Plan',
      body: '',
      now: new Date('2026-05-15T10:00:00Z'),
    });
    const fresh = await createEntry({
      projectPath: projectAbs,
      type: 'plan',
      title: 'Fresh Plan',
      body: '',
      now: new Date('2026-05-18T10:00:00Z'),
    });
    await createEntry({
      projectPath: projectAbs,
      type: 'result',
      title: 'A Release',
      body: '',
      now: new Date('2026-05-17T10:00:00Z'),
    });
    const plansOnly = await listEntries({
      projectPath: projectAbs,
      type: 'plan',
    });
    expect(plansOnly).toHaveLength(2);
    expect(plansOnly[0]!.id).toBe(fresh.id);
    expect(plansOnly[1]!.id).toBe(old.id);
    const all = await listEntries({ projectPath: projectAbs });
    expect(all).toHaveLength(3);
    // confirm desc sort across types
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1]!.createdAt).toBeGreaterThanOrEqual(all[i]!.createdAt);
    }
  });

  it('returns empty array for a project with no devlog dir', async () => {
    const list = await listEntries({ projectPath: projectAbs });
    expect(list).toEqual([]);
  });

  it('returns projection without body (lazy load)', async () => {
    await createEntry({
      projectPath: projectAbs,
      type: 'plan',
      title: 'Heavy Plan',
      body: 'a'.repeat(2000),
    });
    const list = await listEntries({ projectPath: projectAbs });
    expect(list).toHaveLength(1);
    expect(list[0]!.body).toBeUndefined();
    expect(list[0]!.preview.length).toBeGreaterThan(0);
  });
});

describe('DevlogService.updateEntry', () => {
  it('preserves untouched fields when patching title only', async () => {
    const created = await createEntry({
      projectPath: projectAbs,
      type: 'agent',
      title: 'Original Agent',
      body: 'work happened here',
      subagentType: 'security-engineer',
      durationMs: 5000,
      verdict: 'success',
    });
    const updated = await updateEntry({
      projectPath: projectAbs,
      entryId: created.id,
      title: 'Renamed Agent',
    });
    expect(updated.title).toBe('Renamed Agent');
    expect(updated.subagentType).toBe('security-engineer');
    expect(updated.durationMs).toBe(5000);
    expect(updated.verdict).toBe('success');
    // body is preserved verbatim aside from the trailing newline the
    // serializer normalizes onto every entry on disk.
    expect((updated.body ?? '').trimEnd()).toBe('work happened here');
  });

  it('rejects status updates on non-plan entries', async () => {
    const created = await createEntry({
      projectPath: projectAbs,
      type: 'result',
      title: 'A Release',
      body: '',
      version: '0.24.0',
    });
    await expect(
      updateEntry({
        projectPath: projectAbs,
        entryId: created.id,
        status: 'done',
      }),
    ).rejects.toThrow(/status only valid on plan/);
  });

  it('toggles plan status from in_progress → done', async () => {
    const created = await createEntry({
      projectPath: projectAbs,
      type: 'plan',
      title: 'Ship It',
      body: '',
    });
    expect(created.status).toBe('in_progress');
    const updated = await updateEntry({
      projectPath: projectAbs,
      entryId: created.id,
      status: 'done',
    });
    expect(updated.status).toBe('done');
    const reloaded = await getEntry({
      projectPath: projectAbs,
      entryId: created.id,
    });
    expect(reloaded!.status).toBe('done');
  });
});

describe('DevlogService.deleteEntry', () => {
  it('removes the file and is idempotent on second call', async () => {
    const created = await createEntry({
      projectPath: projectAbs,
      type: 'plan',
      title: 'Disposable',
      body: '',
    });
    expect(fs.existsSync(devlogPath('plans', created.filename))).toBe(true);
    await deleteEntry({ projectPath: projectAbs, entryId: created.id });
    expect(fs.existsSync(devlogPath('plans', created.filename))).toBe(false);
    // Second call must not throw — idempotent.
    await deleteEntry({ projectPath: projectAbs, entryId: created.id });
    // INDEX.md is regenerated, so the file should exist.
    // (regen runs async via void chain — let it settle.)
    await new Promise((r) => setTimeout(r, 30));
    const idxPath = devlogPath('INDEX.md');
    expect(fs.existsSync(idxPath)).toBe(true);
  });
});

describe('DevlogService.appendDailyLog', () => {
  it('creates a new daily log file with HH:MM prefix', async () => {
    // Local-tz Date — see comment above for rationale.
    const fixedNow = new Date(2026, 4, 18, 14, 30, 0);
    await appendDailyLog({
      projectPath: projectAbs,
      text: 'first entry of the day',
      now: fixedNow,
    });
    const file = devlogPath('log', '2026-05-18.md');
    expect(fs.existsSync(file)).toBe(true);
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).toContain('## 14:30');
    expect(raw).toContain('first entry of the day');
  });

  it('appends to an existing daily log with a new HH:MM prefix', async () => {
    const morning = new Date(2026, 4, 18, 9, 0, 0);
    const evening = new Date(2026, 4, 18, 20, 15, 0);
    await appendDailyLog({
      projectPath: projectAbs,
      text: 'morning note',
      now: morning,
    });
    await appendDailyLog({
      projectPath: projectAbs,
      text: 'evening note',
      now: evening,
    });
    const raw = fs.readFileSync(devlogPath('log', '2026-05-18.md'), 'utf8');
    expect(raw).toContain('## 09:00');
    expect(raw).toContain('morning note');
    expect(raw).toContain('## 20:15');
    expect(raw).toContain('evening note');
  });

  it('silently ignores empty/whitespace-only text', async () => {
    await appendDailyLog({
      projectPath: projectAbs,
      text: '   \n\t ',
    });
    // No file should have been created.
    expect(fs.existsSync(devlogPath('log'))).toBe(false);
  });
});

describe('DevlogService.buildInjectPreamble', () => {
  it('returns empty string when no entries exist', async () => {
    const out = await buildInjectPreamble(projectAbs);
    expect(out).toBe('');
  });

  it('returns empty string when injectOnNewThread=false', async () => {
    await createEntry({
      projectPath: projectAbs,
      type: 'plan',
      title: 'A Plan',
      body: '',
    });
    await setSettings({ injectOnNewThread: false }, projectAbs);
    const out = await buildInjectPreamble(projectAbs);
    expect(out).toBe('');
  });

  it('respects maxInjectEntries cap', async () => {
    for (let i = 0; i < 6; i++) {
      await createEntry({
        projectPath: projectAbs,
        type: 'plan',
        title: `Plan ${i}`,
        body: '',
        // distinct timestamps so sort order is deterministic
        now: new Date(2026, 4, 18, i, 0, 0),
      });
    }
    await setSettings({ maxInjectEntries: 3 }, projectAbs);
    const out = await buildInjectPreamble(projectAbs);
    // bullet list lines start with `- `
    const bullets = out.split('\n').filter((l) => l.startsWith('- '));
    expect(bullets).toHaveLength(3);
    expect(out).toContain('<<<devlog_context');
    expect(out).toContain('<<</devlog_context>>>');
    expect(out).toContain('## Project Devlog (last 3 entries)');
  });
});

describe('DevlogService security guards', () => {
  it('slug validation rejects path traversal in titles', async () => {
    // Title "../etc/passwd" must slugify into a safe ascii kebab and
    // land inside the type dir — never above it.
    const entry = await createEntry({
      projectPath: projectAbs,
      type: 'plan',
      title: '../etc/passwd',
      body: '',
    });
    expect(entry.filename).not.toContain('..');
    expect(entry.filename).not.toContain('/');
    // file is under plans/, not above devlog/
    const file = devlogPath('plans', entry.filename);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('slug normalization strips unicode + control chars from titles', async () => {
    const entry = await createEntry({
      projectPath: projectAbs,
      type: 'plan',
      // mix of unicode + control chars + ascii
      title: '日本語  plan ⚡',
      body: '',
    });
    // Whatever survives must be ascii kebab.
    const stem = entry.filename.slice(0, -3);
    const date = stem.slice(0, 10);
    const slug = stem.slice(11);
    expect(/^\d{4}-\d{2}-\d{2}$/.test(date)).toBe(true);
    expect(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)).toBe(true);
  });

  it('getEntry rejects entryIds with path traversal', async () => {
    await expect(
      getEntry({
        projectPath: projectAbs,
        entryId: 'plan/../../etc/passwd',
      }),
    ).rejects.toThrow();
  });

  it('getEntry rejects unknown types', async () => {
    await expect(
      getEntry({
        projectPath: projectAbs,
        entryId: 'haxx/2026-05-18-evil',
      }),
    ).rejects.toThrow(/invalid devlog type/);
  });
});

describe('DevlogService retention prune', () => {
  it('removes log files older than logRetentionDays based on filename date', async () => {
    // Seed two daily logs — one ancient, one fresh.
    const ancient = new Date('2025-01-01T10:00:00Z');
    const today = new Date();
    await appendDailyLog({
      projectPath: projectAbs,
      text: 'old log',
      now: ancient,
    });
    await appendDailyLog({
      projectPath: projectAbs,
      text: 'today log',
      now: today,
    });
    expect(fs.existsSync(devlogPath('log', '2025-01-01.md'))).toBe(true);

    // Default logRetentionDays is 90 — the 2025 entry should be pruned.
    const stats = await pruneByRetention(projectAbs);
    expect(stats.logsRemoved).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(devlogPath('log', '2025-01-01.md'))).toBe(false);
  });

  it('keeps plans + results forever even with retention=1 day', async () => {
    const ancient = new Date('2024-01-01T10:00:00Z');
    const plan = await createEntry({
      projectPath: projectAbs,
      type: 'plan',
      title: 'Ancient Plan',
      body: '',
      now: ancient,
    });
    await setSettings({ logRetentionDays: 1, agentRetentionDays: 1 }, projectAbs);
    await pruneByRetention(projectAbs);
    expect(fs.existsSync(devlogPath('plans', plan.filename))).toBe(true);
  });

  it('respects logRetentionDays=0 (forever)', async () => {
    const ancient = new Date('2024-01-01T10:00:00Z');
    await appendDailyLog({
      projectPath: projectAbs,
      text: 'old log',
      now: ancient,
    });
    await setSettings({ logRetentionDays: 0 }, projectAbs);
    const stats = await pruneByRetention(projectAbs);
    expect(stats.logsRemoved).toBe(0);
    expect(fs.existsSync(devlogPath('log', '2024-01-01.md'))).toBe(true);
  });
});

describe('DevlogService.frontmatter parser edge cases', () => {
  it('survives a file with trailing whitespace + missing optional keys', async () => {
    // Hand-craft a frontmatter file that includes whitespace around
    // keys, missing optionals, and a list value. The walker must
    // accept it and project the entry into listEntries.
    const dir = devlogPath('plans');
    fs.mkdirSync(dir, { recursive: true });
    const filename = '2026-05-18-handcrafted.md';
    const raw = [
      '---',
      'type: plan',
      'title:   "Hand Crafted"   ',
      'createdAt: 2026-05-18T10:00:00Z',
      'updatedAt: 2026-05-18T11:00:00Z',
      'status: in_progress',
      'links: [other-plan, follow-up]',
      '---',
      '',
      'Body content here.',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, filename), raw, 'utf8');
    const list = await listEntries({ projectPath: projectAbs, type: 'plan' });
    expect(list).toHaveLength(1);
    expect(list[0]!.title).toBe('Hand Crafted');
    expect(list[0]!.status).toBe('in_progress');
    expect(list[0]!.links).toContain('other-plan');
    expect(list[0]!.links).toContain('follow-up');
  });

  it('ignores files with invalid filenames (not date-prefixed)', async () => {
    const dir = devlogPath('plans');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'not-a-date.md'),
      '---\ntype: plan\ntitle: bad\n---\n',
      'utf8',
    );
    const list = await listEntries({ projectPath: projectAbs, type: 'plan' });
    expect(list).toEqual([]);
  });

  it('rejects unknown frontmatter status values gracefully (falls back)', async () => {
    const dir = devlogPath('plans');
    fs.mkdirSync(dir, { recursive: true });
    const raw = [
      '---',
      'type: plan',
      'title: Bad Status',
      'createdAt: 2026-05-18T10:00:00Z',
      'updatedAt: 2026-05-18T10:00:00Z',
      'status: invented-status',
      '---',
      '',
      'body',
    ].join('\n');
    fs.writeFileSync(path.join(dir, '2026-05-18-bad-status.md'), raw, 'utf8');
    const list = await listEntries({ projectPath: projectAbs, type: 'plan' });
    expect(list).toHaveLength(1);
    expect(list[0]!.status).toBeUndefined();
  });
});

describe('DevlogService.settings', () => {
  it('falls back to baseline defaults when no global file exists', async () => {
    const def = await getSettings();
    expect(def.enabled).toBe(true);
    expect(def.autoCaptureAgents).toBe(true);
    expect(def.autoCaptureReleases).toBe(false);
    expect(def.injectOnNewThread).toBe(true);
    expect(def.maxInjectEntries).toBe(10);
    expect(def.maxInjectLines).toBe(150);
    expect(def.commitToRepo).toBe(false);
    expect(def.logRetentionDays).toBe(90);
    expect(def.agentRetentionDays).toBe(60);
  });

  it('persists project-scoped settings and merges with defaults', async () => {
    const updated = await setSettings(
      { maxInjectEntries: 5, autoCaptureAgents: false },
      projectAbs,
    );
    expect(updated.maxInjectEntries).toBe(5);
    expect(updated.autoCaptureAgents).toBe(false);
    // unchanged fields keep defaults
    expect(updated.injectOnNewThread).toBe(true);
    // Reset cache to force a fresh disk read.
    __resetForTests(homeTmp);
    await init();
    const reloaded = await getSettings(projectAbs);
    expect(reloaded.maxInjectEntries).toBe(5);
    expect(reloaded.autoCaptureAgents).toBe(false);
  });

  it('clamps out-of-range maxInjectEntries', async () => {
    const updated = await setSettings(
      { maxInjectEntries: 9999 },
      projectAbs,
    );
    expect(updated.maxInjectEntries).toBeLessThanOrEqual(100);
  });

  // v0.25: new auto-capture toggle for end-of-turn work signals.
  // Defaults true (smart threshold), persists across reload, and merges
  // with other settings without clobbering them. Regression: ChatService
  // reads this flag through getSettings — if either layer drops it the
  // smart capture goes silent without errors.
  it('defaults autoCaptureWork to true and persists overrides', async () => {
    const fresh = await getSettings(projectAbs);
    expect(fresh.autoCaptureWork).toBe(true);
    const updated = await setSettings(
      { autoCaptureWork: false },
      projectAbs,
    );
    expect(updated.autoCaptureWork).toBe(false);
    // Other fields unaffected.
    expect(updated.autoCaptureAgents).toBe(true);
    expect(updated.injectOnNewThread).toBe(true);
    // Reset cache and reload from disk.
    __resetForTests(homeTmp);
    await init();
    const reloaded = await getSettings(projectAbs);
    expect(reloaded.autoCaptureWork).toBe(false);
    expect(reloaded.autoCaptureAgents).toBe(true);
  });
});
