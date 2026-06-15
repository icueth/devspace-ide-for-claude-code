#!/usr/bin/env node
/*
 * Downloads the all-MiniLM-L6-v2 sentence-embedding model (ONNX + tokenizer)
 * into resources/embeddings/Xenova/all-MiniLM-L6-v2/ — the exact layout that
 * @huggingface/transformers (transformers.js) expects when loading from a local
 * path via env.localModelPath. This vendors the model so DevSpace's native
 * semantic memory search (EmbeddingService) runs fully offline in a packaged
 * build, with no per-query cost and no network dependency.
 *
 * Mirrors scripts/fetch-uv.mjs: build-time fetch, bundled via electron-builder
 * `extraResources` ({ from: resources/embeddings, to: embeddings }). The model
 * is ~90MB so it's not committed; CI/`prebuild` runs this.
 *
 * Usage:
 *   node scripts/fetch-embeddings.mjs           # fetch if missing
 *   node scripts/fetch-embeddings.mjs --force   # re-download even if present
 */
import { createWriteStream, existsSync, statSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const OUT_DIR = join(ROOT, 'resources', 'embeddings', MODEL_ID);
const BASE_URL = `https://huggingface.co/${MODEL_ID}/resolve/main`;

// The minimal file set transformers.js needs for feature-extraction with the
// fp32 ONNX model. Paths are relative to the model root (preserve subdirs).
const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model.onnx',
];

async function download(url, destPath) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`GET ${url} → ${res.status}`);
  }
  await mkdir(dirname(destPath), { recursive: true });
  // Stream to a temp file then rename, so an interrupted download can't leave a
  // truncated file that looks "present" on the next run.
  const tmp = `${destPath}.partial`;
  await pipeline(res.body, createWriteStream(tmp));
  await rename(tmp, destPath);
}

function humanSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

async function main() {
  const force = process.argv.includes('--force');
  await mkdir(OUT_DIR, { recursive: true });

  process.stdout.write(`→ vendoring ${MODEL_ID} into resources/embeddings/\n`);
  let total = 0;
  for (const rel of FILES) {
    const dest = join(OUT_DIR, rel);
    if (!force && existsSync(dest)) {
      const sz = statSync(dest).size;
      total += sz;
      process.stdout.write(`  • ${rel}: present (${humanSize(sz)}), skipping\n`);
      continue;
    }
    const url = `${BASE_URL}/${rel}`;
    process.stdout.write(`  ↓ ${rel} …\n`);
    await download(url, dest);
    const sz = statSync(dest).size;
    total += sz;
    process.stdout.write(`  ✓ ${rel} (${humanSize(sz)})\n`);
  }
  process.stdout.write(`done — total ${humanSize(total)} in ${OUT_DIR}\n`);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err.message}\n`);
  process.exit(1);
});
