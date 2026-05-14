import { describe, expect, it } from 'vitest';

import {
  buildAppPlanPrompt,
  parseAppPlanResponse,
} from '@main/services/design/AppPlanner';
import type {
  ProjectDesignProfile,
  ProjectDesignTokens,
} from '@shared/design';

// Build a minimal but valid ProjectDesignProfile for tests that need
// project context. Most fields are optional; the prompt builder only
// reads `summary`, `componentLibraries`, and friends.
function makeProfile(overrides: Partial<ProjectDesignProfile> = {}): ProjectDesignProfile {
  return {
    projectPath: '/proj',
    framework: 'next',
    styling: 'tailwind',
    packageManager: 'pnpm',
    typescript: true,
    componentLibraries: ['shadcn', 'radix'],
    summary: 'Next.js + Tailwind + shadcn components.',
    evidence: ['package.json', 'tailwind.config.ts'],
    builtAt: 0,
    ...overrides,
  };
}

const AVAILABLE_SKILLS = [
  'dashboard',
  'landing',
  'app-shell',
  'checkout',
  'pricing',
  'settings',
  'profile',
  'login',
  'signup',
  'product-detail',
];

// ─── buildAppPlanPrompt ─────────────────────────────────────────────────────

describe('buildAppPlanPrompt', () => {
  it('includes the brief verbatim', () => {
    const brief = 'Stock management app for a small warehouse team.';
    const out = buildAppPlanPrompt(brief, null);
    expect(out).toContain(brief);
  });

  it('respects maxScreens cap when provided', () => {
    const out = buildAppPlanPrompt('brief', null, 5);
    // Output rules section says "Plan {MIN}-{cap} screens"
    expect(out).toMatch(/Plan\s+4-5\s+screens/);
  });

  it('emits explicit JSON-only instruction', () => {
    const out = buildAppPlanPrompt('brief', null);
    expect(out.toLowerCase()).toContain('exactly one fenced code block');
    expect(out).toContain('json');
    expect(out.toLowerCase()).toContain('no prose');
  });

  it('includes project profile context when provided (framework, styling, libraries)', () => {
    const profile = makeProfile({
      summary:
        'Framework: next (App Router)\nStyling: tailwind\nComponent libraries: shadcn, radix',
    });
    const out = buildAppPlanPrompt('brief', profile);
    expect(out).toContain('Project Context');
    expect(out).toContain('next');
    expect(out).toContain('tailwind');
    expect(out).toContain('shadcn');
  });

  it('injects locked project tokens when present (vibe + colors mention)', () => {
    const tokens: ProjectDesignTokens = {
      colors: ['#4c8dff', 'accent: #ff6b6b'],
      fonts: ['Inter'],
      vibe: 'clean modern dashboard, deep navy',
      lockedAt: Date.now(),
    };
    const out = buildAppPlanPrompt('brief', null, undefined, tokens);
    expect(out).toContain('Project Tokens');
    expect(out).toContain('#4c8dff');
    expect(out).toContain('Inter');
    expect(out).toContain('clean modern dashboard');
  });

  it('does NOT inject project tokens when not lockedAt', () => {
    const tokens: ProjectDesignTokens = {
      colors: ['#abcdef'],
      fonts: ['Inter'],
      vibe: 'playful',
      // No lockedAt — advisory only.
    };
    const out = buildAppPlanPrompt('brief', null, undefined, tokens);
    expect(out).not.toContain('Project Tokens');
    expect(out).not.toContain('#abcdef');
  });

  it('caps brief at 8KB before composing', () => {
    const huge = 'x'.repeat(9 * 1024);
    const out = buildAppPlanPrompt(huge, null);
    // The full 9KB string must NOT appear verbatim.
    expect(out).not.toContain(huge);
    // But a sizeable prefix should — the cap is at 8KB so 7KB should fit.
    expect(out).toContain('x'.repeat(7 * 1024));
  });

  it('lists JSON schema with screen.skillSlug field so Claude picks valid ones', () => {
    const out = buildAppPlanPrompt('brief', null);
    // The schema section must reference skillSlug (it's how Claude knows
    // to emit one) and give an example value the parser can map.
    expect(out).toContain('skillSlug');
  });
});

// ─── parseAppPlanResponse ───────────────────────────────────────────────────

