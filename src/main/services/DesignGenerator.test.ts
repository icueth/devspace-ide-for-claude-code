// Regression tests for the extractHtml helper. The biggest concern is
// S3 from the v0.13 audit: claude sometimes emits TWO HTML documents in
// one response (an example snippet inside a code fence + the real page
// outside). The v0.10 implementation merged them — first doctype to
// last `</html>` — which produced an invalid document and could mix
// scripts that weren't reviewed together.

import { describe, expect, it } from 'vitest';

import {
  buildClaudeArgs,
  extractGeneratedSegments,
  extractHtml,
} from './DesignGenerator';

describe('extractHtml', () => {
  it('returns null for empty input', () => {
    expect(extractHtml('')).toBeNull();
    expect(extractHtml('   \n   ')).toBeNull();
  });

  it('returns null when no doctype or <html> opener is present', () => {
    expect(extractHtml('Here is what I would do…\n\nNo HTML in this answer.')).toBeNull();
  });

  it('extracts a clean fenced ```html block', () => {
    const raw = [
      "Here's the page:",
      '```html',
      '<!DOCTYPE html>',
      '<html><body><h1>Hi</h1></body></html>',
      '```',
      'Let me know what you think!',
    ].join('\n');
    const out = extractHtml(raw);
    expect(out).toBe('<!DOCTYPE html>\n<html><body><h1>Hi</h1></body></html>');
  });

  it('extracts the bare doctype when no fence is used', () => {
    const raw = [
      "Sure, here you go:",
      '<!DOCTYPE html>',
      '<html><body>hi</body></html>',
      'Hope that helps.',
    ].join('\n');
    const out = extractHtml(raw);
    expect(out).toBe('<!DOCTYPE html>\n<html><body>hi</body></html>');
  });

  // S3: two-document merge regression. Old extractor would return:
  //   <!DOCTYPE html><html>SMALL</html>BIG-PROSE<!DOCTYPE html><html>BIG</html>
  // because it took FIRST doctype + LAST </html>.
  it('does not merge an example fenced doc with a separate inline doc', () => {
    const raw = [
      'Quick example of what I mean:',
      '```html',
      '<!DOCTYPE html>',
      '<html><body><h1>EX</h1></body></html>',
      '```',
      'And here is the real page:',
      '<!DOCTYPE html>',
      '<html><body><main><h1>REAL HERO</h1></main></body></html>',
    ].join('\n');
    const out = extractHtml(raw);
    // Fence preference picks the largest fence; in this case the fence
    // body is shorter than the inline doc, so the inline doc wins.
    // Either way, the result must contain only ONE complete <html>…</html>.
    expect(out).not.toBeNull();
    const matches = out!.match(/<\/html>/gi);
    expect(matches?.length ?? 0).toBe(1);
  });

  it('prefers the LAST complete fenced html block (often the real answer)', () => {
    const before = '<!DOCTYPE html><html><body>BEFORE</body></html>';
    const after = '<!DOCTYPE html><html><body>AFTER</body></html>';
    const raw = `Before example:\n\`\`\`html\n${before}\n\`\`\`\nFinal version:\n\`\`\`html\n${after}\n\`\`\``;
    const out = extractHtml(raw);
    expect(out).toContain('AFTER');
    expect(out).not.toContain('BEFORE');
  });

  it('prefers a complete fence over an incomplete (longer) one', () => {
    const partial = `<!DOCTYPE html><html><body>${'X'.repeat(2000)}<!-- truncated`;
    const complete = '<!DOCTYPE html><html><body>REAL</body></html>';
    const raw = `Partial first:\n\`\`\`html\n${partial}\n\`\`\`\nThen the complete one:\n\`\`\`html\n${complete}\n\`\`\``;
    const out = extractHtml(raw);
    expect(out).toContain('REAL');
    expect(out).not.toContain('X'.repeat(2000));
  });

  it('falls back to longest fence when no fence is complete', () => {
    const tiny = '<!DOCTYPE html><html><body>T';
    const big = `<!DOCTYPE html><html><body>${'B'.repeat(500)}`;
    const raw = `\`\`\`html\n${tiny}\n\`\`\`\n\`\`\`html\n${big}\n\`\`\``;
    const out = extractHtml(raw);
    expect(out).toContain('B'.repeat(500));
  });

  it('tolerates truncated output without a closing </html>', () => {
    const raw = "Here's the start:\n<!DOCTYPE html>\n<html><body><h1>Truncated";
    const out = extractHtml(raw);
    expect(out).toBe('<!DOCTYPE html>\n<html><body><h1>Truncated');
  });

  it('handles uppercase HTML language tag in fence', () => {
    const raw = '```HTML\n<!DOCTYPE html>\n<html></html>\n```';
    const out = extractHtml(raw);
    expect(out).toBe('<!DOCTYPE html>\n<html></html>');
  });
});

