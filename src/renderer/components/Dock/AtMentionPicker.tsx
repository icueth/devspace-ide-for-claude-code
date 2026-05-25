import { useEffect, useRef } from 'react';

import { cn } from '@renderer/lib/utils';
import { buildFileIndex, type IndexedFile } from '@renderer/utils/fileIndex';

interface AtMentionPickerProps {
  query: string;
  // Already-filtered+ranked paths. Computed ONCE by the parent (ChatPanel)
  // and passed down — the picker no longer re-filters internally, which
  // previously ran filterAtMentionFiles twice for identical inputs.
  filtered: string[];
  highlight: number;
  loading: boolean;
  onHighlight: (idx: number) => void;
  onPick: (path: string) => void;
}

/**
 * Floating palette that appears above the chat textarea when the user
 * types `@` at the start of input or after whitespace. Inserts a
 * relative path token `@<path>` that Claude Code expands as a file
 * attachment — same UX as the CLI's native `@path` syntax, but with
 * fuzzy search across the active project tree.
 *
 * Selection is owned by the parent so arrow-key navigation can be
 * routed through the textarea's onKeyDown without focus jumping.
 */
export function AtMentionPicker({
  query,
  filtered,
  highlight,
  loading,
  onHighlight,
  onPick,
}: AtMentionPickerProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (highlight >= filtered.length) onHighlight(0);
  }, [filtered.length, highlight, onHighlight]);

  // Keep the active row visible while the user arrows through results.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-at-idx="${highlight}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  if (loading && filtered.length === 0) {
    return (
      <div className="mb-1 rounded-[8px] border border-border bg-surface-2 px-2.5 py-1.5 text-[11px] text-text-dim shadow-xl">
        Scanning project files…
      </div>
    );
  }
  if (filtered.length === 0) {
    return (
      <div className="mb-1 rounded-[8px] border border-border bg-surface-2 px-2.5 py-1.5 text-[11px] text-text-dim shadow-xl">
        No files match "{query}"
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      className="mb-1 max-h-[240px] overflow-y-auto rounded-[8px] border border-border bg-surface-2 shadow-xl"
    >
      {filtered.map((path, idx) => {
        const isActive = idx === highlight;
        const slash = path.lastIndexOf('/');
        const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
        const base = slash >= 0 ? path.slice(slash + 1) : path;
        return (
          <button
            key={path}
            data-at-idx={idx}
            onMouseEnter={() => onHighlight(idx)}
            onMouseDown={(e) => {
              // Use mousedown not click — click fires after textarea blur
              // which closes the picker before the handler runs.
              e.preventDefault();
              onPick(path);
            }}
            className={cn(
              'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11.5px] transition',
              isActive
                ? 'bg-[rgba(76,141,255,0.18)] text-text'
                : 'text-text-secondary hover:bg-surface-3',
            )}
          >
            <span className="font-mono text-accent">@</span>
            <span className="truncate font-mono font-medium">{base}</span>
            {dir && (
              <span className="ml-auto truncate text-[10.5px] text-text-dim">{dir}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Detects whether the cursor in `text` at position `caret` is currently
 * inside an `@<token>` mention. A mention opens with `@` that is either
 * at the start of input OR preceded by whitespace. It closes when the
 * cursor crosses a space, tab, or newline — so `@foo bar` stops at the
 * space and `bar` is normal text again. Returns the byte offset of the
 * `@` and the partial query typed so far (without the leading `@`).
 *
 * Designed to also reject email-style `user@example` patterns where
 * `@` is immediately preceded by a non-space character.
 */
export function findAtMentionToken(
  text: string,
  caret: number,
): { tokenStart: number; query: string } | null {
  if (caret < 0 || caret > text.length) return null;
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  // Char before `@` must be start-of-input or whitespace.
  if (at > 0) {
    const prev = before.charAt(at - 1);
    if (!/\s/.test(prev)) return null;
  }
  const query = before.slice(at + 1);
  // A space/newline closes the token. Tab too — same convention as
  // Claude Code's prompt parser.
  if (/[\s\n]/.test(query)) return null;
  // Hard cap on query length so a runaway paste doesn't burn cycles
  // re-filtering a huge candidate list every keystroke.
  if (query.length > 200) return null;
  return { tokenStart: at, query };
}

/**
 * Score-and-sort file list for the given query. Prefers basename
 * matches over directory matches, earlier matches over later, and
 * caps the result at 50 rows. Pure so it can be unit-tested.
 *
 * Convenience wrapper that builds the lowercase index inline (used by the
 * unit tests). The live picker uses filterAtMentionIndexed against an index
 * built once when the project file list is set — see ChatPanel — so the
 * per-file lowercase work isn't repeated on every keystroke.
 */
export function filterAtMentionFiles(files: string[], query: string): string[] {
  return filterAtMentionIndexed(buildFileIndex(files), query);
}

/**
 * Same ranking/caps as filterAtMentionFiles, but matches against a
 * PRECOMPUTED lowercase index (relLower + nameLower) so no per-file
 * `.toLowerCase()` or basename derivation happens per keystroke.
 */
export function filterAtMentionIndexed(
  index: ReadonlyArray<IndexedFile>,
  query: string,
): string[] {
  if (!query) return index.slice(0, 50).map((f) => f.rel);
  const q = query.toLowerCase();
  const scored: { path: string; score: number }[] = [];
  for (const f of index) {
    const idx = f.relLower.indexOf(q);
    if (idx < 0) continue;
    const baseIdx = f.nameLower.indexOf(q);
    // Basename hits dominate; among basename hits, earlier is better.
    // Within directory-only hits, earlier path position wins.
    const score = baseIdx >= 0 ? 10_000 - baseIdx : 1_000 - idx;
    scored.push({ path: f.rel, score });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Stable tie-break by shorter path then lexicographic, so the
    // closest-to-root file wins when scores tie.
    if (a.path.length !== b.path.length) return a.path.length - b.path.length;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  return scored.slice(0, 50).map((s) => s.path);
}
