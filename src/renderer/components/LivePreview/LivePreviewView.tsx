import {
  AlertCircle,
  ChevronRight,
  FileCode2,
  FolderOpen,
  Loader2,
  Play,
  Sparkles,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import type {
  DesignElementInfo,
  DesignWebviewMode,
  DevServerEvent,
  DevServerInfo,
} from '@shared/design';

import { EditPanel } from './EditPanel';
import { LivePreviewLogPane } from './LivePreviewLogPane';
import { LivePreviewToolbar } from './LivePreviewToolbar';
import {
  BRIDGE_LOG_PREFIX,
  buildBridgeScript,
  parseBridgeConsoleLine,
} from './webviewBridge';

// ─── Electron <webview> type wedge ──────────────────────────────────
//
// React 19's @types/react ships JSX typings for `<webview>` against
// `HTMLWebViewElement` (an alias of HTMLElement), but the *method
// surface* on Electron's actual webview tag (executeJavaScript, reload,
// addEventListener for dom-ready/console-message/etc.) is NOT modeled
// because Electron owns it. We declare a structural type for the
// methods we touch and cast the ref at attach time.
//
// Method list comes from the public Electron docs:
// https://www.electronjs.org/docs/latest/api/webview-tag

interface WebviewTag extends HTMLElement {
  src: string;
  reload: () => void;
  stop: () => void;
  executeJavaScript: (
    code: string,
    userGesture?: boolean,
  ) => Promise<unknown>;
  getURL: () => string;
  isLoading: () => boolean;
}

export interface LivePreviewViewProps {
  projectPath: string;
}

const INITIAL_INFO: DevServerInfo = {
  kind: 'unknown',
  scriptName: '',
  url: null,
  status: 'idle',
  logTail: [],
};

const LOG_TAIL_CAP = 500;

/**
 * Top-level Live Preview pane. Owns the `DevServerInfo` snapshot, the
 * webview ref + bridge handshake, and the inspect/edit mode state.
 *
 * Lifecycle:
 *   1. On mount we call `detect` + `status` in parallel — detect gives
 *      us the framework label even before the first event arrives,
 *      status tells us if a server is already running (cross-tab).
 *   2. `subscribe` arms the IPC event channel; `onEvent` rolls each
 *      `DevServerEvent` into local state. We hold an event ref to keep
 *      the listener stable across renders (same pattern DesignView uses).
 *   3. When status flips to `running` and the webview has fired
 *      `dom-ready`, we inject the bridge script.
 *   4. Mode changes are pushed into the bridge via executeJavaScript
 *      calling the `window.__devspaceSetMode` shim the bridge exposes.
 */
export function LivePreviewView({ projectPath }: LivePreviewViewProps) {
  const [info, setInfo] = useState<DevServerInfo>(INITIAL_INFO);
  const [logTail, setLogTail] = useState<string[]>([]);
  const [logCollapsed, setLogCollapsed] = useState(true);
  const [mode, setMode] = useState<DesignWebviewMode>('view');
  const [selectedElement, setSelectedElement] =
    useState<DesignElementInfo | null>(null);
  const [busy, setBusy] = useState(false);
  // Local error string for failed start/stop calls + webview load
  // failures. Separate from `info.errorMessage` (which the backend owns)
  // so a renderer-only error doesn't get clobbered by the next event.
  const [localError, setLocalError] = useState<string | null>(null);
  // Bumped after Stop so the webview unmounts and re-mounts on the
  // next start — otherwise the previous URL stays in DOM.
  const [webviewKey, setWebviewKey] = useState(0);
  const webviewRef = useRef<WebviewTag | null>(null);
  // Latest mode value, read inside the bridge `console-message` handler
  // so it stays stable across mode changes (same trick DesignView uses
  // with `modeRef` to avoid re-subscribing the listener).
  const modeRef = useRef<DesignWebviewMode>('view');
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  // Anti-forgery secrets for the bridge handshake. Fresh on every
  // dom-ready (see onDomReady below). The bridge stamps each envelope
  // with the current value; we drop anything else.
  //
  // The ref holds a small ring of *currently-accepted* secrets so an HMR
  // reload race (page's old realm fires a final envelope right after we
  // rotate) doesn't lose those last events. After the grace window the
  // previous secret is dropped — anything still arriving with it is
  // either a buggy retained reference or an attempted forgery, and gets
  // rejected like before.
  const bridgeSecretsRef = useRef<string[]>([]);
  const bridgeSecretGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Expected origin for the active dev server, derived from `info.url`.
  // Kept on a ref so the bridge `bridgeReady` handler can read the
  // latest value without re-attaching every render. An empty string
  // means "no expectation yet" and disables the check (used before the
  // first url_resolved event lands).
  const expectedOriginRef = useRef<string>('');

  // ─── Initial detection + status ────────────────────────────────────
  useEffect(() => {
    if (!projectPath) return;
    let cancelled = false;
    void (async () => {
      try {
        const [detected, current] = await Promise.all([
          api.devServer.detect(projectPath),
          api.devServer.status(projectPath),
        ]);
        if (cancelled) return;
        // `status` is the authoritative source when a server is already
        // running (e.g. opened the tab while one was started in another
        // window). `detect` is best-effort framework metadata.
        const merged: DevServerInfo = {
          ...detected,
          ...current,
          // Keep the detection-only fields when status returns an empty
          // / idle stub.
          kind: current.kind && current.kind !== 'unknown'
            ? current.kind
            : detected.kind,
          scriptName: current.scriptName || detected.scriptName,
        };
        setInfo(merged);
        if (merged.logTail && merged.logTail.length > 0) {
          setLogTail(merged.logTail.slice(-LOG_TAIL_CAP));
        }
      } catch (err) {
        if (cancelled) return;
        // Don't blow up — the backend may not be wired yet. Surface a
        // readable empty state instead of a thrown error.
        // eslint-disable-next-line no-console
        console.warn('[live-preview] initial detect/status failed:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  // ─── Event subscription ────────────────────────────────────────────
  const eventHandlerRef = useRef<(ev: DevServerEvent) => void>(() => {});
  useEffect(() => {
    eventHandlerRef.current = (ev: DevServerEvent) => {
      if (ev.kind === 'log') {
        if (typeof ev.line === 'string') {
          setLogTail((prev) => {
            const next = prev.concat(ev.line!);
            return next.length > LOG_TAIL_CAP
              ? next.slice(next.length - LOG_TAIL_CAP)
              : next;
          });
        }
        return;
      }
      if (ev.kind === 'status_changed') {
        setInfo((prev) => ({
          ...prev,
          status: ev.status ?? prev.status,
          errorMessage:
            ev.status === 'error' ? (ev.message ?? prev.errorMessage) : undefined,
        }));
        return;
      }
      if (ev.kind === 'url_resolved') {
        setInfo((prev) => ({
          ...prev,
          url: ev.url ?? null,
          status: 'running',
          startedAt: prev.startedAt ?? ev.ts,
        }));
        return;
      }
      if (ev.kind === 'crashed') {
        setInfo((prev) => ({
          ...prev,
          status: 'error',
          errorMessage: ev.message ?? 'Dev server crashed.',
        }));
      }
    };
  });

  useEffect(() => {
    if (!projectPath) return;
    let unsub: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        await api.devServer.subscribe(projectPath);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[live-preview] subscribe failed:', err);
      }
      if (cancelled) return;
      unsub = api.devServer.onEvent(projectPath, (ev) => {
        eventHandlerRef.current(ev);
      });
    })();
    return () => {
      cancelled = true;
      unsub?.();
      // Unsubscribe from main-side too so we don't accumulate ghost
      // subscribers across tab open/close cycles on the same renderer.
      void api.devServer.unsubscribe?.(projectPath).catch(() => {
        /* swallow */
      });
    };
  }, [projectPath]);

  // ─── Action handlers ───────────────────────────────────────────────
  const handleStart = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setLocalError(null);
    // Wipe previous run's tail so the user sees fresh output.
    setLogTail([]);
    try {
      const next = await api.devServer.start({ projectPath });
      // Backend immediately echoes the transition; merge defensively in
      // case `subscribe` hasn't completed before this resolves.
      setInfo((prev) => ({ ...prev, ...next }));
      setMode('view');
      setSelectedElement(null);
    } catch (err) {
      setLocalError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [busy, projectPath]);

  const handleStop = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setLocalError(null);
    try {
      const next = await api.devServer.stop(projectPath);
      setInfo((prev) => ({
        ...prev,
        ...next,
        url: null,
        status: next.status === 'idle' ? 'stopped' : next.status,
      }));
      setMode('view');
      setSelectedElement(null);
      setWebviewKey((k) => k + 1);
    } catch (err) {
      setLocalError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [busy, projectPath]);

  const handleReload = useCallback(() => {
    try {
      webviewRef.current?.reload();
    } catch (err) {
      setLocalError((err as Error).message);
    }
  }, []);

  // ─── Webview lifecycle: attach, bridge inject, mode pushing ───────
  //
  // Refs as callbacks let us register the listeners without depending
  // on a render cycle — and React 19 supports returning a cleanup
  // function from the ref callback, which is exactly the shape we need
  // since the webview events live on the DOM node.
  const attachWebview = useCallback((el: WebviewTag | null) => {
    webviewRef.current = el;
    if (!el) return undefined;

    // `partition` and `webpreferences` are set as JSX attributes on the
    // <webview> element itself so Electron reads them at element-attach
    // time. Do NOT set them via setAttribute here — too late.

    const onDomReady = () => {
      // Mint a fresh secret per dom-ready so HMR reloads rotate the
      // anti-forgery key and a stale page realm can't impersonate the
      // current bridge generation.
      const newSecret = (() => {
        try {
          return crypto.randomUUID();
        } catch {
          // crypto.randomUUID is available in all Electron versions
          // we target; this fallback exists only to make the function
          // total. Math.random is not security-grade, but losing the
          // unforgeability guarantee on the secret-less branch is
          // still no worse than v0.6.x.
          return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        }
      })();
      // Keep the previous secret valid for a short grace period so the
      // last few envelopes from the page's old realm (which may still
      // be queued behind a console flush on HMR reload) don't get
      // rejected. Anything still arriving after the grace is either a
      // buggy retained reference or a forgery attempt — drop it.
      const BRIDGE_SECRET_GRACE_MS = 5_000;
      const previous = bridgeSecretsRef.current[0];
      bridgeSecretsRef.current = previous ? [newSecret, previous] : [newSecret];
      if (bridgeSecretGraceTimerRef.current) {
        clearTimeout(bridgeSecretGraceTimerRef.current);
      }
      bridgeSecretGraceTimerRef.current = setTimeout(() => {
        bridgeSecretsRef.current = bridgeSecretsRef.current.slice(0, 1);
        bridgeSecretGraceTimerRef.current = null;
      }, BRIDGE_SECRET_GRACE_MS);
      const script = buildBridgeScript(undefined, newSecret);
      // Inject the bridge once per dom-ready. The script is idempotent
      // (window.__devspaceLivePreviewBridgeInstalled gate), so HMR
      // reloads that re-fire dom-ready are safe.
      el.executeJavaScript(script, false).then(
        () => {
          // After install, re-pin the current mode — survives reloads.
          const m = modeRef.current;
          if (m !== 'view') {
            void el.executeJavaScript(
              `window.__devspaceSetMode && window.__devspaceSetMode(${JSON.stringify(m)})`,
              false,
            );
          }
        },
        (err: unknown) => {
          // eslint-disable-next-line no-console
          console.warn('[live-preview] bridge inject failed:', err);
        },
      );
    };

    const onConsoleMessage = (
      ev: { level?: number; message?: string; sourceId?: string; line?: number } & Event,
    ) => {
      // Filter by level: bridge uses console.log → level 0 (info).
      // Electron's webview emits console-message for every framework
      // warning, deprecation notice, CSP violation, etc. — gate at level
      // 1 to keep parse work proportional to actual bridge traffic.
      if (typeof ev.level === 'number' && ev.level > 1) return;
      const msg = ev.message;
      if (typeof msg !== 'string') return;
      // Must START with the sentinel (not "contain"). User code can log
      // strings containing the sentinel substring; only logs whose first
      // characters are the sentinel are accepted as bridge envelopes.
      if (!msg.startsWith(BRIDGE_LOG_PREFIX)) return;
      const parsed = parseBridgeConsoleLine(msg, bridgeSecretsRef.current);
      if (!parsed || typeof parsed !== 'object') return;
      const type = (parsed as { type?: unknown }).type;
      if (typeof type !== 'string') return;
      // Drop late-arriving messages after unmount to avoid React state
      // updates on an unmounted component.
      if (!mountedRef.current) return;
      if (type === 'devspace:dev:bridgeReady') {
        // Origin check: the bridge stamped its `window.location.origin`
        // into the handshake. If the webview navigated off the expected
        // dev-server origin between attach and dom-ready (or a hostile
        // page slipped through `will-navigate`), drop the bridge so we
        // don't trust any subsequent envelopes from it. The expected
        // origin is empty until url_resolved lands — pre-resolution
        // bridges (rare race) are accepted as-is.
        const reportedOrigin = (parsed as { origin?: unknown }).origin;
        const expected = expectedOriginRef.current;
        if (
          expected &&
          typeof reportedOrigin === 'string' &&
          reportedOrigin !== expected
        ) {
          // eslint-disable-next-line no-console
          console.warn(
            `[live-preview] bridge origin mismatch: expected ${expected}, got ${reportedOrigin}`,
          );
          setLocalError(
            `Preview origin mismatch — got ${reportedOrigin}, expected ${expected}. Bridge disabled.`,
          );
          // Drop secrets so subsequent envelopes from this realm fail
          // the authenticator. The next dom-ready will mint new ones.
          bridgeSecretsRef.current = [];
          return;
        }
        // Bridge confirmed live — re-pin mode (covers race where
        // dom-ready fires before bridge initialization completes its
        // own setup).
        const m = modeRef.current;
        if (m !== 'view') {
          void el.executeJavaScript(
            `window.__devspaceSetMode && window.__devspaceSetMode(${JSON.stringify(m)})`,
            false,
          );
        }
        return;
      }
      if (type === 'devspace:dev:elementSelect') {
        const info = (parsed as { info?: DesignElementInfo }).info;
        if (info) setSelectedElement(info);
        return;
      }
      if (type === 'devspace:dev:bridgeError') {
        const message = (parsed as { message?: string }).message;
        if (message) setLocalError(`Preview bridge error: ${message}`);
        return;
      }
      // Hover messages are noisy; we keep them off the host state to
      // avoid a re-render on every mousemove. Add a hovered-element
      // pill later if the UX demands it.
    };

    // Guard against the user navigating the webview to an arbitrary
    // origin. The dev server is at localhost; any other origin means
    // either the page tried `location = '...'` or a form submit to an
    // external URL. We prevent the navigation entirely. This also
    // protects against phishing — a malicious dev-server page that
    // tries to redirect the user to attacker.com is stopped here.
    const onWillNavigate = (ev: { url?: string; preventDefault?: () => void }) => {
      if (!ev.url) return;
      try {
        const u = new URL(ev.url);
        const host = u.hostname.toLowerCase();
        if (host !== 'localhost' && host !== '127.0.0.1') {
          ev.preventDefault?.();
          setLocalError(
            `Blocked navigation to ${u.origin} — Live Preview is locked to localhost.`,
          );
        }
      } catch {
        ev.preventDefault?.();
      }
    };

    // Route `window.open` / target="_blank" through the system browser
    // instead of opening a child webview window. This also matches the
    // host BrowserWindow's existing window-open policy.
    const onNewWindow = (ev: { url?: string; preventDefault?: () => void }) => {
      ev.preventDefault?.();
      if (ev.url) {
        try {
          window.open(ev.url, '_blank', 'noopener,noreferrer');
        } catch {
          /* swallow — opening external link is best-effort */
        }
      }
    };

    const onDidFailLoad = (
      ev: { errorCode?: number; errorDescription?: string } & Event,
    ) => {
      // -3 is ABORTED, which Electron emits on normal user-driven
      // navigation cancellation. Ignore — surfacing it would scare
      // users every time they hit Reload.
      if (ev.errorCode === -3) return;
      setLocalError(
        `Webview failed to load: ${ev.errorDescription ?? 'unknown error'}`,
      );
    };

    const onCrashed = () => {
      setLocalError('Webview crashed.');
    };

    el.addEventListener('dom-ready', onDomReady);
    el.addEventListener('console-message', onConsoleMessage as EventListener);
    el.addEventListener('did-fail-load', onDidFailLoad as EventListener);
    el.addEventListener('crashed', onCrashed);
    el.addEventListener('will-navigate', onWillNavigate as EventListener);
    el.addEventListener('new-window', onNewWindow as EventListener);

    // React 19: returning a cleanup from a ref callback removes the
    // listeners when the element unmounts (e.g. when the user hits
    // Stop and we bump webviewKey).
    return () => {
      el.removeEventListener('dom-ready', onDomReady);
      el.removeEventListener(
        'console-message',
        onConsoleMessage as EventListener,
      );
      el.removeEventListener('did-fail-load', onDidFailLoad as EventListener);
      el.removeEventListener('crashed', onCrashed);
      el.removeEventListener(
        'will-navigate',
        onWillNavigate as EventListener,
      );
      el.removeEventListener('new-window', onNewWindow as EventListener);
    };
  }, []);

  // Mount guard for state updates from async webview event handlers.
  // The webview destroys asynchronously and can emit a `console-message`
  // between unmount and listener removal — without this guard, React
  // logs the "setState on unmounted component" warning and we hold a
  // closure over the dead component.
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
      // Clear the grace timer so it doesn't fire after unmount and
      // touch a stale ref through the closure.
      if (bridgeSecretGraceTimerRef.current) {
        clearTimeout(bridgeSecretGraceTimerRef.current);
        bridgeSecretGraceTimerRef.current = null;
      }
      bridgeSecretsRef.current = [];
      expectedOriginRef.current = '';
    },
    [],
  );

  // Sync the expected origin ref from `info.url`. The bridge handshake
  // checks against this on `bridgeReady` so we never trust a bridge
  // running in a page whose origin no longer matches our dev server
  // (e.g. dev server was restarted on a different port between mounts).
  useEffect(() => {
    if (info.url) {
      try {
        expectedOriginRef.current = new URL(info.url).origin;
      } catch {
        expectedOriginRef.current = '';
      }
    } else {
      expectedOriginRef.current = '';
    }
  }, [info.url]);

  // Push mode changes into the bridge whenever they happen. No-op when
  // the webview isn't mounted yet (`executeJavaScript` would throw).
  useEffect(() => {
    const el = webviewRef.current;
    if (!el) return;
    if (info.status !== 'running') return;
    el.executeJavaScript(
      `window.__devspaceSetMode && window.__devspaceSetMode(${JSON.stringify(mode)})`,
      false,
    ).catch(() => {
      // Swallow — bridge may not be installed yet (between dom-ready
      // race + handshake). The next bridgeReady will re-pin.
    });
    if (mode === 'view') setSelectedElement(null);
  }, [mode, info.status]);

  // ─── Derived render decisions ──────────────────────────────────────
  const stageContent = useMemo(() => {
    if (info.status === 'error') {
      return (
        <ErrorState
          message={info.errorMessage ?? 'Dev server failed to start.'}
          onRetry={() => void handleStart()}
        />
      );
    }
    if (info.status === 'starting') {
      return <StartingState />;
    }
    if (info.status === 'running' && info.url) {
      // The webview is a real DOM element; React mounts it like any
      // other tag once the JSX namespace augmentation above is in
      // scope. We key by `${webviewKey}-${url}` so a Stop→Start cycle
      // unmounts the previous element and starts fresh.
      return (
        // `partition` and `webpreferences` MUST be present as DOM
        // attributes at element-attach time — Electron reads them when
        // the guest webContents is created. Setting them after mount via
        // setAttribute is too late (silent security regression: nodeIntegration
        // and sandbox defaults would apply on first load). React 19 passes
        // unknown lowercase JSX attributes through to the DOM element, so
        // we render them inline. Per-project partition prevents cookie /
        // localStorage / service-worker bleed across projects.
        <webview
          key={`${webviewKey}-${info.url}`}
          ref={attachWebview as unknown as React.Ref<HTMLElement>}
          src={info.url}
          partition={`persist:devspace-live:${projectPath}`}
          webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes,webSecurity=yes,allowRunningInsecureContent=no"
          className="h-full w-full border-0 bg-white"
        />
      );
    }
    // idle / stopped — show the empty state
    return (
      <IdleState
        info={info}
        onStart={() => void handleStart()}
        busy={busy}
      />
    );
  }, [
    attachWebview,
    busy,
    handleStart,
    info,
    webviewKey,
  ]);

  // ─── Empty / no project guard ──────────────────────────────────────
  if (!projectPath) {
    return (
      <div className="flex h-full items-center justify-center bg-surface text-text-muted">
        <div className="text-center">
          <FolderOpen size={24} className="mx-auto mb-2 text-text-dim" />
          <div className="text-[12px]">
            Open a project to use Live Preview.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <LivePreviewToolbar
        info={info}
        onStart={() => void handleStart()}
        onStop={() => void handleStop()}
        onReload={handleReload}
        mode={mode}
        onModeChange={setMode}
        busy={busy}
      />

      {localError && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-semantic-error/30 bg-semantic-error/10 px-3 py-1.5 text-[11px] text-semantic-error">
          <span className="truncate">{localError}</span>
          <button
            type="button"
            onClick={() => setLocalError(null)}
            className="rounded p-0.5 transition hover:bg-semantic-error/20"
            title="Dismiss"
          >
            <ChevronRight size={11} />
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 items-stretch justify-stretch bg-surface">
            {stageContent}
          </div>
          <LivePreviewLogPane
            lines={logTail}
            collapsed={logCollapsed}
            onToggle={() => setLogCollapsed((v) => !v)}
          />
        </main>

        {mode === 'inspect' && (
          <ElementInfoPanel
            info={selectedElement}
            onClose={() => setMode('view')}
            mode={mode}
          />
        )}
        {mode === 'edit' && (
          <EditPanel
            selectedElement={selectedElement}
            projectPath={projectPath}
            onClose={() => setMode('view')}
          />
        )}
      </div>
    </div>
  );
}

// Default export so the lazy-loader in EditorArea can use the standard
// `(m) => ({ default: m.X })` pattern OR a bare `import(...)` — either
// works.
export default LivePreviewView;

// ─── Sub-views ────────────────────────────────────────────────────────

interface IdleStateProps {
  info: DevServerInfo;
  onStart: () => void;
  busy: boolean;
}

function IdleState({ info, onStart, busy }: IdleStateProps) {
  const isUnknown = info.kind === 'unknown';
  return (
    <div className="flex h-full w-full items-center justify-center bg-surface px-6">
      <div className="max-w-md text-center">
        <div
          className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-[10px]"
          style={{
            background:
              'linear-gradient(135deg, rgba(76,141,255,0.18), rgba(168,85,247,0.18))',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)',
          }}
        >
          <Sparkles size={20} className="text-accent" />
        </div>
        {isUnknown ? (
          <>
            <div className="text-[13px] font-medium text-text">
              No supported dev server detected
            </div>
            <div className="mt-1.5 text-[11px] text-text-muted">
              We didn't find a Vite / Next / Astro / Remix config in this
              project. The Live Preview tab supports those frameworks today.
            </div>
            <div className="mt-3 rounded-[6px] border border-dashed border-border-subtle bg-surface-2 px-3 py-2 text-[10.5px] text-text-dim">
              Manual URL entry is coming in a follow-up patch — point any
              local server at the webview without auto-detection.
            </div>
          </>
        ) : (
          <>
            <div className="text-[13px] font-medium text-text">
              Ready to start {frameworkLabel(info.kind)}
            </div>
            <div className="mt-1.5 text-[11px] text-text-muted">
              We'll run <code className="font-mono text-text-secondary">
                {info.scriptName || 'dev'}
              </code>{' '}
              and mount a webview at the URL it prints.
            </div>
            <button
              type="button"
              onClick={onStart}
              disabled={busy}
              className={cn(
                'mt-4 inline-flex h-[34px] items-center gap-2 rounded-[8px] px-4 text-[12px] font-medium transition',
                busy
                  ? 'pointer-events-none border border-border bg-surface-3 text-text-muted opacity-60'
                  : 'text-white hover:brightness-110',
              )}
              style={
                busy
                  ? undefined
                  : {
                      background:
                        'linear-gradient(135deg, var(--color-accent), var(--color-accent-3))',
                      boxShadow: '0 2px 8px rgba(76,141,255,0.25)',
                    }
              }
            >
              <Play size={13} />
              Start {frameworkLabel(info.kind)} dev server
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function StartingState() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-surface">
      <div className="text-center">
        <Loader2
          size={22}
          className="mx-auto mb-2 animate-spin text-accent"
        />
        <div className="text-[12px] text-text">Starting dev server…</div>
        <div className="mt-1 text-[10.5px] text-text-muted">
          Tail the log pane below for real-time output.
        </div>
      </div>
    </div>
  );
}

interface ErrorStateProps {
  message: string;
  onRetry: () => void;
}

function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-surface px-6">
      <div className="max-w-md text-center">
        <AlertCircle
          size={20}
          className="mx-auto mb-2 text-semantic-error"
        />
        <div className="text-[12px] font-medium text-semantic-error">
          Dev server failed
        </div>
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-[6px] border border-semantic-error/30 bg-[rgba(239,68,68,0.05)] px-3 py-2 text-left text-[11px] text-text-secondary">
          {message}
        </pre>
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 inline-flex h-[28px] items-center gap-1.5 rounded-[6px] border border-border-subtle bg-surface-3 px-3 text-[11px] text-text transition hover:bg-surface-4"
        >
          <Play size={11} />
          Retry
        </button>
      </div>
    </div>
  );
}

interface ElementInfoPanelProps {
  info: DesignElementInfo | null;
  onClose: () => void;
  mode: DesignWebviewMode;
}

/**
 * Right-rail panel showing inspected element details. Source ref is
 * the Phase C value — it tells the user which file:line emitted the
 * element they clicked, even though write-back (0.8) can't yet touch
 * it. Layout mirrors `ElementInspector` in Design Studio so users feel
 * at home.
 */
function ElementInfoPanel({ info, onClose, mode }: ElementInfoPanelProps) {
  const title = mode === 'edit' ? 'Edit element' : 'Inspect element';
  return (
    <aside
      className="flex h-full w-[320px] shrink-0 flex-col border-l border-border bg-surface-2"
      aria-label={title}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="text-[11px] font-semibold text-text">{title}</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          title="Close panel (return to view mode)"
          className="rounded p-1 text-text-muted transition hover:bg-surface-3 hover:text-text"
        >
          <ChevronRight size={11} />
        </button>
      </div>

      {!info ? (
        <div className="flex flex-1 flex-col items-center justify-center px-4 text-center">
          <FileCode2 size={14} className="mb-1.5 text-text-dim" />
          <div className="text-[11px] text-text-muted">
            Click an element to inspect
          </div>
          <div className="mt-1 text-[10px] text-text-dim">
            Hover the preview to highlight, click to lock the selection.
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <section className="flex flex-col gap-2 border-b border-border-subtle px-3 py-3">
            <Label>Element</Label>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center rounded-[4px] bg-[rgba(76,141,255,0.18)] px-1.5 py-0.5 font-mono text-[10.5px] text-accent">
                &lt;{info.tagName.toLowerCase()}&gt;
              </span>
              {info.classes.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {info.classes.slice(0, 6).map((cls) => (
                    <span
                      key={cls}
                      className="inline-flex items-center rounded-[4px] border border-border-subtle bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-text-secondary"
                      title={cls}
                    >
                      .{cls}
                    </span>
                  ))}
                  {info.classes.length > 6 && (
                    <span className="text-[10px] text-text-dim">
                      +{info.classes.length - 6} more
                    </span>
                  )}
                </div>
              )}
            </div>
            {info.innerTextPreview && (
              <p className="whitespace-pre-wrap rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-1.5 text-[11px] leading-snug text-text-secondary">
                {info.innerTextPreview}
              </p>
            )}
          </section>

          {/* Source ref — the headline Phase C feature. Write-back isn't
              live yet, but seeing which JSX file the user clicked is the
              0.7 win we want to surface prominently. */}
          <section className="flex flex-col gap-1.5 border-b border-border-subtle px-3 py-3">
            <Label>Source</Label>
            {info.source?.ref ? (
              <div className="flex items-start gap-1.5 rounded-[6px] border border-accent/30 bg-[rgba(76,141,255,0.08)] px-2 py-1.5">
                <FileCode2
                  size={11}
                  className="mt-0.5 shrink-0 text-accent"
                />
                <span
                  className="min-w-0 break-all font-mono text-[10.5px] text-accent"
                  title={info.source.ref}
                >
                  {info.source.ref}
                </span>
              </div>
            ) : (
              <div className="text-[10.5px] italic text-text-dim">
                No source ref. The element came from a production build
                (no <code className="font-mono">_debugSource</code>) or a
                non-React framework.
              </div>
            )}
          </section>

          <section className="flex flex-col gap-1 px-3 py-3">
            <Label>Computed styles</Label>
            <StyleRow name="color" value={info.computedStyles.color} />
            <StyleRow
              name="background-color"
              value={info.computedStyles.backgroundColor}
            />
            <StyleRow
              name="font-family"
              value={info.computedStyles.fontFamily}
            />
            <StyleRow name="font-size" value={info.computedStyles.fontSize} />
            <StyleRow
              name="font-weight"
              value={info.computedStyles.fontWeight}
            />
            <StyleRow name="padding" value={info.computedStyles.padding} />
            <StyleRow name="margin" value={info.computedStyles.margin} />
            <StyleRow name="border" value={info.computedStyles.border} />
            <StyleRow
              name="border-radius"
              value={info.computedStyles.borderRadius}
            />
            <StyleRow name="display" value={info.computedStyles.display} />
            <StyleRow
              name="text-align"
              value={info.computedStyles.textAlign}
            />
          </section>

          {mode === 'edit' && (
            <section className="border-t border-border-subtle bg-surface-3 px-3 py-3">
              <div className="text-[10.5px] italic text-text-dim">
                Inline write-back ships in 0.8 (Tailwind) and 0.9 (vanilla
                CSS / styled-components / CSS Modules). For now, edit mode
                surfaces the same data as inspect mode — the source ref
                above tells you exactly where to make the change by hand.
              </div>
            </section>
          )}
        </div>
      )}
    </aside>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
      {children}
    </div>
  );
}

function StyleRow({ name, value }: { name: string; value: string | undefined }) {
  if (!value) return null;
  return (
    <div className="flex items-baseline justify-between gap-2 text-[11px]">
      <span className="shrink-0 font-mono text-text-muted">{name}</span>
      <span
        className="min-w-0 truncate text-right font-mono text-text-secondary"
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function frameworkLabel(kind: DevServerInfo['kind']): string {
  switch (kind) {
    case 'vite':
      return 'Vite';
    case 'next':
      return 'Next.js';
    case 'astro':
      return 'Astro';
    case 'remix':
      return 'Remix';
    default:
      return 'dev';
  }
}
