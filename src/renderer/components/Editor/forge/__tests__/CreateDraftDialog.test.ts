import { describe, expect, it } from 'vitest';

import {
  BRIEF_MAX,
  validateSlug,
} from '@renderer/components/Editor/forge/CreateDraftDialog';

// CreateDraftDialog exports `validateSlug` and `BRIEF_MAX` as pure helpers
// so we can pin the validation rules without standing up a full DOM. The
// Forge service applies the same kebab-case rule on disk (≤80c, no `..`),
// so these tests double as a contract pin between renderer + main.

describe('validateSlug', () => {
  it('accepts a clean kebab-case slug', () => {
    const r = validateSlug('refactor-css');
    expect(r.ok).toBe(true);
    expect(r.cleaned).toBe('refactor-css');
    expect(r.error).toBeUndefined();
  });

  it('rejects slugs with spaces', () => {
    const r = validateSlug('refactor css');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/whitespace/i);
  });

  it('rejects uppercase letters explicitly (no auto-lowercase, surface intent)', () => {
    const r = validateSlug('RefactorCSS');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/lowercase/i);
  });

  it('rejects path traversal sequences (`..`) anywhere in the slug', () => {
    const traversal = validateSlug('../etc/passwd');
    expect(traversal.ok).toBe(false);
    expect(traversal.error).toMatch(/\.\./);

    const embedded = validateSlug('foo..bar');
    expect(embedded.ok).toBe(false);
    expect(embedded.error).toMatch(/\.\./);
  });

  it('rejects leading or trailing dashes', () => {
    expect(validateSlug('-foo').ok).toBe(false);
    expect(validateSlug('foo-').ok).toBe(false);
  });

  it('rejects the empty / whitespace-only string', () => {
    expect(validateSlug('').ok).toBe(false);
    expect(validateSlug('   ').ok).toBe(false);
  });

  it('caps slug length at 80 characters', () => {
    const tooLong = `a${'-b'.repeat(50)}`; // > 80 chars, valid charset
    const r = validateSlug(tooLong);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/80/);
  });

  it('exposes BRIEF_MAX as 4KB so the char counter and service stay in sync', () => {
    expect(BRIEF_MAX).toBe(4096);
  });
});

// Simulated submit pipeline — mirrors what the Dialog does in submit():
// trim + validate slug, then build the createDraft payload. We test the
// payload-building rules end-to-end without rendering the dialog.
describe('submit pipeline — cleaned slug + brief reach api.forge.createDraft', () => {
  function buildSubmitPayload(input: {
    projectPath: string;
    kind: 'skill' | 'agent';
    scope: 'project' | 'global';
    slug: string;
    brief: string;
  }): { ok: true; payload: typeof input } | { ok: false; reason: string } {
    const check = validateSlug(input.slug);
    if (!check.ok) return { ok: false, reason: check.error ?? 'invalid slug' };
    const brief = input.brief.trim();
    if (brief.length === 0) return { ok: false, reason: 'brief required' };
    if (brief.length > BRIEF_MAX) return { ok: false, reason: 'brief too long' };
    return {
      ok: true,
      payload: { ...input, slug: check.cleaned, brief },
    };
  }

  it('passes the cleaned (trimmed) slug + trimmed brief to createDraft', () => {
    const out = buildSubmitPayload({
      projectPath: '/tmp/p',
      kind: 'skill',
      scope: 'project',
      slug: '  refactor-css  ',
      brief: '  Refactor the CSS in src/ui  \n',
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.payload.slug).toBe('refactor-css');
      expect(out.payload.brief).toBe('Refactor the CSS in src/ui');
      expect(out.payload.kind).toBe('skill');
      expect(out.payload.scope).toBe('project');
    }
  });

  it('refuses to submit when the slug fails validation', () => {
    const out = buildSubmitPayload({
      projectPath: '/tmp/p',
      kind: 'skill',
      scope: 'project',
      slug: '../escape',
      brief: 'whatever',
    });
    expect(out.ok).toBe(false);
  });

  it('refuses to submit when brief is empty after trim', () => {
    const out = buildSubmitPayload({
      projectPath: '/tmp/p',
      kind: 'skill',
      scope: 'project',
      slug: 'valid-slug',
      brief: '   ',
    });
    expect(out.ok).toBe(false);
  });
});
