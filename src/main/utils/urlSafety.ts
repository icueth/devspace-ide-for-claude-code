// urlSafety — central validator for any user-provided baseUrl that
// the main process is about to `fetch()`. Blocks SSRF vectors that
// would let a renderer-side prompt-injection or a hostile hand-edited
// profiles JSON pivot to internal services:
//   - cloud metadata endpoints (AWS IMDS, GCP metadata)
//   - loopback (unless explicitly opted-in for local Ollama/LM Studio)
//   - RFC-1918 private ranges (10/8, 172.16/12, 192.168/16)
//   - IPv6 link-local + ULA
//   - non-http(s) schemes (file://, data:, javascript:, gopher:, …)
//
// Returns the parsed URL on success so callers don't re-parse.
// Throws Error with a stable message prefix `baseUrl:` so the IPC layer
// can let it propagate to the renderer toast as a clear diagnostic.

const HOST_BLOCKLIST = new Set([
  '169.254.169.254',            // AWS IMDSv1/v2
  'fd00:ec2::254',              // AWS IMDS v6
  'metadata.google.internal',   // GCP
  'metadata.goog',              // GCP DNS alias
  'metadata.azure.com',         // Azure (when DNS routes)
  '0.0.0.0',
  '::',
]);

function isLoopback(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '::1' ||
    /^127\./.test(h) ||
    h.endsWith('.localhost')
  );
}

function isPrivateIpv4(host: string): boolean {
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return false;
  const [a, b] = host.split('.').map((s) => parseInt(s, 10));
  if (a === 10) return true;                               // 10.0.0.0/8
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true;                 // 192.168/16
  if (a === 169 && b === 254) return true;                 // 169.254/16 link-local
  return false;
}

function isPrivateIpv6(host: string): boolean {
  // Crude but covers the practical cases: fc00::/7 (ULA), fe80::/10 (link-local).
  // The `[` brackets URL.hostname strips, so 'fc00::1' arrives raw here.
  return /^(fc|fd)/i.test(host) || /^fe[89ab]/i.test(host);
}

export interface AssertBaseUrlOpts {
  /**
   * Allow loopback hosts (localhost / 127.* / ::1) — opt-in for users
   * running local LLM servers (Ollama, LM Studio, llama.cpp, vLLM).
   * Defaults to FALSE so a hostile profile can't pivot to internal
   * services bound on loopback without explicit acknowledgment.
   */
  allowLoopback?: boolean;
  /**
   * Plain-HTTP policy. Three semantics:
   *
   *   • `true`  (default)  — accept `http://` URLs. Preserves the
   *                          historical behavior every existing caller
   *                          (LlmChatProfilesService, LlmClient) relies
   *                          on. v0.30 OpenCode CLI profiles also pass
   *                          this because user-hosted vLLM / TGI /
   *                          openai-compatible inference servers are
   *                          commonly reached over plain HTTP inside a
   *                          private VPN where TLS is terminated at
   *                          the edge.
   *   • `false`            — reject `http://` URLs after the more
   *                          specific blocklist / loopback / private
   *                          checks have fired. Strict opt-in for new
   *                          surfaces that want to require TLS for
   *                          cleartext-credential protection.
   *
   * Note: this flag exists primarily for v0.30 audit clarity — the
   * callable contract is unchanged for every existing call site since
   * `true` is the default. SSRF blocklist + private-IP blocks STILL
   * apply regardless of this flag's value.
   */
  allowHttp?: boolean;
}

export function assertSafeBaseUrl(
  raw: unknown,
  opts: AssertBaseUrlOpts = {},
): URL {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('baseUrl: required');
  }
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error('baseUrl: invalid URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`baseUrl: only http/https allowed (got ${u.protocol})`);
  }
  // Node's URL.hostname returns IPv6 addresses WITH surrounding brackets
  // (e.g. '[::1]', '[fc00::1]') — strip them so the loopback / ULA / link-
  // local regex checks see bare host strings.
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) {
    throw new Error('baseUrl: missing host');
  }
  if (HOST_BLOCKLIST.has(host)) {
    throw new Error(`baseUrl: blocked host (${host})`);
  }
  if (isLoopback(host)) {
    if (!opts.allowLoopback) {
      throw new Error(
        `baseUrl: loopback (${host}) blocked — use a public endpoint or enable local-endpoint opt-in`,
      );
    }
    // loopback explicitly allowed — http:// at this point is local-only,
    // which is the original allowLoopback use case (Ollama/LM Studio
    // never run TLS on 127.0.0.1). Don't re-apply allowHttp gating.
    return u;
  }
  if (isPrivateIpv4(host) || isPrivateIpv6(host)) {
    throw new Error(`baseUrl: private network address blocked (${host})`);
  }
  // After all SSRF blocks have cleared, optionally require TLS for public
  // hosts. Default `allowHttp: true` preserves historical behavior; only
  // strict callers (none today; reserved for future hardening) flip it.
  if (u.protocol === 'http:' && opts.allowHttp === false) {
    throw new Error(
      `baseUrl: http:// blocked — use https:// or enable plain-HTTP opt-in`,
    );
  }
  return u;
}

/** Convenience: returns true/false instead of throwing — for filters. */
export function isSafeBaseUrl(
  raw: unknown,
  opts: AssertBaseUrlOpts = {},
): boolean {
  try {
    assertSafeBaseUrl(raw, opts);
    return true;
  } catch {
    return false;
  }
}
