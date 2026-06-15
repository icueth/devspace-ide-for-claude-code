import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// VectorIndex imports EmbeddingService (for EMBEDDING_DIM / EMBEDDING_MODEL_ID),
// which statically imports electron's `app`. Mock electron so this pure test
// doesn't need an Electron runtime. transformers is never touched here.
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
}));

import { EMBEDDING_DIM, EMBEDDING_MODEL_ID } from './EmbeddingService';
import { VectorIndex } from './VectorIndex';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'devspace-vecidx-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// A normalized vector pointing mostly along one axis, with a small tail so two
// "axes" can be ranked by closeness.
function unitish(axis: number, dim = EMBEDDING_DIM): Float32Array {
  const v = new Float32Array(dim);
  v[axis % dim] = 1;
  // tiny perturbation so vectors aren't perfectly orthogonal
  v[(axis + 1) % dim] = 0.01;
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < dim; i++) v[i] /= n;
  return v;
}

describe('VectorIndex', () => {
  it('upsert + query ranks the nearest vector first', async () => {
    const idx = new VectorIndex();
    await idx.load(dir);
    const a = unitish(0);
    const b = unitish(100);
    const c = unitish(200);
    idx.upsert('a', a);
    idx.upsert('b', b);
    idx.upsert('c', c);
    expect(idx.size).toBe(3);

    // Query with a vector ~equal to a → 'a' ranks first.
    const hits = idx.query(a, 3);
    expect(hits[0].id).toBe('a');
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect(hits[0].score).toBeCloseTo(1, 5);
  });

  it('upsert overwrites the vector for an existing id', async () => {
    const idx = new VectorIndex();
    await idx.load(dir);
    idx.upsert('x', unitish(0));
    idx.upsert('x', unitish(50)); // overwrite
    expect(idx.size).toBe(1);
    const hits = idx.query(unitish(50), 1);
    expect(hits[0].id).toBe('x');
    expect(hits[0].score).toBeCloseTo(1, 5);
  });

  it('remove() drops a vector from results', async () => {
    const idx = new VectorIndex();
    await idx.load(dir);
    idx.upsert('a', unitish(0));
    idx.upsert('b', unitish(100));
    idx.remove('a');
    expect(idx.size).toBe(1);
    const hits = idx.query(unitish(0), 5);
    expect(hits.find((h) => h.id === 'a')).toBeUndefined();
  });

  it('query rejects a dimension mismatch and empty index', async () => {
    const idx = new VectorIndex();
    await idx.load(dir);
    expect(idx.query(unitish(0), 5)).toEqual([]); // empty
    idx.upsert('a', unitish(0));
    expect(idx.query(new Float32Array(10), 5)).toEqual([]); // wrong dim
    expect(idx.query(unitish(0), 0)).toEqual([]); // k=0
  });

  it('upsert throws on a wrong-dimension vector', async () => {
    const idx = new VectorIndex();
    await idx.load(dir);
    expect(() => idx.upsert('bad', new Float32Array(10))).toThrow(/dim/);
  });

  it('persist + reload round-trips vectors and ranking', async () => {
    const idx = new VectorIndex();
    await idx.load(dir);
    idx.upsert('a', unitish(0));
    idx.upsert('b', unitish(100));
    idx.upsert('c', unitish(200));
    await idx.flush();

    // meta.json + index.bin exist
    const meta = JSON.parse(
      await readFile(path.join(dir, '.embeddings', 'meta.json'), 'utf8'),
    );
    expect(meta.model).toBe(EMBEDDING_MODEL_ID);
    expect(meta.dim).toBe(EMBEDDING_DIM);
    expect(meta.count).toBe(3);

    // Fresh index loads the same data
    const idx2 = new VectorIndex();
    const loaded = await idx2.load(dir);
    expect(loaded).toBe(true);
    expect(idx2.size).toBe(3);
    const hits = idx2.query(unitish(100), 3);
    expect(hits[0].id).toBe('b');
    expect(hits[0].score).toBeCloseTo(1, 4);
  });

  it('load() returns false on first run (no persisted index)', async () => {
    const idx = new VectorIndex();
    const loaded = await idx.load(dir);
    expect(loaded).toBe(false);
    expect(idx.size).toBe(0);
  });

  it('invalidates the index when meta model/dim mismatches', async () => {
    // Write a valid index first.
    const idx = new VectorIndex();
    await idx.load(dir);
    idx.upsert('a', unitish(0));
    await idx.flush();

    // Corrupt the meta to a different model id.
    const metaPath = path.join(dir, '.embeddings', 'meta.json');
    await writeFile(
      metaPath,
      JSON.stringify({ model: 'some-other-model', dim: EMBEDDING_DIM, count: 1 }),
    );

    const idx2 = new VectorIndex();
    const loaded = await idx2.load(dir);
    expect(loaded).toBe(false); // → caller will rebuild
    expect(idx2.size).toBe(0);
  });

  it('invalidates when the dim changes', async () => {
    const idx = new VectorIndex();
    await idx.load(dir);
    idx.upsert('a', unitish(0));
    await idx.flush();
    const metaPath = path.join(dir, '.embeddings', 'meta.json');
    await writeFile(
      metaPath,
      JSON.stringify({ model: EMBEDDING_MODEL_ID, dim: 128, count: 1 }),
    );
    const idx2 = new VectorIndex();
    expect(await idx2.load(dir)).toBe(false);
    expect(idx2.size).toBe(0);
  });

  it('treats a corrupt index.bin as empty (returns false)', async () => {
    const idx = new VectorIndex();
    await idx.load(dir);
    idx.upsert('a', unitish(0));
    await idx.flush();
    // Truncate index.bin to garbage while keeping a valid meta.
    await writeFile(path.join(dir, '.embeddings', 'index.bin'), Buffer.from([1, 2, 3]));
    const idx2 = new VectorIndex();
    expect(await idx2.load(dir)).toBe(false);
    expect(idx2.size).toBe(0);
  });

  it('clear() empties the index', async () => {
    const idx = new VectorIndex();
    await idx.load(dir);
    idx.upsert('a', unitish(0));
    idx.upsert('b', unitish(50));
    idx.clear();
    expect(idx.size).toBe(0);
    expect(idx.query(unitish(0), 5)).toEqual([]);
  });
});
