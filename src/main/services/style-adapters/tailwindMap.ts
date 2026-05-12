// tailwindMap — pure data + a single pure function (`tailwindClassFor`)
// that maps a (cssProperty, cssValue) pair to a Tailwind class string.
//
// Phase 0.8 ships a focused subset (~30 CSS properties). Anything outside
// the table returns `null` and the dispatcher falls back to a style-prop
// write. Inside the table, values that don't match a canonical Tailwind
// token fall through to the arbitrary-value syntax (`bg-[#ff00ff]`,
// `p-[13px]`, …) so the caller always gets a usable class back.
//
// This file is intentionally data-heavy and side-effect free. The unit
// tests import `tailwindClassFor` directly; no IO, no module-level state.

// ─── colour palette (Tailwind v3 default) ───────────────────────────────────
//
// Each entry is the canonical name + the hex value. We keep the SHADES
// in a fixed order so the nearest-colour search is deterministic — when
// two palette entries are equidistant from the input, the lower-shade
// name wins (mirrors what designers expect when seeing "100" vs "200").

interface PaletteEntry {
  /** Tailwind class fragment (e.g. "red-500"). */
  name: string;
  /** Lowercased 6-digit hex without leading `#`. */
  hex: string;
}

// Default palette covering the colours users most commonly hit in design
// edits. Full palette is ~250 entries — we cap at ~120 of the most-used.
// Hex values lifted from tailwindcss v3 default theme.
const PALETTE: PaletteEntry[] = [
  // Pure colours
  { name: 'white', hex: 'ffffff' },
  { name: 'black', hex: '000000' },
  { name: 'transparent', hex: 'transparent' },

  // Slate
  { name: 'slate-50', hex: 'f8fafc' },
  { name: 'slate-100', hex: 'f1f5f9' },
  { name: 'slate-200', hex: 'e2e8f0' },
  { name: 'slate-300', hex: 'cbd5e1' },
  { name: 'slate-400', hex: '94a3b8' },
  { name: 'slate-500', hex: '64748b' },
  { name: 'slate-600', hex: '475569' },
  { name: 'slate-700', hex: '334155' },
  { name: 'slate-800', hex: '1e293b' },
  { name: 'slate-900', hex: '0f172a' },

  // Gray
  { name: 'gray-50', hex: 'f9fafb' },
  { name: 'gray-100', hex: 'f3f4f6' },
  { name: 'gray-200', hex: 'e5e7eb' },
  { name: 'gray-300', hex: 'd1d5db' },
  { name: 'gray-400', hex: '9ca3af' },
  { name: 'gray-500', hex: '6b7280' },
  { name: 'gray-600', hex: '4b5563' },
  { name: 'gray-700', hex: '374151' },
  { name: 'gray-800', hex: '1f2937' },
  { name: 'gray-900', hex: '111827' },

  // Zinc
  { name: 'zinc-50', hex: 'fafafa' },
  { name: 'zinc-100', hex: 'f4f4f5' },
  { name: 'zinc-200', hex: 'e4e4e7' },
  { name: 'zinc-300', hex: 'd4d4d8' },
  { name: 'zinc-400', hex: 'a1a1aa' },
  { name: 'zinc-500', hex: '71717a' },
  { name: 'zinc-600', hex: '52525b' },
  { name: 'zinc-700', hex: '3f3f46' },
  { name: 'zinc-800', hex: '27272a' },
  { name: 'zinc-900', hex: '18181b' },

  // Red
  { name: 'red-50', hex: 'fef2f2' },
  { name: 'red-100', hex: 'fee2e2' },
  { name: 'red-200', hex: 'fecaca' },
  { name: 'red-300', hex: 'fca5a5' },
  { name: 'red-400', hex: 'f87171' },
  { name: 'red-500', hex: 'ef4444' },
  { name: 'red-600', hex: 'dc2626' },
  { name: 'red-700', hex: 'b91c1c' },
  { name: 'red-800', hex: '991b1b' },
  { name: 'red-900', hex: '7f1d1d' },

  // Orange
  { name: 'orange-50', hex: 'fff7ed' },
  { name: 'orange-100', hex: 'ffedd5' },
  { name: 'orange-200', hex: 'fed7aa' },
  { name: 'orange-300', hex: 'fdba74' },
  { name: 'orange-400', hex: 'fb923c' },
  { name: 'orange-500', hex: 'f97316' },
  { name: 'orange-600', hex: 'ea580c' },
  { name: 'orange-700', hex: 'c2410c' },
  { name: 'orange-800', hex: '9a3412' },
  { name: 'orange-900', hex: '7c2d12' },

  // Amber
  { name: 'amber-50', hex: 'fffbeb' },
  { name: 'amber-100', hex: 'fef3c7' },
  { name: 'amber-200', hex: 'fde68a' },
  { name: 'amber-300', hex: 'fcd34d' },
  { name: 'amber-400', hex: 'fbbf24' },
  { name: 'amber-500', hex: 'f59e0b' },
  { name: 'amber-600', hex: 'd97706' },
  { name: 'amber-700', hex: 'b45309' },
  { name: 'amber-800', hex: '92400e' },
  { name: 'amber-900', hex: '78350f' },

  // Yellow
  { name: 'yellow-50', hex: 'fefce8' },
  { name: 'yellow-100', hex: 'fef9c3' },
  { name: 'yellow-200', hex: 'fef08a' },
  { name: 'yellow-300', hex: 'fde047' },
  { name: 'yellow-400', hex: 'facc15' },
  { name: 'yellow-500', hex: 'eab308' },
  { name: 'yellow-600', hex: 'ca8a04' },
  { name: 'yellow-700', hex: 'a16207' },
  { name: 'yellow-800', hex: '854d0e' },
  { name: 'yellow-900', hex: '713f12' },

  // Green
  { name: 'green-50', hex: 'f0fdf4' },
  { name: 'green-100', hex: 'dcfce7' },
  { name: 'green-200', hex: 'bbf7d0' },
  { name: 'green-300', hex: '86efac' },
  { name: 'green-400', hex: '4ade80' },
  { name: 'green-500', hex: '22c55e' },
  { name: 'green-600', hex: '16a34a' },
  { name: 'green-700', hex: '15803d' },
  { name: 'green-800', hex: '166534' },
  { name: 'green-900', hex: '14532d' },

  // Emerald
  { name: 'emerald-50', hex: 'ecfdf5' },
  { name: 'emerald-100', hex: 'd1fae5' },
  { name: 'emerald-200', hex: 'a7f3d0' },
  { name: 'emerald-300', hex: '6ee7b7' },
  { name: 'emerald-400', hex: '34d399' },
  { name: 'emerald-500', hex: '10b981' },
  { name: 'emerald-600', hex: '059669' },
  { name: 'emerald-700', hex: '047857' },
  { name: 'emerald-800', hex: '065f46' },
  { name: 'emerald-900', hex: '064e3b' },

  // Teal
  { name: 'teal-50', hex: 'f0fdfa' },
  { name: 'teal-100', hex: 'ccfbf1' },
  { name: 'teal-200', hex: '99f6e4' },
  { name: 'teal-300', hex: '5eead4' },
  { name: 'teal-400', hex: '2dd4bf' },
  { name: 'teal-500', hex: '14b8a6' },
  { name: 'teal-600', hex: '0d9488' },
  { name: 'teal-700', hex: '0f766e' },
  { name: 'teal-800', hex: '115e59' },
  { name: 'teal-900', hex: '134e4a' },

  // Cyan
  { name: 'cyan-50', hex: 'ecfeff' },
  { name: 'cyan-100', hex: 'cffafe' },
  { name: 'cyan-200', hex: 'a5f3fc' },
  { name: 'cyan-300', hex: '67e8f9' },
  { name: 'cyan-400', hex: '22d3ee' },
  { name: 'cyan-500', hex: '06b6d4' },
  { name: 'cyan-600', hex: '0891b2' },
  { name: 'cyan-700', hex: '0e7490' },
  { name: 'cyan-800', hex: '155e75' },
  { name: 'cyan-900', hex: '164e63' },

  // Sky
  { name: 'sky-50', hex: 'f0f9ff' },
  { name: 'sky-100', hex: 'e0f2fe' },
  { name: 'sky-200', hex: 'bae6fd' },
  { name: 'sky-300', hex: '7dd3fc' },
  { name: 'sky-400', hex: '38bdf8' },
  { name: 'sky-500', hex: '0ea5e9' },
  { name: 'sky-600', hex: '0284c7' },
  { name: 'sky-700', hex: '0369a1' },
  { name: 'sky-800', hex: '075985' },
  { name: 'sky-900', hex: '0c4a6e' },

  // Blue
  { name: 'blue-50', hex: 'eff6ff' },
  { name: 'blue-100', hex: 'dbeafe' },
  { name: 'blue-200', hex: 'bfdbfe' },
  { name: 'blue-300', hex: '93c5fd' },
  { name: 'blue-400', hex: '60a5fa' },
  { name: 'blue-500', hex: '3b82f6' },
  { name: 'blue-600', hex: '2563eb' },
  { name: 'blue-700', hex: '1d4ed8' },
  { name: 'blue-800', hex: '1e40af' },
  { name: 'blue-900', hex: '1e3a8a' },

  // Indigo
  { name: 'indigo-50', hex: 'eef2ff' },
  { name: 'indigo-100', hex: 'e0e7ff' },
  { name: 'indigo-200', hex: 'c7d2fe' },
  { name: 'indigo-300', hex: 'a5b4fc' },
  { name: 'indigo-400', hex: '818cf8' },
  { name: 'indigo-500', hex: '6366f1' },
  { name: 'indigo-600', hex: '4f46e5' },
  { name: 'indigo-700', hex: '4338ca' },
  { name: 'indigo-800', hex: '3730a3' },
  { name: 'indigo-900', hex: '312e81' },

  // Violet
  { name: 'violet-50', hex: 'f5f3ff' },
  { name: 'violet-100', hex: 'ede9fe' },
  { name: 'violet-200', hex: 'ddd6fe' },
  { name: 'violet-300', hex: 'c4b5fd' },
  { name: 'violet-400', hex: 'a78bfa' },
  { name: 'violet-500', hex: '8b5cf6' },
  { name: 'violet-600', hex: '7c3aed' },
  { name: 'violet-700', hex: '6d28d9' },
  { name: 'violet-800', hex: '5b21b6' },
  { name: 'violet-900', hex: '4c1d95' },

  // Purple
  { name: 'purple-50', hex: 'faf5ff' },
  { name: 'purple-100', hex: 'f3e8ff' },
  { name: 'purple-200', hex: 'e9d5ff' },
  { name: 'purple-300', hex: 'd8b4fe' },
  { name: 'purple-400', hex: 'c084fc' },
  { name: 'purple-500', hex: 'a855f7' },
  { name: 'purple-600', hex: '9333ea' },
  { name: 'purple-700', hex: '7e22ce' },
  { name: 'purple-800', hex: '6b21a8' },
  { name: 'purple-900', hex: '581c87' },

  // Pink
  { name: 'pink-50', hex: 'fdf2f8' },
  { name: 'pink-100', hex: 'fce7f3' },
  { name: 'pink-200', hex: 'fbcfe8' },
  { name: 'pink-300', hex: 'f9a8d4' },
  { name: 'pink-400', hex: 'f472b6' },
  { name: 'pink-500', hex: 'ec4899' },
  { name: 'pink-600', hex: 'db2777' },
  { name: 'pink-700', hex: 'be185d' },
  { name: 'pink-800', hex: '9d174d' },
  { name: 'pink-900', hex: '831843' },

  // Rose
  { name: 'rose-50', hex: 'fff1f2' },
  { name: 'rose-100', hex: 'ffe4e6' },
  { name: 'rose-200', hex: 'fecdd3' },
  { name: 'rose-300', hex: 'fda4af' },
  { name: 'rose-400', hex: 'fb7185' },
  { name: 'rose-500', hex: 'f43f5e' },
  { name: 'rose-600', hex: 'e11d48' },
  { name: 'rose-700', hex: 'be123c' },
  { name: 'rose-800', hex: '9f1239' },
  { name: 'rose-900', hex: '881337' },
];