// Pins the CLI invocation shape. Direct regression for the v0.13.0 bug
// where `--permission-mode plan` made claude return a plan text instead
// of HTML in --print mode. Plan mode is interactive-only; never pass it
// here. If you need a tighter sandbox, extend `--disallowed-tools`.
describe('buildClaudeArgs', () => {
  it('uses --print + text output', () => {
    const args = buildClaudeArgs();
    expect(args).toContain('--print');
    expect(args).toContain('--output-format');
    const fmtIdx = args.indexOf('--output-format');
    expect(args[fmtIdx + 1]).toBe('text');
  });

  it('NEVER passes --permission-mode plan in --print mode', () => {
    const args = buildClaudeArgs();
    expect(args).not.toContain('--permission-mode');
    expect(args).not.toContain('plan');
  });

  it('explicitly disallows write + exfil tools', () => {
    const args = buildClaudeArgs();
    const idx = args.indexOf('--disallowed-tools');
    expect(idx).toBeGreaterThanOrEqual(0);
    const disallowed = args[idx + 1] ?? '';
    for (const tool of ['Bash', 'WebFetch', 'WebSearch', 'Edit', 'Write', 'Read']) {
      expect(disallowed.split(',')).toContain(tool);
    }
  });

  it('allows only Glob + Grep for project inspection', () => {
    const args = buildClaudeArgs();
    const idx = args.indexOf('--allowed-tools');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('Glob,Grep');
  });
});

// v0.14: extractGeneratedSegments slices the response into prose + html
// + prose so the chat surface can render the prose as message bubbles
// and the HTML as a compact "Generated index.html — N KB" card. The
// regression invariants extractHtml pins above must hold here too (we
// share the same fence-picking logic).
describe('extractGeneratedSegments', () => {
  it('tri-splits a prose / ```html / prose response', () => {
    const intro = 'This is a clean dashboard with a sidebar and KPI row.';
    const html = '<!DOCTYPE html>\n<html><body><h1>K</h1></body></html>';
    const outro = 'Try asking for a darker theme or tighter spacing next.';
    const raw = `${intro}\n\n\`\`\`html\n${html}\n\`\`\`\n\n${outro}`;
    const out = extractGeneratedSegments(raw);
    expect(out.html).toBe(html);
    expect(out.segments).toHaveLength(3);
    expect(out.segments[0]).toEqual({ kind: 'prose', text: intro });
    expect(out.segments[1]).toMatchObject({
      kind: 'html',
      bytes: Buffer.byteLength(html, 'utf8'),
    });
    // Preview is the first <=200 chars of the html.
    if (out.segments[1].kind === 'html') {
      expect(out.segments[1].preview).toBe(html);
    }
    expect(out.segments[2]).toEqual({ kind: 'prose', text: outro });
  });

  it('returns only an html segment when neither prose half is present', () => {
    const html = '<!DOCTYPE html>\n<html><body>x</body></html>';
    const raw = `\`\`\`html\n${html}\n\`\`\``;
    const out = extractGeneratedSegments(raw);
    expect(out.html).toBe(html);
    expect(out.segments).toHaveLength(1);
    expect(out.segments[0].kind).toBe('html');
  });

  it('returns prose+html when only the intro is present', () => {
    const html = '<!DOCTYPE html>\n<html><body>x</body></html>';
    const raw = `Here it is:\n\n\`\`\`html\n${html}\n\`\`\``;
    const out = extractGeneratedSegments(raw);
    expect(out.html).toBe(html);
    expect(out.segments.map((s) => s.kind)).toEqual(['prose', 'html']);
    expect(out.segments[0]).toEqual({ kind: 'prose', text: 'Here it is:' });
  });

  it('returns prose-only segments when no html fence and no doctype', () => {
    const raw = 'I cannot fulfil that request. Please refine the brief.';
    const out = extractGeneratedSegments(raw);
    expect(out.html).toBeNull();
    expect(out.segments).toHaveLength(1);
    expect(out.segments[0]).toEqual({ kind: 'prose', text: raw });
  });

  it('falls back to bare-doctype extraction (no fence) and emits a single html segment', () => {
    const raw = "Here's the page:\n<!DOCTYPE html>\n<html><body>hi</body></html>\nDone.";
    const out = extractGeneratedSegments(raw);
    // The doctype-scan path doesn't try to split prose halves (no
    // delimiter), but the html itself MUST be extracted correctly.
    expect(out.html).toBe('<!DOCTYPE html>\n<html><body>hi</body></html>');
    expect(out.segments).toHaveLength(1);
    expect(out.segments[0].kind).toBe('html');
  });

  it('returns empty segments and null html on empty input', () => {
    expect(extractGeneratedSegments('')).toEqual({
      html: null,
      segments: [],
    });
  });

  it('truncates the html preview to 200 chars', () => {
    const inner = 'a'.repeat(500);
    const html = `<!DOCTYPE html>\n<html><body>${inner}</body></html>`;
    const raw = `intro\n\n\`\`\`html\n${html}\n\`\`\``;
    const out = extractGeneratedSegments(raw);
    expect(out.segments[1].kind).toBe('html');
    if (out.segments[1].kind === 'html') {
      expect(out.segments[1].preview?.length).toBe(200);
    }
  });

  it('keeps extractHtml as a thin wrapper that returns the same html string', () => {
    const html = '<!DOCTYPE html>\n<html><body>x</body></html>';
    const raw = `intro\n\`\`\`html\n${html}\n\`\`\`\nbye`;
    expect(extractHtml(raw)).toBe(extractGeneratedSegments(raw).html);
  });
});
