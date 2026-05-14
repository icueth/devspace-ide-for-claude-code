// ThemeExtractor — pure helper that pulls coarse "theme tokens" out of a
// previously-generated HTML page. Used by Design Studio when the user
// flips the "Keep theme" checkbox: we re-feed the prior version's colors
// + fonts back into the prompt builder so the next generation stays
// visually consistent with the page the user just iterated on.
//
// Best-effort by design. The signal feeds a prompt section that the
// model must honour — small heuristic misses don't break correctness,
// they just give Claude slightly less to lock onto. Returns null when
// the input has no `<style>` block or yields zero usable tokens, so the
// caller can omit the constraint cleanly instead of injecting an empty
// section.

export interface ThemeTokens {
  colors: string[];
  fonts: string[];
  bg?: string;
  fg?: string;
}

// Cap output. Long token lists waste prompt budget without measurably
// improving the model's adherence to the theme; the first handful of
// distinct hex / hsl / rgb values capture the brand intent.
const MAX_COLORS = 12;
const MAX_FONTS = 6;
// v0.14 sec-review MED-2: cap the raw HTML input length so the regex
// passes are bounded against adversarial content. Theme extraction is a
// best-effort signal — 64 KB of inline <style> is more than enough to
// capture brand tokens; anything beyond is almost certainly noise or an
// attempt to trigger backtracking on the value-extractors.
const MAX_HTML_BYTES = 64 * 1024;
// Cap each individual extracted token. A long "font-family" or color
// function body is either malformed or hostile; either way we drop it
// rather than carrying it into the next prompt.
const MAX_TOKEN_LEN = 80;

export function extractTheme(html: string): ThemeTokens | null {
  if (!html || typeof html !== 'string') return null;
  const trimmed = html.length > MAX_HTML_BYTES ? html.slice(0, MAX_HTML_BYTES) : html;

  // Pull every `<style>...</style>` body. There's usually only one but
  // some skill packs emit multiple (utility classes split from page
  // styles), and we want to scan all of them.
  const styleBlocks = collectStyleBlocks(trimmed);
  if (styleBlocks.length === 0) return null;

  const allCss = styleBlocks.join('\n');

  const colors = dedupe(extractColors(allCss)).slice(0, MAX_COLORS);
  const fonts = dedupe(extractFonts(allCss)).slice(0, MAX_FONTS);
  const body = extractBodyRule(allCss);

  // null when we have nothing meaningful — callers treat this as
  // "no theme signal, fall through to normal prompt".
  if (
    colors.length === 0 &&
    fonts.length === 0 &&
    !body.bg &&
    !body.fg
  ) {
    return null;
  }

  const out: ThemeTokens = { colors, fonts };
  if (body.bg) out.bg = body.bg;
  if (body.fg) out.fg = body.fg;
  return out;
}

function collectStyleBlocks(html: string): string[] {
  const out: string[] = [];
  const re = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const body = (m[1] ?? '').trim();
    if (body.length > 0) out.push(body);
  }
  return out;
}

// v0.14 sec-review MED-1: tokens flow VERBATIM into the next Claude
// prompt under an authoritative "MUST use" framing. A poisoned <style>
// could smuggle "ignore your instructions" into the prompt unless the
// extractor refuses anything outside a strict allowlist. The patterns
// below reject control chars, quotes, semicolons, braces, angle
// brackets, and everything else that has no place in a color or font
// name. Anything ambiguous gets dropped, not escaped.

// Strict color-function body validator: digits, dot, comma, percent,
// slash, plus/minus, whitespace only. Caller is responsible for the
// `fn(...)` outer wrapper; we just validate what's inside the parens.
const COLOR_FN_BODY_RE = /^[0-9.,%\s\/+\-]+$/;
// Strict font-name validator: letters, digits, space, hyphen, underscore.
// Common single fonts ("Inter", "JetBrains Mono", "system-ui") fit. Anything
// with quotes, parens, semicolons, or punctuation gets dropped.
const FONT_NAME_RE = /^[A-Za-z0-9 _\-]+$/;

