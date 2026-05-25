// Live-preview bridge (pure viewer).
//
// This script is injected INSIDE the `<webview>` via
// `webview.executeJavaScript(BRIDGE_SCRIPT)` after the `dom-ready` event.
// It runs in the dev-server's renderer-process origin — same JS realm as
// the user's React app.
//
// The viewer no longer inspects or edits the page; the bridge's only job
// is a one-shot handshake so the host can (a) learn the framework the page
// reports for the status pill, and (b) cross-check the bridge is running
// inside the expected dev-server origin. The handshake is stamped with a
// per-injection secret so a malicious page cannot forge bridge envelopes
// via its own `console.log`.
//
// ─── Message-passing approach (read me, you'll wonder later) ─────────
//
// The webview is sandboxed in a separate web contents from the host
// renderer. There are four plausible channels for webview → host:
//
//   1. `ipcRenderer.sendToHost(...)` — clean and typed, BUT requires a
//      preload script attached to the webview tag. We deliberately do
//      NOT attach a preload (the dev-server origin is untrusted user
//      code), so `ipcRenderer` is not exposed inside the bridge.
//   2. `window.parent.postMessage(...)` — blocked: the webview is NOT
//      the host renderer's child window. The webview's top window is
//      itself; `window.parent === window`.
//   3. `webContents.send(...)` — host → webview only, wrong direction.
//   4. `console.log('__devspace_dev_bridge__:' + JSON.stringify(payload))`
//      and have the host parse `webview.addEventListener(
//      'console-message', ev => ...)`. This works without a preload,
//      survives cross-origin boundaries, and Electron already exposes
//      console events on the webview tag.
//
// We chose #4.

// Bridge handshake protocol version. Bumped only if the handshake shape
// changes; kept local now that the Design Studio shared types are gone.
export const LIVE_PREVIEW_BRIDGE_PROTOCOL_VERSION = 1;

// The console-message sentinel prefix the host filters on. Long enough
// to make collision with user console logs unlikely; short enough that
// it doesn't dominate the message channel.
export const BRIDGE_LOG_PREFIX = '__devspace_dev_bridge__:';

/**
 * Build the bridge script as a single self-executing string.
 *
 * It's a string (not a real module) because:
 *   • `webview.executeJavaScript` only accepts source text;
 *   • we want zero build-time dependency between renderer bundle and
 *     bridge content, so the script is self-contained;
 *   • passing through a Vite import would inline @shared types that
 *     can't survive the wire — strings always can.
 *
 * The function takes the live `protocolVersion` so a future bump on the
 * host side automatically flows into the bridge handshake without two
 * places to update.
 */
export function buildBridgeScript(
  protocolVersion: number = LIVE_PREVIEW_BRIDGE_PROTOCOL_VERSION,
  secret: string = '',
): string {
  // The secret-key handshake is the defense against a malicious page
  // forging bridge envelopes via its own `console.log`. The host injects
  // a fresh random secret on every `dom-ready`; the bridge keeps it in
  // a closure (not on `window`); the outbound envelope includes it. The
  // host checks `parsed.__k === expectedSecret` and drops anything else.
  // NOTE: the body below is serialized as-is. Keep it dependency-free
  // and ES2020-compatible — it runs in whatever JS realm the dev server
  // ships.
  return `
(function devspaceLivePreviewBridge() {
  if (window.__devspaceLivePreviewBridgeInstalled) return;
  window.__devspaceLivePreviewBridgeInstalled = true;

  var PREFIX = ${JSON.stringify(BRIDGE_LOG_PREFIX)};
  var VERSION = ${JSON.stringify(protocolVersion)};
  var SECRET = ${JSON.stringify(secret)};
  // Framework hint surfaces in the handshake so the host can label the
  // status pill. We sniff a few globals — best-effort, no throw on miss.
  var FRAMEWORK = (function detectFramework() {
    try {
      if (window.__NEXT_DATA__) return 'next';
      if (window.__remixContext) return 'remix';
      if (window.Astro || document.querySelector('astro-island')) return 'astro';
      if (window.__vite_plugin_react_preamble_installed__) return 'vite';
    } catch (_err) {}
    return 'unknown';
  })();

  function send(payload) {
    // console.log is the chosen webview→host channel — see the source
    // header for the design rationale. The SECRET key stamped on the
    // envelope is the host's anti-forgery check; user page code can
    // see neither this closure nor the secret string.
    try {
      payload.__k = SECRET;
      console.log(PREFIX + JSON.stringify(payload));
    } catch (_err) {}
  }

  // Handshake — host listens for this to know the bridge is live. The
  // origin field lets the host cross-check that the bridge is running
  // inside the expected dev server origin (not a page that navigated us
  // off-route mid-load). Defense-in-depth: will-navigate already blocks
  // non-localhost navigation, so this is the second gate, not the first.
  send({
    type: 'devspace:dev:bridgeReady',
    version: VERSION,
    framework: FRAMEWORK,
    origin: (function readOrigin() {
      try {
        return window.location && window.location.origin
          ? window.location.origin
          : '';
      } catch (_err) {
        return '';
      }
    })(),
  });
})();
`;
}

/**
 * Default bridge script with the current protocol version baked in.
 * Exported as `BRIDGE_SCRIPT` to keep callsites tiny.
 */
export const BRIDGE_SCRIPT: string = buildBridgeScript();

// ─── Host-side helpers ─────────────────────────────────────────────────

/**
 * Strip ANSI color escape sequences from a single line so the log pane
 * can render readable text. We DON'T try to recover bold/italic — those
 * are visual sugar we'd need to map to spans, and the log pane is
 * read-only mono.
 */
export function stripAnsi(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Try to parse a single console-message string back into the inbound
 * protocol envelope. Returns null when the line wasn't ours OR the
 * payload didn't parse OR the secret-key check failed against EVERY
 * accepted secret.
 *
 * The line MUST start with the bridge prefix — substring matches are
 * rejected so a user-app log that *contains* the sentinel anywhere is
 * never treated as a bridge envelope. Per-message secret enforces
 * unforgeability against page-side console.log.
 *
 * Pass an array of accepted secrets to honour the brief grace window
 * after a secret rotates on HMR — during the grace, envelopes from the
 * just-rotated bridge realm are still accepted. Pass a single string
 * for back-compat (treated as a one-element array). Pass an empty
 * string / empty array to disable the secret check (used in unit tests
 * where the bridge string is generated without a secret).
 */
export function parseBridgeConsoleLine(
  line: string,
  expectedSecret: string | readonly string[],
): unknown | null {
  if (!line.startsWith(BRIDGE_LOG_PREFIX)) return null;
  const raw = line.slice(BRIDGE_LOG_PREFIX.length).trim();
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const payload = parsed as Record<string, unknown>;
  const accepted = Array.isArray(expectedSecret)
    ? expectedSecret.filter((s) => typeof s === 'string' && s.length > 0)
    : expectedSecret
      ? [expectedSecret]
      : [];
  if (accepted.length > 0) {
    const k = payload.__k;
    if (typeof k !== 'string') return null;
    if (!accepted.includes(k)) return null;
  }
  return payload;
}
