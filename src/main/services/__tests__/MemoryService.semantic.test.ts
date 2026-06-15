import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Sub-project 2: semantic search in MemoryService. We mock the EmbeddingService
// so embeddings are deterministic (no real model needed) and we can flip the
// embedder "available/unavailable" to prove the keyword-only fallback.
//
// The fake assigns each known phrase a fixed unit vector in a tiny semantic
// space, so we can engineer a query that is close to one entry and far from
// another WITHOUT sharing keywords.

const DIM = 384;

// Deterministic unit vectors keyed by a "concept" axis. Two phrases on the same
// axis are near-identical (cosine ~1); different axes are orthogonal (cosine 0).
function conceptVec(axis: number): Float32Array {
  const v = new Float32Array(DIM);
  v[axis] = 1;
  return v;
}

// Map substrings → concept axis. The query and the semantically-related entry
// share an axis but NOT any literal token.
function vectorForText(text: string): Float32Array {
  const t = text.toLowerCase();
  if (t.includes('feline') || t.includes('whiskers')) return conceptVec(0); // "cat" concept
  if (t.includes('canine') || t.includes('barks')) return conceptVec(1); // "dog" concept
  if (t.includes('automobile') || t.includes('engine')) return conceptVec(2); // "car" concept
  // Unknown → its own orthogonal axis derived from length (stable per text).
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
  __vectorTestHooks,
  createEntry,
  deleteEntry,
  init,
  projectHashFor,
  search,
} from '@main/services/MemoryService';

let tmpRoot: string;
let projectAbs: string;

// Give fire-and-forget embeds (createEntry) a tick to land in the vector index.
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setImmediate(r));
}

beforeEach(async () => {
  available = true;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devspace-memsem-'));
  projectAbs = fs.mkdtempSync(path.join(os.tmpdir(), 'devspace-memsem-proj-'));
  __resetForTests(tmpRoot);
  await init();
});

afterEach(() => {
  __resetForTests();
  __vectorTestHooks.reset();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(projectAbs, { recursive: true, force: true });
});

describe('MemoryService semantic search', () => {
  it('hybrid finds a semantically-related entry that shares no keywords', async () => {
    // Entry A is about cats but never says "feline".
    await createEntry({
      scope: 'project',
      projectPath: projectAbs,
      type: 'project',
      slug: 'pet-notes',
      description: 'whiskers the housepet',
      body: 'the small animal with whiskers',
    });
    // Entry B is about cars — unrelated.
    await createEntry({
      scope: 'project',
      projectPath: projectAbs,
      type: 'project',
      slug: 'vehicle-notes',
      description: 'automobile maintenance',
      body: 'engine oil and tires',
    });
    await settle();

    // Query uses "feline" — shares NO literal token with "whiskers/housepet",
    // so pure keyword search would miss entry A entirely. Semantic should find it.
    const kw = await search({ query: 'feline', projectPath: projectAbs, mode: 'keyword' });
    expect(kw.find((h) => h.entry.slug === 'pet-notes')).toBeUndefined();

    const hits = await search({ query: 'feline', projectPath: projectAbs, mode: 'hybrid' });
    const top = hits[0];
    expect(top.entry.slug).toBe('pet-notes');
    expect(top.matchedFields).toContain('semantic');
  });

  it('semantic-only mode returns the nearest entry by cosine', async () => {
    await createEntry({
      scope: 'project',
      projectPath: projectAbs,
      type: 'project',
      slug: 'dog-notes',
      description: 'canine companion',
      body: 'it barks',
    });
    await createEntry({
      scope: 'project',
      projectPath: projectAbs,
      type: 'project',
      slug: 'cat-notes',
      description: 'feline friend',
      body: 'whiskers',
    });
    await settle();

    const hits = await search({ query: 'barks loudly', projectPath: projectAbs, mode: 'semantic' });
    expect(hits[0].entry.slug).toBe('dog-notes');
    expect(hits[0].matchedFields).toContain('semantic');
  });

  it('falls back to keyword-only when the embedder is unavailable', async () => {
    await createEntry({
      scope: 'project',
      projectPath: projectAbs,
      type: 'project',
      slug: 'keyword-entry',
      description: 'searchable token zebra',
      body: 'body text',
    });
    await settle();

    // Embedder goes dark — hybrid must still return keyword hits, never throw.
    available = false;
    const hits = await search({ query: 'zebra', projectPath: projectAbs, mode: 'hybrid' });
    expect(hits.length).toBe(1);
    expect(hits[0].entry.slug).toBe('keyword-entry');
    // No semantic contribution when the embedder is down.
    expect(hits[0].matchedFields).not.toContain('semantic');
  });

  it('keeps the vector index in sync on create and delete', async () => {
    const hash = projectHashFor(projectAbs);
    const entry = await createEntry({
      scope: 'project',
      projectPath: projectAbs,
      type: 'project',
      slug: 'sync-entry',
      description: 'feline subject',
      body: 'whiskers',
    });
    await settle();

    const idx = __vectorTestHooks.indexFor('project', hash);
    expect(idx.size).toBe(1);

    // Found via semantic before delete.
    let hits = await search({ query: 'feline', projectPath: projectAbs, mode: 'semantic' });
    expect(hits.find((h) => h.entry.id === entry.id)).toBeDefined();

    await deleteEntry(entry.id);
    await settle();
    expect(idx.size).toBe(0);

    hits = await search({ query: 'feline', projectPath: projectAbs, mode: 'semantic' });
    expect(hits.find((h) => h.entry.id === entry.id)).toBeUndefined();
  });

  it('rebuilds the vector index from markdown when none is persisted', async () => {
    const hash = projectHashFor(projectAbs);
    await createEntry({
      scope: 'project',
      projectPath: projectAbs,
      type: 'project',
      slug: 'rebuild-me',
      description: 'feline rebuild subject',
      body: 'whiskers',
    });
    await settle();

    // Simulate a fresh process: clear in-memory vector state, then trigger a
    // rebuild from the still-present markdown entries.
    __vectorTestHooks.reset();
    await __vectorTestHooks.rebuild('project', hash);

    const idx = __vectorTestHooks.indexFor('project', hash);
    expect(idx.size).toBe(1);
    const hits = await search({ query: 'feline', projectPath: projectAbs, mode: 'semantic' });
    expect(hits[0].entry.slug).toBe('rebuild-me');
  });
});
