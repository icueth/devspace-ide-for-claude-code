import { describe, expect, it } from 'vitest';

import {
  extractTokensFromHtml,
  validateAndSanitizeTokens,
} from '@main/services/design/ProjectTokens';
import type { ProjectDesignTokens } from '@shared/design';

// ─── validateAndSanitizeTokens ──────────────────────────────────────────────

describe('validateAndSanitizeTokens', () => {
  it('returns null on null input', () => {
    expect(validateAndSanitizeTokens(null)).toBeNull();
  });

  it('returns null when all fields are empty', () => {
    const empty: ProjectDesignTokens = { colors: [], fonts: [], vibe: '' };
    expect(validateAndSanitizeTokens(empty)).toBeNull();
  });

  it('drops colors with url(), expression(), javascript:', () => {
    const input: ProjectDesignTokens = {
      colors: [
        'url(http://evil)',
        'expression(alert(1))',
        'javascript:alert(1)',
        '#abcdef',
      ],
      fonts: [],
      vibe: '',
    };
    const out = validateAndSanitizeTokens(input);
    expect(out).not.toBeNull();
    if (out) {
      // Hostile entries dropped (they get stripped to empty/invalid then
      // filtered by the allowlist).
      expect(out.colors.find((c) => c.includes('url('))).toBeUndefined();
      expect(out.colors.find((c) => c.includes('expression('))).toBeUndefined();
      expect(out.colors.find((c) => c.includes('javascript:'))).toBeUndefined();
      // Valid hex survived.
      expect(out.colors).toContain('#abcdef');
    }
  });

  it('drops on*= prefixed entries (defense in depth)', () => {
    const input: ProjectDesignTokens = {
      // Naughty event-handler-style entries should be wiped by the
      // hostile-pattern stripper before allowlist evaluation, leaving
      // nothing valid behind.
      colors: ['onclick=alert(1)', 'onload=stuff', '#fff'],
      fonts: [],
      vibe: '',
    };
    const out = validateAndSanitizeTokens(input);
    expect(out).not.toBeNull();
    if (out) {
      expect(out.colors.find((c) => c.includes('onclick='))).toBeUndefined();
      expect(out.colors.find((c) => c.includes('onload='))).toBeUndefined();
      expect(out.colors).toContain('#fff');
    }
  });

  it('keeps valid hex / named / rgb / hsl colors', () => {
    const valid = [
      '#fff',
      '#ffffff',
      '#ffffffcc',
      'red',
      'rgb(0,0,0)',
      'rgba(0,0,0,0.5)',
      'hsl(0,0%,0%)',
    ];
    const input: ProjectDesignTokens = { colors: valid, fonts: [], vibe: '' };
    const out = validateAndSanitizeTokens(input);
    expect(out).not.toBeNull();
    if (out) {
      for (const c of valid) expect(out.colors).toContain(c);
    }
  });

  it('caps colors at 8, fonts at 4', () => {
    const colors = Array.from({ length: 12 }, (_, i) =>
      '#' + (i + 16).toString(16).padStart(2, '0').repeat(3),
    );
    const fonts = ['Inter', 'Roboto', 'Lato', 'Poppins', 'Nunito', 'Montserrat'];
    const input: ProjectDesignTokens = { colors, fonts, vibe: 'v' };
    const out = validateAndSanitizeTokens(input);
    expect(out).not.toBeNull();
    if (out) {
      expect(out.colors).toHaveLength(8);
      expect(out.fonts).toHaveLength(4);
    }
  });

  it('caps vibe at 200 chars', () => {
    const vibe = 'a'.repeat(500);
    const input: ProjectDesignTokens = { colors: ['#fff'], fonts: [], vibe };
    const out = validateAndSanitizeTokens(input);
    expect(out).not.toBeNull();
    if (out) expect(out.vibe.length).toBeLessThanOrEqual(200);
  });

  it('preserves source + lockedAt fields verbatim', () => {
    const lockedAt = 1_700_000_000_000;
    const input: ProjectDesignTokens = {
      colors: ['#abc'],
      fonts: [],
      vibe: '',
      lockedAt,
      source: { screenId: 'sid', versionId: 'vid' },
    };
    const out = validateAndSanitizeTokens(input);
    expect(out).not.toBeNull();
    if (out) {
      expect(out.lockedAt).toBe(lockedAt);
      expect(out.source).toEqual({ screenId: 'sid', versionId: 'vid' });
    }
  });
});

// ─── extractTokensFromHtml ──────────────────────────────────────────────────

describe('extractTokensFromHtml', () => {
  it('extracts CSS variable colors from <style> blocks', () => {
    const html = `
      <html><head><style>
        :root {
          --primary: #4c8dff;
          --accent: #ff6b6b;
        }
      </style></head><body>x</body></html>
    `;
    const out = extractTokensFromHtml(html);
    // ThemeExtractor lowercases hex tokens.
    expect(out.colors).toContain('#4c8dff');
    expect(out.colors).toContain('#ff6b6b');
  });

  it('extracts inline color: declarations', () => {
    const html = `
      <html><head><style>
        body { color: #112233; background-color: #abcdef; }
        .accent { color: hsl(220, 50%, 50%); }
      </style></head><body>x</body></html>
    `;
    const out = extractTokensFromHtml(html);
    expect(out.colors.length).toBeGreaterThan(0);
    expect(out.colors).toContain('#112233');
    expect(out.colors).toContain('#abcdef');
  });

  it('extracts font-family declarations', () => {
    const html = `
      <html><head><style>
        body { font-family: Inter, sans-serif; }
        h1 { font-family: "JetBrains Mono", monospace; }
      </style></head><body>x</body></html>
    `;
    const out = extractTokensFromHtml(html);
    expect(out.fonts).toContain('Inter');
    expect(out.fonts).toContain('JetBrains Mono');
  });

  it('returns empty arrays for HTML with no style content', () => {
    const html = '<html><body>just text, no styles</body></html>';
    const out = extractTokensFromHtml(html);
    expect(out.colors).toEqual([]);
    expect(out.fonts).toEqual([]);
  });

  it('returns empty arrays for empty / non-string input', () => {
    expect(extractTokensFromHtml('')).toEqual({ colors: [], fonts: [] });
    // intentionally violates the type to mirror runtime resilience
    expect(extractTokensFromHtml(undefined as unknown as string)).toEqual({
      colors: [],
      fonts: [],
    });
  });

  it('caps to 8 colors + 4 fonts', () => {
    const colorDecls = Array.from({ length: 15 }, (_, i) =>
      `--c${i}: #${(i + 16).toString(16).padStart(2, '0').repeat(3)};`,
    ).join(' ');
    const fontDecls = [
      '.a{font-family:Inter,sans-serif}',
      '.b{font-family:Roboto,sans-serif}',
      '.c{font-family:Lato,sans-serif}',
      '.d{font-family:Poppins,sans-serif}',
      '.e{font-family:Nunito,sans-serif}',
      '.f{font-family:Montserrat,sans-serif}',
      '.g{font-family:Arial,sans-serif}',
    ].join(' ');
    const html = `<html><head><style>:root{${colorDecls}} ${fontDecls}</style></head><body>x</body></html>`;
    const out = extractTokensFromHtml(html);
    expect(out.colors.length).toBeLessThanOrEqual(8);
    expect(out.fonts.length).toBeLessThanOrEqual(4);
  });
});
