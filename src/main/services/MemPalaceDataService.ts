import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { resolvePalaceDir } from '@main/utils/mempalacePaths';
import type {
  MemPalaceDrawer,
  MemPalaceListDrawersInput,
  MemPalaceListTriplesInput,
  MemPalaceOverview,
  MemPalaceRoom,
  MemPalaceTriple,
  MemPalaceVaultInfo,
  MemPalaceWing,
} from '@shared/mempalaceData';

/**
 * Read-only accessor for the MemPalace SQLite databases. Connections are
 * opened lazily on the first call and kept alive for the lifetime of the
 * main process. WAL files written by the live MemPalace process are picked
 * up automatically because SQLite re-reads on each query.
 *
 * Why direct SQLite rather than shelling out to `mempalace`:
 *   - `mempalace` has no JSON output mode; parsing text is fragile.
 *   - Spawning a Python interpreter per query (status/search/wing list) is
 *     orders of magnitude slower than a prepared statement.
 *   - The dashboard needs filtered/paged listings the CLI does not expose.
 *
 * All connections open with the `readonly` and `fileMustExist` flags so we
 * physically cannot corrupt the vault even if a bug tries.
 */
class MemPalaceDataService {
  private kgDb: Database.Database | null = null;
  private chromaDb: Database.Database | null = null;
  private palaceDir: string | null = null;
  private drawerCollectionId: string | null = null;
  private closetCollectionId: string | null = null;

  /**
   * Closes any open SQLite handles. Called during app shutdown so file
   * handles do not leak and so a subsequent process can WAL-checkpoint.
   */
  close(): void {
    this.kgDb?.close();
    this.chromaDb?.close();
    this.kgDb = null;
    this.chromaDb = null;
    this.drawerCollectionId = null;
    this.closetCollectionId = null;
  }

  /** Resets cached paths/handles so {@link ensureOpen} re-detects the vault. */
  invalidate(): void {
    this.close();
    this.palaceDir = null;
  }

  /**
   * Returns palace metadata + an availability flag without opening the
   * databases. Used to render the "empty state" when MemPalace is not yet
   * installed or has not yet been mined.
   */
  private detectVault(): MemPalaceVaultInfo {
    const palaceDir = resolvePalaceDir();
    if (palaceDir === null) {
      return {
        palaceDir: '',
        available: false,
        reason: 'No palace directory found. Install MemPalace via Settings → Memory.',
      };
    }
    const kgFile = path.join(palaceDir, 'knowledge_graph.sqlite3');
    const chromaFile = path.join(palaceDir, 'chroma.sqlite3');
    if (!fs.existsSync(kgFile) || !fs.existsSync(chromaFile)) {
      return {
        palaceDir,
        available: false,
        reason: 'Palace directory exists but SQLite stores are missing. Run `mempalace mine` to populate.',
      };
    }
    return { palaceDir, available: true };
  }

  /**
   * Opens (or returns the cached) database handles. Throws when the vault
   * is not available — callers should check {@link detectVault} first or
   * trap the error and surface it through {@link MemPalaceVaultInfo}.
   */
  private ensureOpen(): { kg: Database.Database; chroma: Database.Database; palaceDir: string } {
    const info = this.detectVault();
    if (!info.available) {
      throw new Error(info.reason ?? 'MemPalace vault is unavailable.');
    }
    if (this.palaceDir !== info.palaceDir) {
      this.close();
      this.palaceDir = info.palaceDir;
    }
    if (this.kgDb === null) {
      this.kgDb = new Database(path.join(info.palaceDir, 'knowledge_graph.sqlite3'), {
        readonly: true,
        fileMustExist: true,
      });
    }
    if (this.chromaDb === null) {
      this.chromaDb = new Database(path.join(info.palaceDir, 'chroma.sqlite3'), {
        readonly: true,
        fileMustExist: true,
      });
      this.resolveCollectionIds(this.chromaDb);
    }
    return { kg: this.kgDb, chroma: this.chromaDb, palaceDir: info.palaceDir };
  }

