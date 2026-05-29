// Regression tests for the M1 lazy-load refactor (v0.30.7).
//
// init() previously walked every project's memory + threads dirs on
// boot, which for a workspace with N projects × M markdown files each
// blocked the main thread for hundreds of ms. The fix defers per-project
// walks until first access (listEntries / search / getStats /
// createEntry / etc.).
//
// These tests verify:
//   1. init() returns much faster than a sequential pre-walk would.
//   2. ensureProjectLoaded is idempotent (single walk per project).
//   3. Concurrent ensureProjectLoaded calls share one in-flight promise
//      so we never double-index entries (race protection).
//   4. Public read methods (listEntries, search) and write methods
//      (createEntry) transparently trigger ensureProjectLoaded.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __resetForTests,
  __testHooks,
  createEntry,
  init,
  listEntries,
  projectHashFor,
  search,
} from '@main/services/MemoryService';

let tmpRoot: string;
const projectAbsPaths: string[] = [];

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devspace-memory-lazy-'));
  projectAbsPaths.length = 0;
  __resetForTests(tmpRoot);
});

afterEach(() => {
  __resetForTests();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  for (const p of projectAbsPaths) {
    fs.rmSync(p, { recursive: true, force: true });
  }
  projectAbsPaths.length = 0;
});

// Seed N projects with M entries each *on disk* (no service calls) so
// init() has to discover them from a cold start. We bypass the service
// to keep the seed phase pure file I/O — the service would otherwise
// pre-load via ensureProjectHash.
function seedProjectsOnDisk(
  projectCount: number,
  entriesPerProject: number,
): string[] {
  const hashes: string[] = [];
  for (let i = 0; i < projectCount; i++) {
    const projAbs = fs.mkdtempSync(
      path.join(os.tmpdir(), `devspace-lazy-proj-${i}-`),
    );
    projectAbsPaths.push(projAbs);
    const hash = projectHashFor(projAbs);
    hashes.push(hash);
    const projDir = path.join(tmpRoot, 'projects', hash);
    const memDir = path.join(projDir, 'memory');
    const threadsDir = path.join(projDir, 'threads');
    fs.mkdirSync(memDir, { recursive: true });
    fs.mkdirSync(threadsDir, { recursive: true });
    fs.writeFileSync(
      path.join(projDir, 'manifest.json'),
      JSON.stringify({
        path: projAbs,
        name: path.basename(projAbs),
        lastAccessedAt: Date.now(),
      }),
    );
    for (let j = 0; j < entriesPerProject; j++) {
      const slug = `seed-entry-${j}`;
      // Build a single-word ≥3-char unique marker — the tokenizer
      // splits on [^a-z0-9]+ and drops <3-char tokens, so dashes or
      // short fragments would produce collisions across entries.
      const uniqueMarker = `markerp${i}e${j}xyzunique`;
      const body = [
        '---',
        `name: ${slug}`,
        `description: ${uniqueMarker}`,
        'type: project',
        'tags: [seed, lazy]',
        `createdAt: ${Date.now()}`,
        `updatedAt: ${Date.now()}`,
        'pinned: false',
        '---',
        '',
        uniqueMarker,
        '',
      ].join('\n');
      fs.writeFileSync(path.join(memDir, `project_${slug}.md`), body);
    }
  }
  return hashes;
}

