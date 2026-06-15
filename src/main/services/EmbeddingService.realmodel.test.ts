import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// REAL-MODEL end-to-end test (gated by RUN_EMBEDDING_MODEL=1). Exercises the
// actual EmbeddingService (loading the vendored ONNX model from
// resources/embeddings/, offline) AND the real VectorIndex, proving a related
// entry ranks above an unrelated one — the thing keyword search can't do.
// Skipped in CI so the suite passes without the ~87MB model.
//
// IMPORTANT: this file does NOT mock '@huggingface/transformers', so the real
// pipeline runs. electron is still mocked (no Electron runtime in vitest); the
// service's vendoredModelRoot() then falls back to <cwd>/resources/embeddings.

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
}));

const RUN = process.env.RUN_EMBEDDING_MODEL === '1';

describe.skipIf(!RUN)('EmbeddingService + VectorIndex (real model, offline)', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'devspace-realmodel-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('embeds 384-dim normalized and ranks related > unrelated via VectorIndex', async () => {
    const Embedding = await import('./EmbeddingService');
    const { VectorIndex } = await import('./VectorIndex');
    Embedding.__resetForTests();

    expect(await Embedding.isAvailable()).toBe(true);

    const qv = await Embedding.embed('how do I deploy the application to production');
    expect(qv.length).toBe(384);
    let n = 0;
    for (const x of qv) n += x * x;
    expect(Math.sqrt(n)).toBeCloseTo(1, 3);

    const idx = new VectorIndex();
    await idx.load(dir);
    idx.upsert('related', await Embedding.embed('shipping a build live to the servers for users'));
    idx.upsert('unrelated', await Embedding.embed('a recipe for chocolate chip cookies'));

    const hits = idx.query(qv, 2);
    expect(hits[0].id).toBe('related');
    expect(hits[0].score).toBeGreaterThan(hits[1].score);

    // Round-trip through disk still ranks correctly (offline persistence).
    await idx.flush();
    const idx2 = new VectorIndex();
    expect(await idx2.load(dir)).toBe(true);
    expect(idx2.query(qv, 2)[0].id).toBe('related');
  }, 60_000);
});