  /**
   * Caches the chroma `collections.id` values for `mempalace_drawers` and
   * `mempalace_closets`. They are stable per-vault, so we look them up
   * once per process and reuse across queries.
   */
  private resolveCollectionIds(chroma: Database.Database): void {
    const rows = chroma
      .prepare('SELECT id, name FROM collections WHERE name IN (?, ?)')
      .all('mempalace_drawers', 'mempalace_closets') as Array<{ id: string; name: string }>;
    for (const row of rows) {
      if (row.name === 'mempalace_drawers') this.drawerCollectionId = row.id;
      else if (row.name === 'mempalace_closets') this.closetCollectionId = row.id;
    }
  }

  /**
   * Returns a stats snapshot for the dashboard header. Safe to call when
   * the vault does not exist — `available: false` is reflected in the
   * result and counts come back as zero.
   */
  getOverview(): MemPalaceOverview {
    const info = this.detectVault();
    if (!info.available) {
      return {
        vault: info,
        drawerCount: 0,
        closetCount: 0,
        wingCount: 0,
        roomCount: 0,
        entityCount: 0,
        tripleCount: 0,
        newestFiledAt: null,
      };
    }
    const { kg, chroma } = this.ensureOpen();

    const drawerSegs = this.drawerSegmentIds(chroma);
    const closetSegs = this.closetSegmentIds(chroma);

    const drawerCount = drawerSegs.length === 0
      ? 0
      : (chroma
          .prepare(
            `SELECT COUNT(*) AS n FROM embeddings WHERE segment_id IN (${drawerSegs.map(() => '?').join(',')})`,
          )
          .get(...drawerSegs) as { n: number }).n;

    const closetCount = closetSegs.length === 0
      ? 0
      : (chroma
          .prepare(
            `SELECT COUNT(*) AS n FROM embeddings WHERE segment_id IN (${closetSegs.map(() => '?').join(',')})`,
          )
          .get(...closetSegs) as { n: number }).n;

    const wingCount = (chroma
      .prepare(
        `SELECT COUNT(DISTINCT string_value) AS n FROM embedding_metadata
           WHERE key='wing' AND id IN (
             SELECT id FROM embeddings WHERE segment_id IN (${drawerSegs.map(() => '?').join(',') || 'NULL'})
           )`,
      )
      .get(...drawerSegs) as { n: number } | undefined)?.n ?? 0;

    const roomCount = (chroma
      .prepare(
        `SELECT COUNT(DISTINCT wing_room) AS n FROM (
           SELECT (
             SELECT string_value FROM embedding_metadata WHERE id=e.id AND key='wing'
           ) || '/' || (
             SELECT string_value FROM embedding_metadata WHERE id=e.id AND key='room'
           ) AS wing_room
           FROM embeddings e
           WHERE e.segment_id IN (${drawerSegs.map(() => '?').join(',') || 'NULL'})
         )`,
      )
      .get(...drawerSegs) as { n: number } | undefined)?.n ?? 0;

    const newestFiledAt = (chroma
      .prepare(
        `SELECT MAX(string_value) AS m FROM embedding_metadata
           WHERE key='filed_at' AND id IN (
             SELECT id FROM embeddings WHERE segment_id IN (${drawerSegs.map(() => '?').join(',') || 'NULL'})
           )`,
      )
      .get(...drawerSegs) as { m: string | null } | undefined)?.m ?? null;

    const entityCount = (kg.prepare('SELECT COUNT(*) AS n FROM entities').get() as { n: number }).n;
    const tripleCount = (kg.prepare('SELECT COUNT(*) AS n FROM triples').get() as { n: number }).n;

    return {
      vault: info,
      drawerCount,
      closetCount,
      wingCount,
      roomCount,
      entityCount,
      tripleCount,
      newestFiledAt,
    };
  }

  /**
   * Wings with drawer counts, sorted by count desc. Empty array when the
   * vault is unavailable.
   */
  listWings(): MemPalaceWing[] {
    const info = this.detectVault();
    if (!info.available) return [];
    const { chroma } = this.ensureOpen();
    const segs = this.drawerSegmentIds(chroma);
    if (segs.length === 0) return [];
    const rows = chroma
      .prepare(
        `SELECT string_value AS name, COUNT(*) AS n
           FROM embedding_metadata
           WHERE key='wing'
             AND id IN (SELECT id FROM embeddings WHERE segment_id IN (${segs.map(() => '?').join(',')}))
           GROUP BY string_value
           ORDER BY n DESC, name ASC`,
      )
      .all(...segs) as Array<{ name: string | null; n: number }>;
    return rows
      .filter((r): r is { name: string; n: number } => r.name !== null && r.name.length > 0)
      .map((r) => ({ name: r.name, drawerCount: r.n }));
  }

