// Pure-data tests for tailwindMap. The module is side-effect-free — no
// mocks needed. We pin behaviour around (a) the property table coverage,
// (b) the palette/spacing/size/keyword scales, (c) the arbitrary-value
// fallback, (d) conflict-group classification for `prefixForClass`, and
// (e) the `swapClass` dedupe-or-append semantics.

import { describe, expect, it } from 'vitest';

import {
  cssPropertyToStyleKey,
  parseTailwindClassString,
  prefixForClass,
  swapClass,
  TAILWIND_PALETTE_SIZE,
  tailwindClassFor,
} from '@main/services/style-adapters/tailwindMap';

describe('tailwindClassFor', () => {
  it('maps an exact-palette background hex to the named class', () => {
    // #3b82f6 is the canonical hex for `blue-500` in the v3 default theme,
    // so we expect the nearest-colour search to land on the exact match.
    expect(tailwindClassFor('background-color', '#3b82f6')).toBe('bg-blue-500');
  });

  it('maps `red-500` palette hex to the named class', () => {
    expect(tailwindClassFor('background-color', '#ef4444')).toBe('bg-red-500');
  });

  it('snaps a near-palette hex to the nearest named class (within threshold)', () => {
    // #3a83f6 differs from #3b82f6 by 1 channel each — well within the
    // ~32-units threshold, so nearest-match still names blue-500.
    expect(tailwindClassFor('background-color', '#3a83f6')).toBe('bg-blue-500');
  });

  it('falls back to arbitrary value for an off-palette hex', () => {
    // #7f00ff is far enough from every palette entry that nearest-match
    // refuses to mis-name it; the function emits the bracket syntax.
    expect(tailwindClassFor('background-color', '#7f00ff')).toBe('bg-[#7f00ff]');
  });

  it('handles the `transparent` keyword', () => {
    expect(tailwindClassFor('background-color', 'transparent')).toBe('bg-transparent');
  });

  it('maps padding 16px to `p-4`', () => {
    expect(tailwindClassFor('padding', '16px')).toBe('p-4');
  });

  it('maps padding 0 to `p-0`', () => {
    expect(tailwindClassFor('padding', '0')).toBe('p-0');
  });

  it('emits arbitrary value when spacing is off-scale', () => {
    expect(tailwindClassFor('padding', '13px')).toBe('p-[13px]');
  });

  it('maps font-size 14px to `text-sm`', () => {
    expect(tailwindClassFor('font-size', '14px')).toBe('text-sm');
  });

  it('maps font-size 16px to `text-base`', () => {
    expect(tailwindClassFor('font-size', '16px')).toBe('text-base');
  });

  it('maps display flex to bare `flex`', () => {
    expect(tailwindClassFor('display', 'flex')).toBe('flex');
  });

  it('maps display block to bare `block`', () => {
    expect(tailwindClassFor('display', 'block')).toBe('block');
  });

  it('maps font-weight numeric `600` to `font-semibold`', () => {
    expect(tailwindClassFor('font-weight', '600')).toBe('font-semibold');
  });

  it('maps font-weight keyword `bold` to `font-bold`', () => {
    expect(tailwindClassFor('font-weight', 'bold')).toBe('font-bold');
  });

  it('returns null for an unsupported CSS property', () => {
    // `z-index` isn't in the property table, so the dispatcher should
    // signal a fall-through to the style-prop adapter.
    expect(tailwindClassFor('z-index', '50')).toBeNull();
  });

  it('returns null for an unsupported display keyword', () => {
    // Keyword properties refuse unknown tokens rather than mis-emitting.
    expect(tailwindClassFor('display', 'table-cell')).toBeNull();
  });

  it('returns null for an empty value', () => {
    expect(tailwindClassFor('padding', '   ')).toBeNull();
  });

  it('parses rgb() input as hex', () => {
    // 59,130,246 == #3b82f6 == blue-500.
    expect(tailwindClassFor('background-color', 'rgb(59, 130, 246)')).toBe('bg-blue-500');
  });

  it('exposes a non-empty palette size for upstream reporting', () => {
    expect(TAILWIND_PALETTE_SIZE).toBeGreaterThan(50);
  });
});

