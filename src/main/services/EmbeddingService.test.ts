import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// EmbeddingService loads @huggingface/transformers dynamically and reads
// electron's `app` for the vendored-model path. We mock both so these tests run
// fast and offline without a real model or an Electron context. A real-model
// smoke test is gated behind RUN_EMBEDDING_MODEL=1 so CI (no model) stays green.

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
}));

// Controls for the transformers mock — flipped per-test before importing the
// service fresh (resetModules ensures the dynamic import re-reads these).
let pipelineImpl: ((...args: unknown[]) => Promise<unknown>) | null = null;
const envMock = { localModelPath: '', allowRemoteModels: true };

vi.mock('@huggingface/transformers', () => ({
  env: envMock,
  pipeline: (...args: unknown[]) => {
    if (!pipelineImpl) throw new Error('pipeline not configured');
    return pipelineImpl(...args);
  },
}));

// Build a fake feature-extraction extractor that returns a deterministic,
// L2-normalized 384-dim vector derived from the input text length.
function makeExtractor(dim = 384) {
  return async (text: string, _opts: unknown) => {
    const data = new Float32Array(dim);
    const seed = (text?.length ?? 0) + 1;
    for (let i = 0; i < dim; i++) data[i] = Math.sin((i + 1) * seed);
    // L2 normalize (the real pipeline does this with normalize:true).
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += data[i] * data[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i++) data[i] /= norm;
    return { data, dims: [1, dim] };
  };
}

async function freshService() {
  vi.resetModules();
  const mod = await import('./EmbeddingService');
  mod.__resetForTests();
  return mod;
}

beforeEach(() => {
  pipelineImpl = null;
  envMock.localModelPath = '';
  envMock.allowRemoteModels = true;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EmbeddingService', () => {
  it('embed() returns a 384-dim L2-normalized Float32Array', async () => {
    pipelineImpl = async () => makeExtractor();
    const svc = await freshService();
    const vec = await svc.embed('hello world');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(384);
    let norm = 0;
    for (const x of vec) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
  });

  it('embedBatch() embeds each text to a 384-dim vector', async () => {
    pipelineImpl = async () => makeExtractor();
    const svc = await freshService();
    const out = await svc.embedBatch(['a', 'bb', 'ccc']);
    expect(out).toHaveLength(3);
    for (const v of out) {
      expect(v.length).toBe(384);
    }
    // Different inputs → different vectors (the fake seeds on length).
    expect(out[0]).not.toEqual(out[1]);
  });

  it('lazy-loads: pipeline is built once and only on first embed', async () => {
    let calls = 0;
    pipelineImpl = async () => {
      calls += 1;
      return makeExtractor();
    };
    const svc = await freshService();
    expect(calls).toBe(0); // import alone must not load the model
    await svc.embed('one');
    await svc.embed('two');
    expect(calls).toBe(1); // singleton — loaded once, reused
  });

  it('degrades gracefully: embed() throws EmbeddingUnavailableError on load failure', async () => {
    pipelineImpl = async () => {
      throw new Error('model file not found');
    };
    const svc = await freshService();
    await expect(svc.embed('x')).rejects.toMatchObject({
      name: 'EmbeddingUnavailableError',
    });
    // isAvailable() probes without throwing.
    expect(await svc.isAvailable()).toBe(false);
  });

  it('isAvailable() is true when the model loads', async () => {
    pipelineImpl = async () => makeExtractor();
    const svc = await freshService();
    expect(await svc.isAvailable()).toBe(true);
  });

  it('exposes model id + dim constants for index invalidation', async () => {
    const svc = await freshService();
    expect(svc.EMBEDDING_DIM).toBe(384);
    expect(svc.EMBEDDING_MODEL_ID).toBe('Xenova/all-MiniLM-L6-v2');
  });

  // Real-model smoke — only runs when the vendored model is present AND the
  // env flag is set. Proves the actual MiniLM recipe yields a normalized
  // 384-dim vector. Skipped in CI so the suite passes without the model.
  const runReal = process.env.RUN_EMBEDDING_MODEL === '1';
  it.skipIf(!runReal)('real model embeds to 384-dim normalized vector', async () => {
    vi.resetModules();
    vi.doUnmock('@huggingface/transformers');
    const mod = await import('./EmbeddingService');
    mod.__resetForTests();
    const vec = await mod.embed('the quick brown fox');
    expect(vec.length).toBe(384);
    let norm = 0;
    for (const x of vec) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 3);
  }, 30_000);
});
