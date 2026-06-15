// EmbeddingService — local sentence-embedding singleton for native semantic
// memory search (sub-project 2). Wraps @huggingface/transformers running the
// all-MiniLM-L6-v2 ONNX model fully on-device. No external API, no per-query
// cost, private.
//
// Design notes:
//   - Lazy-loaded: the pipeline (model load ~100-300ms) is paid on the FIRST
//     embed() call, never at import / app start.
//   - In a packaged build the model is VENDORED under
//     `<resourcesPath>/embeddings/Xenova/all-MiniLM-L6-v2/` and loaded with
//     transformers.js `env.localModelPath` + `allowRemoteModels = false`
//     (offline, deterministic). In dev the same vendored dir is preferred but
//     remote download is allowed as a fallback so a fresh checkout still works.
//   - Degrades gracefully: if the model can't load, embed()/embedBatch() throw
//     a typed `EmbeddingUnavailableError` so callers (MemoryService.search)
//     fall back to keyword-only search. Semantic is ADDITIVE, never required.
//
// Output contract: `embed(text)` → Float32Array(384), L2-normalized (mean
// pooling, the standard MiniLM sentence-embedding recipe). Because vectors are
// normalized, cosine similarity reduces to a dot product downstream
// (VectorIndex).

import * as fs from 'node:fs';
import * as path from 'node:path';

import { app } from 'electron';

import { createLogger } from '@shared/logger';

const logger = createLogger('Embedding');

// Model identity is part of the index meta — bump-detectable. If we ever swap
// models or pooling, this string changes and VectorIndex invalidates on load.
export const EMBEDDING_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIM = 384;

// Typed failure so callers can branch on "embedder unavailable" vs an
// unexpected runtime error and silently fall back to keyword search.
export class EmbeddingUnavailableError extends Error {
  override readonly name = 'EmbeddingUnavailableError';
  constructor(message: string, readonly cause?: unknown) {
    super(message);
  }
}

// transformers.js types are loaded dynamically (heavy ESM dep); keep a minimal
// structural type for the pieces we touch so we don't import the whole surface.
type FeatureExtractionPipeline = (
  texts: string | string[],
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: Float32Array | number[]; dims: number[] }>;

interface LoaderState {
  // Resolved once the pipeline is ready.
  extractor: FeatureExtractionPipeline | null;
  // The in-flight load (deduped so concurrent first-callers share one load).
  loading: Promise<FeatureExtractionPipeline> | null;
  // Sticky failure: once the model is known-bad this session we stop retrying
  // on every search and serve keyword-only fast.
  failed: boolean;
}

const loader: LoaderState = {
  extractor: null,
  loading: null,
  failed: false,
};

// ─── resource resolution ─────────────────────────────────────────────────────

// Resolve the vendored model root. Packaged → process.resourcesPath/embeddings;
// dev → <appPath>/resources/embeddings. Wrapped in try/catch so a context
// where `app` isn't ready (or electron is mocked thinly in tests) falls back to
// a repo-relative resources dir instead of throwing.
function vendoredModelRoot(): string | null {
  try {
    const base = app.isPackaged
      ? process.resourcesPath
      : path.join(app.getAppPath(), 'resources');
    return path.join(base, 'embeddings');
  } catch {
    // No usable electron app (CLI/odd test context) — fall back repo-relative.
    return path.join(process.cwd(), 'resources', 'embeddings');
  }
}

// True when the vendored model files actually exist on disk. Drives the
// offline-only vs remote-fallback decision.
function vendoredModelPresent(root: string | null): boolean {
  if (!root) return false;
  // transformers.js localModelPath layout: <root>/<modelId>/onnx/model.onnx
  const onnx = path.join(root, EMBEDDING_MODEL_ID, 'onnx', 'model.onnx');
  try {
    return fs.statSync(onnx).isFile();
  } catch {
    return false;
  }
}

// Whether we're running in a packaged build (drives remote-fallback policy).
function isPackaged(): boolean {
  try {
    return app.isPackaged === true;
  } catch {
    return false;
  }
}

