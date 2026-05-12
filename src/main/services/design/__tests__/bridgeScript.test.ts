import { describe, expect, it } from 'vitest';

import { DEVSPACE_BRIDGE_SCRIPT } from '@main/services/design/bridgeScript';

describe('DEVSPACE_BRIDGE_SCRIPT', () => {
  it('exports a non-empty string', () => {
    expect(typeof DEVSPACE_BRIDGE_SCRIPT).toBe('string');
    expect(DEVSPACE_BRIDGE_SCRIPT.length).toBeGreaterThan(200);
  });

  it('is shaped as an IIFE (starts with (function or ;(function)', () => {
    const head = DEVSPACE_BRIDGE_SCRIPT.trimStart();
    expect(head.startsWith('(function') || head.startsWith(';(function')).toBe(true);
  });

  it('contains no dangerous APIs (eval, new Function, document.write, fetch, XHR, localStorage writes)', () => {
    const forbidden = [
      /\beval\s*\(/,
      /\bnew\s+Function\b/,
      /document\.write(?:ln)?\s*\(/,
      /\bfetch\s*\(/,
      /\bXMLHttpRequest\b/,
      /\bWebSocket\b/,
      /localStorage\s*\.\s*setItem/,
      /sessionStorage\s*\.\s*setItem/,
    ];
    for (const re of forbidden) {
      expect(DEVSPACE_BRIDGE_SCRIPT, `forbidden token ${re}`).not.toMatch(re);
    }
  });

  it('references window.parent.postMessage for outbound communication', () => {
    expect(DEVSPACE_BRIDGE_SCRIPT).toMatch(/window\.parent\.postMessage/);
  });

  it("registers a 'message' event listener", () => {
    expect(DEVSPACE_BRIDGE_SCRIPT).toMatch(/addEventListener\(\s*['"]message['"]/);
  });

  it('references the data-devspace-id selector contract', () => {
    expect(DEVSPACE_BRIDGE_SCRIPT).toContain('data-devspace-id');
  });

  it('validates inbound messages by source identity', () => {
    expect(DEVSPACE_BRIDGE_SCRIPT).toMatch(/event\.source\s*!==\s*window\.parent/);
  });

  it("emits a 'devspace:bridgeReady' handshake with the protocol version", () => {
    expect(DEVSPACE_BRIDGE_SCRIPT).toContain('devspace:bridgeReady');
  });
});
