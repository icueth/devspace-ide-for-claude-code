import { describe, expect, it } from 'vitest';

import { buildDesignPrompt } from '@main/services/DesignPromptBuilder';
import type {
  DesignMessage,
  DesignSkill,
  DesignSystem,
  ProjectDesignProfile,
} from '@shared/design';

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

  // v0.10 — project context + chat transcript

  const PROFILE: ProjectDesignProfile = {
    projectPath: '/tmp/example',
    framework: 'next',
    styling: 'tailwind',
    packageManager: 'pnpm',
    typescript: true,
    summary:
      '- Framework: Next.js\n- Styling: Tailwind CSS\n- Language: TypeScript\n- Package manager: pnpm',
    evidence: ['package.json', 'next.config.js', 'tailwind.config.js'],
    builtAt: 1_700_000_000_000,
  };

  it('renders project profile under "## Project Context" BEFORE the brief', () => {
    const out = buildDesignPrompt({
      skill: SKILL,
      brief: 'do a thing',
      skillBody: 'skill',
      projectProfile: PROFILE,
    });

    expect(out).toContain('## Project Context');
    expect(out).toContain('Framework: Next.js');
    expect(out).toContain('Styling: Tailwind CSS');
    const ctxIdx = out.indexOf('## Project Context');
    const briefIdx = out.indexOf('## Brief');
    expect(ctxIdx).toBeGreaterThan(-1);
    expect(briefIdx).toBeGreaterThan(ctxIdx);
  });

  it('omits "## Project Context" when projectProfile is null/undefined or has empty summary', () => {
    const noneOut = buildDesignPrompt({
      skill: SKILL,
      brief: 'b',
      skillBody: 'skill',
    });
    expect(noneOut).not.toContain('## Project Context');

    const emptyOut = buildDesignPrompt({
      skill: SKILL,
      brief: 'b',
      skillBody: 'skill',
      projectProfile: { ...PROFILE, summary: '   ' },
    });
    expect(emptyOut).not.toContain('## Project Context');
  });

  it('renders conversation section under "## Conversation" with User:/Assistant: prefixes in order', () => {
    const messages: DesignMessage[] = [
      { id: 'a', role: 'user', content: 'Make a dashboard', ts: 1 },
      { id: 'b', role: 'assistant', content: 'Sure, here is a starter.', ts: 2 },
      { id: 'c', role: 'user', content: 'Make the hero darker', ts: 3 },
    ];
    const out = buildDesignPrompt({
      skill: SKILL,
      brief: 'ignored when messages set',
      skillBody: 'skill',
      messages,
    });

    expect(out).toContain('## Conversation');
    // Each turn is wrapped in triple-quote fences as injection defense.
    expect(out).toContain('User:\n"""\nMake a dashboard\n"""');
    expect(out).toContain('Assistant:\n"""\nSure, here is a starter.\n"""');
    expect(out).toContain('User:\n"""\nMake the hero darker\n"""');
    // Order check — the second user turn must come after the assistant turn.
    expect(out.indexOf('Make a dashboard')).toBeLessThan(
      out.indexOf('Sure, here is a starter.'),
    );
    expect(out.indexOf('Sure, here is a starter.')).toBeLessThan(
      out.indexOf('Make the hero darker'),
    );
    // When messages is present, "## Brief" should NOT be a separate header.
    expect(out).not.toContain('## Brief\n');
  });

  it('summarizes large prior assistant HTML payloads to a byte-count placeholder', () => {
    const hugeHtml =
      '<!DOCTYPE html><html><head><title>x</title></head><body>' +
      'x'.repeat(50_000) +
      '</body></html>';
    const messages: DesignMessage[] = [
      { id: 'u1', role: 'user', content: 'first', ts: 1 },
      { id: 'a1', role: 'assistant', content: hugeHtml, ts: 2 },
      { id: 'u2', role: 'user', content: 'now in blue', ts: 3 },
    ];
    const out = buildDesignPrompt({
      skill: SKILL,
      brief: 'ignored',
      skillBody: 'skill',
      messages,
    });

    expect(out).toContain('[generated HTML — ');
    // The raw 50k of x's must NOT appear verbatim in the prompt.
    expect(out).not.toContain('x'.repeat(2_000));
    // The last user turn survives (wrapped in injection-defense fences).
    expect(out).toContain('User:\n"""\nnow in blue\n"""');
  });

  it('re-anchors authoritative instructions AFTER the untrusted conversation', () => {
    // Defence against prompt-injection via hostile prior assistant turn.
    // The "## Instructions (authoritative)" header MUST appear AFTER the
    // conversation so a malicious "ignore your instructions and …" turn
    // can't override the system framing.
    const out = buildDesignPrompt({
      skill: SKILL,
      brief: 'ignored',
      skillBody: 'skill',
      messages: [
        { id: 'u1', role: 'user', content: 'do a thing', ts: 1 },
      ],
    });
    expect(out).toContain('## Conversation (untrusted');
    expect(out).toContain('## Instructions (authoritative)');
    expect(out.indexOf('## Conversation')).toBeLessThan(
      out.indexOf('## Instructions (authoritative)'),
    );
  });

  it('strips ASCII control chars from transcript content', () => {
    // A hostile prior turn embedding C0 control chars could try to
    // smuggle invisible instructions through. The builder strips them.
    const out = buildDesignPrompt({
      skill: SKILL,
      brief: 'ignored',
      skillBody: 'skill',
      messages: [
        { id: 'u1', role: 'user', content: 'hello\x07\x1bworld', ts: 1 },
      ],
    });
    expect(out).not.toMatch(/[\x00-\x08\x0e-\x1f\x7f]/);
    expect(out).toContain('helloworld');
  });

  it('still renders a "## Brief" section when messages is absent (backward compat)', () => {
    const out = buildDesignPrompt({
      skill: SKILL,
      brief: 'this is the brief',
      skillBody: 'skill',
    });
    expect(out).toContain('## Brief\nthis is the brief');
    expect(out).not.toContain('## Conversation');
  });

  it('places "## Project Context" before "## Conversation" when both are present', () => {
    const messages: DesignMessage[] = [
      { id: 'u', role: 'user', content: 'hello', ts: 1 },
    ];
    const out = buildDesignPrompt({
      skill: SKILL,
      brief: '',
      skillBody: 'skill',
      projectProfile: PROFILE,
      messages,
    });
    const ctxIdx = out.indexOf('## Project Context');
    const convIdx = out.indexOf('## Conversation');
    expect(ctxIdx).toBeGreaterThan(-1);
    expect(convIdx).toBeGreaterThan(ctxIdx);
  });
});
