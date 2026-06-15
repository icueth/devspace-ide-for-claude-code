# Sub-project 2: Native Semantic Memory — Design Spec

**Date:** 2026-06-15
**Status:** Approved (design) — pending build
**Parent:** `docs/superpowers/specs/2026-06-15-deruflo-program-design.md`
**Branch:** continues on `feat/remove-ruflo` (or a fresh `feat/native-semantic-memory`)

## Goal
Add **local semantic ("find similar") search** to DevSpace's existing native `MemoryService`,
as a *complement* to its current keyword (inverted-index) search — the one genuinely-useful
capability ruflo had that DevSpace lacks. Fully local, private, no per-query cost.

## Locked decisions
- **Embeddings runtime:** vendor **onnxruntime-node + all-MiniLM-L6-v2** (384-dim), model under
  `resources/embeddings/` (same pattern as the vendored graphify binary). No external API.
- **Data:** START CLEAN — index only DevSpace's curated native memory
  (`~/.devspace/projects/<sha1>/memory/*.md` + global). No import of ruflo-archive data; no
  runtime dependency on it.
- **Naming/location:** DevSpace-native only. Vector index at
  `~/.devspace/projects/<sha1>/memory/.embeddings/` (global: `~/.devspace/global/.embeddings/`).
  No `.swarm`/`ruvector`/ruflo names.

## Architecture (3 focused new units + thin MemoryService hooks)

MemoryService.ts is already 2014 lines, so the new logic lives in **separate files**; MemoryService
only calls into them.

### 1. `src/main/services/EmbeddingService.ts` (new)
- Wraps `onnxruntime-node` + the MiniLM tokenizer + model. Singleton, **lazy-loaded** on first use
  (model load ~100-300ms; don't pay it at app start).
- `embed(text: string): Promise<Float32Array>` → L2-normalized 384-dim vector. Mean-pooling over
  token embeddings (the standard MiniLM sentence-embedding recipe).
- `embedBatch(texts: string[]): Promise<Float32Array[]>` for index rebuilds.
- Resolves the model path from `resources/embeddings/` (packaged) or a dev fallback.
- Degrades gracefully: if the model can't load, `embed` throws a typed error and callers fall back
  to keyword-only search (semantic is additive, never required).

### 2. `src/main/services/VectorIndex.ts` (new)
- Per-scope in-memory map `entryId → Float32Array(384)`, persisted to
  `<memoryDir>/.embeddings/index.bin` (+ `meta.json` with model id + dim for invalidation).
- API: `load(dir)`, `upsert(id, vec)`, `remove(id)`, `query(vec, k): {id, score}[]` (cosine; vectors
  are pre-normalized so it's a dot product), `persist()` (debounced).
- **Brute-force cosine** — at DevSpace memory scale (hundreds–low thousands of entries) a full scan
  of N×384 floats is <5ms. HNSW is explicitly deferred (YAGNI) and noted as a future swap behind the
  same interface. `log()` a warning if an index ever exceeds ~20k entries (revisit then).

### 3. MemoryService hooks (edit, minimal)
- `createEntry` (1086) / `updateEntry` (1225): after writing the markdown, fire-and-forget
  `EmbeddingService.embed(description + "\n" + body)` → `VectorIndex.upsert(id, vec)`. Non-blocking;
  a failed embed logs + leaves the entry keyword-searchable.
- `deleteEntry` (1283): `VectorIndex.remove(id)`.
- `search` (1355): add `mode?: 'keyword' | 'semantic' | 'hybrid'` (default `hybrid`). Hybrid =
  run the existing keyword path AND a vector query, then merge by a normalized score
  (e.g. `0.5*keywordScore + 0.5*cosine`, deduped by id). Pure-keyword behavior is preserved when the
  embedder is unavailable or `mode==='keyword'`.
- `init` (793): load the persisted `.embeddings/` index for known projects; if missing/stale
  (model id or dim changed), schedule a background rebuild from the markdown entries (batch-embed).

### 4. Model vendoring + build
- `scripts/fetch-embeddings.mjs` (new) — downloads `all-MiniLM-L6-v2` ONNX + tokenizer.json into
  `resources/embeddings/` (mirrors `scripts/fetch-uv.mjs`). Run in `prebuild`/CI, not committed
  (large binary) — or committed via LFS if the team prefers; decide in the plan.
- `package.json`: add `onnxruntime-node` dependency; electron-builder `asarUnpack` for the native
  `.node` binary + `resources/embeddings/**`; `after-pack.cjs` ensures the per-OS onnxruntime binary
  ships. macOS-first (matches the DMG); Win/Linux binaries are a later add behind the same code.

## Data flow
create/update entry → write markdown (unchanged) → embed → upsert vector + debounced persist.
search(query, hybrid) → keyword hits ∪ vector hits → merge/rerank → return. Index loads at `init`,
rebuilds in the background if the model/dim changed.

## Error handling
- Model load failure → semantic disabled, keyword search fully works (additive design).
- Embed failure on one entry → that entry is keyword-only; logged, not fatal.
- Corrupt/old index → detected via `meta.json` (model id + dim), rebuilt from markdown.
- Never block entry creation or search on embedding.

## Testing
- `EmbeddingService.test.ts` — mock onnxruntime; assert 384-dim normalized output, batch, graceful
  failure. (A real-model smoke test gated behind an env flag so CI without the model still passes.)
- `VectorIndex.test.ts` — upsert/remove/query correctness, cosine ranking, persist+reload round-trip,
  meta-based invalidation. Pure, no model needed.
- `MemoryService` search test — hybrid merges keyword+vector; falls back to keyword when the
  embedder is unavailable; create/update/delete keep the index in sync.

## Done-criteria ("100% ready")
`tsc` + `vitest` green; `electron-vite build` ok; in a real run, a query finds semantically-related
memory entries that share no keywords (the thing keyword search can't do); deleting an entry removes
it from results; the index persists across restarts; keyword search still works with the model absent.

## Out of scope (sub-project 3)
Turning activity into *learned patterns* (distillation). This spec is retrieval only.

## YAGNI / deferred
HNSW (brute-force suffices), Windows/Linux model binaries (macOS first), re-ranking models,
cross-encoder rerankers, GPU.