// ─── pipeline load ───────────────────────────────────────────────────────────

async function loadPipeline(): Promise<FeatureExtractionPipeline> {
  // Dynamic import keeps the ~heavy transformers ESM module out of the main
  // bundle's startup path and lets tests mock '@huggingface/transformers'.
  const mod = await import('@huggingface/transformers');
  const { pipeline, env } = mod;

  const root = vendoredModelRoot();
  const haveVendored = vendoredModelPresent(root);

  if (root) {
    // localModelPath is where transformers.js looks for `<modelId>/...`.
    env.localModelPath = root;
  }
  if (haveVendored) {
    // Vendored model present → run fully offline (deterministic, no network).
    env.allowRemoteModels = false;
    // Force loads from localModelPath (a REAL path under Resources/) and skip
    // transformers' FS cache: in a packaged build that cache lives inside
    // app.asar, which onnxruntime's native loader cannot read (ENOTDIR / errno
    // 20). Disabling it makes resolution use the unpacked vendored model.
    env.useFSCache = false;
    logger.info(`loading vendored model from ${root} (offline)`);
  } else if (isPackaged()) {
    // Packaged build with no vendored model is a packaging bug. We still try
    // local-only so we fail loudly rather than silently phoning home.
    env.allowRemoteModels = false;
    logger.warn(
      `vendored model missing under ${root}; semantic search will be unavailable in this packaged build`,
    );
  } else {
    // Dev fallback: allow remote download so a fresh checkout works before the
    // model is vendored via `pnpm run fetch:embeddings`.
    env.allowRemoteModels = true;
    logger.info('vendored model absent (dev) — allowing remote model download as fallback');
  }

  const extractor = (await pipeline('feature-extraction', EMBEDDING_MODEL_ID, {
    dtype: 'fp32',
  })) as unknown as FeatureExtractionPipeline;
  return extractor;
}

async function ensurePipeline(): Promise<FeatureExtractionPipeline> {
  if (loader.extractor) return loader.extractor;
  if (loader.failed) {
    throw new EmbeddingUnavailableError('embedding model previously failed to load');
  }
  if (!loader.loading) {
    loader.loading = (async () => {
      try {
        const ex = await loadPipeline();
        loader.extractor = ex;
        return ex;
      } catch (err) {
        loader.failed = true;
        loader.loading = null;
        logger.error(`model load failed: ${(err as Error).message}`);
        throw new EmbeddingUnavailableError(
          `failed to load embedding model: ${(err as Error).message}`,
          err,
        );
      }
    })();
  }
  return loader.loading;
}

// ─── public API ──────────────────────────────────────────────────────────────

// Embed a single string → 384-dim L2-normalized Float32Array.
export async function embed(text: string): Promise<Float32Array> {
  const extractor = await ensurePipeline();
  const out = await extractor(text ?? '', { pooling: 'mean', normalize: true });
  return toFloat32(out.data);
}

// Batch variant for index rebuilds. Embeds sequentially (the ONNX session is
// single-threaded; a tight Promise.all gives no real speedup and balloons
// memory). Each result is independently normalized by the pipeline.
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  const extractor = await ensurePipeline();
  const out: Float32Array[] = [];
  for (const t of texts) {
    const r = await extractor(t ?? '', { pooling: 'mean', normalize: true });
    out.push(toFloat32(r.data));
  }
  return out;
}

// Cheap probe: is semantic search usable right now? Tries to load the pipeline
// (deduped with real embed calls). Returns false instead of throwing so callers
// can decide layout without try/catch. Never downloads in packaged builds.
export async function isAvailable(): Promise<boolean> {
  try {
    await ensurePipeline();
    return true;
  } catch {
    return false;
  }
}

// Test/maintenance hook: drop the cached pipeline + failure flag so a fresh
// load is attempted. Production code never calls this.
export function __resetForTests(): void {
  loader.extractor = null;
  loader.loading = null;
  loader.failed = false;
}

function toFloat32(data: Float32Array | number[]): Float32Array {
  return data instanceof Float32Array ? data : Float32Array.from(data);
}
