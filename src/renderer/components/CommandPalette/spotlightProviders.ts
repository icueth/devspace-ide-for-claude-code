// v0.30.8 — Pure helpers for the Spotlight (Cmd+K) palette.
//
// Lives outside the React component so the routing/scoring rules can be
// unit-tested in isolation (no DOM, no stores, no IPC). The dialog component
// imports these and stitches them together with live data.
//
// Routing prefixes are intentionally identical to common editor conventions
// (>commands, /settings, @symbols, #notes) so users coming from VS Code /
// Linear / Slack don't have to relearn anything.

import { buildFileIndex, type IndexedFile } from '@renderer/utils/fileIndex';

export type { IndexedFile };

export type SpotlightSource = 'file' | 'recent' | 'command' | 'settings' | 'symbol' | 'note';

export type SpotlightMode = 'mixed' | 'commands' | 'settings' | 'symbols' | 'notes';

export interface SpotlightParsed {
  mode: SpotlightMode;
  term: string;
}

const PREFIX_MAP: Record<string, SpotlightMode> = {
  '>': 'commands',
  '/': 'settings',
  '@': 'symbols',
  '#': 'notes',
};

/**
 * Parse the raw input — strip a leading routing prefix (if any) and return
 * the resolved mode + the residual search term. Empty input returns
 * `{ mode: 'mixed', term: '' }`.
 */
export function parseSpotlightQuery(raw: string): SpotlightParsed {
  const s = raw ?? '';
  if (s.length === 0) return { mode: 'mixed', term: '' };
  const first = s[0]!;
  const mode = PREFIX_MAP[first];
  if (mode) return { mode, term: s.slice(1).trim() };
  return { mode: 'mixed', term: s.trim() };
}

/**
 * Score a filename + path against a lowercase query. Higher is better.
 * Exact match (1000) → prefix (600 - len) → substring (400 - idx - len) →
 * path-substring (200 - idx - len) → fuzzy fallback (50 - len).
 *
 * Identical to QuickOpenDialog's original behavior — kept here so the
 * file source uses the same rules whether reached via Cmd+P or Cmd+K.
 */
export function scoreFileMatch(rel: string, name: string, q: string): number {
  if (!q) return 1;
  return scoreFileMatchLower(rel.toLowerCase(), name.toLowerCase(), q);
}

/**
 * Core scoring against ALREADY-lowercased fields. Lets the file source
 * match the live query against a precomputed index (buildFileIndex) instead
 * of re-lowercasing every path on every keystroke. Ranking is byte-for-byte
 * identical to scoreFileMatch — only the lowercase work is hoisted out.
 *
 * NOTE: assumes `q` is non-empty (callers handle the empty-query "match all"
 * case before calling, matching scoreFileMatch's `if (!q) return 1`).
 */
function scoreFileMatchLower(relLower: string, nameLower: string, q: string): number {
  if (nameLower === q) return 1000;
  if (nameLower.startsWith(q)) return 600 - nameLower.length;
  const nameIdx = nameLower.indexOf(q);
  if (nameIdx >= 0) return 400 - nameIdx - nameLower.length;
  const relIdx = relLower.indexOf(q);
  if (relIdx >= 0) return 200 - relIdx - relLower.length;
  // Fuzzy fallback: every char must appear in order.
  let i = 0;
  for (let c = 0; c < relLower.length && i < q.length; c++) {
    if (relLower[c] === q[i]) i++;
  }
  if (i === q.length) return 50 - relLower.length;
  return 0;
}

/**
 * Score a command title + keywords against a query. Similar bias to file
 * scoring but exact-title wins much harder (commands have stable names —
 * users learn them, so "wrap" should reliably surface "Toggle word wrap").
 */
export function scoreCommandMatch(title: string, keywords: string, q: string): number {
  if (!q) return 1;
  const titleLower = title.toLowerCase();
  if (titleLower === q) return 1000;
  if (titleLower.startsWith(q)) return 700 - titleLower.length;
  const tIdx = titleLower.indexOf(q);
  if (tIdx >= 0) return 500 - tIdx - titleLower.length;
  const kIdx = keywords.toLowerCase().indexOf(q);
  if (kIdx >= 0) return 300 - kIdx;
  // Fuzzy on title only — keyword fuzzy creates too much noise.
  let i = 0;
  for (let c = 0; c < titleLower.length && i < q.length; c++) {
    if (titleLower[c] === q[i]) i++;
  }
  if (i === q.length) return 50 - titleLower.length;
  return 0;
}

