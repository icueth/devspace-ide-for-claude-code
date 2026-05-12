// Phase B iframe bridge script.
//
// Runs inside a sandboxed Blob-URL iframe with `allow-scripts` (no
// `allow-same-origin`). It can talk to the renderer ONLY via
// `window.parent.postMessage`. See `src/shared/design.ts` for the
// DesignBridgeOutbound / DesignBridgeInbound protocol shapes this script
// implements.
//
// Security invariants enforced in-script:
//   • Drop any incoming message whose `event.source` is not `window.parent`.
//   • Drop any message whose `type` does not start with `'devspace:'`.
//   • Never `eval` / `new Function` / `document.write` an incoming string.
//     CSS values flow through `element.style.setProperty`, which validates
//     against the CSS grammar natively.
//   • No network calls (no fetch / XHR / WebSocket / Image-beacon).
//   • No persistent storage writes.

export const DEVSPACE_BRIDGE_SCRIPT = `;(function () {
  'use strict';

  var PROTOCOL_VERSION = 1;
  var ATTR = 'data-devspace-id';
  var OUTLINE_STYLE_KEY = '__devspaceOriginalOutline';

  var mode = 'view';
  /** elementId -> { property -> value } */
  var overrides = Object.create(null);
  /** elementId -> ts when most recently set */
  var overrideTs = Object.create(null);

  var hoveredEl = null;
  var selectedEl = null;
  var rafPending = false;
  var pendingHoverEvent = null;

  function post(msg) {
    try { window.parent.postMessage(msg, '*'); } catch (_e) {}
  }

  function postError(message) {
    post({ type: 'devspace:bridgeError', message: String(message) });
  }

  function findHandledAncestor(el) {
    var node = el;
    while (node && node.nodeType === 1) {
      if (node.hasAttribute && node.hasAttribute(ATTR)) return node;
      node = node.parentElement;
    }
    return el && el.nodeType === 1 ? el : null;
  }

  function elementInfo(el) {
    if (!el || el.nodeType !== 1) return null;
    var id = el.getAttribute(ATTR) || '';
    var rect = el.getBoundingClientRect();
    var cs = null;
    try { cs = window.getComputedStyle(el); } catch (_e) { cs = null; }
    var text = (el.textContent == null ? '' : String(el.textContent))
      .replace(/\\s+/g, ' ')
      .trim()
      .slice(0, 80);
    var classes = [];
    if (el.classList && el.classList.length) {
      for (var i = 0; i < el.classList.length; i++) classes.push(el.classList[i]);
    }
    return {
      elementId: id,
      tagName: (el.tagName || '').toLowerCase(),
      classes: classes,
      innerTextPreview: text,
      // Phase B: every element comes from a Claude generation. Phase C
      // will populate this with a JSX file/line ref when the previewed
      // tree originates from real user source code.
      source: { kind: 'generated' },
      rect: {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height
      },
      computedStyles: cs ? {
        color: cs.color,
        backgroundColor: cs.backgroundColor,
        fontSize: cs.fontSize,
        fontFamily: cs.fontFamily,
        fontWeight: cs.fontWeight,
        padding: cs.padding,
        margin: cs.margin,
        borderRadius: cs.borderRadius,
        border: cs.border,
        display: cs.display,
        textAlign: cs.textAlign
      } : {}
    };
  }

  function setOutline(el, on) {
    if (!el || el.nodeType !== 1) return;
    if (on) {
      if (el[OUTLINE_STYLE_KEY] === undefined) {
        el[OUTLINE_STYLE_KEY] = el.style.outline || '';
      }
      el.style.outline = '2px solid #6366f1';
      el.style.outlineOffset = '1px';
    } else {
      if (el[OUTLINE_STYLE_KEY] !== undefined) {
        el.style.outline = el[OUTLINE_STYLE_KEY];
        try { delete el[OUTLINE_STYLE_KEY]; } catch (_e) { el[OUTLINE_STYLE_KEY] = undefined; }
      }
      el.style.removeProperty('outline-offset');
    }
  }

  function clearHover() {
    if (hoveredEl && hoveredEl !== selectedEl) setOutline(hoveredEl, false);
    hoveredEl = null;
  }
  function clearSelected() {
    if (selectedEl) setOutline(selectedEl, false);
    selectedEl = null;
  }

  function findById(id) {
    // Defense-in-depth: data-devspace-id values are integers assigned by
    // the server-side tagger. Reject anything else before it reaches
    // querySelector so a future renderer-side bug that leaks user input
    // here cannot smuggle in selector metachars.
    if (typeof id !== 'string' && typeof id !== 'number') return null;
    var s = String(id);
    if (!/^[0-9]+$/.test(s)) return null;
    try {
      return document.querySelector('[' + ATTR + '="' + s + '"]');
    } catch (_e) { return null; }
  }

  function recordOverride(id, property, value) {
    if (!overrides[id]) overrides[id] = Object.create(null);
    overrides[id][property] = value;
    overrideTs[id + '|' + property] = Date.now();
  }

  function applyEdit(id, property, value) {
    var el = findById(id);
    if (!el) return false;
    try {
      if (value === '' || value == null) {
        el.style.removeProperty(property);
        if (overrides[id]) delete overrides[id][property];
        delete overrideTs[id + '|' + property];
      } else {
        el.style.setProperty(property, value);
        recordOverride(id, property, value);
      }
      return true;
    } catch (_e) { return false; }
  }

  function clearAllOverrides() {
    var ids = Object.keys(overrides);
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var el = findById(id);
      var props = Object.keys(overrides[id]);
      if (el) {
        for (var j = 0; j < props.length; j++) {
          try { el.style.removeProperty(props[j]); } catch (_e) {}
        }
      }
    }
    overrides = Object.create(null);
    overrideTs = Object.create(null);
  }

  function buildOps() {
    var ops = [];
    var ids = Object.keys(overrides);
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var props = Object.keys(overrides[id]);
      for (var j = 0; j < props.length; j++) {
        var p = props[j];
        ops.push({
          elementId: id,
          property: p,
          value: overrides[id][p],
          ts: overrideTs[id + '|' + p] || Date.now()
        });
      }
    }
    return ops;
  }

  function flushOverridesToAttributes() {
    // Ensures inline style= attribute reflects every active override so
    // outerHTML serialization captures them.
    var ids = Object.keys(overrides);
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var el = findById(id);
      if (!el) continue;
      var props = Object.keys(overrides[id]);
      var current = el.getAttribute('style') || '';
      var trimmed = current.trim().replace(/;\\s*$/, '');
      var parts = trimmed.length ? [trimmed] : [];
      for (var j = 0; j < props.length; j++) {
        parts.push(props[j] + ': ' + overrides[id][props[j]]);
      }
      el.setAttribute('style', parts.join('; '));
    }
  }

  function snapshot(requestId) {
    // Clear BOTH outline and outline-offset on hovered + selected
    // elements before serialization — otherwise the editor's
    // ephemeral '2px solid #6366f1' + '1px' offset bleeds into the
    // persisted HTML as a permanent inline style on whichever element
    // was last focused at save time.
    var origH = null, origHOffset = null;
    var origS = null, origSOffset = null;
    if (hoveredEl) {
      origH = hoveredEl.style.outline;
      origHOffset = hoveredEl.style.outlineOffset;
      hoveredEl.style.outline = '';
      hoveredEl.style.removeProperty('outline-offset');
    }
    if (selectedEl) {
      origS = selectedEl.style.outline;
      origSOffset = selectedEl.style.outlineOffset;
      selectedEl.style.outline = '';
      selectedEl.style.removeProperty('outline-offset');
    }
    flushOverridesToAttributes();
    var html = '';
    try {
      var doctype = '';
      if (document.doctype) {
        doctype = '<!DOCTYPE ' + document.doctype.name + '>';
      }
      html = doctype + document.documentElement.outerHTML;
    } catch (_e) { html = ''; }
    if (hoveredEl) {
      hoveredEl.style.outline = origH || '';
      if (origHOffset) hoveredEl.style.outlineOffset = origHOffset;
    }
    if (selectedEl) {
      selectedEl.style.outline = origS || '';
      if (origSOffset) selectedEl.style.outlineOffset = origSOffset;
    }
    post({ type: 'devspace:snapshot', requestId: requestId, html: html, ops: buildOps() });
  }

  function focusElement(id) {
    var el = findById(id);
    if (!el) return;
    try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_e) {}
  }

  function handleMessage(event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    var type = data.type;
    if (typeof type !== 'string' || type.indexOf('devspace:') !== 0) return;

    try {
      if (type === 'devspace:setMode') {
        var newMode = data.mode;
        if (newMode === 'view' || newMode === 'inspect' || newMode === 'edit') {
          mode = newMode;
          if (mode === 'view') { clearHover(); clearSelected(); }
        }
      } else if (type === 'devspace:applyEdit') {
        var ok = applyEdit(String(data.elementId), String(data.property), String(data.value == null ? '' : data.value));
        if (ok) post({ type: 'devspace:editApplied', elementId: data.elementId, property: data.property, value: data.value });
      } else if (type === 'devspace:clearOverrides') {
        clearAllOverrides();
      } else if (type === 'devspace:requestSnapshot') {
        snapshot(String(data.requestId || ''));
      } else if (type === 'devspace:focusElement') {
        focusElement(String(data.elementId));
      }
    } catch (e) { postError(e && e.message ? e.message : 'bridge error'); }
  }

  function processHover() {
    rafPending = false;
    var evt = pendingHoverEvent;
    pendingHoverEvent = null;
    if (!evt || mode === 'view') return;
    var target = findHandledAncestor(evt.target);
    if (!target) {
      if (hoveredEl && hoveredEl !== selectedEl) setOutline(hoveredEl, false);
      hoveredEl = null;
      post({ type: 'devspace:elementHover', info: null });
      return;
    }
    if (target === hoveredEl) return;
    if (hoveredEl && hoveredEl !== selectedEl) setOutline(hoveredEl, false);
    hoveredEl = target;
    if (target !== selectedEl) setOutline(target, true);
    post({ type: 'devspace:elementHover', info: elementInfo(target) });
  }

  function onMouseMove(e) {
    if (mode === 'view') return;
    pendingHoverEvent = e;
    if (rafPending) return;
    rafPending = true;
    (window.requestAnimationFrame || function (cb) { return window.setTimeout(cb, 16); })(processHover);
  }

  function onMouseLeave() {
    if (mode === 'view') return;
    if (hoveredEl && hoveredEl !== selectedEl) setOutline(hoveredEl, false);
    hoveredEl = null;
    post({ type: 'devspace:elementHover', info: null });
  }

  function onClick(e) {
    if (mode === 'view') return;
    e.preventDefault();
    e.stopPropagation();
    var target = findHandledAncestor(e.target);
    if (!target) return;
    if (selectedEl && selectedEl !== target) setOutline(selectedEl, false);
    selectedEl = target;
    setOutline(target, true);
    post({ type: 'devspace:elementSelect', info: elementInfo(target) });
  }

  function onSubmit(e) {
    if (mode !== 'view') { e.preventDefault(); e.stopPropagation(); }
  }

  window.addEventListener('message', handleMessage);
  window.addEventListener('mousemove', onMouseMove, true);
  window.addEventListener('mouseleave', onMouseLeave, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('submit', onSubmit, true);

  post({ type: 'devspace:bridgeReady', version: PROTOCOL_VERSION });
})();
`;