/** Total entries in PALETTE — exposed for parent agent's report. */
export const TAILWIND_PALETTE_SIZE = PALETTE.length;

// ─── numeric scales (spacing, font-size, radius, font-weight) ──────────────

// Tailwind spacing scale, rem units. We accept px input and translate
// using a default 1rem = 16px (the framework's default `baseFontSize`).
// Phase 0.8 doesn't read the project's tailwind.config.js — that's a
// 0.9-grade feature; the dispatcher will warn if the project overrides.
const SPACING_PX: Record<number, string> = {
  0: '0',
  1: 'px',     // 1px → `p-px`
  2: '0.5',    // 2px → `p-0.5`
  4: '1',
  6: '1.5',
  8: '2',
  10: '2.5',
  12: '3',
  14: '3.5',
  16: '4',
  20: '5',
  24: '6',
  28: '7',
  32: '8',
  36: '9',
  40: '10',
  44: '11',
  48: '12',
  56: '14',
  64: '16',
  80: '20',
  96: '24',
  112: '28',
  128: '32',
  144: '36',
  160: '40',
  176: '44',
  192: '48',
  208: '52',
  224: '56',
  240: '60',
  256: '64',
  288: '72',
  320: '80',
  384: '96',
};

// Tailwind text-size scale: name → px.
const FONT_SIZE_PX: Record<number, string> = {
  12: 'xs',
  14: 'sm',
  16: 'base',
  18: 'lg',
  20: 'xl',
  24: '2xl',
  30: '3xl',
  36: '4xl',
  48: '5xl',
  60: '6xl',
  72: '7xl',
  96: '8xl',
  128: '9xl',
};

