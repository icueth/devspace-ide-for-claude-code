import { describe, expect, it } from 'vitest';

import { tagDevspaceIds } from '@main/services/design/idTagger';

describe('tagDevspaceIds', () => {
  it('tags every element in a simple <div><span/></div> with sequential ids', () => {
    const out = tagDevspaceIds('<div><span></span></div>');
    expect(out).toContain('data-devspace-id="1"');
    expect(out).toContain('data-devspace-id="2"');
    // Two and only two tags
    expect(out.match(/data-devspace-id=/g)?.length).toBe(2);
  });

  it('preserves existing data-devspace-id values', () => {
    const input = '<div data-devspace-id="7"><span data-devspace-id="9"></span></div>';
    const out = tagDevspaceIds(input);
    expect(out).toContain('data-devspace-id="7"');
    expect(out).toContain('data-devspace-id="9"');
    // No third id introduced — both elements already had handles.
    expect(out.match(/data-devspace-id=/g)?.length).toBe(2);
  });

  it('starts counter at max(existing) + 1 when some elements are pre-tagged', () => {
    const input = '<div data-devspace-id="5"><span></span><em></em></div>';
    const out = tagDevspaceIds(input);
    expect(out).toContain('data-devspace-id="5"');
    expect(out).toContain('data-devspace-id="6"');
    expect(out).toContain('data-devspace-id="7"');
    // Must NOT renumber the pre-tagged div.
    expect(out.match(/data-devspace-id="1"/g)).toBeNull();
  });

  it('skips <script>, <style>, <title>, <meta>, <link>, <noscript>', () => {
    const input =
      '<html><head>' +
      '<title>t</title>' +
      '<meta charset="utf-8">' +
      '<link rel="stylesheet" href="x.css">' +
      '<style>.a{}</style>' +
      '<script>var x=1;</script>' +
      '</head><body><noscript>no js</noscript><div>hi</div></body></html>';
    const out = tagDevspaceIds(input);
    // Skipped tags should NOT receive the attribute.
    expect(out).not.toMatch(/<title\b[^>]*data-devspace-id/);
    expect(out).not.toMatch(/<meta\b[^>]*data-devspace-id/);
    expect(out).not.toMatch(/<link\b[^>]*data-devspace-id/);
    expect(out).not.toMatch(/<style\b[^>]*data-devspace-id/);
    expect(out).not.toMatch(/<script\b[^>]*data-devspace-id/);
    expect(out).not.toMatch(/<noscript\b[^>]*data-devspace-id/);
    // <html>, <head>, <body>, <div> should be tagged.
    expect(out).toMatch(/<html\b[^>]*data-devspace-id/);
    expect(out).toMatch(/<head\b[^>]*data-devspace-id/);
    expect(out).toMatch(/<body\b[^>]*data-devspace-id/);
    expect(out).toMatch(/<div\b[^>]*data-devspace-id/);
  });

  it('is idempotent: tagging the same HTML twice produces the same output', () => {
    const input = '<section><h1>Hello</h1><p>World</p><span><em>!</em></span></section>';
    const once = tagDevspaceIds(input);
    const twice = tagDevspaceIds(once);
    expect(twice).toBe(once);
  });

  it('preserves doctype', () => {
    const input = '<!DOCTYPE html><html><body><p>x</p></body></html>';
    const out = tagDevspaceIds(input);
    expect(out.toUpperCase()).toContain('<!DOCTYPE HTML>');
  });

  it('preserves text nodes and whitespace structure between elements', () => {
    const input = '<div>\n  <span>hello</span>\n  world\n</div>';
    const out = tagDevspaceIds(input);
    expect(out).toContain('hello');
    expect(out).toContain('world');
    // Inner newline + indentation between the <span> and the text node
    // survives the round-trip.
    expect(out).toMatch(/<\/span>\s*\n\s*world/);
  });

  it('handles empty / whitespace-only input', () => {
    expect(tagDevspaceIds('')).toBe('');
    expect(tagDevspaceIds('   ')).toBe('   ');
    expect(tagDevspaceIds('\n\n')).toBe('\n\n');
  });

  // Phase B architecture review concern: when a save round-trip inserts a
  // new element near the top of the document, existing tagged elements
  // must retain their handles, AND the new element must get a fresh id
  // higher than any existing one — never collide with a pre-existing id.
  it('survives insertion: new sibling near the top gets max+1 without renumbering existing', () => {
    // Round 1: tag a baseline document.
    const r1 = tagDevspaceIds('<section><h1>a</h1><p>b</p></section>');
    expect(r1).toContain('data-devspace-id="1"'); // section
    expect(r1).toContain('data-devspace-id="2"'); // h1
    expect(r1).toContain('data-devspace-id="3"'); // p

    // Round 2: simulate the user inserting a new <header> before the
    // <h1>. The existing <section>, <h1>, <p> tags survive, and the
    // <header> picks up the next free id (4) — NOT id 1, NOT id 2.
    const inserted = r1.replace(
      /<section([^>]*)>/,
      '<section$1><header>x</header>',
    );
    const r2 = tagDevspaceIds(inserted);
    expect(r2).toContain('data-devspace-id="1"');
    expect(r2).toContain('data-devspace-id="2"');
    expect(r2).toContain('data-devspace-id="3"');
    expect(r2).toMatch(/<header\b[^>]*data-devspace-id="4"/);
    // No duplicate id 4 anywhere — assert exact count
    expect(r2.match(/data-devspace-id="4"/g)?.length).toBe(1);
  });
});