  /**
   * Rooms inside one wing. Empty wing name means "all rooms across the
   * palace" — used by the unrestricted view in the sidebar.
   */
  listRoomsForWing(wing: string): MemPalaceRoom[] {
    const info = this.detectVault();
    if (!info.available) return [];
    const { chroma } = this.ensureOpen();
    const segs = this.drawerSegmentIds(chroma);
    if (segs.length === 0) return [];

    const ids = chroma
      .prepare(
        `SELECT id FROM embedding_metadata
           WHERE key='wing' AND string_value=?
             AND id IN (SELECT id FROM embeddings WHERE segment_id IN (${segs.map(() => '?').join(',')}))`,
      )
      .all(wing, ...segs) as Array<{ id: number }>;
    if (ids.length === 0) return [];

    const idList = ids.map((r) => r.id);
    const rows = chroma
      .prepare(
        `SELECT string_value AS name, COUNT(*) AS n
           FROM embedding_metadata
           WHERE key='room' AND id IN (${idList.map(() => '?').join(',')})
           GROUP BY string_value
           ORDER BY n DESC, name ASC`,
      )
      .all(...idList) as Array<{ name: string | null; n: number }>;
    return rows
      .filter((r): r is { name: string; n: number } => r.name !== null && r.name.length > 0)
      .map((r) => ({ wing, name: r.name, drawerCount: r.n }));
  }