const FONT_WEIGHT_TOKENS: Record<string, string> = {
  '100': 'thin',
  '200': 'extralight',
  '300': 'light',
  '400': 'normal',
  '500': 'medium',
  '600': 'semibold',
  '700': 'bold',
  '800': 'extrabold',
  '900': 'black',
  thin: 'thin',
  extralight: 'extralight',
  light: 'light',
  normal: 'normal',
  medium: 'medium',
  semibold: 'semibold',
  bold: 'bold',
  extrabold: 'extrabold',
  black: 'black',
};

const RADIUS_PX: Record<number, string> = {
  0: 'none',
  2: 'sm',
  4: '',
  6: 'md',
  8: 'lg',
  12: 'xl',
  16: '2xl',
  24: '3xl',
  9999: 'full',
};

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Parse a CSS value as px. Accepts "16px", "16", "1rem", "1.5rem".
 * Returns the px-equivalent number, or null when unparseable.
 */
function parsePx(value: string): number | null {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '0') return 0;
  let m = /^(-?\d+(?:\.\d+)?)px$/.exec(trimmed);
  if (m) return Number(m[1]);
  m = /^(-?\d+(?:\.\d+)?)rem$/.exec(trimmed);
  if (m) return Number(m[1]) * 16;
  m = /^(-?\d+(?:\.\d+)?)$/.exec(trimmed);
  if (m) return Number(m[1]);
  return null;
}

/** Strip leading `#`, expand `#abc` to `#aabbcc`, lowercase. Returns null when
 * the input isn't a recognizable hex form. */