describe('parseAppPlanResponse', () => {
  it('parses a clean ```json block successfully', () => {
    const raw =
      'Here is the plan:\n\n```json\n' +
      JSON.stringify({
        name: 'Stock Manager',
        theme: { colors: ['#112233'], fonts: ['Inter'], vibe: 'clean' },
        screens: [
          { name: 'Dashboard', pageName: 'Dashboard', brief: 'Top-level overview', skillSlug: 'dashboard' },
        ],
      }) +
      '\n```';
    const result = parseAppPlanResponse(raw, AVAILABLE_SKILLS);
    expect('plan' in result).toBe(true);
    if ('plan' in result) {
      expect(result.plan.name).toBe('Stock Manager');
      expect(result.plan.screens).toHaveLength(1);
      expect(result.plan.theme.colors).toContain('#112233');
    }
  });

  it('parses the LAST ```json block when multiple are present', () => {
    const first = JSON.stringify({
      name: 'WRONG',
      theme: { colors: [], fonts: [], vibe: '' },
      screens: [{ name: 'X', pageName: 'X', brief: 'b', skillSlug: 'dashboard' }],
    });
    const last = JSON.stringify({
      name: 'RIGHT',
      theme: { colors: ['#abcdef'], fonts: [], vibe: 'v' },
      screens: [{ name: 'Y', pageName: 'Y', brief: 'b', skillSlug: 'dashboard' }],
    });
    const raw = '```json\n' + first + '\n```\n\nrethink:\n\n```json\n' + last + '\n```';
    const result = parseAppPlanResponse(raw, AVAILABLE_SKILLS);
    expect('plan' in result).toBe(true);
    if ('plan' in result) expect(result.plan.name).toBe('RIGHT');
  });

  it('returns error on empty input', () => {
    const result = parseAppPlanResponse('   ', AVAILABLE_SKILLS);
    expect('error' in result).toBe(true);
  });

  it('returns error when JSON is malformed', () => {
    const raw = '```json\n{not json,,,}\n```';
    const result = parseAppPlanResponse(raw, AVAILABLE_SKILLS);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error.toLowerCase()).toContain('json');
  });

  it('returns error when required name field missing', () => {
    const raw =
      '```json\n' +
      JSON.stringify({
        theme: { colors: [], fonts: [], vibe: '' },
        screens: [{ name: 'A', pageName: 'A', brief: 'b', skillSlug: 'dashboard' }],
      }) +
      '\n```';
    const result = parseAppPlanResponse(raw, AVAILABLE_SKILLS);
    expect('error' in result).toBe(true);
  });

  it('returns error when screens array is empty', () => {
    const raw =
      '```json\n' +
      JSON.stringify({
        name: 'Empty Plan',
        theme: { colors: [], fonts: [], vibe: '' },
        screens: [],
      }) +
      '\n```';
    const result = parseAppPlanResponse(raw, AVAILABLE_SKILLS);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error.toLowerCase()).toContain('screen');
  });

  it('assigns crypto.randomUUID() to each PlannedScreen.id', () => {
    const raw =
      '```json\n' +
      JSON.stringify({
        name: 'A',
        theme: { colors: [], fonts: [], vibe: '' },
        screens: [
          { name: 'S1', pageName: 'S1', brief: 'b', skillSlug: 'dashboard' },
          { name: 'S2', pageName: 'S2', brief: 'b', skillSlug: 'landing' },
        ],
      }) +
      '\n```';
    const result = parseAppPlanResponse(raw, AVAILABLE_SKILLS);
    expect('plan' in result).toBe(true);
    if ('plan' in result) {
      const ids = result.plan.screens.map((s) => s.id);
      // RFC 4122 UUID shape (any version).
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      expect(uuidRe.test(ids[0]!)).toBe(true);
      expect(uuidRe.test(ids[1]!)).toBe(true);
      expect(ids[0]).not.toBe(ids[1]);
    }
  });

  it('sanitizes theme.colors: drops javascript:/url()/expression() entries', () => {
    const raw =
      '```json\n' +
      JSON.stringify({
        name: 'A',
        theme: {
          colors: [
            'javascript:alert(1)',
            'url(http://evil)',
            'expression(alert(1))',
            '#abcdef',
          ],
          fonts: [],
          vibe: '',
        },
        screens: [{ name: 'S1', pageName: 'S1', brief: 'b', skillSlug: 'dashboard' }],
      }) +
      '\n```';
    const result = parseAppPlanResponse(raw, AVAILABLE_SKILLS);
    expect('plan' in result).toBe(true);
    if ('plan' in result) {
      expect(result.plan.theme.colors).not.toContain('javascript:alert(1)');
      expect(result.plan.theme.colors.find((c) => c.includes('url('))).toBeUndefined();
      expect(result.plan.theme.colors.find((c) => c.includes('expression('))).toBeUndefined();
      // Valid entry survived.
      expect(result.plan.theme.colors).toContain('#abcdef');
    }
  });

  it('keeps valid colors (#fff, #ffffff, #ffffffcc, named, rgb/rgba/hsl)', () => {
    const validColors = [
      '#fff',
      '#ffffff',
      '#ffffffcc',
      'red',
      'rgb(0,0,0)',
      'rgba(0,0,0,0.5)',
      'hsl(0,0%,0%)',
    ];
    const raw =
      '```json\n' +
      JSON.stringify({
        name: 'A',
        theme: { colors: validColors, fonts: [], vibe: '' },
        screens: [{ name: 'S1', pageName: 'S1', brief: 'b', skillSlug: 'dashboard' }],
      }) +
      '\n```';
    const result = parseAppPlanResponse(raw, AVAILABLE_SKILLS);
    expect('plan' in result).toBe(true);
    if ('plan' in result) {
      for (const c of validColors) {
        expect(result.plan.theme.colors).toContain(c);
      }
    }
  });

  it('sanitizes theme.fonts: drops entries containing url() or invalid characters', () => {
    const raw =
      '```json\n' +
      JSON.stringify({
        name: 'A',
        theme: {
          colors: [],
          fonts: ['url(http://evil/font.woff2)', 'Inter; danger;', 'Inter'],
          vibe: '',
        },
        screens: [{ name: 'S1', pageName: 'S1', brief: 'b', skillSlug: 'dashboard' }],
      }) +
      '\n```';
    const result = parseAppPlanResponse(raw, AVAILABLE_SKILLS);
    expect('plan' in result).toBe(true);
    if ('plan' in result) {
      expect(result.plan.theme.fonts.find((f) => f.includes('url('))).toBeUndefined();
      expect(result.plan.theme.fonts.find((f) => f.includes(';'))).toBeUndefined();
      expect(result.plan.theme.fonts).toContain('Inter');
    }
  });

  it('caps colors at 8 entries silently (prefers first 8)', () => {
    const colors = Array.from({ length: 12 }, (_, i) =>
      // generate distinct valid hex colors
      '#' + (i + 16).toString(16).padStart(2, '0').repeat(3),
    );
    const raw =
      '```json\n' +
      JSON.stringify({
        name: 'A',
        theme: { colors, fonts: [], vibe: '' },
        screens: [{ name: 'S1', pageName: 'S1', brief: 'b', skillSlug: 'dashboard' }],
      }) +
      '\n```';
    const result = parseAppPlanResponse(raw, AVAILABLE_SKILLS);
    expect('plan' in result).toBe(true);
    if ('plan' in result) {
      expect(result.plan.theme.colors).toHaveLength(8);
      // First 8 should be retained in order.
      expect(result.plan.theme.colors).toEqual(colors.slice(0, 8));
    }
  });

  it('caps fonts at 4 entries silently', () => {
    const fonts = ['Inter', 'JetBrains Mono', 'Roboto', 'Poppins', 'Lato', 'Nunito'];
    const raw =
      '```json\n' +
      JSON.stringify({
        name: 'A',
        theme: { colors: [], fonts, vibe: '' },
        screens: [{ name: 'S1', pageName: 'S1', brief: 'b', skillSlug: 'dashboard' }],
      }) +
      '\n```';
    const result = parseAppPlanResponse(raw, AVAILABLE_SKILLS);
    expect('plan' in result).toBe(true);
    if ('plan' in result) {
      expect(result.plan.theme.fonts).toHaveLength(4);
      expect(result.plan.theme.fonts).toEqual(fonts.slice(0, 4));
    }
  });

  it('caps screens at 12 entries silently', () => {
    const screens = Array.from({ length: 20 }, (_, i) => ({
      name: `Screen ${i}`,
      pageName: `Page${i}`,
      brief: `brief ${i}`,
      skillSlug: 'dashboard',
    }));
    const raw =
      '```json\n' +
      JSON.stringify({
        name: 'A',
        theme: { colors: [], fonts: [], vibe: '' },
        screens,
      }) +
      '\n```';
    const result = parseAppPlanResponse(raw, AVAILABLE_SKILLS);
    expect('plan' in result).toBe(true);
    if ('plan' in result) {
      expect(result.plan.screens).toHaveLength(12);
    }
  });

  it('maps screen.skillSlug to nearest available slug via heuristic when unknown', () => {
    // "stock-dashboard" isn't in the available list, but "dashboard" is —
    // the heuristic on the slug-itself should pick "dashboard".
    const raw =
      '```json\n' +
      JSON.stringify({
        name: 'A',
        theme: { colors: [], fonts: [], vibe: '' },
        screens: [
          { name: 'Sales', pageName: 'Sales', brief: 'sales overview', skillSlug: 'stock-dashboard' },
        ],
      }) +
      '\n```';
    const result = parseAppPlanResponse(raw, AVAILABLE_SKILLS);
    expect('plan' in result).toBe(true);
    if ('plan' in result) {
      expect(result.plan.screens[0]!.skillSlug).toBe('dashboard');
    }
  });

  it('falls back to first available skill when even the heuristic finds nothing', () => {
    // No heuristic match for slug or brief, no preferred skill in the
    // available list — must still produce a usable plan.
    const skills = ['custom-only-skill'];
    const raw =
      '```json\n' +
      JSON.stringify({
        name: 'A',
        theme: { colors: [], fonts: [], vibe: '' },
        screens: [
          { name: 'Foo', pageName: 'Foo', brief: 'something obscure', skillSlug: 'made-up' },
        ],
      }) +
      '\n```';
    const result = parseAppPlanResponse(raw, skills);
    expect('plan' in result).toBe(true);
    if ('plan' in result) {
      expect(result.plan.screens[0]!.skillSlug).toBe('custom-only-skill');
    }
  });

  it("sets each PlannedScreen.status='pending'", () => {
    const raw =
      '```json\n' +
      JSON.stringify({
        name: 'A',
        theme: { colors: [], fonts: [], vibe: '' },
        screens: [
          { name: 'S1', pageName: 'S1', brief: 'b', skillSlug: 'dashboard' },
          { name: 'S2', pageName: 'S2', brief: 'b', skillSlug: 'landing' },
        ],
      }) +
      '\n```';
    const result = parseAppPlanResponse(raw, AVAILABLE_SKILLS);
    expect('plan' in result).toBe(true);
    if ('plan' in result) {
      for (const s of result.plan.screens) {
        expect(s.status).toBe('pending');
      }
    }
  });

  it('preserves screen pageName, brief, name fields verbatim (within reason — caps brief)', () => {
    const longBrief = 'b'.repeat(5000);
    const raw =
      '```json\n' +
      JSON.stringify({
        name: 'A',
        theme: { colors: [], fonts: [], vibe: '' },
        screens: [
          {
            name: 'Customer Dashboard',
            pageName: 'CustomerDashboard',
            brief: longBrief,
            skillSlug: 'dashboard',
          },
        ],
      }) +
      '\n```';
    const result = parseAppPlanResponse(raw, AVAILABLE_SKILLS);
    expect('plan' in result).toBe(true);
    if ('plan' in result) {
      const screen = result.plan.screens[0]!;
      expect(screen.name).toBe('Customer Dashboard');
      expect(screen.pageName).toBe('CustomerDashboard');
      // Per-screen brief cap is well under 4KB (the module uses 600);
      // here we just assert it was capped (i.e. shorter than input).
      expect(screen.brief.length).toBeLessThan(longBrief.length);
      expect(screen.brief.length).toBeLessThanOrEqual(4096);
    }
  });

  // v0.15.0 SEC-MED-3 regression: parser must reject runaway inputs to
  // defend against a hostile / runaway planner emitting megabytes of
  // nested JSON. Hard cap on raw input + on the picked candidate body.
  it('returns an error when picked JSON candidate exceeds the size cap', () => {
    // Candidate larger than 64 KB inside a fenced block.
    const huge = '"x":"' + 'a'.repeat(70 * 1024) + '"';
    const raw = '```json\n{"name":"X",' + huge + ',"theme":{},"screens":[]}\n```';
    const result = parseAppPlanResponse(raw, ['dashboard']);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toMatch(/size cap|exceeds/i);
    }
  });
});
