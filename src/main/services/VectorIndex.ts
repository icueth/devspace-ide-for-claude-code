// VectorIndex — per-scope brute-force cosine index for native semantic memory
// search (sub-project 2).
//
// One instance owns the vectors for a single memory scope (a project's
// `<memoryDir>/.embeddings/` or global's `<globalRoot>/.embeddings/`). Vectors
// are produced by EmbeddingService and are already L2-normalized, so cosine
// similarity is just a dot product — no per-query normalization.
//
// Storage:
//   <dir>/.embeddings/index.bin   — packed records: id-len(u32) + utf8 id +
//                                    EMBEDDING_DIM float32 vector, repeated.
//   <dir>/.embeddings/meta.json   — { model, dim, count } for invalidation.
//
// On load, if meta.json's model id or dim don't match the current
// EmbeddingService config, the on-disk index is treated as EMPTY — the caller
// (MemoryService.init) then schedules a background rebuild from the markdown
// entries. This makes a model/pooling swap self-healing.
//
// SCALING: brute force is intentional. At DevSpace memory scale (hundreds to a
// few thousand entries) a full scan of N×384 floats is sub-millisecond. HNSW is
// explicitly deferred (YAGNI) and would slot in behind this exact interface
// (load/upsert/remove/query/persist). We log a warning if an index ever grows
// past WARN_AT_ENTRIES so we know to revisit.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { createLogger } from '@shared/logger';

import { EMBEDDING_DIM, EMBEDDING_MODEL_ID } from './EmbeddingService';

const logger = createLogger('VectorIndex');

const EMBEDDINGS_SUBDIR = '.embeddings';
const INDEX_FILE = 'index.bin';
const META_FILE = 'meta.json';

// Debounce window for persist(); batches a burst of upserts (e.g. a rebuild)
// into a single write.
const PERSIST_DEBOUNCE_MS = 1500;

// Brute force is fine well past this; the warning just flags that we've left
// the "obviously fine" zone and an ANN index may be worth it.
const WARN_AT_ENTRIES = 20_000;

interface IndexMeta {
  model: string;
  dim: number;
  count: number;
}

export interface QueryHit {
  id: string;
  // Cosine similarity in [-1, 1] (dot product of normalized vectors).
  score: number;
}

export class VectorIndex {
  // entryId → normalized Float32Array(dim). The hot path for query().
  private readonly vectors = new Map<string, Float32Array>();
  private readonly dim: number;
  private readonly model: string;

  // The scope's memory dir; the .embeddings/ subdir lives under it. Empty until
  // load(dir) is called.
  private dir: string | null = null;

  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  // Serialize concurrent persist() flushes so a debounced flush and an explicit
  // flush can't interleave half-written files.
  private flushChain: Promise<void> = Promise.resolve();
  private warnedSize = false;

  constructor(opts?: { dim?: number; model?: string }) {
    this.dim = opts?.dim ?? EMBEDDING_DIM;
    this.model = opts?.model ?? EMBEDDING_MODEL_ID;
  }

  get size(): number {
    return this.vectors.size;
  }

  // Has this index been bound to a directory yet?
  get loaded(): boolean {
    return this.dir !== null;
  }

  private embeddingsDir(): string {
    if (!this.dir) throw new Error('VectorIndex not bound to a dir; call load() first');
    return path.join(this.dir, EMBEDDINGS_SUBDIR);
  }

  // Load (or initialize) the index for `dir`. If the persisted meta doesn't
  // match the current model/dim, or files are missing/corrupt, the in-memory
  // map is left EMPTY and `false` is returned so the caller can schedule a
  // rebuild. Returns `true` when a valid index was loaded from disk.
  async load(dir: string): Promise<boolean> {
    this.dir = dir;
    this.vectors.clear();
    this.dirty = false;

    const metaPath = path.join(this.embeddingsDir(), META_FILE);
    const indexPath = path.join(this.embeddingsDir(), INDEX_FILE);

    let meta: IndexMeta | null = null;
    try {
      const raw = await fs.promises.readFile(metaPath, 'utf8');
      meta = JSON.parse(raw) as IndexMeta;
    } catch {
      // No meta → first run for this scope. Empty, needs build.
      return false;
    }

    if (!meta || meta.model !== this.model || meta.dim !== this.dim) {
      // Model or dimensionality changed since last write → stale. Treat as
      // empty; caller rebuilds. (We deliberately do NOT delete the old files
      // here — persist() overwrites them once the rebuild upserts vectors.)
      logger.info(
        `index meta mismatch in ${dir} (have model=${meta?.model} dim=${meta?.dim}, want model=${this.model} dim=${this.dim}) — treating as empty`,
      );
      return false;
    }

    let buf: Buffer;
    try {
      buf = await fs.promises.readFile(indexPath);
    } catch {
      // meta but no index.bin (or unreadable) → rebuild.
      return false;
    }

    try {
      this.decode(buf);
    } catch (err) {
      logger.warn(`index.bin in ${dir} is corrupt (${(err as Error).message}) — treating as empty`);
      this.vectors.clear();
      return false;
    }

    this.maybeWarnSize();
    return true;
  }

