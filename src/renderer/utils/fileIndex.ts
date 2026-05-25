// Shared precomputed file index for the fuzzy-search pickers (Quick Open,
// Spotlight, @-mention). Each picker previously re-lowercased the ENTIRE
// project file list (up to ~20k paths) on EVERY keystroke — calling
// `.toLowerCase()` twice per file, plus reallocating a candidate object per
// file. For large repos this is the dominant per-keystroke cost.
//
// `buildFileIndex` does the lowercase work ONCE (keyed on the file list, not
// the query). The pickers then match the live query against the cached
// lowercase fields. Pure + unit-testable: no DOM, no stores, no IPC.

export interface IndexedFile {
  /** Original relative path, preserved for display + activation. */
  rel: string;
  /** Basename of `rel` (segment after the last '/'), original case. */
  name: string;
  /** `rel.toLowerCase()` — computed once. */
  relLower: string;
  /** `name.toLowerCase()` — computed once. */
  nameLower: string;
}

/** Basename of a '/'-separated path. */
export function basename(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(idx + 1) : p;
}

/**
 * Precompute the lowercase index for a file list. The result is meant to be
 * cached (e.g. behind a `useMemo` keyed on the raw file array) so the
 * per-file lowercase work happens once per file-list change rather than once
 * per keystroke.
 */
export function buildFileIndex(files: ReadonlyArray<string>): IndexedFile[] {
  const out: IndexedFile[] = new Array(files.length);
  for (let i = 0; i < files.length; i++) {
    const rel = files[i]!;
    const name = basename(rel);
    out[i] = {
      rel,
      name,
      relLower: rel.toLowerCase(),
      nameLower: name.toLowerCase(),
    };
  }
  return out;
}
