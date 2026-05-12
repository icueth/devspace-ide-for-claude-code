// DesignPromptBuilder — pure prompt-composition layer for the Design
// Studio (Phase A). Takes a chosen skill + optional design system + the
// user's natural-language brief and produces the single text blob that
// gets piped to `claude --print --output-format text`.
//
// This module is intentionally side-effect-free: the caller reads
// SKILL.md and DESIGN.md from disk and hands the bodies in. That keeps
// the composer trivially unit-testable and lets DesignGenerator decide
// when to read (and how to handle missing files / permissions).
//
// Pattern adapted from open-design's `apps/daemon/src/agents.ts` prompt
// composer (Apache-2.0). We strip frontmatter, hard-cap each body so a
// pathological skill file can't blow past Claude's context, and pin the
// output instructions to the tail so the model always sees them last.

import type { DesignSkill, DesignSystem } from '@shared/design';

export interface BuildPromptInput {
  skill: DesignSkill;
  designSystem?: DesignSystem;
  brief: string;
  // Pre-read SKILL.md body. Caller is responsible for `fs.readFile`.
  skillBody: string;
  // Pre-read DESIGN.md body. Required when designSystem is set; ignored
  // otherwise so callers can safely pass `undefined`.
  designSystemBody?: string;
}

// Hard cap on individual skill / design-system body length. Skills are
// usually 1-3 KB but a brand spec with embedded color tokens + type
// scales can easily run long; 12 KB leaves plenty of room for both
// plus the user's brief while staying well under Claude's context.
const BODY_CHAR_LIMIT = 12_000;
const TRUNCATION_MARKER = '\n…[truncated]';

const SYSTEM_FRAMING =
  'You are an expert frontend designer. You generate complete, production-ready HTML files.';

const OUTPUT_INSTRUCTIONS = [
  'Generate a complete, self-contained `index.html` file.',
  'Output ONLY the HTML — no explanation, no markdown fences.',
  'Inline all CSS in a `<style>` block. Use no external scripts.',
  'Allow only Google Fonts for typography.',
  'Make it responsive and accessible.',
].join(' ');

export function buildDesignPrompt(input: BuildPromptInput): string {
  const skillBody = prepareBody(input.skillBody);
  const sections: string[] = [SYSTEM_FRAMING];

  sections.push(`## Skill: ${input.skill.name}\n${skillBody}`);

  if (input.designSystem) {
    const dsBody = prepareBody(input.designSystemBody ?? '');
    sections.push(`## Design System: ${input.designSystem.name}\n${dsBody}`);
  }

  // Brief is rendered verbatim (after trim) — no transformation, no
  // censorship. The model needs the user's words exactly as written.
  sections.push(`## Brief\n${input.brief.trim()}`);

  sections.push(`## Output\n${OUTPUT_INSTRUCTIONS}`);

  return sections.join('\n\n');
}

// Strip frontmatter, trim outer whitespace, hard-cap length. Pure.
function prepareBody(raw: string): string {
  const stripped = stripFrontmatter(raw).trim();
  if (stripped.length <= BODY_CHAR_LIMIT) return stripped;
  // Leave room for the marker so the total never exceeds the cap.
  const sliceLen = BODY_CHAR_LIMIT - TRUNCATION_MARKER.length;
  return stripped.slice(0, sliceLen) + TRUNCATION_MARKER;
}

// Matches the same `---\n...\n---\n?` shape parseFrontmatter accepts in
// the open-design daemon — leading BOM tolerated, CRLF tolerated. If no
// frontmatter is present, returns the input unchanged.
function stripFrontmatter(src: string): string {
  if (!src) return '';
  const text = src.replace(/^﻿/, '');
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return match ? text.slice(match[0].length) : text;
}
