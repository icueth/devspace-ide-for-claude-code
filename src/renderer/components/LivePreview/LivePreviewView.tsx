import * as Dialog from '@radix-ui/react-dialog';
import {
  AlertCircle,
  ChevronRight,
  Download,
  FolderOpen,
  Globe,
  Loader2,
  Package,
  Play,
  RotateCw,
  Sparkles,
  Terminal,
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
  DevServerEvent,
  DevServerInfo,
} from '@shared/design';

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
const INSTALL_LOG_CAP = 50;

interface ScriptSwitchConfirm {
  nextScript: string;
}

/**
 * Top-level Live Preview pane. Owns the `DevServerInfo` snapshot and the
 * webview ref + bridge handshake. The bridge is a pure viewer — it only
 * performs the secret-key handshake so the host can verify the page's
 * origin; there is no inspect/edit overlay.
 *
 * Lifecycle:
 *   1. On mount we call `detect` + `status` in parallel — detect gives
 *      us the framework label even before the first event arrives,
 *      status tells us if a server is already running (cross-tab).
 *   2. `subscribe` arms the IPC event channel; `onEvent` rolls each
 *      `DevServerEvent` into local state. We hold an event ref to keep
 *      the listener stable across renders.
 *   3. When status flips to `running` and the webview has fired
 *      `dom-ready`, we inject the bridge handshake script.
 */