function normalizeHex(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  // Named keywords we cover.
  if (trimmed === 'transparent') return 'transparent';
  if (trimmed === 'white') return 'ffffff';
  if (trimmed === 'black') return '000000';
  // `#abc` / `#aabbcc` / `abc` / `aabbcc`.
  const stripped = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  if (/^[0-9a-f]{3}$/.test(stripped)) {
    return stripped
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (/^[0-9a-f]{6}$/.test(stripped)) return stripped;
  // `rgb()` / `rgba()` — translate to hex (alpha dropped, Tailwind doesn't
  // have a "with-alpha-arbitrary-value" syntax cleanly).
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(trimmed);
  if (rgb) {
    const r = clampByte(Number(rgb[1]));
    const g = clampByte(Number(rgb[2]));
    const b = clampByte(Number(rgb[3]));
    return [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('');
  }
  return null;
}

function clampByte(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

/** Squared Euclidean distance in sRGB space. Good enough for nearest-named
 * matching — closer-perceptual distance metrics (LAB ΔE) aren't worth the
 * code in a designer-driven flow where users mostly hit exact hex values. */
function colorDistance(a: string, b: string): number {
  const ar = parseInt(a.slice(0, 2), 16);
  const ag = parseInt(a.slice(2, 4), 16);
  const ab = parseInt(a.slice(4, 6), 16);
  const br = parseInt(b.slice(0, 2), 16);
  const bg = parseInt(b.slice(2, 4), 16);
  const bb = parseInt(b.slice(4, 6), 16);
  const dr = ar - br;
  const dg = ag - bg;
  const db = ab - bb;
  return dr * dr + dg * dg + db * db;
}

/**
 * Match a hex (no `#`) against the palette. Exact match wins; otherwise
 * returns the nearest entry as long as it's within a small distance
 * threshold (~32 RGB units). Beyond that we'd rather use an arbitrary
 * value than mis-name the colour.
 */
function nearestPaletteEntry(hex: string): PaletteEntry | null {
  if (hex === 'transparent') {
    return { name: 'transparent', hex: 'transparent' };
  }
  for (const entry of PALETTE) {
    if (entry.hex === hex) return entry;
  }
  // Find the nearest. Threshold is squared-distance — 32*32*3 ≈ 3072 is
  // perceptually tight enough that a #3a83f6 still maps to blue-500.
  const THRESHOLD = 32 * 32 * 3;
  let best: PaletteEntry | null = null;
  let bestDist = Infinity;
  for (const entry of PALETTE) {
    if (entry.hex === 'transparent') continue;
    const d = colorDistance(hex, entry.hex);
    if (d < bestDist) {
      bestDist = d;
      best = entry;
    }
  }
  if (best && bestDist <= THRESHOLD) return best;
  return null;
}

// Property dispatch table. Each entry knows its colour/spacing/etc. flavour
// + the Tailwind prefix it expands to. We keep this in one place so adding
// a new property is one row.
type Flavor =
  | 'color'
  | 'spacing'
  | 'spacing-x'
  | 'spacing-y'
  | 'font-size'
  | 'font-weight'
  | 'border-radius'
  | 'keyword'
  | 'border-width'
  | 'opacity';

interface PropEntry {
  prefix: string;
  flavor: Flavor;
  /** Map of canonical CSS keyword → Tailwind tail (for flavor='keyword'). */
  keywords?: Record<string, string>;
}

const PROPS: Record<string, PropEntry> = {
  'background-color': { prefix: 'bg', flavor: 'color' },
  color: { prefix: 'text', flavor: 'color' },
  'border-color': { prefix: 'border', flavor: 'color' },
  fill: { prefix: 'fill', flavor: 'color' },
  stroke: { prefix: 'stroke', flavor: 'color' },

  padding: { prefix: 'p', flavor: 'spacing' },
  'padding-top': { prefix: 'pt', flavor: 'spacing' },
  'padding-right': { prefix: 'pr', flavor: 'spacing' },
  'padding-bottom': { prefix: 'pb', flavor: 'spacing' },
  'padding-left': { prefix: 'pl', flavor: 'spacing' },
  margin: { prefix: 'm', flavor: 'spacing' },
  'margin-top': { prefix: 'mt', flavor: 'spacing' },
  'margin-right': { prefix: 'mr', flavor: 'spacing' },
  'margin-bottom': { prefix: 'mb', flavor: 'spacing' },
  'margin-left': { prefix: 'ml', flavor: 'spacing' },
  gap: { prefix: 'gap', flavor: 'spacing' },
  'row-gap': { prefix: 'gap-y', flavor: 'spacing' },
  'column-gap': { prefix: 'gap-x', flavor: 'spacing' },

  width: { prefix: 'w', flavor: 'spacing' },
  height: { prefix: 'h', flavor: 'spacing' },
  'min-width': { prefix: 'min-w', flavor: 'spacing' },
  'min-height': { prefix: 'min-h', flavor: 'spacing' },
  'max-width': { prefix: 'max-w', flavor: 'spacing' },
  'max-height': { prefix: 'max-h', flavor: 'spacing' },

  'font-size': { prefix: 'text', flavor: 'font-size' },
  'font-weight': { prefix: 'font', flavor: 'font-weight' },

  'border-radius': { prefix: 'rounded', flavor: 'border-radius' },
  'border-width': { prefix: 'border', flavor: 'border-width' },
  opacity: { prefix: 'opacity', flavor: 'opacity' },

  display: {
    prefix: '',
    flavor: 'keyword',
    keywords: {
      flex: 'flex',
      'inline-flex': 'inline-flex',
      grid: 'grid',
      'inline-grid': 'inline-grid',
      block: 'block',
      'inline-block': 'inline-block',
      inline: 'inline',
      hidden: 'hidden',
      none: 'hidden',
      contents: 'contents',
    },
  },
  'text-align': {
    prefix: 'text',
    flavor: 'keyword',
    keywords: {
      left: 'left',
      right: 'right',
      center: 'center',
      justify: 'justify',
      start: 'start',
      end: 'end',
    },
  },
  'flex-direction': {
    prefix: 'flex',
    flavor: 'keyword',
    keywords: {
      row: 'row',
      'row-reverse': 'row-reverse',
      column: 'col',
      'column-reverse': 'col-reverse',
    },
  },
  'justify-content': {
    prefix: 'justify',
    flavor: 'keyword',
    keywords: {
      'flex-start': 'start',
      'flex-end': 'end',
      center: 'center',
      'space-between': 'between',
      'space-around': 'around',
      'space-evenly': 'evenly',
      start: 'start',
      end: 'end',
    },
  },
  'align-items': {
    prefix: 'items',
    flavor: 'keyword',
    keywords: {
      'flex-start': 'start',
      'flex-end': 'end',
      center: 'center',
      stretch: 'stretch',
      baseline: 'baseline',
      start: 'start',
      end: 'end',
    },
  },
  position: {
    prefix: '',
    flavor: 'keyword',
    keywords: {
      static: 'static',
      relative: 'relative',
      absolute: 'absolute',
      fixed: 'fixed',
      sticky: 'sticky',
    },
  },
  'font-style': {
    prefix: '',
    flavor: 'keyword',
    keywords: {
      italic: 'italic',
      normal: 'not-italic',
    },
  },
  'text-decoration': {
    prefix: '',
    flavor: 'keyword',
    keywords: {
      underline: 'underline',
      'line-through': 'line-through',
      none: 'no-underline',
    },
  },
  cursor: {
    prefix: 'cursor',
    flavor: 'keyword',
    keywords: {
      pointer: 'pointer',
      default: 'default',
      'not-allowed': 'not-allowed',
      wait: 'wait',
      text: 'text',
      move: 'move',
      grab: 'grab',
      grabbing: 'grabbing',
    },
  },
  overflow: {
    prefix: 'overflow',
    flavor: 'keyword',
    keywords: {
      auto: 'auto',
      hidden: 'hidden',
      visible: 'visible',
      scroll: 'scroll',
    },
  },
};

/**
 * Compute the Tailwind class for a (property, value) pair, or null when
 * the property prefix isn't in our supported table. A non-null return is
 * always a usable class — the function falls back to arbitrary-value
 * syntax when the value doesn't snap to a canonical token.
 *
 * Examples:
 *   tailwindClassFor('background-color', '#3b82f6')  // 'bg-blue-500'
 *   tailwindClassFor('background-color', '#3a83f6')  // 'bg-blue-500'  (nearest)
 *   tailwindClassFor('background-color', '#abcdef')  // 'bg-[#abcdef]' (arbitrary)
 *   tailwindClassFor('padding', '16px')              // 'p-4'
 *   tailwindClassFor('padding', '13px')              // 'p-[13px]'
 *   tailwindClassFor('display', 'flex')              // 'flex'
 *   tailwindClassFor('z-index', '50')                // null            (unsupported)
 */
export function tailwindClassFor(prop: string, value: string): string | null {
  if (typeof prop !== 'string' || typeof value !== 'string') return null;
  // Cap input sizes — defends against pathological inputs to the regex
  // engines downstream and matches the "small CSS value" assumption.
  if (prop.length > 64 || value.length > 256) return null;
  const entry = PROPS[prop.toLowerCase()];
  if (!entry) return null;
  const trimmedValue = value.trim();
  if (!trimmedValue) return null;

  switch (entry.flavor) {
    case 'color':
      return colorClass(entry.prefix, trimmedValue);
    case 'spacing':
      return spacingClass(entry.prefix, trimmedValue);
    case 'spacing-x':
      return spacingClass(entry.prefix, trimmedValue);
    case 'spacing-y':
      return spacingClass(entry.prefix, trimmedValue);
    case 'font-size':
      return fontSizeClass(entry.prefix, trimmedValue);
    case 'font-weight':
      return fontWeightClass(entry.prefix, trimmedValue);
    case 'border-radius':
      return radiusClass(entry.prefix, trimmedValue);
    case 'border-width':
      return borderWidthClass(entry.prefix, trimmedValue);
    case 'opacity':
      return opacityClass(entry.prefix, trimmedValue);
    case 'keyword':
      return keywordClass(entry, trimmedValue);
  }
}

// SECURITY: characters allowed inside a Tailwind arbitrary-value bracket
// `<prefix>-[<value>]`. The bracket is spliced verbatim into the JSX
// className string literal; anything outside this set can break out of
// the attribute and inject JSX/JS (RCE on next build). Keep this list
// tight — letters, digits, the units we expect, plus a few separators.
// Forbid quotes, angle brackets, curlies, backticks, semicolons,
// backslash, equals, parentheses with content beyond `var()`.
const ARBITRARY_VALUE_RE = /^[A-Za-z0-9_:./%#,-]+$/;

function safeArbitraryValue(value: string): string | null {
  const stripped = value.replace(/\s+/g, '');
  if (stripped.length === 0 || stripped.length > 64) return null;
  if (!ARBITRARY_VALUE_RE.test(stripped)) return null;
  return stripped;
}

function colorClass(prefix: string, value: string): string | null {
  const hex = normalizeHex(value);
  if (!hex) {
    // Tailwind's arbitrary-value bracket would normally accept anything
    // free of whitespace, but we splice this string into a JSX className
    // literal — return null on any value containing unsafe characters
    // so the dispatcher falls back to the safe `style={{...}}` write
    // path (which escapes properly via a JS string literal).
    const safe = safeArbitraryValue(value);
    if (!safe) return null;
    return `${prefix}-[${safe}]`;
  }
  if (hex === 'transparent') return `${prefix}-transparent`;
  const named = nearestPaletteEntry(hex);
  if (named) return `${prefix}-${named.name}`;
  return `${prefix}-[#${hex}]`;
}

function spacingClass(prefix: string, value: string): string | null {
  // Handle `auto` keyword for margin / inset.
  if (value === 'auto' && prefix.startsWith('m')) {
    return `${prefix}-auto`;
  }
  const px = parsePx(value);
  if (px === null) {
    const safe = safeArbitraryValue(value);
    if (!safe) return null;
    return `${prefix}-[${safe}]`;
  }
  if (px < 0) {
    // Negative margins: tailwind uses `-mt-4` etc. The prefix becomes
    // `-${prefix}` and we look up by abs(px).
    const abs = Math.abs(px);
    const token = SPACING_PX[abs];
    if (token !== undefined) return `-${prefix}-${token}`;
    return `-${prefix}-[${abs}px]`;
  }
  const token = SPACING_PX[px];
  if (token !== undefined) return `${prefix}-${token}`;
  return `${prefix}-[${px}px]`;
}

function fontSizeClass(prefix: string, value: string): string | null {
  const px = parsePx(value);
  if (px === null) {
    const safe = safeArbitraryValue(value);
    if (!safe) return null;
    return `${prefix}-[${safe}]`;
  }
  const token = FONT_SIZE_PX[px];
  if (token !== undefined) return `${prefix}-${token}`;
  return `${prefix}-[${px}px]`;
}

function fontWeightClass(prefix: string, value: string): string | null {
  const token = FONT_WEIGHT_TOKENS[value.trim().toLowerCase()];
  if (token) return `${prefix}-${token}`;
  const safe = safeArbitraryValue(value);
  if (!safe) return null;
  return `${prefix}-[${safe}]`;
}

function radiusClass(prefix: string, value: string): string | null {
  const px = parsePx(value);
  if (px === null) {
    const safe = safeArbitraryValue(value);
    if (!safe) return null;
    return `${prefix}-[${safe}]`;
  }
  const token = RADIUS_PX[px];
  if (token === '') return prefix; // 4px → bare `rounded`
  if (token !== undefined) return `${prefix}-${token}`;
  return `${prefix}-[${px}px]`;
}

function borderWidthClass(prefix: string, value: string): string | null {
  const px = parsePx(value);
  if (px === null) {
    const safe = safeArbitraryValue(value);
    if (!safe) return null;
    return `${prefix}-[${safe}]`;
  }
  if (px === 1) return prefix; // `border-width: 1px` → bare `border`
  if (px === 0) return `${prefix}-0`;
  if ([2, 4, 8].includes(px)) return `${prefix}-${px}`;
  return `${prefix}-[${px}px]`;
}

function opacityClass(prefix: string, value: string): string {
  const trimmed = value.trim();
  // Accept "0.5" or "50%".
  let pct: number | null = null;
  const pctMatch = /^(\d+(?:\.\d+)?)%$/.exec(trimmed);
  if (pctMatch) {
    pct = Number(pctMatch[1]);
  } else {
    const num = Number(trimmed);
    if (Number.isFinite(num)) pct = num * 100;
  }
  if (pct === null) return `${prefix}-[${trimmed}]`;
  const rounded = Math.round(pct);
  // Tailwind opacity scale: 0,5,10,…,100 (multiples of 5).
  const snapped = Math.round(rounded / 5) * 5;
  if (Math.abs(snapped - rounded) < 1 && snapped >= 0 && snapped <= 100) {
    return `${prefix}-${snapped}`;
  }
  return `${prefix}-[${rounded}%]`;
}

function keywordClass(entry: PropEntry, value: string): string | null {
  const v = value.toLowerCase();
  const token = entry.keywords?.[v];
  if (!token) {
    // Unknown keyword — better to fall through to style-prop write than
    // emit a class that won't be recognized.
    return null;
  }
  return entry.prefix ? `${entry.prefix}-${token}` : token;
}

// ─── prefix lookup for conflict-resolution on class strings ────────────────

// Map of every Tailwind class fragment a property could emit, back to its
// "conflict group" key. Two classes in the same group can't both apply —
// the swapper must strip the old one before inserting the new.
//
// Keys are the property prefix (e.g. "bg", "text", "p", "pt", "rounded",
// "flex" – note "flex" is both a display class AND a flex-direction
// prefix; we resolve that ambiguity in `prefixForClass` below).
//
// This is the source-of-truth list of conflict groups. `prefixForClass`
// is the only consumer; `swapClass` calls it.

/** Conflict groups. Each tuple is [groupKey, classMatcher].
 *
 *   groupKey identifies the property family the class belongs to. Classes
 *   sharing a groupKey are mutually exclusive in Tailwind's compiled CSS.
 *
 *   classMatcher decides whether a given class belongs to the group. It
 *   either compares directly (bare class like 'flex' or 'italic') or
 *   prefixes with a separator like 'bg-' / 'text-' / 'p-'.
 */
type ClassMatcher =
  | { kind: 'exact'; classes: string[] }
  | { kind: 'prefix'; prefix: string };

const CONFLICT_GROUPS: Array<[string, ClassMatcher]> = [
  // Display — exact bare classes (some overlap with prefixed groups
  // below; ordering matters and we check exact-set first).
  [
    'display',
    {
      kind: 'exact',
      classes: [
        'block',
        'inline-block',
        'inline',
        'flex',
        'inline-flex',
        'grid',
        'inline-grid',
        'hidden',
        'contents',
      ],
    },
  ],
  ['position', { kind: 'exact', classes: ['static', 'relative', 'absolute', 'fixed', 'sticky'] }],
  ['font-style', { kind: 'exact', classes: ['italic', 'not-italic'] }],
  [
    'text-decoration',
    { kind: 'exact', classes: ['underline', 'line-through', 'no-underline'] },
  ],
  // Border-width bare class.
  ['border-width', { kind: 'exact', classes: ['border'] }],
  // Border-radius bare class (default rounded ≈ 4px).
  ['border-radius', { kind: 'exact', classes: ['rounded'] }],

  // Prefix-based groups. Order matters: longer prefixes (e.g. `min-w-`)
  // must come before shorter ones (`m-`) so we don't mis-classify.
  ['min-width', { kind: 'prefix', prefix: 'min-w-' }],
  ['min-height', { kind: 'prefix', prefix: 'min-h-' }],
  ['max-width', { kind: 'prefix', prefix: 'max-w-' }],
  ['max-height', { kind: 'prefix', prefix: 'max-h-' }],

  ['padding-top', { kind: 'prefix', prefix: 'pt-' }],
  ['padding-right', { kind: 'prefix', prefix: 'pr-' }],
  ['padding-bottom', { kind: 'prefix', prefix: 'pb-' }],
  ['padding-left', { kind: 'prefix', prefix: 'pl-' }],
  ['padding-x', { kind: 'prefix', prefix: 'px-' }],
  ['padding-y', { kind: 'prefix', prefix: 'py-' }],
  ['padding', { kind: 'prefix', prefix: 'p-' }],

  ['margin-top', { kind: 'prefix', prefix: 'mt-' }],
  ['margin-right', { kind: 'prefix', prefix: 'mr-' }],
  ['margin-bottom', { kind: 'prefix', prefix: 'mb-' }],
  ['margin-left', { kind: 'prefix', prefix: 'ml-' }],
  ['margin-x', { kind: 'prefix', prefix: 'mx-' }],
  ['margin-y', { kind: 'prefix', prefix: 'my-' }],
  ['margin', { kind: 'prefix', prefix: 'm-' }],

  ['gap-x', { kind: 'prefix', prefix: 'gap-x-' }],
  ['gap-y', { kind: 'prefix', prefix: 'gap-y-' }],
  ['gap', { kind: 'prefix', prefix: 'gap-' }],

  ['width', { kind: 'prefix', prefix: 'w-' }],
  ['height', { kind: 'prefix', prefix: 'h-' }],

  ['background-color', { kind: 'prefix', prefix: 'bg-' }],
  ['border-color', { kind: 'prefix', prefix: 'border-' }],
  ['fill', { kind: 'prefix', prefix: 'fill-' }],
  ['stroke', { kind: 'prefix', prefix: 'stroke-' }],
  // `text-*` is ambiguous (color + font-size + alignment). The class
  // value disambiguates — we treat each as its own group key so the
  // dispatcher can swap by exact group, not by shared prefix.
  ['color-or-fontsize-or-text', { kind: 'prefix', prefix: 'text-' }],
  ['font-weight', { kind: 'prefix', prefix: 'font-' }],
  ['border-radius', { kind: 'prefix', prefix: 'rounded-' }],
  ['border-width', { kind: 'prefix', prefix: 'border-' }], // overlaps border-color; resolved by tail
  ['opacity', { kind: 'prefix', prefix: 'opacity-' }],

  ['flex-direction', { kind: 'prefix', prefix: 'flex-' }],
  ['justify-content', { kind: 'prefix', prefix: 'justify-' }],
  ['align-items', { kind: 'prefix', prefix: 'items-' }],
  ['cursor', { kind: 'prefix', prefix: 'cursor-' }],
  ['overflow', { kind: 'prefix', prefix: 'overflow-' }],
];

/**
 * Return the conflict-group key for a class, or empty string when the
 * class isn't recognized (we leave unknown classes untouched on swap).
 *
 *   prefixForClass('bg-red-500')   → 'background-color'
 *   prefixForClass('flex')         → 'display'
 *   prefixForClass('flex-col')     → 'flex-direction'
 *   prefixForClass('text-sm')      → 'font-size'  (tail is a size scale)
 *   prefixForClass('text-red-500') → 'color'      (tail is a colour)
 *   prefixForClass('text-center')  → 'text-align' (tail is alignment kw)
 *   prefixForClass('unknown-foo')  → ''
 */
export function prefixForClass(cls: string): string {
  if (!cls) return '';
  // Strip Tailwind variants like "hover:", "md:", "dark:". The variant
  // prefix doesn't affect conflict grouping for unconditional classes —
  // and conditional + unconditional don't conflict with each other, so
  // we treat variant-prefixed classes as their own opaque group.
  if (cls.includes(':')) {
    return `variant:${cls.split(':').slice(0, -1).join(':')}`;
  }

  // Exact-match groups first — `flex` would otherwise be eaten by the
  // `flex-` prefix group.
  for (const [key, matcher] of CONFLICT_GROUPS) {
    if (matcher.kind === 'exact' && matcher.classes.includes(cls)) {
      return key;
    }
  }

  // Handle the ambiguous `text-*` family. text-{color}, text-{size}, and
  // text-{alignment} all share the `text-` prefix but must NOT conflict
  // with each other.
  if (cls.startsWith('text-')) {
    const tail = cls.slice('text-'.length);
    // Alignment.
    if (
      tail === 'left' ||
      tail === 'right' ||
      tail === 'center' ||
      tail === 'justify' ||
      tail === 'start' ||
      tail === 'end'
    ) {
      return 'text-align';
    }
    // Size scale.
    if (
      tail === 'xs' ||
      tail === 'sm' ||
      tail === 'base' ||
      tail === 'lg' ||
      tail === 'xl' ||
      /^[2-9]xl$/.test(tail) ||
      /^\[\d+(?:\.\d+)?(?:px|rem|em|%)\]$/.test(tail)
    ) {
      return 'font-size';
    }
    // Otherwise treat as colour.
    return 'color';
  }

  // `border-*` is also ambiguous: `border-{color}` vs `border-{width}` vs
  // bare `border`. The exact-match group already caught bare `border`.
  if (cls.startsWith('border-')) {
    const tail = cls.slice('border-'.length);
    if (
      tail === '0' ||
      tail === '2' ||
      tail === '4' ||
      tail === '8' ||
      /^\[\d+(?:\.\d+)?px\]$/.test(tail)
    ) {
      return 'border-width';
    }
    return 'border-color';
  }

  // Prefix-based groups (in declaration order so longer prefixes win).
  for (const [key, matcher] of CONFLICT_GROUPS) {
    if (matcher.kind === 'prefix' && cls.startsWith(matcher.prefix)) {
      // Skip the bg-/border-/text- groups we already handled or that
      // we treat ambiguously elsewhere.
      if (matcher.prefix === 'text-' || matcher.prefix === 'border-') continue;
      return key;
    }
  }
  return '';
}

/**
 * Parse a className string into an array of trimmed class tokens.
 * Collapses runs of whitespace; ignores empty tokens; preserves order.
 */
export function parseTailwindClassString(s: string): string[] {
  if (!s) return [];
  const out: string[] = [];
  for (const tok of s.split(/\s+/)) {
    if (tok.length > 0) out.push(tok);
  }
  return out;
}

/**
 * Swap-with-dedupe: insert `newClass` into the current class string,
 * removing any existing classes whose conflict group matches the new
 * class. Preserves original order for the surviving classes; the new
 * class lands at the end of its group's first occurrence (or at the end
 * of the string if the group was previously absent).
 *
 *   swapClass('bg-red-500 text-white p-4', 'bg-blue-500')
 *     → 'bg-blue-500 text-white p-4'
 *   swapClass('p-4 text-sm', 'text-lg')
 *     → 'p-4 text-lg'
 *   swapClass('flex items-center', 'block')
 *     → 'block items-center'
 */
export function swapClass(currentClasses: string, newClass: string): string {
  const tokens = parseTailwindClassString(currentClasses);
  const newGroup = prefixForClass(newClass);
  // Unknown groups — just append (we can't dedupe what we can't classify).
  if (!newGroup) {
    if (tokens.includes(newClass)) return tokens.join(' ');
    return [...tokens, newClass].join(' ');
  }
  const survivors: string[] = [];
  let inserted = false;
  for (const tok of tokens) {
    const g = prefixForClass(tok);
    if (g === newGroup) {
      // This is a conflict: drop the old class; remember to insert the
      // replacement at this location to keep authoring intent.
      if (!inserted) {
        survivors.push(newClass);
        inserted = true;
      }
      continue;
    }
    survivors.push(tok);
  }
  if (!inserted) survivors.push(newClass);
  return survivors.join(' ');
}

/**
 * kebab-case CSS property → camelCase style key.
 *
 *   cssPropertyToStyleKey('background-color') → 'backgroundColor'
 *   cssPropertyToStyleKey('color')             → 'color'
 *   cssPropertyToStyleKey('-webkit-transform') → 'WebkitTransform'
 */
export function cssPropertyToStyleKey(prop: string): string {
  if (!prop) return '';
  const trimmed = prop.trim();
  // Vendor prefix (-webkit-, -moz-) → leading uppercase.
  let s = trimmed;
  if (s.startsWith('-')) {
    s = s.slice(1);
  }
  return s.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
}