  // Insert or replace the vector for `id`. Marks the index dirty and schedules a
  // debounced persist. Throws on a dimension mismatch (a programmer error — the
  // embedder and index must agree).
  upsert(id: string, vec: Float32Array): void {
    if (vec.length !== this.dim) {
      throw new Error(`vector dim ${vec.length} != index dim ${this.dim}`);
    }
    this.vectors.set(id, vec);
    this.maybeWarnSize();
    this.markDirty();
  }

  // Remove the vector for `id` (no-op if absent). Schedules a persist only if
  // something actually changed.
  remove(id: string): void {
    if (this.vectors.delete(id)) this.markDirty();
  }

  // k-nearest by cosine similarity. Vectors are normalized so this is a dot
  // product. Returns up to `k` hits sorted by descending score. A zero/garbage
  // query vector simply yields low scores; we don't special-case it.
  query(vec: Float32Array, k: number): QueryHit[] {
    if (vec.length !== this.dim || this.vectors.size === 0 || k <= 0) return [];
    const hits: QueryHit[] = [];
    for (const [id, v] of this.vectors) {
      hits.push({ id, score: dot(vec, v) });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }

  // Schedule a debounced flush to disk. Safe to call on every mutation.
  persist(): void {
    this.markDirty();
  }

  // Force an immediate flush and clear the debounce timer. Used on shutdown and
  // in tests for deterministic round-trips.
  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.doFlush();
  }

  // Drop everything (used before a full rebuild). Does not touch disk until the
  // next persist/flush.
  clear(): void {
    this.vectors.clear();
    this.markDirty();
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  private markDirty(): void {
    this.dirty = true;
    if (!this.dir) return; // not bound yet — nothing to persist to
    if (this.persistTimer) return; // already scheduled
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.doFlush();
    }, PERSIST_DEBOUNCE_MS);
    // Don't keep the event loop alive just for a pending index write.
    if (typeof this.persistTimer.unref === 'function') this.persistTimer.unref();
  }

  private doFlush(): Promise<void> {
    // Chain so two flushes never write the same files concurrently.
    this.flushChain = this.flushChain.then(() => this.writeToDisk()).catch((err) => {
      logger.error(`persist failed: ${(err as Error).message}`);
    });
    return this.flushChain;
  }

  private async writeToDisk(): Promise<void> {
    if (!this.dir || !this.dirty) return;
    this.dirty = false;
    const dir = this.embeddingsDir();
    await fs.promises.mkdir(dir, { recursive: true });

    const indexPath = path.join(dir, INDEX_FILE);
    const metaPath = path.join(dir, META_FILE);

    const buf = this.encode();
    const meta: IndexMeta = { model: this.model, dim: this.dim, count: this.vectors.size };

    // Atomic-ish: write temp then rename so a crash mid-write can't leave a
    // truncated index.bin that fails to decode on next load.
    const tmpIndex = `${indexPath}.tmp`;
    const tmpMeta = `${metaPath}.tmp`;
    await fs.promises.writeFile(tmpIndex, buf);
    await fs.promises.writeFile(tmpMeta, JSON.stringify(meta));
    await fs.promises.rename(tmpIndex, indexPath);
    await fs.promises.rename(tmpMeta, metaPath);
  }

  // Binary layout per record: [idLen u32 LE][id utf8][dim × f32 LE].
  private encode(): Buffer {
    const parts: Buffer[] = [];
    for (const [id, vec] of this.vectors) {
      const idBuf = Buffer.from(id, 'utf8');
      const head = Buffer.allocUnsafe(4);
      head.writeUInt32LE(idBuf.length, 0);
      const vecBuf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
      // Copy the vector bytes (the underlying ArrayBuffer may be shared/pooled).
      parts.push(head, idBuf, Buffer.from(vecBuf));
    }
    return Buffer.concat(parts);
  }

  private decode(buf: Buffer): void {
    const recBytes = this.dim * 4;
    let off = 0;
    while (off < buf.length) {
      if (off + 4 > buf.length) throw new Error('truncated id length');
      const idLen = buf.readUInt32LE(off);
      off += 4;
      if (idLen === 0 || idLen > 4096) throw new Error(`implausible id length ${idLen}`);
      if (off + idLen + recBytes > buf.length) throw new Error('truncated record');
      const id = buf.toString('utf8', off, off + idLen);
      off += idLen;
      // Copy out into a fresh Float32Array so it's not a view over the large
      // file buffer (which would pin the whole buffer in memory).
      const vec = new Float32Array(this.dim);
      for (let i = 0; i < this.dim; i++) {
        vec[i] = buf.readFloatLE(off + i * 4);
      }
      off += recBytes;
      this.vectors.set(id, vec);
    }
  }

  private maybeWarnSize(): void {
    if (!this.warnedSize && this.vectors.size > WARN_AT_ENTRIES) {
      this.warnedSize = true;
      logger.warn(
        `index has ${this.vectors.size} entries (> ${WARN_AT_ENTRIES}); brute-force cosine may be slow — consider an ANN index (HNSW) behind this interface`,
      );
    }
  }
}

// Dot product of two equal-length vectors. Both are L2-normalized so this is
// cosine similarity.
function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