export function LivePreviewView({ projectPath }: LivePreviewViewProps) {
  const [info, setInfo] = useState<DevServerInfo>(INITIAL_INFO);
  const [logTail, setLogTail] = useState<string[]>([]);
  const [logCollapsed, setLogCollapsed] = useState(true);
  const [busy, setBusy] = useState(false);
  // ── v0.16 state ────────────────────────────────────────────────────
  // Refresh re-runs detection; UI disables refresh + start during the call.
  const [refreshing, setRefreshing] = useState(false);
  // Install state — true while `<pm> install` PTY is alive. Mirrors the
  // streaming `install_progress` events.
  const [installing, setInstalling] = useState(false);
  // Install log tail; capped at INSTALL_LOG_CAP lines. Rendered inside
  // the empty-state Install card.
  const [installLog, setInstallLog] = useState<string[]>([]);
  // Last failed install result (sticky until the user retries).
  const [installError, setInstallError] = useState<string | null>(null);
  // Manual URL the user typed in the unknown-framework empty state.
  const [manualUrl, setManualUrl] = useState('');
  const [manualUrlError, setManualUrlError] = useState<string | null>(null);
  // Selected script for the "multiple candidate scripts" empty-state
  // picker. Defaults below in an effect once detection lands.
  const [selectedScript, setSelectedScript] = useState<string>('');
  // Pending confirmation for switching scripts on a running server.
  // Null when no dialog is open.
  const [scriptSwitchConfirm, setScriptSwitchConfirm] =
    useState<ScriptSwitchConfirm | null>(null);
  // Local error string for failed start/stop calls + webview load
  // failures. Separate from `info.errorMessage` (which the backend owns)
  // so a renderer-only error doesn't get clobbered by the next event.
  const [localError, setLocalError] = useState<string | null>(null);
  // Bumped after Stop so the webview unmounts and re-mounts on the
  // next start — otherwise the previous URL stays in DOM.
  const [webviewKey, setWebviewKey] = useState(0);
  const webviewRef = useRef<WebviewTag | null>(null);
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
      if (ev.kind === 'install_progress') {
        // Route install lines to a separate buffer so they don't pollute
        // the dev-server log tail (which the user might re-read after the
        // server is up). Status hints arrive as `status` on the event.
        if (typeof ev.line === 'string') {
          setInstallLog((prev) => {
            const next = prev.concat(ev.line!);
            return next.length > INSTALL_LOG_CAP
              ? next.slice(next.length - INSTALL_LOG_CAP)
              : next;
          });
        }
        // status 'starting' → install began; backend already flipped
        // `installing` state via the action call. status 'error' is
        // surfaced through the action result, not here.
        return;
      }
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

  // Keep the empty-state script picker default in sync with detection.
  // If detection lands a `scriptName` (single happy-path script) or the
  // candidate list updates, default-select that. The user can override
  // via the dropdown.
  useEffect(() => {
    if (!selectedScript && info.scriptName) {
      setSelectedScript(info.scriptName);
      return;
    }
    // If selectedScript is no longer present in candidates (and not the
    // active scriptName), reset to a sensible default.
    if (
      selectedScript &&
      info.candidateScripts &&
      info.candidateScripts.length > 0 &&
      !info.candidateScripts.some((c) => c.name === selectedScript) &&
      info.scriptName !== selectedScript
    ) {
      setSelectedScript(info.scriptName || info.candidateScripts[0]!.name);
    }
  }, [info.candidateScripts, info.scriptName, selectedScript]);

  // ─── Action handlers ───────────────────────────────────────────────
  const handleStart = useCallback(
    async (overrides?: { scriptName?: string; manualUrl?: string }) => {
      if (busy) return;
      setBusy(true);
      setLocalError(null);
      // Wipe previous run's tail so the user sees fresh output.
      setLogTail([]);
      try {
        const next = await api.devServer.start({
          projectPath,
          ...(overrides?.scriptName ? { scriptName: overrides.scriptName } : {}),
          ...(overrides?.manualUrl ? { manualUrl: overrides.manualUrl } : {}),
        });
        // Backend immediately echoes the transition; merge defensively in
        // case `subscribe` hasn't completed before this resolves.
        setInfo((prev) => ({ ...prev, ...next }));
      } catch (err) {
        setLocalError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [busy, projectPath],
  );

  // Re-run detection without touching a running PTY. Disabled while a
  // server is starting (race with URL parser).
  const handleRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    setLocalError(null);
    try {
      const next = await api.devServer.refresh(projectPath);
      // Merge so we don't accidentally wipe transient state the backend
      // might not have re-emitted (logTail, url for a manualUrl session).
      setInfo((prev) => ({ ...prev, ...next }));
    } catch (err) {
      setLocalError((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, [projectPath, refreshing]);

  // Install dependencies in a managed PTY. Streams `install_progress`
  // events into installLog. Auto-refreshes detection on success so the
  // empty state transitions to the next priority.
  const handleInstall = useCallback(async () => {
    if (installing) return;
    setInstalling(true);
    setInstallError(null);
    setInstallLog([]);
    try {
      const result = await api.devServer.installDependencies({
        projectPath,
        ...(info.preflight?.packageManager
          ? { packageManager: info.preflight.packageManager }
          : {}),
      });
      if (!result.ok) {
        setInstallError(
          result.errorMessage ?? 'Install failed. Inspect the log above and retry.',
        );
        return;
      }
      // Success → refresh detection so preflight.hasNodeModules flips.
      try {
        const next = await api.devServer.refresh(projectPath);
        setInfo((prev) => ({ ...prev, ...next }));
      } catch {
        // Non-fatal — the user can hit Refresh manually.
      }
    } catch (err) {
      setInstallError((err as Error).message);
    } finally {
      setInstalling(false);
    }
  }, [info.preflight?.packageManager, installing, projectPath]);

  // Manual URL submit handler. Validation mirrors the backend regex
  // (localhost/127.0.0.1 + non-privileged port, no path/query). On
  // success delegates to handleStart with `manualUrl` override.
  const handleManualUrlSubmit = useCallback(async () => {
    const trimmed = manualUrl.trim();
    if (!trimmed) {
      setManualUrlError('Enter a URL like http://localhost:3000.');
      return;
    }
    if (!isValidManualUrl(trimmed)) {
      setManualUrlError(
        'URL must be http(s)://localhost or http(s)://127.0.0.1 on a non-privileged port.',
      );
      return;
    }
    setManualUrlError(null);
    await handleStart({ manualUrl: trimmed });
  }, [handleStart, manualUrl]);

  // Script-switch flow: when the running server is using script A and
  // the user picks script B from the toolbar picker, we surface a
  // confirm dialog (stopping is destructive — the user might lose HMR
  // state). On confirm: stop → start with the new scriptName.
  const handleScriptPickFromToolbar = useCallback(
    (nextScript: string) => {
      if (nextScript === info.scriptName) return;
      setScriptSwitchConfirm({ nextScript });
    },
    [info.scriptName],
  );

  const confirmScriptSwitch = useCallback(async () => {
    const target = scriptSwitchConfirm?.nextScript;
    setScriptSwitchConfirm(null);
    if (!target) return;
    if (busy) return;
    setBusy(true);
    setLocalError(null);
    try {
      await api.devServer.stop(projectPath);
      // Wipe log so user sees the new script's fresh output.
      setLogTail([]);
      const next = await api.devServer.start({
        projectPath,
        scriptName: target,
      });
      setInfo((prev) => ({ ...prev, ...next }));
      setSelectedScript(target);
      setWebviewKey((k) => k + 1);
    } catch (err) {
      setLocalError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [busy, projectPath, scriptSwitchConfirm]);

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

  // ─── Webview lifecycle: attach + bridge handshake inject ───────
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
        () => undefined,
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
        // Bridge confirmed live + origin verified. Nothing else to do —
        // the viewer doesn't push any state into the page.
        return;
      }
      if (type === 'devspace:dev:bridgeError') {
        const message = (parsed as { message?: string }).message;
        if (message) setLocalError(`Preview bridge error: ${message}`);
        return;
      }
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
        onStart={(scriptName) =>
          void handleStart(scriptName ? { scriptName } : undefined)
        }
        onManualUrlStart={(url) => void handleStart({ manualUrl: url })}
        onInstall={() => void handleInstall()}
        installing={installing}
        installLog={installLog}
        installError={installError}
        refreshing={refreshing}
        onRefresh={() => void handleRefresh()}
        selectedScript={selectedScript}
        onSelectedScriptChange={setSelectedScript}
        manualUrl={manualUrl}
        onManualUrlChange={(v) => {
          setManualUrl(v);
          if (manualUrlError) setManualUrlError(null);
        }}
        manualUrlError={manualUrlError}
        onManualUrlSubmit={() => void handleManualUrlSubmit()}
        busy={busy}
      />
    );
  }, [
    attachWebview,
    busy,
    handleInstall,
    handleManualUrlSubmit,
    handleRefresh,
    handleStart,
    info,
    installError,
    installLog,
    installing,
    manualUrl,
    manualUrlError,
    refreshing,
    selectedScript,
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
        onRefresh={() => void handleRefresh()}
        refreshing={refreshing}
        onScriptChange={handleScriptPickFromToolbar}
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
      </div>

      <ScriptSwitchConfirmDialog
        open={!!scriptSwitchConfirm}
        currentScript={info.scriptName}
        nextScript={scriptSwitchConfirm?.nextScript ?? ''}
        onConfirm={() => void confirmScriptSwitch()}
        onCancel={() => setScriptSwitchConfirm(null)}
      />
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
  /** Start the dev server; pass scriptName when picking from a candidates list. */
  onStart: (scriptName?: string) => void;
  /** Start in manual-URL mode (bypasses PTY entirely). */
  onManualUrlStart: (url: string) => void;
  /** Run `<pm> install`. */
  onInstall: () => void;
  installing: boolean;
  installLog: string[];
  installError: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  selectedScript: string;
  onSelectedScriptChange: (s: string) => void;
  manualUrl: string;
  onManualUrlChange: (v: string) => void;
  manualUrlError: string | null;
  onManualUrlSubmit: () => void;
  busy: boolean;
}

/**
 * Layered empty state — drives the user from a fresh clone to a running
 * dev server through four prioritized fallbacks:
 *
 *  1. Preflight fail (no node_modules) → Install CTA + streaming log
 *  2. Multiple candidate dev scripts   → Script picker + Start
 *  3. Unknown framework                → Manual URL OR detected list
 *  4. Happy path                       → Single Start button + Refresh
 *
 * Each branch is fully self-contained so the user can recover without
 * leaving the Live Preview tab.
 */
function IdleState({
  info,
  onStart,
  onManualUrlStart,
  onInstall,
  installing,
  installLog,
  installError,
  refreshing,
  onRefresh,
  selectedScript,
  onSelectedScriptChange,
  manualUrl,
  onManualUrlChange,
  manualUrlError,
  onManualUrlSubmit,
  busy,
}: IdleStateProps) {
  // ── Priority 1: deps not installed ───────────────────────────────
  if (info.preflight && info.preflight.hasNodeModules === false) {
    return (
      <PreflightFailState
        packageManager={info.preflight.packageManager}
        installing={installing}
        installLog={installLog}
        installError={installError}
        onInstall={onInstall}
        onRefresh={onRefresh}
        refreshing={refreshing}
        busy={busy}
      />
    );
  }

  // ── Priority 2: multiple candidate dev scripts ───────────────────
  if (info.candidateScripts && info.candidateScripts.length > 1) {
    return (
      <MultipleScriptsState
        info={info}
        candidates={info.candidateScripts}
        selectedScript={selectedScript || info.scriptName}
        onSelectedScriptChange={onSelectedScriptChange}
        onStart={onStart}
        onRefresh={onRefresh}
        refreshing={refreshing}
        busy={busy}
      />
    );
  }

  // ── Priority 3: unknown framework — manual URL fallback ──────────
  if (info.kind === 'unknown') {
    return (
      <UnknownFrameworkState
        manualUrl={manualUrl}
        onManualUrlChange={onManualUrlChange}
        manualUrlError={manualUrlError}
        onManualUrlSubmit={onManualUrlSubmit}
        onManualUrlStart={onManualUrlStart}
        onRefresh={onRefresh}
        refreshing={refreshing}
        busy={busy}
      />
    );
  }

  // ── Priority 4: happy path ───────────────────────────────────────
  return (
    <HappyPathState
      info={info}
      onStart={onStart}
      onRefresh={onRefresh}
      refreshing={refreshing}
      busy={busy}
    />
  );
}

// ─── Priority 1: Install dependencies CTA ────────────────────────────

interface PreflightFailStateProps {
  packageManager: 'pnpm' | 'yarn' | 'npm' | 'bun';
  installing: boolean;
  installLog: string[];
  installError: string | null;
  onInstall: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  busy: boolean;
}

function PreflightFailState({
  packageManager,
  installing,
  installLog,
  installError,
  onInstall,
  onRefresh,
  refreshing,
  busy,
}: PreflightFailStateProps) {
  const installDisabled = installing || busy;
  return (
    <div className="flex h-full w-full items-start justify-center overflow-y-auto bg-surface px-6 py-10">
      <div className="w-full max-w-md text-center">
        <EmptyStateIcon Icon={Package} />
        <div className="text-[13px] font-medium text-text">
          Dependencies not installed
        </div>
        <div className="mt-1.5 text-[11px] text-text-muted">
          Run <code className="font-mono text-text-secondary">{packageManager} install</code>{' '}
          to install dependencies before starting the dev server.
        </div>

        {installError && (
          <div
            role="alert"
            className="mt-3 rounded-[6px] border border-semantic-error/40 bg-[rgba(239,68,68,0.08)] px-3 py-2 text-left text-[11px] text-semantic-error"
          >
            <div className="font-medium">Install failed</div>
            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[10.5px]">
              {installError}
            </pre>
          </div>
        )}

        {installing ? (
          <InstallProgressLog lines={installLog} />
        ) : (
          <button
            type="button"
            onClick={onInstall}
            disabled={installDisabled}
            className={cn(
              'mt-4 inline-flex h-[34px] items-center gap-2 rounded-[8px] px-4 text-[12px] font-medium transition',
              installDisabled
                ? 'pointer-events-none border border-border bg-surface-3 text-text-muted opacity-60'
                : 'text-white hover:brightness-110',
            )}
            style={
              installDisabled
                ? undefined
                : {
                    background:
                      'linear-gradient(135deg, var(--color-accent), var(--color-accent-3))',
                    boxShadow: '0 2px 8px rgba(76,141,255,0.25)',
                  }
            }
          >
            <Download size={13} />
            Install with {packageManager}
          </button>
        )}

        <div className="mt-3 flex items-center justify-center gap-2 text-[10.5px] text-text-dim">
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing || installing}
            className="inline-flex items-center gap-1 rounded-[4px] px-2 py-1 transition hover:bg-surface-3 hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
          >
            {refreshing ? (
              <Loader2 size={10} className="animate-spin" />
            ) : (
              <RotateCw size={10} />
            )}
            Refresh detection
          </button>
          <span aria-hidden>·</span>
          <span>
            Already ran install in another terminal? Hit refresh.
          </span>
        </div>
      </div>
    </div>
  );
}

// Compact streaming-log card shown while `<pm> install` is running.
// Lines come from the `install_progress` event subscription, capped at
// INSTALL_LOG_CAP. We show the last 8 — enough to feel alive without
// dominating the panel.
function InstallProgressLog({ lines }: { lines: string[] }) {
  const visible = useMemo(() => lines.slice(-8), [lines]);
  return (
    <div className="mt-4 rounded-[6px] border border-border-subtle bg-surface-2 text-left">
      <div className="flex items-center gap-1.5 border-b border-border-subtle bg-surface-3 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-text-muted">
        <Loader2 size={10} className="animate-spin text-accent" />
        <Terminal size={10} />
        Installing dependencies
      </div>
      <div className="max-h-44 overflow-auto px-2 py-1.5 font-mono text-[10.5px] leading-snug text-text-secondary">
        {visible.length === 0 ? (
          <div className="italic text-text-dim">Waiting for output…</div>
        ) : (
          visible.map((line, i) => (
            <div key={`${i}-${line.slice(0, 8)}`} className="whitespace-pre-wrap">
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ─── Priority 2: Multiple candidate scripts ──────────────────────────

interface MultipleScriptsStateProps {
  info: DevServerInfo;
  candidates: Array<{ name: string; body: string }>;
  selectedScript: string;
  onSelectedScriptChange: (s: string) => void;
  onStart: (scriptName?: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
  busy: boolean;
}

function MultipleScriptsState({
  info,
  candidates,
  selectedScript,
  onSelectedScriptChange,
  onStart,
  onRefresh,
  refreshing,
  busy,
}: MultipleScriptsStateProps) {
  const effective =
    selectedScript ||
    info.scriptName ||
    candidates[0]?.name ||
    '';
  const startDisabled = busy || !effective;
  return (
    <div className="flex h-full w-full items-start justify-center overflow-y-auto bg-surface px-6 py-10">
      <div className="w-full max-w-md">
        <div className="text-center">
          <EmptyStateIcon Icon={Sparkles} />
          <div className="text-[13px] font-medium text-text">
            Select dev script
          </div>
          <div className="mt-1.5 text-[11px] text-text-muted">
            {candidates.length} dev-ish scripts found in{' '}
            <code className="font-mono text-text-secondary">package.json</code>
            . Pick which one to run.
          </div>
        </div>

        <div
          className="mt-4 flex flex-col gap-1.5"
          role="radiogroup"
          aria-label="Select dev script"
        >
          {candidates.map((c) => {
            const active = c.name === effective;
            return (
              <button
                key={c.name}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onSelectedScriptChange(c.name)}
                className={cn(
                  'flex flex-col items-start rounded-[8px] border px-3 py-2 text-left transition',
                  active
                    ? 'border-accent/60 bg-[rgba(76,141,255,0.10)]'
                    : 'border-border-subtle bg-surface-2 hover:border-border hover:bg-surface-3',
                )}
              >
                <span
                  className={cn(
                    'font-mono text-[12px] font-medium',
                    active ? 'text-accent' : 'text-text',
                  )}
                >
                  {c.name}
                </span>
                <span className="mt-0.5 truncate font-mono text-[10.5px] text-text-muted">
                  {c.body}
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-4 flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => onStart(effective)}
            disabled={startDisabled}
            className={cn(
              'inline-flex h-[34px] items-center gap-2 rounded-[8px] px-4 text-[12px] font-medium transition',
              startDisabled
                ? 'pointer-events-none border border-border bg-surface-3 text-text-muted opacity-60'
                : 'text-white hover:brightness-110',
            )}
            style={
              startDisabled
                ? undefined
                : {
                    background:
                      'linear-gradient(135deg, var(--color-accent), var(--color-accent-3))',
                    boxShadow: '0 2px 8px rgba(76,141,255,0.25)',
                  }
            }
          >
            <Play size={13} />
            Start
          </button>
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing || busy}
            title="Refresh detection"
            className="inline-flex h-[34px] items-center gap-1.5 rounded-[8px] border border-border-subtle bg-surface-3 px-3 text-[11px] text-text-secondary transition hover:bg-surface-4 hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
          >
            {refreshing ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <RotateCw size={12} />
            )}
            Refresh
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Priority 3: Unknown framework — manual URL fallback ─────────────

interface UnknownFrameworkStateProps {
  manualUrl: string;
  onManualUrlChange: (v: string) => void;
  manualUrlError: string | null;
  onManualUrlSubmit: () => void;
  onManualUrlStart: (url: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
  busy: boolean;
}

function UnknownFrameworkState({
  manualUrl,
  onManualUrlChange,
  manualUrlError,
  onManualUrlSubmit,
  onRefresh,
  refreshing,
  busy,
}: UnknownFrameworkStateProps) {
  return (
    <div className="flex h-full w-full items-start justify-center overflow-y-auto bg-surface px-6 py-10">
      <div className="w-full max-w-md">
        <div className="text-center">
          <EmptyStateIcon Icon={Sparkles} />
          <div className="text-[13px] font-medium text-text">
            No supported dev server detected
          </div>
          <div className="mt-1.5 text-[11px] text-text-muted">
            Auto-detection didn't find a supported framework. Live Preview
            supports{' '}
            <span className="text-text-secondary">{SUPPORTED_FRAMEWORKS_TEXT}</span>
            .
          </div>
        </div>

        <div className="mt-4 rounded-[8px] border border-border-subtle bg-surface-2 px-3 py-3">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-text">
            <Globe size={11} className="text-accent" />
            Use an already-running dev server
          </div>
          <div className="text-[10.5px] text-text-muted">
            Paste the URL of a dev server you've already started elsewhere.
            Must be <code className="font-mono">localhost</code> or{' '}
            <code className="font-mono">127.0.0.1</code>.
          </div>
          <form
            className="mt-2 flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              onManualUrlSubmit();
            }}
          >
            <input
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="http://localhost:3000"
              value={manualUrl}
              onChange={(e) => onManualUrlChange(e.target.value)}
              disabled={busy}
              aria-invalid={!!manualUrlError}
              aria-describedby={manualUrlError ? 'manual-url-error' : undefined}
              className={cn(
                'flex-1 rounded-[6px] border bg-surface-3 px-2 py-1.5 font-mono text-[11px] text-text outline-none transition',
                manualUrlError
                  ? 'border-semantic-error/60 focus:border-semantic-error'
                  : 'border-border-subtle focus:border-accent',
                busy && 'opacity-60',
              )}
            />
            <button
              type="submit"
              disabled={busy || !manualUrl.trim()}
              className={cn(
                'inline-flex h-[30px] items-center gap-1 rounded-[6px] px-3 text-[11px] font-medium transition',
                busy || !manualUrl.trim()
                  ? 'pointer-events-none border border-border bg-surface-3 text-text-muted opacity-60'
                  : 'text-white hover:brightness-110',
              )}
              style={
                busy || !manualUrl.trim()
                  ? undefined
                  : {
                      background:
                        'linear-gradient(135deg, var(--color-accent), var(--color-accent-3))',
                    }
              }
            >
              <Play size={11} />
              Use URL
            </button>
          </form>
          {manualUrlError && (
            <div
              id="manual-url-error"
              role="alert"
              className="mt-1.5 text-[10.5px] text-semantic-error"
            >
              {manualUrlError}
            </div>
          )}
        </div>

        <div className="mt-3 flex items-center justify-center gap-2 text-[10.5px] text-text-dim">
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing || busy}
            className="inline-flex items-center gap-1 rounded-[4px] px-2 py-1 transition hover:bg-surface-3 hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
          >
            {refreshing ? (
              <Loader2 size={10} className="animate-spin" />
            ) : (
              <RotateCw size={10} />
            )}
            Refresh detection
          </button>
          <span aria-hidden>·</span>
          <span>Added a config file? Hit refresh.</span>
        </div>
      </div>
    </div>
  );
}

// ─── Priority 4: Happy path ──────────────────────────────────────────

interface HappyPathStateProps {
  info: DevServerInfo;
  onStart: (scriptName?: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
  busy: boolean;
}

function HappyPathState({
  info,
  onStart,
  onRefresh,
  refreshing,
  busy,
}: HappyPathStateProps) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-surface px-6">
      <div className="max-w-md text-center">
        <EmptyStateIcon Icon={Sparkles} />
        <div className="text-[13px] font-medium text-text">
          Ready to start {frameworkLabel(info.kind)}
        </div>
        <div className="mt-1.5 text-[11px] text-text-muted">
          We'll run{' '}
          <code className="font-mono text-text-secondary">
            {info.scriptName || 'dev'}
          </code>{' '}
          and mount a webview at the URL it prints.
        </div>
        <div className="mt-4 flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => onStart()}
            disabled={busy}
            className={cn(
              'inline-flex h-[34px] items-center gap-2 rounded-[8px] px-4 text-[12px] font-medium transition',
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
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing || busy}
            title="Refresh detection"
            className="inline-flex h-[34px] items-center gap-1.5 rounded-[8px] border border-border-subtle bg-surface-3 px-3 text-[11px] text-text-secondary transition hover:bg-surface-4 hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
          >
            {refreshing ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <RotateCw size={12} />
            )}
            Refresh
          </button>
        </div>
      </div>
    </div>
  );
}

// Shared rounded gradient icon badge used at the top of each empty
// state. Centralized so the visual language stays consistent.
function EmptyStateIcon({
  Icon,
}: {
  Icon: React.ComponentType<{ size?: number; className?: string }>;
}) {
  return (
    <div
      className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-[10px]"
      style={{
        background:
          'linear-gradient(135deg, rgba(76,141,255,0.18), rgba(168,85,247,0.18))',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)',
      }}
    >
      <Icon size={20} className="text-accent" />
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
    case 'sveltekit':
      return 'SvelteKit';
    case 'nuxt':
      return 'Nuxt';
    case 'gatsby':
      return 'Gatsby';
    case 'angular':
      return 'Angular';
    case 'vue-cli':
      return 'Vue CLI';
    case 'cra':
      return 'CRA';
    case 'storybook':
      return 'Storybook';
    case 'vitepress':
      return 'VitePress';
    case 'docusaurus':
      return 'Docusaurus';
    case 'static':
      return 'Static server';
    default:
      return 'dev';
  }
}

// Human-readable list of every framework v0.16 auto-detects. Used in
// the unknown-framework empty state so the user knows what's supported.
const SUPPORTED_FRAMEWORKS_TEXT =
  'Vite, Next.js, Astro, Remix, SvelteKit, Nuxt, Gatsby, Angular, Vue CLI, CRA, Storybook, VitePress, Docusaurus, and generic static servers';

/**
 * Renderer-side mirror of `DevServerService.tryParseLocalUrl`. We validate
 * before calling `api.devServer.start({ manualUrl })` so the user sees a
 * fast, readable error instead of an IPC throw. Accepts http(s)://localhost
 * or 127.0.0.1 on a non-privileged port; rejects paths, queries, userinfo,
 * and LAN IPs.
 */
function isValidManualUrl(candidate: string): boolean {
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host !== 'localhost' && host !== '127.0.0.1') return false;
  if (u.username || u.password) return false;
  if (!u.port) return false;
  const port = Number(u.port);
  // v0.16.0 review-fix L3: reject privileged ports — the user-facing
  // error elsewhere claims "non-privileged port" so the validator must
  // actually enforce it. Dev servers never bind below 1024 anyway.
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return false;
  // v0.16.0 review-fix H1: reject paths / queries / fragments so the
  // client validator stays in sync with the backend (which strips them
  // to compute the bare origin). User pasting `localhost:3000/admin`
  // would otherwise be silently rewritten — surface "invalid" instead.
  if (u.pathname && u.pathname !== '/') return false;
  if (u.search) return false;
  if (u.hash) return false;
  return true;
}

// ─── Script-switch confirm dialog ────────────────────────────────────

interface ScriptSwitchConfirmDialogProps {
  open: boolean;
  currentScript: string;
  nextScript: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirms a destructive script switch. Stopping the running server
 * loses HMR state, so we make the user opt in via a destructive-style
 * confirm dialog.
 */
function ScriptSwitchConfirmDialog({
  open,
  currentScript,
  nextScript,
  onConfirm,
  onCancel,
}: ScriptSwitchConfirmDialogProps) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-24 z-50 w-[min(420px,85vw)] -translate-x-1/2 overflow-hidden rounded-lg border border-border-emphasis bg-surface-raised shadow-2xl">
          <Dialog.Title className="border-b border-border-subtle bg-surface-sidebar px-4 py-2 text-[12px] font-medium text-text">
            Switch dev script?
          </Dialog.Title>
          <Dialog.Description className="px-4 py-3 text-[12px] text-text-secondary">
            This will stop the running server (
            <code className="font-mono">{currentScript || '—'}</code>) and
            restart with <code className="font-mono">{nextScript}</code>.
            You'll lose any HMR state.
          </Dialog.Description>
          <div className="flex justify-end gap-2 border-t border-border-subtle bg-surface-sidebar px-3 py-2 text-[11px]">
            <button
              type="button"
              onClick={onCancel}
              className="rounded px-2 py-1 text-text-secondary hover:bg-surface-overlay hover:text-text"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              autoFocus
              className="rounded bg-accent px-3 py-1 text-white transition hover:opacity-90"
            >
              Stop and restart
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
