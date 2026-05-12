// Phase B element ID tagger.
//
// Walks HTML and injects `data-devspace-id="<n>"` on every element so the
// iframe bridge can refer to a stable handle that survives DOM mutations
// from CSS overrides. IDs are dense (1, 2, 3 …) per document — generation-
// scoped, NOT global — so they stay reasonably small.
//
// Idempotency: if an element already carries `data-devspace-id`, leave it
// untouched. The counter starts at `max(existing) + 1` so a save → re-tag
// round-trip never renumbers existing handles.
//
// Skipped tags (data-* attrs are a smell on metadata / non-rendered nodes):
//   <script> <style> <title> <meta> <link> <noscript>

import { parse, HTMLElement } from 'node-html-parser';

const SKIP_TAGS = new Set(['script', 'style', 'title', 'meta', 'link', 'noscript']);

const ATTR_NAME = 'data-devspace-id';

function scanExistingMax(root: HTMLElement): number {
  let max = 0;
  const walk = (node: HTMLElement): void => {
    const existing = node.getAttribute(ATTR_NAME);
    if (existing !== undefined) {
      const n = Number.parseInt(existing, 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    for (const child of node.childNodes) {
      if (child instanceof HTMLElement) walk(child);
    }
  };
  walk(root);
  return max;
}

export function tagDevspaceIds(html: string): string {
  // Empty / whitespace-only input — nothing to walk, return as-is.
  if (!html || html.trim().length === 0) return html;

  // `comment: true` keeps HTML comments + doctype intact through round-trip.
  const root = parse(html, { comment: true });

  let counter = scanExistingMax(root);

  const walk = (node: HTMLElement): void => {
    const tag = node.rawTagName ? node.rawTagName.toLowerCase() : '';
    // Root container from node-html-parser has empty rawTagName — descend
    // but don't tag it.
    const taggable = tag !== '' && !SKIP_TAGS.has(tag);

    if (taggable && node.getAttribute(ATTR_NAME) === undefined) {
      counter += 1;
      node.setAttribute(ATTR_NAME, String(counter));
    }

    // Even for skipped tags we don't descend into their children — <script>
    // / <style> contents are non-element text and <noscript>'s contents are
    // semantically inert under the bridge.
    if (taggable || tag === '') {
      for (const child of node.childNodes) {
        if (child instanceof HTMLElement) walk(child);
      }
    }
  };

  walk(root);

  return root.toString();
}