describe('parseTailwindClassString', () => {
  it('splits whitespace-separated classes', () => {
    expect(parseTailwindClassString('bg-red-500 text-white p-4')).toEqual([
      'bg-red-500',
      'text-white',
      'p-4',
    ]);
  });

  it('collapses runs of whitespace', () => {
    expect(parseTailwindClassString('  bg-red-500   p-4  ')).toEqual([
      'bg-red-500',
      'p-4',
    ]);
  });

  it('returns an empty array for empty/whitespace input', () => {
    expect(parseTailwindClassString('')).toEqual([]);
    expect(parseTailwindClassString('    ')).toEqual([]);
  });
});

describe('prefixForClass', () => {
  it('classifies bg-* as background-color', () => {
    expect(prefixForClass('bg-red-500')).toBe('background-color');
    expect(prefixForClass('bg-[#7f00ff]')).toBe('background-color');
  });

  it('classifies p-* as padding', () => {
    expect(prefixForClass('p-4')).toBe('padding');
  });

  it('classifies pt-* and px-* as their own groups (longer-prefix-wins)', () => {
    expect(prefixForClass('pt-2')).toBe('padding-top');
    expect(prefixForClass('px-4')).toBe('padding-x');
  });

  it('classifies bare `flex` as display (exact-match first)', () => {
    // Without exact-match-first, the prefix-based `flex-` group would
    // eat bare `flex`. This is the single most fragile bit of the
    // classifier — keep the regression test loud.
    expect(prefixForClass('flex')).toBe('display');
  });

  it('classifies flex-col as flex-direction', () => {
    expect(prefixForClass('flex-col')).toBe('flex-direction');
  });

  it('classifies `text-white` as color (colour tail)', () => {
    expect(prefixForClass('text-white')).toBe('color');
  });

  it('classifies `text-sm` as font-size (size-scale tail)', () => {
    expect(prefixForClass('text-sm')).toBe('font-size');
  });

  it('classifies `text-center` as text-align (alignment tail)', () => {
    expect(prefixForClass('text-center')).toBe('text-align');
  });

  it('returns empty string for unknown classes', () => {
    expect(prefixForClass('totally-made-up-class')).toBe('');
    expect(prefixForClass('')).toBe('');
  });

  it('isolates variant-prefixed classes into their own group', () => {
    // hover:bg-red-500 must not conflict-replace bg-red-500.
    expect(prefixForClass('hover:bg-red-500')).not.toBe('background-color');
    expect(prefixForClass('hover:bg-red-500').startsWith('variant:')).toBe(true);
  });
});

describe('swapClass', () => {
  it('replaces the conflicting class in place', () => {
    expect(swapClass('bg-red-500 text-white p-4', 'bg-blue-500')).toBe(
      'bg-blue-500 text-white p-4',
    );
  });

  it('appends when no class in the same group exists', () => {
    // font-bold is font-weight; bg-white is background-color — no conflict.
    expect(swapClass('font-bold', 'bg-white')).toBe('font-bold bg-white');
  });

  it('replaces text-* size class without disturbing colour or alignment siblings', () => {
    expect(swapClass('p-4 text-sm text-white text-center', 'text-lg')).toBe(
      'p-4 text-lg text-white text-center',
    );
  });

  it('preserves an empty class string by simply inserting the new class', () => {
    expect(swapClass('', 'bg-blue-500')).toBe('bg-blue-500');
  });

  it('does not duplicate an unknown class on a no-op swap', () => {
    // Unknown class → append-only path; calling twice should still be
    // idempotent w.r.t. duplicates.
    expect(swapClass('totally-made-up', 'totally-made-up')).toBe('totally-made-up');
  });
});

describe('cssPropertyToStyleKey', () => {
  it('camel-cases a kebab CSS property', () => {
    expect(cssPropertyToStyleKey('background-color')).toBe('backgroundColor');
  });

  it('passes single-word property through unchanged', () => {
    expect(cssPropertyToStyleKey('color')).toBe('color');
  });

  it('handles a vendor-prefixed property by stripping the leading hyphen', () => {
    // Note: the doc-comment in tailwindMap.ts aspires to "WebkitTransform"
    // (capital W), but the actual implementation strips the leading `-`
    // and then runs the kebab→camel regex over the remainder. That keeps
    // the first letter lower-case. We test the real behaviour — if the
    // implementation tightens the contract later, this test changes too.
    expect(cssPropertyToStyleKey('-webkit-transform')).toBe('webkitTransform');
  });

  it('camel-cases font-size', () => {
    expect(cssPropertyToStyleKey('font-size')).toBe('fontSize');
  });

  it('returns empty string for empty input', () => {
    expect(cssPropertyToStyleKey('')).toBe('');
  });
});