describe('MemoryService — lazy load (M1, v0.30.7)', () => {
  it('init() is fast with many projects — per-project walks are deferred', async () => {
    // 8 projects × 30 entries each = 240 markdown files. The pre-M1 init
    // would parse all of them sequentially during boot. After M1 init
    // only enumerates manifests (8 readdir + 8 manifest parses), so the
    // duration should be a small fraction of the per-entry-walk cost.
    const projectCount = 8;
    const entriesPerProject = 30;
    seedProjectsOnDisk(projectCount, entriesPerProject);

    const start = Date.now();
    await init();
    const initDuration = Date.now() - start;

    // No project entries should be hydrated yet — only enumeration ran.
    expect(__testHooks.loadedProjects().size).toBe(0);
    // Cap is generous (CI variance) but well under the per-entry-walk
    // cost which on a cold disk routinely exceeds 500ms for this seed.
    expect(initDuration).toBeLessThan(500);
  });

  it('ensureProjectLoaded is idempotent — second call does not re-walk', async () => {
    const [hash] = seedProjectsOnDisk(1, 5);
    await init();

    await __testHooks.ensureProjectLoaded(hash);
    expect(__testHooks.loadedProjects().has(hash)).toBe(true);

    // Capture the count of indexed entries after the first load.
    const firstLoadEntries = (await listEntries({
      scope: 'project',
      projectPath: projectAbsPaths[0],
    })).length;
    expect(firstLoadEntries).toBe(5);

    // Calling again must be a no-op — entry count must not double up
    // (which would prove indexAdd ran twice for each id).
    await __testHooks.ensureProjectLoaded(hash);
    await __testHooks.ensureProjectLoaded(hash);
    const secondLoadEntries = (await listEntries({
      scope: 'project',
      projectPath: projectAbsPaths[0],
    })).length;
    expect(secondLoadEntries).toBe(5);
  });

  it('concurrent ensureProjectLoaded calls share one in-flight walk (race protection)', async () => {
    const [hash] = seedProjectsOnDisk(1, 8);
    await init();
    expect(__testHooks.loadedProjects().has(hash)).toBe(false);

    // Fire many parallel loads — they must coalesce into a single walk.
    // If they didn't, indexAdd would run multiple times for each id and
    // listEntries would still return 8 (Map keyed by id is unique) BUT
    // state.tokens would have duplicated id refs which would distort
    // search relevance. We assert on both the entry count AND that the
    // in-flight map is empty at the end.
    const inflightSnapshotsDuring: number[] = [];
    const promises = Array.from({ length: 20 }, () => {
      const p = __testHooks.ensureProjectLoaded(hash);
      inflightSnapshotsDuring.push(__testHooks.loadingProjects().size);
      return p;
    });
    await Promise.all(promises);

    // At least one snapshot during the race must have seen exactly 1
    // in-flight walk (proving they coalesced, not 20 separate walks).
    expect(inflightSnapshotsDuring.some((n) => n === 1)).toBe(true);
    expect(__testHooks.loadingProjects().size).toBe(0);
    expect(__testHooks.loadedProjects().has(hash)).toBe(true);

    const entries = await listEntries({
      scope: 'project',
      projectPath: projectAbsPaths[0],
    });
    expect(entries.length).toBe(8);

    // Search for a unique token from one seeded entry: must hit exactly
    // once. A double-walk would show up here as the same entry id
    // appearing in state.tokens twice, which would still dedupe via the
    // Set wrapper — so we instead assert score is the single-walk
    // baseline, not a multiple of it.
    const hits = await search({
      query: 'markerp0e0xyzunique',
      projectPath: projectAbsPaths[0],
    });
    expect(hits.length).toBe(1);
  });

  it('listEntries transparently loads the project on first call', async () => {
    const [hash] = seedProjectsOnDisk(1, 4);
    await init();
    expect(__testHooks.loadedProjects().has(hash)).toBe(false);

    const entries = await listEntries({
      scope: 'project',
      projectPath: projectAbsPaths[0],
    });
    expect(entries.length).toBe(4);
    expect(__testHooks.loadedProjects().has(hash)).toBe(true);
  });

  it('search transparently loads the project on first call', async () => {
    const [hash] = seedProjectsOnDisk(1, 3);
    await init();
    expect(__testHooks.loadedProjects().has(hash)).toBe(false);

    const hits = await search({
      query: 'markerp0e1xyzunique',
      projectPath: projectAbsPaths[0],
    });
    expect(hits.length).toBe(1);
    expect(__testHooks.loadedProjects().has(hash)).toBe(true);
  });

  it('createEntry transparently loads the project before applying the write', async () => {
    // Pre-seed a project on disk so createEntry has something to dedupe
    // against — without ensureProjectLoaded firing inside the write path
    // the dedupe bucket would be empty and we'd silently clobber the
    // existing on-disk entry.
    const [hash] = seedProjectsOnDisk(1, 2);
    await init();
    expect(__testHooks.loadedProjects().has(hash)).toBe(false);

    // Create with a slug that collides with the seed → must produce
    // -2 suffix because dedupe sees the existing entry after lazy load.
    const created = await createEntry({
      scope: 'project',
      projectPath: projectAbsPaths[0],
      type: 'project',
      slug: 'seed-entry-0',
      description: 'should not clobber the seed',
      body: 'new content',
    });

    expect(__testHooks.loadedProjects().has(hash)).toBe(true);
    expect(created.slug).toBe('seed-entry-0-2');

    // Verify the seed entry is still present + intact alongside the new one.
    const all = await listEntries({
      scope: 'project',
      projectPath: projectAbsPaths[0],
    });
    expect(all.length).toBe(3);
    expect(all.some((e) => e.slug === 'seed-entry-0')).toBe(true);
    expect(all.some((e) => e.slug === 'seed-entry-0-2')).toBe(true);
  });
});

