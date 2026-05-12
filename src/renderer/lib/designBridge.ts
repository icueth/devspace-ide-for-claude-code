// Phase B iframe bridge helpers.
//
// Renderer-side companion to `src/main/services/design/bridgeScript.ts`.
// Provides small typed wrappers around `iframe.contentWindow.postMessage`
// (outbound) and a `useDesignBridge(iframeRef, onMessage)` hook (inbound) so
// the rest of the renderer can speak protocol terms instead of raw messages.

import { useEffect } from 'react';

import type {
  DesignBridgeInbound,
  DesignBridgeMode,
  DesignBridgeOutbound,
} from '@shared/design';

export function sendToBridge(
  iframe: HTMLIFrameElement | null,
  message: DesignBridgeOutbound,
): void {
  if (!iframe) return;
  const win = iframe.contentWindow;
  if (!win) return;
  // Origin is opaque ("null") for our sandboxed Blob-URL iframe, so we
  // can't use a strict targetOrigin. The sandbox itself bounds the blast
  // radius — any other window would have to be intentionally embedded
  // by this renderer.
  win.postMessage(message, '*');
}

// ─── Sugar wrappers ────────────────────────────────────────────────────

export function sendSetMode(
  iframe: HTMLIFrameElement | null,
  mode: DesignBridgeMode,
): void {
  sendToBridge(iframe, { type: 'devspace:setMode', mode });
}

export function sendApplyEdit(
  iframe: HTMLIFrameElement | null,
  elementId: string,
  property: string,
  value: string,
): void {
  sendToBridge(iframe, {
    type: 'devspace:applyEdit',
    elementId,
    property,
    value,
  });
}

export function sendClearOverrides(iframe: HTMLIFrameElement | null): void {
  sendToBridge(iframe, { type: 'devspace:clearOverrides' });
}

export function sendRequestSnapshot(
  iframe: HTMLIFrameElement | null,
  requestId: string,
): void {
  sendToBridge(iframe, { type: 'devspace:requestSnapshot', requestId });
}

export function sendFocusElement(
  iframe: HTMLIFrameElement | null,
  elementId: string,
): void {
  sendToBridge(iframe, { type: 'devspace:focusElement', elementId });
}

// ─── Inbound hook ──────────────────────────────────────────────────────

/**
 * Runtime type guard for inbound bridge messages. Drops anything that
 * doesn't have a `devspace:*` `type` string. Doesn't validate every
 * field — the iframe is sandboxed and protocol-version-locked, so we
 * trust shape if the type tag matches.
 */
function isInboundMessage(data: unknown): data is DesignBridgeInbound {
  if (!data || typeof data !== 'object') return false;
  const type = (data as { type?: unknown }).type;
  return typeof type === 'string' && type.startsWith('devspace:');
}

/**
 * Subscribes to inbound bridge messages from the given iframe. The
 * listener is filtered by `event.source === iframe.contentWindow` so
 * we never confuse signals from other windows.
 *
 * Re-binds on iframe ref change (typically when a fresh Blob URL is
 * mounted after regeneration).
 */
export function useDesignBridge(
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
  onMessage: ((msg: DesignBridgeInbound) => void) | undefined,
): void {
  useEffect(() => {
    if (!onMessage) return;
    const handler = (event: MessageEvent) => {
      const iframe = iframeRef.current;
      if (!iframe) return;
      if (event.source !== iframe.contentWindow) return;
      if (!isInboundMessage(event.data)) return;
      onMessage(event.data);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [iframeRef, onMessage]);
}

// Type-only helper so consumers can narrow inbound messages without
// pulling the protocol union into every callsite.
export type DesignBridgeMessage = DesignBridgeInbound;
