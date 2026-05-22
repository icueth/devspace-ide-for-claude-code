import { describe, expect, it } from 'vitest';
import { assertSafeBaseUrl, isSafeBaseUrl } from '../urlSafety';

// Regression tests for the v0.29 SSRF defense in the LLM stack. A
// renderer-side compromise that wrote a hostile profile to
// ~/.devspace/llm-chat-profiles.json would otherwise pivot to AWS IMDS
// (`169.254.169.254`), internal services on private IPs, or non-http
// schemes — all of which the validator must reject.

describe('assertSafeBaseUrl', () => {
  it('accepts public https URLs', () => {
    expect(() => assertSafeBaseUrl('https://api.openai.com/v1')).not.toThrow();
    expect(() => assertSafeBaseUrl('https://api.anthropic.com')).not.toThrow();
    expect(() => assertSafeBaseUrl('http://api.example.com:8080/v1')).not.toThrow();
  });

  it('rejects non-http(s) schemes', () => {
    expect(() => assertSafeBaseUrl('file:///etc/passwd')).toThrow(/only http/);
    expect(() => assertSafeBaseUrl('javascript:alert(1)')).toThrow();
    expect(() => assertSafeBaseUrl('data:text/plain,hi')).toThrow(/only http/);
    expect(() => assertSafeBaseUrl('ftp://example.com')).toThrow(/only http/);
    expect(() => assertSafeBaseUrl('gopher://example.com')).toThrow(/only http/);
  });

  it('rejects empty/invalid input', () => {
    expect(() => assertSafeBaseUrl('')).toThrow(/required/);
    expect(() => assertSafeBaseUrl('   ')).toThrow(/required/);
    expect(() => assertSafeBaseUrl(null)).toThrow(/required/);
    expect(() => assertSafeBaseUrl(undefined)).toThrow(/required/);
    expect(() => assertSafeBaseUrl(42)).toThrow(/required/);
    expect(() => assertSafeBaseUrl('not a url')).toThrow(/invalid URL/);
  });

  it('rejects cloud metadata endpoints', () => {
    expect(() => assertSafeBaseUrl('http://169.254.169.254/latest/meta-data/'))
      .toThrow(/blocked/);
    expect(() => assertSafeBaseUrl('http://metadata.google.internal/computeMetadata/v1/'))
      .toThrow(/blocked/);
    expect(() => assertSafeBaseUrl('http://metadata.goog/'))
      .toThrow(/blocked/);
  });

  it('rejects RFC-1918 private IPv4 ranges', () => {
    expect(() => assertSafeBaseUrl('http://10.0.0.1')).toThrow(/private/);
    expect(() => assertSafeBaseUrl('http://10.255.255.255')).toThrow(/private/);
    expect(() => assertSafeBaseUrl('http://172.16.0.1')).toThrow(/private/);
    expect(() => assertSafeBaseUrl('http://172.31.255.255')).toThrow(/private/);
    expect(() => assertSafeBaseUrl('http://192.168.1.1')).toThrow(/private/);
    expect(() => assertSafeBaseUrl('http://169.254.0.1')).toThrow(/private/);
    // Not private — public assigned ranges starting with 11, 172.15, 172.32, 193.168
    expect(() => assertSafeBaseUrl('https://11.0.0.1')).not.toThrow();
    expect(() => assertSafeBaseUrl('https://172.15.0.1')).not.toThrow();
    expect(() => assertSafeBaseUrl('https://172.32.0.1')).not.toThrow();
    expect(() => assertSafeBaseUrl('https://193.168.0.1')).not.toThrow();
  });

  it('rejects IPv6 ULA + link-local', () => {
    expect(() => assertSafeBaseUrl('http://[fc00::1]')).toThrow(/private/);
    expect(() => assertSafeBaseUrl('http://[fd12:3456:789a::1]')).toThrow(/private/);
    expect(() => assertSafeBaseUrl('http://[fe80::1]')).toThrow(/private/);
  });

  it('rejects loopback by default; allows when opted in', () => {
    expect(() => assertSafeBaseUrl('http://localhost:11434')).toThrow(/loopback/);
    expect(() => assertSafeBaseUrl('http://127.0.0.1:1234')).toThrow(/loopback/);
    expect(() => assertSafeBaseUrl('http://[::1]:8080')).toThrow(/loopback/);
    // Opt-in for local Ollama / LM Studio / vLLM
    expect(() => assertSafeBaseUrl('http://localhost:11434', { allowLoopback: true }))
      .not.toThrow();
    expect(() => assertSafeBaseUrl('http://127.0.0.1:1234', { allowLoopback: true }))
      .not.toThrow();
    expect(() => assertSafeBaseUrl('http://[::1]:8080', { allowLoopback: true }))
      .not.toThrow();
  });

  it('rejects 0.0.0.0 even with loopback opt-in', () => {
    // 0.0.0.0 isn't "loopback" per se — it's an explicit-all-interfaces
    // address that's never a legitimate baseUrl. Block unconditionally.
    expect(() => assertSafeBaseUrl('http://0.0.0.0', { allowLoopback: true }))
      .toThrow(/blocked/);
  });

  it('returns parsed URL on success', () => {
    const u = assertSafeBaseUrl('https://api.openai.com:443/v1/');
    expect(u.protocol).toBe('https:');
    expect(u.hostname).toBe('api.openai.com');
    expect(u.pathname).toBe('/v1/');
  });

  it('trims input', () => {
    expect(() => assertSafeBaseUrl('   https://api.openai.com  ')).not.toThrow();
  });

  it('isSafeBaseUrl returns boolean without throwing', () => {
    expect(isSafeBaseUrl('https://api.openai.com')).toBe(true);
    expect(isSafeBaseUrl('http://169.254.169.254')).toBe(false);
    expect(isSafeBaseUrl('not a url')).toBe(false);
    expect(isSafeBaseUrl('')).toBe(false);
  });
});