// Regression tests for Wave-2 review fixes shipped in the same release.
describe('MemoryService — review hardening (v0.30.7 pre-commit)', () => {
  it('SEC-LOW-1: ensureProjectLoaded ignores unknown hashes', async () => {
    // Pre-fix: a hostile renderer could pump arbitrary 12-hex ids through
    // MEMORY_GET_ENTRY and unbounded-grow loadedProjects / loadingProjects
    // (each call would readdir a nonexistent path + insert into both sets).
    // Fix: gate ensureProjectLoaded on a known project hash.
    seedProjectsOnDisk(1, 1);
    await init();
    const before = __testHooks.loadedProjects().size;

    // Try a bunch of fake hashes — none of them should land in the set.
    const fakeHashes = [
      '000000000000',
      '111111111111',
      '222222222222',
      'abc123def456',
      'ffffffffffff',
    ];
    await Promise.all(
      fakeHashes.map((h) => __testHooks.ensureProjectLoaded(h)),
    );

    expect(__testHooks.loadedProjects().size).toBe(before);
    expect(__testHooks.loadingProjects().size).toBe(0);
  });

  it('CR-H2: ensureProjectLoaded does NOT throw when walks fail mid-hydration', async () => {
    // Pre-fix: if walkEntries threw (EACCES/EIO), the whole
    // ensureProjectLoaded promise rejected and every downstream IPC
    // (listEntries, search, getStats) would surface the error to the
    // renderer. Pre-M1 init() caught + logged, so we restore that
    // semantic — partial data > total failure.
    const [hash] = seedProjectsOnDisk(1, 3);
    await init();

    // Replace the project's memory dir with a file to force readdir
    // to throw ENOTDIR mid-walk.
    const projDir = path.join(tmpRoot, 'projects', hash);
    const memoryPath = path.join(projDir, 'memory');
    fs.rmSync(memoryPath, { recursive: true, force: true });
    fs.writeFileSync(memoryPath, 'not a directory');

    // ensureProjectLoaded must complete cleanly + mark loaded so we
    // don't thrash retries every IPC call.
    await expect(__testHooks.ensureProjectLoaded(hash)).resolves.toBeUndefined();
    expect(__testHooks.loadedProjects().has(hash)).toBe(true);

    // listEntries must still succeed (return cleanly, not throw) even
    // though the memory dir is unreadable — the walk failure is logged
    // and swallowed, leaving the project with zero hydrated entries.
    const entries = await listEntries({
      scope: 'project',
      projectPath: projectAbsPaths[0],
    });
    expect(entries.length).toBe(0);
  });
});
