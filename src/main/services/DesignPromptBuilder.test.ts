import { describe, expect, it } from 'vitest';

import { buildDesignPrompt } from '@main/services/DesignPromptBuilder';
import type { DesignSkill, DesignSystem } from '@shared/design';

const SKILL: DesignSkill = {
  slug: 'dashboard',
  name: 'Dashboard',
  description: 'An analytics dashboard',
  scope: 'builtin',
  path: '/skills/dashboard/SKILL.md',
  category: 'internal-tool',
};

const DESIGN_SYSTEM: DesignSystem = {
  slug: 'apple',
  name: 'Apple',
  description: 'Apple brand',
  scope: 'builtin',
  path: '/design-systems/apple/DESIGN.md',
  brand: 'Apple',
};

describe('buildDesignPrompt', () => {
  it('renders the skill body in the output under a skill header', () => {
    const out = buildDesignPrompt({
      skill: SKILL,
      brief: 'do a thing',
      skillBody: 'Use a sidebar nav and a header KPI row.',
    });

    expect(out).toContain('## Skill: Dashboard');
    expect(out).toContain('Use a sidebar nav and a header KPI row.');
  });

  it('renders the design system body when provided', () => {
    const out = buildDesignPrompt({
      skill: SKILL,
      designSystem: DESIGN_SYSTEM,
      brief: 'b',
      skillBody: 'skill content',
      designSystemBody: 'use SF Pro and #007aff accents',
    });

    expect(out).toContain('## Design System: Apple');
    expect(out).toContain('use SF Pro and #007aff accents');
  });

  it('omits the design system section when designSystem is undefined', () => {
    const out = buildDesignPrompt({
      skill: SKILL,
      brief: 'b',
      skillBody: 'skill content',
      designSystemBody: 'should-not-leak',
    });

    expect(out).not.toContain('## Design System');
    expect(out).not.toContain('should-not-leak');
  });

  it('strips frontmatter from skillBody and designSystemBody', () => {
    const skillBody = [
      '---',
      'name: dashboard',
      'description: |',
      '  An analytics dashboard',
      'triggers:',
      '  - "dashboard"',
      '---',
      'BODY-START-SKILL',
      'Content after frontmatter.',
    ].join('\n');

    const dsBody = [
      '---',
      'name: apple',
      'brand: Apple',
      '---',
      'BODY-START-DS',
      'Brand tokens go here.',
    ].join('\n');

    const out = buildDesignPrompt({
      skill: SKILL,
      designSystem: DESIGN_SYSTEM,
      brief: 'b',
      skillBody,
      designSystemBody: dsBody,
    });

    expect(out).toContain('BODY-START-SKILL');
    expect(out).toContain('BODY-START-DS');
    // Frontmatter keys must not survive into the prompt.
    expect(out).not.toContain('name: dashboard');
    expect(out).not.toContain('triggers:');
    expect(out).not.toContain('brand: Apple');
  });

  it('truncates oversized bodies with the truncation marker', () => {
    const huge = 'x'.repeat(20_000);
    const out = buildDesignPrompt({
      skill: SKILL,
      brief: 'b',
      skillBody: huge,
    });

    expect(out).toContain('…[truncated]');
    // The "x" run cannot survive in full — the cap is 12k chars total.
    expect(out).not.toContain('x'.repeat(20_000));
    // But the leading run must still be there (truncation, not removal).
    expect(out).toContain('x'.repeat(1000));
  });

  it('trims leading and trailing whitespace from skill / design-system bodies', () => {
    const out = buildDesignPrompt({
      skill: SKILL,
      designSystem: DESIGN_SYSTEM,
      brief: 'b',
      skillBody: '\n\n   real skill text   \n\n',
      designSystemBody: '\n\n   real ds text   \n\n',
    });

    // The body must appear directly after the section header newline,
    // not with extra blank lines or trailing whitespace.
    expect(out).toContain('## Skill: Dashboard\nreal skill text');
    expect(out).toContain('## Design System: Apple\nreal ds text');
    expect(out).not.toContain('real skill text   ');
    expect(out).not.toContain('real ds text   ');
  });

  it('includes the user brief verbatim with no transformation', () => {
    const brief =
      'Build me a landing page for an AI-powered dog walking startup called Pawsome. Tagline: "Walkies, reimagined."';
    const out = buildDesignPrompt({
      skill: SKILL,
      brief,
      skillBody: 'skill',
    });

    expect(out).toContain('## Brief');
    expect(out).toContain(brief);
  });

  it('always emits the output instructions as the last section', () => {
    const out = buildDesignPrompt({
      skill: SKILL,
      designSystem: DESIGN_SYSTEM,
      brief: 'a brief',
      skillBody: 'skill',
      designSystemBody: 'ds',
    });

    const outputIdx = out.indexOf('## Output');
    expect(outputIdx).toBeGreaterThan(-1);
    // No other "## " section header appears after the output section.
    const afterOutput = out.slice(outputIdx + 1);
    expect(afterOutput.includes('\n## ')).toBe(false);
    // And the closing instructions string is present.
    expect(out).toContain('Output ONLY the HTML');
  });

  it('permits an empty brief and still renders skill + output sections', () => {
    const out = buildDesignPrompt({
      skill: SKILL,
      brief: '',
      skillBody: 'skill content here',
    });

    expect(out).toContain('## Skill: Dashboard');
    expect(out).toContain('skill content here');
    expect(out).toContain('## Brief\n'); // header present, body empty after trim
    expect(out).toContain('## Output');
  });

  it('preserves multi-line briefs (line breaks inside the brief are kept)', () => {
    const brief = 'Line one.\nLine two.\nLine three.';
    const out = buildDesignPrompt({
      skill: SKILL,
      brief,
      skillBody: 'skill',
    });

    expect(out).toContain('Line one.\nLine two.\nLine three.');
  });

  it('separates major sections with a blank line (\\n\\n)', () => {
    const out = buildDesignPrompt({
      skill: SKILL,
      designSystem: DESIGN_SYSTEM,
      brief: 'b',
      skillBody: 'skill',
      designSystemBody: 'ds',
    });

    // Section boundary delimiter — adjacent headers must be separated
    // by a blank line, not glued together.
    expect(out).toMatch(/skill\n\n## Design System: Apple/);
    expect(out).toMatch(/ds\n\n## Brief/);
    expect(out).toMatch(/## Brief\nb\n\n## Output/);
  });

  it('starts with the system framing line', () => {
    const out = buildDesignPrompt({
      skill: SKILL,
      brief: 'b',
      skillBody: 'skill',
    });

    expect(out.startsWith('You are an expert frontend designer.')).toBe(true);
  });
});
