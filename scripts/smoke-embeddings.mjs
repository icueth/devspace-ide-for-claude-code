#!/usr/bin/env node
/*
 * Offline smoke test for native semantic memory (sub-project 2).
 * Loads the VENDORED model from resources/embeddings/ with remote downloads
 * DISABLED, embeds three texts, and verifies:
 *   - output is a 384-dim L2-normalized vector
 *   - a brute-force cosine query ranks a RELATED entry above an UNRELATED one
 * Run from the project root: `node scripts/smoke-embeddings.mjs`
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const { pipeline, env } = await import('@huggingface/transformers');

// Force fully-offline load from the vendored resources dir.
env.localModelPath = join(ROOT, 'resources', 'embeddings');
env.allowRemoteModels = false;

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const extractor = await pipeline('feature-extraction', MODEL_ID, { dtype: 'fp32' });

async function embed(text) {
  const out = await extractor(text, { pooling: 'mean', normalize: true });
  return out.data instanceof Float32Array ? out.data : Float32Array.from(out.data);
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function l2(v) {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

// A query and two candidates: one semantically related (no shared keyword),
// one unrelated. This is exactly what keyword search cannot do.
const query = 'how do I deploy the application to production';
const related = 'shipping a build live to the servers for end users';
const unrelated = 'a recipe for chocolate chip cookies with walnuts';

const [qv, rv, uv] = await Promise.all([embed(query), embed(related), embed(unrelated)]);

const dim = qv.length;
const norm = l2(qv);
const cosRelated = dot(qv, rv);
const cosUnrelated = dot(qv, uv);

console.log(JSON.stringify({
  modelPath: env.localModelPath,
  allowRemoteModels: env.allowRemoteModels,
  dim,
  l2Norm: Number(norm.toFixed(6)),
  cosRelated: Number(cosRelated.toFixed(4)),
  cosUnrelated: Number(cosUnrelated.toFixed(4)),
  rankedRelatedAboveUnrelated: cosRelated > cosUnrelated,
}, null, 2));

const ok =
  dim === 384 &&
  Math.abs(norm - 1) < 1e-3 &&
  cosRelated > cosUnrelated &&
  env.allowRemoteModels === false;

if (!ok) {
  console.error('SMOKE FAILED: expected 384-dim normalized vector with related > unrelated, offline');
  process.exit(1);
}
console.log('SMOKE OK');