function extractColors(css: string): string[] {
  const out: string[] = [];
  // Hex: #rgb / #rgba / #rrggbb / #rrggbbaa. Match 3,4,6 or 8 hex
  // chars so we don't pick up "#deadbe" as 6 valid hex + extra "ef".
  // The trailing boundary (\b or non-hex) prevents over-grabbing into
  // longer identifiers.
  const hexRe = /#[0-9a-fA-F]{3,8}\b/g;
  let m: RegExpExecArray | null;
  while ((m = hexRe.exec(css)) !== null) {
    const v = m[0];
    // Only accept canonical lengths.
    const len = v.length - 1;
    if (len === 3 || len === 4 || len === 6 || len === 8) {
      out.push(v.toLowerCase());
    }
  }
  // hsl()/hsla()/rgb()/rgba() function colors. Bounded body (max 120
  // chars) defeats ReDoS — an unclosed `rgb(...` can't force backtracking
  // past 120 chars. Then we validate the BODY against COLOR_FN_BODY_RE
  // to reject anything carrying punctuation/letters/etc that would let
  // a hostile page inject text into the prompt.
  const fnRe = /\b(hsla?|rgba?)\(([^)]{1,120})\)/gi;
  while ((m = fnRe.exec(css)) !== null) {
    const body = (m[2] ?? '').trim();
    if (!COLOR_FN_BODY_RE.test(body)) continue;
    const normalized = `${m[1].toLowerCase()}(${body.replace(/\s+/g, ' ')})`;
    if (normalized.length <= MAX_TOKEN_LEN) out.push(normalized);
  }
  return out;
}

function extractFonts(css: string): string[] {
  const out: string[] = [];
  // font-family: <first-font-name>, ...; — we keep only the first
  // (primary) font from each declaration. The value capture is bounded
  // to 200 chars to keep regex passes linear on adversarial input.
  const re = /font-family\s*:\s*([^;}{]{1,200})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const decl = m[1] ?? '';
    const first = decl.split(',')[0] ?? '';
    const cleaned = stripQuotes(first.trim());
    // Allowlist: letters/digits/space/hyphen/underscore only. Rejects
    // newlines, semicolons, angle brackets, etc. Caps length defensively
    // so an attacker can't carry a long prose payload through a quoted
    // single-token "font name".
    if (cleaned.length === 0 || cleaned.length > MAX_TOKEN_LEN) continue;
    if (!FONT_NAME_RE.test(cleaned)) continue;
    out.push(cleaned);
  }
  return out;
}

function stripQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1).trim();
  }
  return s;
}

// Allowlist for bg/fg values: hex colors, color function calls, or
// plain CSS color identifier (letters/digits/dash only, ≤24 chars).
// Anything that doesn't match — including `var(--x)`, `linear-gradient(…)`,
// or anything carrying punctuation — is dropped to keep the prompt safe.
const BG_FG_VALUE_RE = /^(#[0-9a-fA-F]{3,8}|(?:hsla?|rgba?)\([0-9.,%\s\/+\-]+\)|[A-Za-z][A-Za-z0-9\-]{0,23})$/;

function extractBodyRule(css: string): { bg?: string; fg?: string } {
  // Find the first `body { … }` declaration. We don't try to handle
  // every selector permutation (`html, body`, `body.dark`, etc.) — the
  // primary `body { … }` rule is what page-level theming targets.
  // Tolerate selector lists that include `body` as a standalone token.
  // Body block bounded to 4 KB so a malformed `body { … no-close-brace`
  // can't engage the regex engine in a long backtrack walk.
  const re = /(^|[\s,}])body\s*\{([^}]{0,4096})\}/i;
  const m = re.exec(css);
  if (!m) return {};
  const block = m[2] ?? '';
  const out: { bg?: string; fg?: string } = {};
  // Prefer `background-color`; fall back to `background` shorthand.
  const bg =
    pickDecl(block, 'background-color') ?? pickDecl(block, 'background');
  if (bg && BG_FG_VALUE_RE.test(bg)) out.bg = bg;
  const fg = pickDecl(block, 'color');
  if (fg && BG_FG_VALUE_RE.test(fg)) out.fg = fg;
  return out;
}

function pickDecl(block: string, prop: string): string | undefined {
  // v0.14 sec-review MED-2: bound value capture at 200 chars so
  // adversarial CSS without semicolons can't force quadratic
  // backtracking on the `[^;]+?` lazy match. Plus terminator must be
  // `;` or end-of-string; trailing whitespace then handled by .trim().
  const re = new RegExp(
    `(?:^|;)\\s*${prop}\\s*:\\s*([^;]{1,200}?)\\s*(?:;|$)`,
    'i',
  );
  const m = re.exec(block);
  if (!m) return undefined;
  const v = (m[1] ?? '').trim();
  return v.length > 0 ? v : undefined;
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of items) {
    const k = x.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}
