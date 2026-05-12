import { describe, expect, it } from 'vitest';

import {
  BRIDGE_LOG_PREFIX,
  parseBridgeConsoleLine,
  stripAnsi,
} from './webviewBridge';

const env = (payload: Record<string, unknown>, secret?: string) =>
  `${BRIDGE_LOG_PREFIX}${JSON.stringify(secret ? { ...payload, __k: secret } : payload)}`;

describe('parseBridgeConsoleLine', () => {
  it('returns null for lines that do not start with the bridge prefix', () => {
    expect(parseBridgeConsoleLine('hello world', 'k')).toBeNull();
    expect(
      parseBridgeConsoleLine(`prefix ${BRIDGE_LOG_PREFIX}{"a":1}`, 'k'),
    ).toBeNull();
  });

  it('rejects malformed JSON', () => {
    expect(parseBridgeConsoleLine(`${BRIDGE_LOG_PREFIX}not-json`, 'k')).toBeNull();
  });

  it('accepts when the embedded secret matches', () => {
    const line = env({ type: 'ping' }, 'secret-A');
    expect(parseBridgeConsoleLine(line, 'secret-A')).toMatchObject({ type: 'ping' });
  });

  it('rejects when the secret does not match', () => {
    const line = env({ type: 'ping' }, 'wrong');
    expect(parseBridgeConsoleLine(line, 'secret-A')).toBeNull();
  });

  it('rejects envelopes without an embedded secret when a secret is expected', () => {
    const line = env({ type: 'ping' });
    expect(parseBridgeConsoleLine(line, 'secret-A')).toBeNull();
  });

  // L1: grace window — accept either of two secrets during rotation.
  describe('grace window', () => {
    it('accepts the new secret', () => {
      const line = env({ type: 'ping' }, 'new');
      expect(parseBridgeConsoleLine(line, ['new', 'old'])).toMatchObject({
        type: 'ping',
      });
    });

    it('accepts the previous (graced) secret', () => {
      const line = env({ type: 'ping' }, 'old');
      expect(parseBridgeConsoleLine(line, ['new', 'old'])).toMatchObject({
        type: 'ping',
      });
    });

    it('rejects a stale secret that is not in the accept set', () => {
      const line = env({ type: 'ping' }, 'ancient');
      expect(parseBridgeConsoleLine(line, ['new', 'old'])).toBeNull();
    });

    it('treats an empty accept set as no-secret-check', () => {
      const line = env({ type: 'ping' });
      expect(parseBridgeConsoleLine(line, [])).toMatchObject({ type: 'ping' });
    });

    it('ignores empty-string entries in the accept set', () => {
      const line = env({ type: 'ping' }, 'real');
      expect(parseBridgeConsoleLine(line, ['', 'real'])).toMatchObject({
        type: 'ping',
      });
      expect(parseBridgeConsoleLine(line, ['', ''])).toMatchObject({
        type: 'ping',
      });
    });
  });

  // M4: handshake origin field round-trips through the parser unchanged so
  // the host can inspect it.
  it('preserves the origin field on bridgeReady envelopes', () => {
    const line = env(
      {
        type: 'devspace:dev:bridgeReady',
        version: 1,
        framework: 'vite',
        origin: 'http://localhost:5173',
      },
      's',
    );
    const parsed = parseBridgeConsoleLine(line, 's') as Record<string, unknown>;
    expect(parsed.origin).toBe('http://localhost:5173');
  });
});

describe('stripAnsi', () => {
  it('strips SGR colour codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('leaves plain text alone', () => {
    expect(stripAnsi('hello')).toBe('hello');
  });
});
