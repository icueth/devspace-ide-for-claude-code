// Phase C live-preview bridge.
//
// This script is injected INSIDE the `<webview>` via
// `webview.executeJavaScript(BRIDGE_SCRIPT)` after the `dom-ready` event.
// It runs in the dev-server's renderer-process origin — same JS realm as
// the user's React app — so it can read React fiber internals to recover
// `_debugSource` file/line pointers for inspected elements.
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
//   4. `console.log('__devspace_bridge__:' + JSON.stringify(payload))`
//      and have the host parse `webview.addEventListener(
//      'console-message', ev => ...)`. This works without a preload,
//      survives cross-origin boundaries, and Electron already exposes
//      console events on the webview tag. The trade-off is that the
//      payload becomes visible in the dev-server console — for a local
//      live preview that's a feature (the user can debug what the
//      bridge is shipping), not a leak.
//
// We chose #4. Host → webview uses `webview.executeJavaScript(...)`
// against a function the bridge exposes on `window` (`__devspaceSetMode`
// etc.), which IS available since the bridge itself was injected via
// executeJavaScript and shares the same realm.

import { DESIGN_BRIDGE_PROTOCOL_VERSION } from '@shared/design';

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
  protocolVersion: number = DESIGN_BRIDGE_PROTOCOL_VERSION,
  secret: string = '',
): string {
  // The secret-key handshake is the defense against a malicious page
  // forging bridge envelopes via its own `console.log`. The host injects
  // a fresh random secret on every `dom-ready`; the bridge keeps it in
  // a closure (not on `window`); every outbound envelope includes it.
  // The host checks `parsed.__k === expectedSecret` and drops anything
  // else. User code can still call `console.log(PREFIX + JSON.stringify({...}))`
  // but it cannot guess the secret, so its forged payload is rejected.
  // NOTE: the body below is serialized as-is. Keep it dependency-free
  // and ES2020-compatible — it runs in whatever JS realm the dev server
  // ships (Vite usually targets modern Chromium, but Next on legacy
  // pages can be older). No optional chaining nested with `??` chains
  // beyond what we need. No template literals containing `${` that
  // shadow outer ones — we use single quotes inside the body.
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

  // ─── Outline style for inspect mode ─────────────────────────────
  // Injected once; toggled via the body class \`devspace-inspect-on\`.
  var style = document.createElement('style');
  style.setAttribute('data-devspace-bridge', 'true');
  style.textContent =
    '.devspace-inspect-on *[data-devspace-hover] {' +
    '  outline: 2px solid rgba(76,141,255,0.85) !important;' +
    '  outline-offset: 1px !important;' +
    '  cursor: crosshair !important;' +
    '}' +
    '.devspace-inspect-on { cursor: crosshair !important; }';
  // Append once DOM is ready — script may load before <head> exists if
  // injection raced something weird; defer to be safe.
  if (document.head) document.head.appendChild(style);
  else document.addEventListener('DOMContentLoaded', function () {
    document.head.appendChild(style);
  });

  // ─── Source-pointer extraction via React Fiber internals ────────
  //
  // React 17+ stores the fiber for a DOM node under a key beginning
  // with \`__reactFiber\$\`. Walking up the return-pointer chain finds
  // the host fiber; its \`_debugSource\` (when present — dev builds
  // only) carries { fileName, lineNumber, columnNumber }.
  //
  // Production builds strip _debugSource. We return undefined and the
  // host's element-info panel hides the field — no crash.
  function getReactSourceRef(el) {
    try {
      var fiberKey = null;
      var keys = Object.keys(el);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf('__reactFiber\$') === 0) {
          fiberKey = keys[i];
          break;
        }
      }
      if (!fiberKey) return undefined;
      var fiber = el[fiberKey];
      var hops = 0;
      while (fiber && hops < 24) {
        if (fiber._debugSource) {
          var s = fiber._debugSource;
          var f = s.fileName || '';
          var line = s.lineNumber || 0;
          var col = s.columnNumber || 0;
          if (f) return f + ':' + line + (col ? ':' + col : '');
        }
        fiber = fiber.return;
        hops++;
      }
    } catch (_err) {}
    return undefined;
  }

  function send(payload) {
    // console.log is the chosen webview→host channel — see the source
    // header for the design rationale. The SECRET key stamped on every
    // envelope is the host's anti-forgery check; user page code can
    // see neither this closure nor the secret string.
    try {
      payload.__k = SECRET;
      console.log(PREFIX + JSON.stringify(payload));
    } catch (_err) {}
  }

  function buildElementInfo(el) {
    if (!el || el.nodeType !== 1) return null;
    var rect = el.getBoundingClientRect();
    var styles = window.getComputedStyle(el);
    var classes = [];
    if (el.classList && el.classList.length) {
      for (var i = 0; i < el.classList.length; i++) classes.push(el.classList[i]);
    }
    var text = (el.innerText || el.textContent || '')
      .replace(/\\s+/g, ' ')
      .trim()
      .slice(0, 80);

    // Phase C: every element gets an opaque transient id so the host
    // panel can reference it without us serializing a full selector.
    // We don't persist it — write-back lives in 0.8 against sourceRef.
    var id = el.getAttribute('data-devspace-id');
    if (!id) {
      id = 'dev-' + Math.random().toString(36).slice(2, 9);
      el.setAttribute('data-devspace-id', id);
    }

    var ref = getReactSourceRef(el);

    return {
      elementId: id,
      tagName: el.tagName || 'unknown',
      classes: classes,
      innerTextPreview: text,
      rect: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      },
      source: ref ? { kind: 'user-jsx', ref: ref } : { kind: 'user-jsx' },
      computedStyles: {
        color: styles.color,
        backgroundColor: styles.backgroundColor,
        fontSize: styles.fontSize,
        fontFamily: styles.fontFamily,
        fontWeight: styles.fontWeight,
        padding: styles.padding,
        margin: styles.margin,
        borderRadius: styles.borderRadius,
        border: styles.border,
        display: styles.display,
        textAlign: styles.textAlign,
      },
    };
  }

  // ─── Mode state + interaction gating ────────────────────────────
  var currentMode = 'view';
  var lastHoverEl = null;

  function clearHover() {
    if (lastHoverEl) {
      try { lastHoverEl.removeAttribute('data-devspace-hover'); } catch (_e) {}
      lastHoverEl = null;
    }
  }

  function setHover(el) {
    if (el === lastHoverEl) return;
    clearHover();
    if (el && el.nodeType === 1) {
      try { el.setAttribute('data-devspace-hover', 'true'); } catch (_e) {}
      lastHoverEl = el;
    }
  }

  function onMouseMove(ev) {
    if (currentMode === 'view') return;
    var el = ev.target;
    setHover(el);
    var info = buildElementInfo(el);
    send({ type: 'devspace:dev:elementHover', info: info });
  }

  function onMouseOut() {
    if (currentMode === 'view') return;
    clearHover();
    send({ type: 'devspace:dev:elementHover', info: null });
  }

  function onClick(ev) {
    if (currentMode === 'view') return;
    // Block the dev-server app's own click handler while inspecting —
    // otherwise clicking a <button> would fire its real onClick.
    try {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
    } catch (_e) {}
    var info = buildElementInfo(ev.target);
    if (info) send({ type: 'devspace:dev:elementSelect', info: info });
  }

  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('mouseout', onMouseOut, true);
  document.addEventListener('click', onClick, true);

  // ─── Host → bridge: mode setter exposed on window ───────────────
  // The host calls this via webview.executeJavaScript("window.__devspaceSetMode('inspect')")
  // — a stable JS function in this realm avoids needing postMessage
  // plumbing for the only outbound channel we have.
  window.__devspaceSetMode = function (mode) {
    if (mode !== 'view' && mode !== 'inspect' && mode !== 'edit') return;
    currentMode = mode;
    try {
      if (mode === 'view') {
        document.body.classList.remove('devspace-inspect-on');
        clearHover();
      } else {
        document.body.classList.add('devspace-inspect-on');
      }
    } catch (_e) {}
  };

  // Final handshake — host listens for this to know the bridge is live
  // and may re-pin the current mode. The origin field lets the host
  // cross-check that the bridge is running inside the expected dev
  // server origin (not a page that navigated us off-route mid-load).
  // Defense-in-depth: will-navigate already blocks non-localhost
  // navigation, so this is the second gate, not the first.
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