export function basename(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(idx + 1) : p;
}

// ── Command registry types ────────────────────────────────────────────────

export interface SpotlightCommand {
  id: string;
  title: string;
  // Space-separated alternate terms for fuzzy matching ("toggle wrap word
  // soft hard"). Not shown in UI.
  keywords: string;
  // Optional shortcut hint shown on the right (e.g., "⌘⌥Z").
  shortcut?: string;
  // Section label for grouping in the UI ("Editor", "Project", "Settings").
  group: string;
  // Whether the command needs an active project. Disabled rows are still
  // visible (so users learn they exist) but greyed out.
  requiresProject?: boolean;
  // Side effect when the user activates the row. Runs after the dialog
  // closes — keeps the close animation snappy.
  run: () => void;
}

// ── File source ───────────────────────────────────────────────────────────

export interface FileCandidate {
  source: 'file';
  relPath: string;
  fileName: string;
  score: number;
}

export function filterFiles(
  files: ReadonlyArray<string>,
  term: string,
  limit: number,
): FileCandidate[] {
  // Build the index inline for callers that only have a raw string list
  // (e.g. the unit tests). The live dialog uses filterFilesIndexed with a
  // memoized index so the lowercase work isn't repeated per keystroke.
  return filterFilesIndexed(buildFileIndex(files), term, limit);
}

/**
 * Same ranking/caps as filterFiles, but operates on a PRECOMPUTED lowercase
 * index. Per keystroke this only re-scores against cached fields — no
 * per-file `.toLowerCase()` and no basename re-derivation.
 */
export function filterFilesIndexed(
  index: ReadonlyArray<IndexedFile>,
  term: string,
  limit: number,
): FileCandidate[] {
  const q = term.toLowerCase();
  const scored: FileCandidate[] = [];
  for (const f of index) {
    const score = q ? scoreFileMatchLower(f.relLower, f.nameLower, q) : 1;
    if (score > 0) scored.push({ source: 'file', relPath: f.rel, fileName: f.name, score });
  }
  scored.sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath));
  return scored.slice(0, Math.max(0, limit));
}

// ── Command source ────────────────────────────────────────────────────────

export interface CommandCandidate {
  source: 'command';
  command: SpotlightCommand;
  score: number;
}

export function filterCommands(
  commands: ReadonlyArray<SpotlightCommand>,
  term: string,
  limit: number,
): CommandCandidate[] {
  const q = term.toLowerCase();
  const scored: CommandCandidate[] = [];
  for (const cmd of commands) {
    const score = scoreCommandMatch(cmd.title, cmd.keywords, q);
    if (score > 0) scored.push({ source: 'command', command: cmd, score });
  }
  scored.sort((a, b) => b.score - a.score || a.command.title.localeCompare(b.command.title));
  return scored.slice(0, Math.max(0, limit));
}

// ── Recent source ─────────────────────────────────────────────────────────

export type RecentItem =
  | { kind: 'file'; relPath: string; at: number }
  | { kind: 'command'; commandId: string; at: number };

export interface RecentFileCandidate {
  source: 'recent';
  kind: 'file';
  relPath: string;
  fileName: string;
  at: number;
}

export interface RecentCommandCandidate {
  source: 'recent';
  kind: 'command';
  command: SpotlightCommand;
  at: number;
}

export type RecentCandidate = RecentFileCandidate | RecentCommandCandidate;

/**
 * Resolve a recent list against the current file pool + command registry,
 * dropping entries whose target no longer exists (deleted file / unregistered
 * command). Filters by `term` using the same scoring as the live sources.
 */
