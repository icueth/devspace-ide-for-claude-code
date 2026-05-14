// ProjectTokens — pure helpers for v0.15 project-wide design tokens.
//
// Two responsibilities:
//   1. validateAndSanitizeTokens — applies the same allowlist as
//      AppThemeSpec to anything coming in from the renderer (hand-edit)
//      or extracted from disk. Drops invalid values silently.
//   2. extractTokensFromHtml — lightweight regex-based extraction of
//      colors + fonts from a previously-generated HTML page. Wraps
//      ThemeExtractor for the heavy lifting + caps to the tighter
//      ProjectDesignTokens limits (8 colors, 4 fonts).
//
// Pure module: no disk I/O, no logger. DesignService owns persistence.

import { extractTheme } from '@main/services/ThemeExtractor';
import type { ProjectDesignTokens } from '@shared/design';

// Caps mirror AppThemeSpec doc-comments — the two shapes are kept in
// lock-step so a token set can be promoted from one to the other.
const MAX_COLORS = 8;
const MAX_FONTS = 4;
const MAX_VIBE_LEN = 200;
const MAX_COLOR_ENTRY_LEN = 120;
const MAX_FONT_ENTRY_LEN = 80;

const HEX_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const NAMED_COLOR_RE = /^[A-Za-z]{3,24}$/;
const COLOR_FN_RE = /^(?:rgba?|hsla?)\(\s*[0-9.,%\s\/+\-]+\s*\)$/i;
const FONT_NAME_RE = /^[A-Za-z0-9 _\-]{1,80}$/;

// Patterns we strip OUT of any incoming string before evaluating it.
// Matches the `:` event-handler pattern + scheme injectors that
// hardenGeneratedHtml watches for in HTML.
const HOSTILE_PATTERNS_RE =
  /url\s*\(|expression\s*\(|javascript:|on[a-z]+\s*=/gi;

function stripControlChars(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

function stripHostile(s: string): string {
  // Replace with empty so the result is still evaluable but the
  // injector is gone. The downstream allowlist regexes catch any
  // residue.
  return s.replace(HOSTILE_PATTERNS_RE, '');
}

// validateAndSanitizeTokens — single entry point used by both manual
// edits + auto-extract. Returns null when input is null/empty so the
// caller (DesignService.setTokens) can use the same null pathway to
// CLEAR the on-disk tokens file.
export function validateAndSanitizeTokens(
  input: ProjectDesignTokens | null,
): ProjectDesignTokens | null {
  if (!input || typeof input !== 'object') return null;

  const colors = sanitizeColorList(
    Array.isArray(input.colors) ? input.colors : [],
  );
  const fonts = sanitizeFontList(
    Array.isArray(input.fonts) ? input.fonts : [],
  );
  const vibe = sanitizeVibe(typeof input.vibe === 'string' ? input.vibe : '');

  // All-empty payload → null. Lets the renderer pass an empty object
  // to clear tokens without a separate IPC call.
  if (colors.length === 0 && fonts.length === 0 && vibe.length === 0) {
    return null;
  }

  const out: ProjectDesignTokens = { colors, fonts, vibe };

  // Preserve lockedAt + source when present and well-formed. Drop
  // anything else — extra keys would round-trip unverified.
  if (
    typeof input.lockedAt === 'number' &&
    Number.isFinite(input.lockedAt) &&
    input.lockedAt > 0
  ) {
    out.lockedAt = Math.floor(input.lockedAt);
  }
  if (
    input.source &&
    typeof input.source === 'object' &&
    typeof input.source.screenId === 'string' &&
    typeof input.source.versionId === 'string'
  ) {
    out.source = {
      screenId: input.source.screenId,
      versionId: input.source.versionId,
    };
  }

  return out;
}

function sanitizeColorList(raw: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const cleaned = stripHostile(stripControlChars(item)).trim();
    if (cleaned.length === 0 || cleaned.length > MAX_COLOR_ENTRY_LEN) continue;
    if (!isAllowedColorEntry(cleaned)) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= MAX_COLORS) break;
  }
  return out;
}

function isAllowedColorEntry(entry: string): boolean {
  const colonIdx = entry.indexOf(':');
  let value = entry;
  if (colonIdx > 0) {
    const name = entry.slice(0, colonIdx).trim();
    if (!/^[A-Za-z0-9 _\-]{1,32}$/.test(name)) return false;
    value = entry.slice(colonIdx + 1).trim();
  }
  if (HEX_RE.test(value)) return true;
  if (NAMED_COLOR_RE.test(value)) return true;
  if (COLOR_FN_RE.test(value)) return true;
  return false;
}

function sanitizeFontList(raw: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    let cleaned = stripHostile(stripControlChars(item)).trim();
    if (cleaned.length === 0) continue;
    // Take only the first family if a stack was provided.
    cleaned = (cleaned.split(',')[0] ?? '').trim();
    // Strip surrounding quotes.
    if (
      (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
      (cleaned.startsWith("'") && cleaned.endsWith("'"))
    ) {
      cleaned = cleaned.slice(1, -1).trim();
    }
    if (cleaned.length === 0 || cleaned.length > MAX_FONT_ENTRY_LEN) continue;
    if (!FONT_NAME_RE.test(cleaned)) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= MAX_FONTS) break;
  }
  return out;
}

function sanitizeVibe(raw: string): string {
  const cleaned = stripHostile(stripControlChars(raw)).trim();
  if (cleaned.length === 0) return '';
  return cleaned.length <= MAX_VIBE_LEN ? cleaned : cleaned.slice(0, MAX_VIBE_LEN);
}

// extractTokensFromHtml — pull color + font signal out of a previously-
// generated HTML page. Reuses ThemeExtractor (which already handles
// `<style>` block parsing + the strict color/font allowlists) and just
// tightens its caps to ProjectDesignTokens limits.
//
// Returns empty arrays when the input has no usable signal so the
// caller can render a "no theme detected" hint instead of an empty
// dropdown.
export function extractTokensFromHtml(html: string): {
  colors: string[];
  fonts: string[];
} {
  if (!html || typeof html !== 'string') {
    return { colors: [], fonts: [] };
  }
  const tokens = extractTheme(html);
  if (!tokens) return { colors: [], fonts: [] };

  // ThemeExtractor returns up to 12 colors / 6 fonts. Tighten to
  // ProjectDesignTokens limits + run through the same allowlist as
  // hand-edited tokens so the two paths are byte-for-byte equivalent.
  const colors = sanitizeColorList(tokens.colors).slice(0, MAX_COLORS);
  const fonts = sanitizeFontList(tokens.fonts).slice(0, MAX_FONTS);
  return { colors, fonts };
}