  /**
   * Paged drawer listing with optional wing/room filters and substring
   * search across the document text. Results are sorted by `filed_at`
   * descending so the freshest entries surface first.
   */
  listDrawers(input: MemPalaceListDrawersInput = {}): MemPalaceDrawer[] {
    const info = this.detectVault();
    if (!info.available) return [];
    const { chroma } = this.ensureOpen();
    const segs = this.drawerSegmentIds(chroma);
    if (segs.length === 0) return [];

    const limit = Math.min(Math.max(input.limit ?? 50, 1), 500);
    const offset = Math.max(input.offset ?? 0, 0);

    // Build a candidate set of embedding ids that pass the filters, then
    // fan out via embedding_metadata aggregation to produce the row shape
    // expected by the UI. Splitting the candidate selection from the row
    // hydration keeps each step indexable.
    const params: Array<string | number> = [];
    const whereClauses: string[] = [];
    let candidateSql = `SELECT e.id, e.embedding_id, e.created_at
                          FROM embeddings e
                         WHERE e.segment_id IN (${segs.map(() => '?').join(',')})`;
    params.push(...segs);

    if (input.wing !== undefined && input.wing.length > 0) {
      whereClauses.push(`EXISTS (
        SELECT 1 FROM embedding_metadata
         WHERE id=e.id AND key='wing' AND string_value=?
      )`);
      params.push(input.wing);
    }
    if (input.room !== undefined && input.room.length > 0) {
      whereClauses.push(`EXISTS (
        SELECT 1 FROM embedding_metadata
         WHERE id=e.id AND key='room' AND string_value=?
      )`);
      params.push(input.room);
    }
    if (input.query !== undefined && input.query.trim().length > 0) {
      whereClauses.push(`EXISTS (
        SELECT 1 FROM embedding_metadata
         WHERE id=e.id AND key='chroma:document' AND string_value LIKE ?
      )`);
      params.push(`%${input.query.trim()}%`);
    }
    if (whereClauses.length > 0) {
      candidateSql += ' AND ' + whereClauses.join(' AND ');
    }
    // Sort by filed_at via subquery so freshest drawers appear first.
    candidateSql += ` ORDER BY COALESCE(
                        (SELECT string_value FROM embedding_metadata WHERE id=e.id AND key='filed_at'),
                        ''
                      ) DESC,
                      e.id DESC
                      LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const candidates = chroma.prepare(candidateSql).all(...params) as Array<{
      id: number;
      embedding_id: string;
      created_at: string;
    }>;
    if (candidates.length === 0) return [];

    const ids = candidates.map((c) => c.id);
    const metaRows = chroma
      .prepare(
        `SELECT id, key, string_value
           FROM embedding_metadata
          WHERE id IN (${ids.map(() => '?').join(',')})
            AND key IN ('wing','room','hall','topic','agent','date','filed_at','source_file','added_by','chroma:document')`,
      )
      .all(...ids) as Array<{ id: number; key: string; string_value: string | null }>;

    const byId = new Map<number, Record<string, string>>();
    for (const row of metaRows) {
      if (row.string_value === null) continue;
      const bucket = byId.get(row.id) ?? {};
      bucket[row.key] = row.string_value;
      byId.set(row.id, bucket);
    }

    return candidates.map((c) => {
      const meta = byId.get(c.id) ?? {};
      return {
        id: c.id,
        embeddingId: c.embedding_id,
        wing: meta.wing ?? null,
        room: meta.room ?? null,
        hall: meta.hall ?? null,
        topic: meta.topic ?? null,
        agent: meta.agent ?? null,
        date: meta.date ?? null,
        filedAt: meta['filed_at'] ?? null,
        sourceFile: meta['source_file'] ?? null,
        addedBy: meta['added_by'] ?? null,
        document: meta['chroma:document'] ?? '',
      } satisfies MemPalaceDrawer;
    });
  }

  /**
   * Lists knowledge-graph triples with optional subject/predicate/object
   * filters. Joins back to `entities` for human-readable labels — the
   * dashboard groups by predicate, so we sort that way.
   */
  listTriples(input: MemPalaceListTriplesInput = {}): MemPalaceTriple[] {
    const info = this.detectVault();
    if (!info.available) return [];
    const { kg } = this.ensureOpen();
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);

    const whereClauses: string[] = [];
    const params: Array<string | number> = [];
    if (input.subject !== undefined && input.subject.length > 0) {
      whereClauses.push('t.subject = ?');
      params.push(input.subject);
    }
    if (input.predicate !== undefined && input.predicate.length > 0) {
      whereClauses.push('t.predicate = ?');
      params.push(input.predicate);
    }
    if (input.object !== undefined && input.object.length > 0) {
      whereClauses.push('t.object = ?');
      params.push(input.object);
    }
    const where = whereClauses.length === 0 ? '' : 'WHERE ' + whereClauses.join(' AND ');

    const rows = kg
      .prepare(
        `SELECT t.id, t.subject, t.predicate, t.object,
                t.valid_from, t.valid_to, t.confidence,
                t.source_closet, t.extracted_at,
                s.name AS subject_label, o.name AS object_label
           FROM triples t
           LEFT JOIN entities s ON s.id = t.subject
           LEFT JOIN entities o ON o.id = t.object
           ${where}
          ORDER BY t.extracted_at DESC
          LIMIT ?`,
      )
      .all(...params, limit) as Array<{
        id: string;
        subject: string;
        predicate: string;
        object: string;
        valid_from: string | null;
        valid_to: string | null;
        confidence: number;
        source_closet: string | null;
        extracted_at: string;
        subject_label: string | null;
        object_label: string | null;
      }>;
    return rows.map((r) => ({
      id: r.id,
      subject: r.subject,
      subjectLabel: r.subject_label ?? r.subject,
      predicate: r.predicate,
      object: r.object,
      objectLabel: r.object_label ?? r.object,
      validFrom: r.valid_from,
      validTo: r.valid_to,
      confidence: r.confidence,
      sourceCloset: r.source_closet,
      extractedAt: r.extracted_at,
    }));
  }

  /**
   * Cached helper — chroma stores embeddings across several segments per
   * collection. The dashboard always queries the "drawers" collection, so
   * we materialise its segment list once and reuse it on every query.
   */
  private drawerSegmentIds(chroma: Database.Database): string[] {
    if (this.drawerCollectionId === null) return [];
    return (chroma
      .prepare('SELECT id FROM segments WHERE collection = ?')
      .all(this.drawerCollectionId) as Array<{ id: string }>).map((r) => r.id);
  }

  private closetSegmentIds(chroma: Database.Database): string[] {
    if (this.closetCollectionId === null) return [];
    return (chroma
      .prepare('SELECT id FROM segments WHERE collection = ?')
      .all(this.closetCollectionId) as Array<{ id: string }>).map((r) => r.id);
  }
}

export const mempalaceData = new MemPalaceDataService();
