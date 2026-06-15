import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Sub-project 3 consumer tests: #2 (distilled preference → inject preamble) and
// #1 (auto-surface a related learning via the semantic recall pass). The
// EmbeddingService is mocked so the semantic recall is deterministic and we can
// engineer a query that is semantically near a learning while sharing NO literal
// keywords. (Same fake-embedder strategy as MemoryService.semantic.test.ts.)

const DIM = 384;

function conceptVec(axis: number): Float32Array {
  const v = new Float32Array(DIM);
  v[axis] = 1;
  return v;
}

// Map distinct, non-overlapping phrases onto the SAME concept axis so they are
// cosine-near without sharing tokens.
function vectorForText(text: string): Float32Array {
  const t = text.toLowerCase();
  if (t.includes('migration') || t.includes('schema') || t.includes('alembic')) {
    return conceptVec(0); // "database change" concept
  }
  if (t.includes('latency') || t.includes('p99') || t.includes('throughput')) {
    return conceptVec(1); // "performance" concept
  }
  // Unknown → its own orthogonal axis (stable per text length).
  return conceptVec(3 + (text.length % 300));
}

let available = true;

vi.mock('@main/services/EmbeddingService', () => ({
  EMBEDDING_DIM: 384,
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
  EmbeddingUnavailableError: class extends Error {},
  embed: vi.fn(async (text: string) => {
    if (!available) throw new Error('unavailable');
    return vectorForText(text);
  }),
  embedBatch: vi.fn(async (texts: string[]) => {
    if (!available) throw new Error('unavailable');
    return texts.map(vectorForText);
  }),
  isAvailable: vi.fn(async () => available),
}));

import {
  __resetForTests,
  buildInjectPreamble,
  buildRecallContext,
  createEntry,
  init,
  setSettings,
} from '@main/services/MemoryService';

let tmpRoot: string;
let projectAbs: string;

// Let fire-and-forget embeds (createEntry) land in the vector index.
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setImmediate(r));
}

beforeEach(async () => {
  available = true;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devspace-nl-'));
  projectAbs = fs.mkdtempSync(path.join(os.tmpdir(), 'devspace-nl-proj-'));
  __resetForTests(tmpRoot);
  await init();
});

afterEach(() => {
  __resetForTests();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(projectAbs, { recursive: true, force: true });
});

// ─── #2: distilled preference (feedback type) appears in the inject preamble ──

describe('native learning #2 — distilled preference → inject preamble', () => {
  it('includes a distilled feedback/preference entry in the preamble', async () => {
    await setSettings({ enabled: true, injectOnNewThread: true });
    // A distilled "preference" learning persists as a 'feedback' entry.
    await createEntry({
      scope: 'project',
      projectPath: projectAbs,
      type: 'feedback',
      slug: 'prefer-pnpm',
      description: 'Prefer pnpm over npm for this repo',
      body: 'The repo is a pnpm monorepo; use rtk pnpm.',
      tags: ['distilled'],
    });

    const preamble = await buildInjectPreamble(projectAbs);
    expect(preamble).toContain('Prefer pnpm over npm');
    // Still wrapped in the untrusted-data fence (preamble safety preserved).
    expect(preamble).toContain('project-memory-reference');
  });

  it('also surfaces a distilled lesson entry in the preamble', async () => {
    await setSettings({ enabled: true, injectOnNewThread: true });
    await createEntry({
      scope: 'project',
      projectPath: projectAbs,
      type: 'lesson',
      slug: 'embed-race',
      description: 'Await fire-and-forget embeds before asserting',
      body: 'Otherwise vector-index tests are flaky.',
      tags: ['distilled'],
    });
    const preamble = await buildInjectPreamble(projectAbs);
    expect(preamble).toContain('Await fire-and-forget embeds');
  });
});

// ─── #1: semantic auto-surface in buildRecallContext ─────────────────────────

describe('native learning #1 — auto-surface related learning (semantic recall)', () => {
  it('surfaces a related learning for a query sharing NO keywords', async () => {
    await setSettings({ enabled: true });
    // A distilled lesson about database migrations.
    await createEntry({
      scope: 'project',
      projectPath: projectAbs,
      type: 'lesson',
      slug: 'migration-lesson',
      description: 'Run schema migrations behind a feature flag',
      body: 'Alembic migrations must be reversible and gated.',
    });
    await settle();

    // Query shares NO literal token with the entry ("database change" concept
    // via a different surface form) — only the semantic pass can connect them.
    const out = await buildRecallContext({
      query: 'altering the alembic table structure safely',
      projectPath: projectAbs,
      limit: 3,
    });

    expect(out).not.toBe('');
    expect(out).toContain('Run schema migrations');
    // The framing header + the learning-type tag are present.
    expect(out).toContain("You've dealt with something like this before");
    expect(out).toContain('_(lesson)_');
  });

  it('degrades to keyword-only (no semantic surfacing) when the embedder is unavailable', async () => {
    await setSettings({ enabled: true });
    await createEntry({
      scope: 'project',
      projectPath: projectAbs,
      type: 'lesson',
      slug: 'migration-lesson-2',
      description: 'Run schema migrations behind a feature flag',
      body: 'Alembic migrations must be reversible and gated.',
    });
    await settle();

    // Flip the embedder OFF: hybrid recall must degrade to keyword-only. A query
    // that shares NO keyword with the entry then yields no recall — proving the
    // semantic pass is purely additive and recall never breaks without a model.
    available = false;
    const out = await buildRecallContext({
      query: 'zzz-orthogonal-nomatch-token',
      projectPath: projectAbs,
      limit: 3,
    });
    expect(out).toBe('');
  });
});
