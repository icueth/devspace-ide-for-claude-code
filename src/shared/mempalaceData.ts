/**
 * Shared types for the MemPalace data viewer.
 *
 * The renderer-side Memory dashboard reads its data through these structures;
 * the main process populates them by reading MemPalace's SQLite databases
 * (knowledge_graph.sqlite3 + chroma.sqlite3) in read-only mode.
 */

export interface MemPalaceVaultInfo {
  /** Absolute path to the palace directory (vault). */
  palaceDir: string;
  /** Whether both SQLite files are readable. */
  available: boolean;
  /** If !available, the reason — surfaced to the UI for the empty state. */
  reason?: string;
}

export interface MemPalaceOverview {
  vault: MemPalaceVaultInfo;
  drawerCount: number;
  closetCount: number;
  wingCount: number;
  roomCount: number;
  entityCount: number;
  tripleCount: number;
  /** ISO timestamp of the newest drawer (filed_at) or null when empty. */
  newestFiledAt: string | null;
}

export interface MemPalaceWing {
  name: string;
  drawerCount: number;
}

export interface MemPalaceRoom {
  wing: string;
  name: string;
  drawerCount: number;
}

export interface MemPalaceDrawer {
  id: number;
  embeddingId: string;
  wing: string | null;
  room: string | null;
  hall: string | null;
  topic: string | null;
  agent: string | null;
  date: string | null;
  filedAt: string | null;
  sourceFile: string | null;
  addedBy: string | null;
  document: string;
}

export interface MemPalaceListDrawersInput {
  wing?: string;
  room?: string;
  /** Plain-text substring match against the drawer document. */
  query?: string;
  limit?: number;
  offset?: number;
}

export interface MemPalaceTriple {
  id: string;
  subject: string;
  subjectLabel: string;
  predicate: string;
  object: string;
  objectLabel: string;
  validFrom: string | null;
  validTo: string | null;
  confidence: number;
  sourceCloset: string | null;
  extractedAt: string;
}

export interface MemPalaceListTriplesInput {
  subject?: string;
  predicate?: string;
  object?: string;
  limit?: number;
}