export function filterRecents(
  recents: ReadonlyArray<RecentItem>,
  files: ReadonlyArray<string>,
  commands: ReadonlyArray<SpotlightCommand>,
  term: string,
  limit: number,
): RecentCandidate[] {
  const q = term.toLowerCase();
  // O(1) lookups for resolution. Built once per call — recent lists are
  // capped at 20, so this is negligible cost.
  const fileSet = new Set(files);
  const cmdById = new Map(commands.map((c) => [c.id, c]));

  const out: RecentCandidate[] = [];
  for (const r of recents) {
    if (r.kind === 'file') {
      if (!fileSet.has(r.relPath)) continue;
      const name = basename(r.relPath);
      // For recents, we keep all if no query, else require some match in
      // either name or path. We don't rank by score — recents are already
      // chronologically ranked by user behavior.
      if (q && scoreFileMatch(r.relPath, name, q) <= 0) continue;
      out.push({ source: 'recent', kind: 'file', relPath: r.relPath, fileName: name, at: r.at });
    } else {
      const cmd = cmdById.get(r.commandId);
      if (!cmd) continue;
      if (q && scoreCommandMatch(cmd.title, cmd.keywords, q) <= 0) continue;
      out.push({ source: 'recent', kind: 'command', command: cmd, at: r.at });
    }
    if (out.length >= limit) break;
  }
  return out;
}

// ── Mixed-mode composition ────────────────────────────────────────────────

export type SpotlightCandidate = FileCandidate | CommandCandidate | RecentCandidate;

export interface SpotlightSection {
  label: string;
  items: SpotlightCandidate[];
}

/**
 * Compose sections for the dialog based on the parsed mode. Each section is
 * already capped and sorted — the dialog just renders top-to-bottom.
 *
 * Layout:
 *   mixed:    Recent (up to 5)  → Files (top 30) → Commands (top 10)
 *   commands: Commands (top 50)
 *   settings: Commands filtered to group='Settings' (top 50)
 *   symbols:  Files only — symbol indexing is Phase B (v0.31+). UI will hint.
 *   notes:    Empty for v0.30.8 — UI will hint "coming in a follow-up".
 */
export function composeSections(input: {
  parsed: SpotlightParsed;
  files: ReadonlyArray<string>;
  commands: ReadonlyArray<SpotlightCommand>;
  recents: ReadonlyArray<RecentItem>;
  // Optional precomputed lowercase index for `files`. The live dialog passes
  // a memoized index (keyed on the file list) so the per-file lowercase work
  // doesn't repeat on every keystroke. When omitted (e.g. unit tests) it's
  // built once from `files` here.
  fileIndex?: ReadonlyArray<IndexedFile>;
}): SpotlightSection[] {
  const { parsed, files, commands, recents } = input;
  const fileIndex = input.fileIndex ?? buildFileIndex(files);

  if (parsed.mode === 'commands') {
    return [{ label: 'Commands', items: filterCommands(commands, parsed.term, 50) }];
  }

  if (parsed.mode === 'settings') {
    const settingsOnly = commands.filter((c) => c.group === 'Settings');
    return [{ label: 'Settings', items: filterCommands(settingsOnly, parsed.term, 50) }];
  }

  if (parsed.mode === 'symbols') {
    // Symbol indexing is Phase B. We still let the user search files via @
    // so the prefix isn't a dead-end — but the dialog will show a hint
    // explaining symbols proper are coming later.
    return [{ label: 'Files (symbol indexing coming in v0.31)', items: filterFilesIndexed(fileIndex, parsed.term, 50) }];
  }

  if (parsed.mode === 'notes') {
    // Notes/devlog/memory wiring is Phase C — return empty; UI shows hint.
    return [];
  }

  // mixed
  const sections: SpotlightSection[] = [];
  const recentItems = filterRecents(recents, files, commands, parsed.term, 5);
  if (recentItems.length > 0) sections.push({ label: 'Recent', items: recentItems });
  const fileItems = filterFilesIndexed(fileIndex, parsed.term, 30);
  if (fileItems.length > 0) sections.push({ label: 'Files', items: fileItems });
  const commandItems = filterCommands(commands, parsed.term, 10);
  if (commandItems.length > 0) sections.push({ label: 'Commands', items: commandItems });
  return sections;
}

/**
 * Flatten sections into a single positional list — the dialog tracks one
 * `selected` index across the whole list, not per-section. Headers are
 * NOT items, so arrow keys skip them naturally.
 */
export function flattenSections(sections: ReadonlyArray<SpotlightSection>): SpotlightCandidate[] {
  const out: SpotlightCandidate[] = [];
  for (const s of sections) out.push(...s.items);
  return out;
}
