import * as Dialog from '@radix-ui/react-dialog';
import {
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Info,
  Paintbrush,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { DesignBriefPanel } from '@renderer/components/Design/DesignBriefPanel';
import { DesignPreview } from '@renderer/components/Design/DesignPreview';
import { DesignToolbar } from '@renderer/components/Design/DesignToolbar';
import { EditPanel } from '@renderer/components/Design/EditPanel';
import { ElementInspector } from '@renderer/components/Design/ElementInspector';
import { api } from '@renderer/lib/api';
import {
  sendApplyEdit,
  sendClearOverrides,
  sendRequestSnapshot,
  sendSetMode,
} from '@renderer/lib/designBridge';
import { cn } from '@renderer/lib/utils';
import type {
  DesignBridgeInbound,
  DesignBridgeMode,
  DesignEditOp,
  DesignElementInfo,
  DesignEvent,
  DesignMessage,
  DesignSaveEditsInput,
  DesignScreen,
  DesignScreenVersion,
  DesignSkill,
  DesignSystem,
} from '@shared/design';

// localStorage key for the inspect-mode first-time hint banner. Stored
// globally (not per-screen) — once the user dismisses it on this machine
// we never show it again across any project.
const INSPECT_HINT_LS_KEY = 'devspace:design:inspect-hint-seen';

// Responsive layout breakpoints. The brief panel is 360px wide; below
// 1400px it overlaps the iframe too much, so we auto-collapse it.
const NARROW_BREAKPOINT = 1400;

// Map a kebab-case CSS property name (the form the bridge speaks) to the
// camelCase key under `DesignElementInfo.computedStyles`. Returns null
// for properties not surfaced in the panel — callers should skip those
// instead of polluting computedStyles with unknown keys.
function cssPropertyToCamelKey(
  property: string,
): keyof DesignElementInfo['computedStyles'] | null {
  const map: Record<string, keyof DesignElementInfo['computedStyles']> = {
    'color': 'color',
    'background-color': 'backgroundColor',
    'font-size': 'fontSize',
    'font-family': 'fontFamily',
    'font-weight': 'fontWeight',
    'padding': 'padding',
    'margin': 'margin',
    'border-radius': 'borderRadius',
    'border': 'border',
    'display': 'display',
    'text-align': 'textAlign',
  };
  return map[property] ?? null;
}

export interface DesignViewProps {
  projectPath: string;
}

interface PreviewOverride {
  // When the user clicks a non-latest version, we override the iframe
  // src so they can see it without mutating the registry. Cleared
  // whenever the active screen changes or a new generation completes.
  // We carry the version id directly so the renderer can ask the main
  // process for the historical HTML via `api.design.readHtml`.
  screenId: string;
  versionId: string;
}

/**
 * Main Design Studio pane. Composes the toolbar, the iframe preview,
 * the brief / history side panel, and a thin sidebar listing every
 * screen in the project. The component owns:
 *   • screen list + active screen state
 *   • skill / system catalogs (loaded once per project)
 *   • the toolbar form (currently-typed brief, selected skill/system)
 *   • iframe preview override (clicking an old version)
 *
 * All persistence happens through `api.design.*`. The backend streams
 * `DesignEvent`s via `api.design.onEvent`, which we merge into local
 * state so the UI updates in real time without re-fetching.
 */
export function DesignView({ projectPath }: DesignViewProps) {
  const [screens, setScreens] = useState<DesignScreen[]>([]);
  const [activeScreenId, setActiveScreenId] = useState<string | null>(null);
  const [skills, setSkills] = useState<DesignSkill[]>([]);
  const [systems, setSystems] = useState<DesignSystem[]>([]);
  const [skillSlug, setSkillSlug] = useState<string | null>(null);
  const [systemSlug, setSystemSlug] = useState<string | null>(null);
  const [brief, setBrief] = useState('');
  // v0.14 Goal 2 — optional page-name hint. Threaded through both the
  // create call (initial generation) and follow-ups. Empty string =
  // "the page" generic; the prompt builder collapses it to nothing.
  const [pageName, setPageName] = useState('');
  const [briefPanelOpen, setBriefPanelOpen] = useState(true);
  const [preview, setPreview] = useState<PreviewOverride | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [toolbarError, setToolbarError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // v0.10: chat-style transcript for the active screen. Owned here (not
  // in DesignBriefPanel) because the event stream feeds into it and the
  // follow-up handler lives on this component. Reset whenever the
  // active screen changes; eagerly loaded via api.design.listMessages
  // so legacy screens get a synthetic seed without renderer logic.
  const [messages, setMessages] = useState<DesignMessage[]>([]);
  const onEventRef = useRef<((ev: DesignEvent) => void) | null>(null);

  // ─── Phase B inspect/edit state ─────────────────────────────────────
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [mode, setMode] = useState<DesignBridgeMode>('view');
  const [selectedElement, setSelectedElement] =
    useState<DesignElementInfo | null>(null);
  const [, setHoveredElement] = useState<DesignElementInfo | null>(null);
  const [pendingEdits, setPendingEdits] = useState<DesignEditOp[]>([]);
  const [saving, setSaving] = useState(false);
  // Pending snapshot promise resolver — set when the user clicks
  // "Save edits", cleared when the iframe replies (or we timeout).
  const snapshotWaiterRef = useRef<{
    requestId: string;
    resolve: (snap: { html: string; ops: DesignEditOp[] }) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);

  // ─── F1 dialog state ────────────────────────────────────────────────
  // window.prompt() / window.confirm() are NO-OPs in Electron 28+, so we
  // route all three sites (save-note, discard-confirm, delete-confirm)
  // through controlled Radix dialogs whose results resolve into a Promise.
  // A single nullable state object per dialog guarantees only one is open
  // at a time and prevents stacking when the user spam-clicks.
  const [saveNoteRequest, setSaveNoteRequest] = useState<{
    resolve: (note: string | null) => void;
  } | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<{
    title: string;
    body: string;
    confirmLabel?: string;
    danger?: boolean;
    resolve: (ok: boolean) => void;
  } | null>(null);

  // ─── U3: inspect-mode first-time hint ───────────────────────────────
  // Visible only the first time a user enters Inspect mode on this
  // machine. Persists "seen" in localStorage so it never reappears once
  // dismissed (manually or by 8s auto-hide).
  const [showInspectHint, setShowInspectHint] = useState(false);

  // ─── U6: responsive narrow-window auto-collapse ─────────────────────
  // We watch window.innerWidth via a debounced resize listener. When the
  // window crosses from wide → narrow we override briefPanelOpen to false
  // ONCE so the user isn't stuck with a squashed iframe. We only touch
  // their open state on the falling edge — going wide doesn't auto-open,
  // so the user's intent ("I closed this") is respected.
  const wasNarrowRef = useRef<boolean>(false);
  // v0.13 LOW #3: once the user opens the brief panel after an
  // auto-collapse, suppress further auto-collapse for the lifetime of
  // this mount. They've expressed intent — stop fighting them on every
  // resize-edge crossing.
  const userOverrideRef = useRef<boolean>(false);
  // v0.13 MED #1: tracks the moment a dialog dismissed itself, so a
  // held-Esc (key-repeat) doesn't also trigger our doc-level mode→view
  // handler one tick later. Cleared after a short cooldown.
  const dialogJustClosedAtRef = useRef<number>(0);

  // ─── Initial load ────────────────────────────────────────────────────
  useEffect(() => {
    if (!projectPath) return;
    let cancelled = false;
    void (async () => {
      try {
        const [list, skillList, systemList] = await Promise.all([
          api.design.list(projectPath),
          api.design.listSkills(projectPath),
          api.design.listSystems(projectPath),
        ]);
        if (cancelled) return;
        setScreens(list);
        setSkills(skillList);
        setSystems(systemList);
        // Default the skill picker to whichever is first in scope-priority
        // order: project > global > builtin. The toolbar's group renderer
        // already enforces that order visually.
        if (skillList.length > 0) {
          const preferred =
            skillList.find((s) => s.scope === 'project') ??
            skillList.find((s) => s.scope === 'global') ??
            skillList[0]!;
          setSkillSlug(preferred.slug);
        }
        if (list.length > 0) setActiveScreenId(list[0]!.id);
      } catch (err) {
        // listing is best-effort — backend may not be wired yet (Phase A
        // stub returns []). Don't blow up the pane.
        console.warn('[design] initial load failed:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  // ─── Live event stream ──────────────────────────────────────────────
  useEffect(() => {
    if (!projectPath) return;
    let unsub: (() => void) | null = null;
    let cancelled = false;

    void (async () => {
      try {
        await api.design.subscribe(projectPath);
      } catch (err) {
        // Backend may not implement subscribe yet — keep the UI alive.
        console.warn('[design] subscribe failed:', err);
      }
      if (cancelled) return;
      unsub = api.design.onEvent(projectPath, (ev) => {
        onEventRef.current?.(ev);
      });
    })();

    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [projectPath]);

  // Keep the event handler closure fresh without re-subscribing on every
  // render — the IPC bridge gives one callback slot per `(projectPath, cb)`
  // pair, so churning it would leak listeners.
  useEffect(() => {
    onEventRef.current = (ev: DesignEvent) => {
      setScreens((prev) => {
        if (ev.kind === 'screen_deleted') {
          return prev.filter((s) => s.id !== ev.screenId);
        }
        if (ev.kind === 'screen_created') {
          if (!ev.screen) return prev;
          if (prev.some((s) => s.id === ev.screen!.id)) return prev;
          return [ev.screen, ...prev];
        }
        // For every "*_updated" / "*_complete" / "*_error" event the
        // backend ships the new screen state. Progress events without a
        // payload just touch `updatedAt` so the version list re-renders.
        if (ev.screen) {
          const next = ev.screen;
          const idx = prev.findIndex((s) => s.id === next.id);
          if (idx === -1) return [next, ...prev];
          const out = prev.slice();
          out[idx] = next;
          return out;
        }
        return prev;
      });
      // v0.10: transcript event fan-out. We only mutate the local
      // `messages` buffer when the event targets the currently-active
      // screen — other screens' transcripts stay on disk and reload
      // lazily on switch. This keeps the buffer bounded and avoids the
      // memory cost of holding every project transcript in memory.
      if (
        (ev.kind === 'message_appended' ||
          ev.kind === 'message_updated' ||
          ev.kind === 'message_finalized') &&
        ev.designMessage &&
        ev.screenId === activeScreenIdRef.current
      ) {
        const next = ev.designMessage;
        setMessages((prev) => {
          if (ev.kind === 'message_appended') {
            // Race-safe append: backend MIGHT have already emitted an
            // update that snuck in first (rare, but the IPC ordering
            // isn't strictly guaranteed). Dedupe by id.
            if (prev.some((m) => m.id === next.id)) {
              return prev.map((m) => (m.id === next.id ? next : m));
            }
            return [...prev, next];
          }
          // updated / finalized: patch in place. If the id hasn't been
          // appended yet (race with a fast-streaming first chunk that
          // arrived before its `message_appended`), fall through and
          // append so we never silently drop content.
          const idx = prev.findIndex((m) => m.id === next.id);
          if (idx === -1) return [...prev, next];
          const out = prev.slice();
          out[idx] = next;
          return out;
        });
      }
      // Bump the iframe cache buster ONLY on terminal completion. We
      // intentionally exclude `screen_updated` because mid-generation
      // status pings carry the previous `htmlPath` and would force the
      // iframe to reload the stale page, causing visible flicker.
      if (ev.kind === 'generation_complete' && ev.screen && ev.screen.htmlPath) {
        setPreview((p) => (p?.screenId === ev.screen!.id ? null : p));
        setReloadKey((k) => k + 1);
      }
      if (ev.kind === 'generation_error') {
        setToolbarError(ev.message ?? 'Generation failed.');
      }
    };
  });

  // Mirror the active screen id into a ref so the event handler can
  // route message_* events without re-binding on every screen switch.
  // Refs are read at event-fire time, which is exactly the staleness
  // window we need to dodge.
  const activeScreenIdRef = useRef<string | null>(activeScreenId);
  useEffect(() => {
    activeScreenIdRef.current = activeScreenId;
  }, [activeScreenId]);

  // ─── Transcript: load on screen change ──────────────────────────────
  //
  // The backend synthesizes a `[{role:'user', content: brief}]` seed
  // for legacy screens that predate v0.10, so this call always returns
  // something renderable for a screen that exists. Empty array is fine
  // (and expected) before the first follow-up turn streams in.
  useEffect(() => {
    if (!projectPath || !activeScreenId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const msgs = await api.design.listMessages(projectPath, activeScreenId);
        if (!cancelled) setMessages(msgs);
      } catch (err) {
        // Legacy / pre-wired backend may not implement listMessages.
        // Fall back to an empty transcript so the UI renders the empty
        // state instead of crashing.
        console.warn('[design] listMessages failed:', err);
        if (!cancelled) setMessages([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectPath, activeScreenId]);

  // ─── Derived state ──────────────────────────────────────────────────
  const activeScreen = useMemo(
    () => screens.find((s) => s.id === activeScreenId) ?? null,
    [screens, activeScreenId],
  );

  // Active screen's preview override resolves to a version id; otherwise
  // we show the latest (versionId stays null).
  const previewVersionId = useMemo(
    () => (preview && preview.screenId === activeScreenId ? preview.versionId : null),
    [preview, activeScreenId],
  );
  // Legacy callers (BriefPanel) read the resolved htmlPath for label
  // rendering. We still need it for the "viewing version v3" pill etc.
  const previewHtmlPath = useMemo(() => {
    if (preview && preview.screenId === activeScreenId) {
      const v = activeScreen?.versions.find((x) => x.id === preview.versionId);
      return v?.htmlPath ?? activeScreen?.htmlPath ?? null;
    }
    return activeScreen?.htmlPath ?? null;
  }, [preview, activeScreenId, activeScreen]);

  const busy = creating || activeScreen?.status === 'generating';
  const canGenerate =
    !!projectPath &&
    !!skillSlug &&
    brief.trim().length > 0 &&
    !busy &&
    skills.length > 0;

  // ─── U2: auto-expand brief panel on generation start ────────────────
  // Force the panel open on the RISING edge of `busy` so the user can see
  // the live transcript without manually unhiding it. We never auto-close
  // it on completion — once the user has the panel up, that's their call.
  const prevBusyRef = useRef<boolean>(busy);
  useEffect(() => {
    if (!prevBusyRef.current && busy) {
      setBriefPanelOpen(true);
    }
    prevBusyRef.current = busy;
  }, [busy]);

  // ─── Handlers ───────────────────────────────────────────────────────
  const handleGenerate = useCallback(async () => {
    if (!canGenerate || !skillSlug) return;
    setToolbarError(null);
    setCreating(true);
    try {
      const trimmedPageName = pageName.trim();
      const screen = await api.design.create({
        projectPath,
        // Use a short slug derived from the brief so the sidebar reads
        // sensibly even before the backend renames things. Prefer the
        // page-name hint when present — it's a more user-meaningful
        // label than a brief excerpt.
        name:
          trimmedPageName ||
          brief.trim().split(/\n/)[0]!.slice(0, 60) ||
          'Untitled screen',
        skillSlug,
        designSystemSlug: systemSlug ?? undefined,
        brief: brief.trim(),
        pageName: trimmedPageName || undefined,
      });
      // Optimistic insert — the streaming event will overwrite this in
      // place, but inserting now keeps the sidebar from flickering.
      // Mark the created screen as `generating` immediately so `busy`
      // stays true through the race between `setCreating(false)` and
      // the eventual `generation_started` IPC event. Otherwise the user
      // can spam-click and queue parallel runs.
      const optimistic: DesignScreen = { ...screen, status: 'generating' };
      setScreens((prev) =>
        prev.some((s) => s.id === optimistic.id)
          ? prev.map((s) => (s.id === optimistic.id ? optimistic : s))
          : [optimistic, ...prev],
      );
      setActiveScreenId(optimistic.id);
      setBrief('');
      // Reset the page-name hint after submit — it's a per-screen
      // choice, not a sticky preference.
      setPageName('');
    } catch (err) {
      setToolbarError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }, [brief, canGenerate, pageName, projectPath, skillSlug, systemSlug]);

  const handleCancel = useCallback(async () => {
    if (!activeScreenId) return;
    try {
      await api.design.cancel(projectPath, activeScreenId);
    } catch (err) {
      console.warn('[design] cancel failed:', err);
    }
  }, [activeScreenId, projectPath]);

  // v0.10: replaces handleRegenerate. Every follow-up appends to the
  // transcript (rather than wholesale-replacing the screen's brief)
  // and feeds prior conversation back into the next prompt. The
  // backend streams the assistant reply through `message_*` events,
  // which the local handler routes into `messages` state.
  const handleFollowUp = useCallback(
    async (text: string, opts?: { reuseTheme?: boolean }) => {
      if (!activeScreenId) return;
      setToolbarError(null);
      try {
        await api.design.followUp({
          projectPath,
          screenId: activeScreenId,
          message: text,
          designSystemSlug: systemSlug ?? undefined,
          // v0.14 Goal 3: forward the composer's keep-theme checkbox
          // state. Omit the field entirely when false so the IPC payload
          // matches the pre-0.14 shape on the common path.
          ...(opts?.reuseTheme ? { reuseTheme: true } : {}),
        });
      } catch (err) {
        setToolbarError((err as Error).message);
      }
    },
    [activeScreenId, projectPath, systemSlug],
  );

  const handleSelectVersion = useCallback(
    (version: DesignScreenVersion) => {
      if (!activeScreen) return;
      // Override the preview with the chosen version; DesignPreview will
      // fetch the historical HTML via api.design.readHtml(...,versionId).
      setPreview({ screenId: activeScreen.id, versionId: version.id });
    },
    [activeScreen],
  );

  // Mode is read out of a ref inside handleBridgeMessage so the callback
  // can stay stable (no re-binding on every mode change) while still
  // re-sending the current mode on bridgeReady. Without this, a bridge
  // re-handshake (e.g. after reloadKey bump on save) would force the
  // iframe back to 'view' even when the renderer was mid-edit.
  const modeRef = useRef<DesignBridgeMode>('view');
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  // ─── Phase B handlers ───────────────────────────────────────────────
  const handleBridgeMessage = useCallback((msg: DesignBridgeInbound) => {
    switch (msg.type) {
      case 'devspace:bridgeReady':
        // Pin the renderer's current mode into the freshly-loaded bridge.
        // This matters most after a save (which bumps reloadKey and
        // re-mounts the iframe) — without it, the new bridge bootstraps
        // in 'view' regardless of the user's actual mode.
        sendSetMode(iframeRef.current, modeRef.current);
        break;
      case 'devspace:elementHover':
        setHoveredElement(msg.info);
        break;
      case 'devspace:elementSelect':
        setSelectedElement(msg.info);
        setHoveredElement(null);
        break;
      case 'devspace:editApplied':
        setPendingEdits((prev) => {
          // Dedupe by (elementId, property) — latest wins. Empty value
          // means the override was cleared; drop the row entirely.
          const filtered = prev.filter(
            (op) =>
              !(op.elementId === msg.elementId && op.property === msg.property),
          );
          if (msg.value === '') return filtered;
          return [
            ...filtered,
            {
              elementId: msg.elementId,
              property: msg.property,
              value: msg.value,
              ts: Date.now(),
            },
          ];
        });
        // Optimistically reflect the new value back onto the selected
        // element info so the EditPanel's displayed computedStyles stay
        // current without round-tripping through the iframe.
        setSelectedElement((prev) => {
          if (!prev || prev.elementId !== msg.elementId) return prev;
          const key = cssPropertyToCamelKey(msg.property);
          if (!key) return prev;
          return {
            ...prev,
            computedStyles: { ...prev.computedStyles, [key]: msg.value },
          };
        });
        break;
      case 'devspace:snapshot': {
        const w = snapshotWaiterRef.current;
        if (w && w.requestId === msg.requestId) {
          clearTimeout(w.timer);
          snapshotWaiterRef.current = null;
          w.resolve({ html: msg.html, ops: msg.ops });
        }
        break;
      }
      case 'devspace:bridgeError':
        setToolbarError(msg.message);
        break;
      default:
        break;
    }
  }, []);

  // Push mode changes into the iframe whenever they change.
  useEffect(() => {
    sendSetMode(iframeRef.current, mode);
    if (mode === 'view') {
      setSelectedElement(null);
      setHoveredElement(null);
    }
  }, [mode]);

  // U3: show the inspect-mode hint banner the first time the user enters
  // Inspect mode on this machine. Read from localStorage at the rising
  // edge of mode === 'inspect' so we don't pay the cost on every render.
  useEffect(() => {
    if (mode !== 'inspect') return;
    let seen = false;
    try {
      seen = localStorage.getItem(INSPECT_HINT_LS_KEY) === '1';
    } catch {
      // localStorage may throw in restricted contexts (e.g. private mode
      // in some browsers). Treat as "seen" — the hint is a nice-to-have,
      // not worth crashing for.
      seen = true;
    }
    if (seen) return;
    setShowInspectHint(true);
    // Auto-dismiss after 8 seconds. Cleanup nukes the timer if the user
    // leaves inspect mode or the component unmounts before the timeout.
    const timer = setTimeout(() => {
      setShowInspectHint(false);
      try {
        localStorage.setItem(INSPECT_HINT_LS_KEY, '1');
      } catch {
        // ignore — non-critical
      }
    }, 8000);
    return () => clearTimeout(timer);
  }, [mode]);

  const dismissInspectHint = useCallback(() => {
    setShowInspectHint(false);
    try {
      localStorage.setItem(INSPECT_HINT_LS_KEY, '1');
    } catch {
      // ignore
    }
  }, []);

  // Reset edit state on screen switch so we don't bleed selections /
  // pending edits across screens. We DON'T confirm here because the
  // switch comes from a list-row click that already happened — the
  // sidebar Select handler now confirms BEFORE switching when there are
  // unsaved edits, so by the time we land here the user already agreed.
  useEffect(() => {
    setSelectedElement(null);
    setHoveredElement(null);
    setPendingEdits([]);
    setMode('view');
  }, [activeScreenId]);

  // Cancel any in-flight snapshot waiter on unmount so the timer +
  // promise don't leak across project switches or pane unmounts.
  useEffect(() => {
    return () => {
      const w = snapshotWaiterRef.current;
      if (w) {
        clearTimeout(w.timer);
        w.reject(new Error('design view unmounted'));
        snapshotWaiterRef.current = null;
      }
    };
  }, []);

  const handleEditChange = useCallback(
    ({
      elementId,
      property,
      value,
    }: {
      elementId: string;
      property: string;
      value: string;
    }) => {
      sendApplyEdit(iframeRef.current, elementId, property, value);
    },
    [],
  );

  const handleClearOverrides = useCallback(() => {
    sendClearOverrides(iframeRef.current);
    setPendingEdits([]);
  }, []);

  // F1: request an optional save-note via the dialog. Returns null if
  // the user cancels, '' if they hit Save with an empty field, or the
  // trimmed string otherwise. Wrapping the dialog as a promise keeps
  // the existing save-flow control flow readable.
  const promptSaveNote = useCallback((): Promise<string | null> => {
    return new Promise((resolve) => {
      // Defensive: if a prior request is still pending (shouldn't be —
      // the save button is gated on `saving`), resolve it as cancelled
      // so we never strand the upstream awaiter.
      setSaveNoteRequest((prev) => {
        if (prev) prev.resolve(null);
        return { resolve };
      });
    });
  }, []);

  // F1: a single-shot Promise-based confirm. Same re-entrancy guard as
  // promptSaveNote — opening twice in quick succession cancels the
  // first dialog instead of stacking them.
  const requestConfirm = useCallback(
    (opts: {
      title: string;
      body: string;
      confirmLabel?: string;
      danger?: boolean;
    }): Promise<boolean> => {
      return new Promise((resolve) => {
        setConfirmRequest((prev) => {
          if (prev) prev.resolve(false);
          return { ...opts, resolve };
        });
      });
    },
    [],
  );

  const handleSaveEdits = useCallback(async () => {
    if (!activeScreen || pendingEdits.length === 0 || saving) return;
    setSaving(true);
    setToolbarError(null);
    // crypto.randomUUID is always present in Electron renderers; no
    // fallback needed. Throwing here would mean the runtime is broken
    // long before save buttons are reachable.
    const requestId = crypto.randomUUID();

    // Prompt for the note FIRST. If the user cancels we never even
    // send a snapshot request — the iframe stays untouched, the timer
    // never starts, and there's nothing to clean up. (The original
    // flow opened the prompt AFTER the snapshot arrived, which leaked
    // the still-armed 10s timer on cancel.)
    //
    // F1: replaces window.prompt (no-op in Electron 28+) with our Radix
    // dialog. Returns null on cancel, the (possibly empty) string on save.
    const note = await promptSaveNote();
    if (note === null) {
      setSaving(false);
      return;
    }

    try {
      const snapshot = await new Promise<{ html: string; ops: DesignEditOp[] }>(
        (resolve, reject) => {
          const timer = setTimeout(() => {
            if (
              snapshotWaiterRef.current &&
              snapshotWaiterRef.current.requestId === requestId
            ) {
              snapshotWaiterRef.current = null;
              reject(new Error('Snapshot timed out after 10s'));
            }
          }, 10_000);
          snapshotWaiterRef.current = { requestId, resolve, reject, timer };
          sendRequestSnapshot(iframeRef.current, requestId);
        },
      );

      const input: DesignSaveEditsInput = {
        projectPath,
        screenId: activeScreen.id,
        html: snapshot.html,
        // Prefer the iframe-reported op list (its ordering reflects what
        // actually applied), but fall back to our local list if missing.
        ops: snapshot.ops.length > 0 ? snapshot.ops : pendingEdits,
        note: note.trim() ? note.trim() : undefined,
      };

      const updated = await api.design.saveEdits(input);
      setScreens((prev) =>
        prev.some((s) => s.id === updated.id)
          ? prev.map((s) => (s.id === updated.id ? updated : s))
          : [updated, ...prev],
      );
      setPendingEdits([]);
      setMode('view');
      setPreview(null);
      setReloadKey((k) => k + 1);
    } catch (err) {
      setToolbarError((err as Error).message ?? 'Save failed.');
    } finally {
      // Belt-and-suspenders: if the promise rejected and the waiter ref
      // is still armed, clear it so the next save can't hit a stale
      // resolver / dangling timer.
      const w = snapshotWaiterRef.current;
      if (w) {
        clearTimeout(w.timer);
        snapshotWaiterRef.current = null;
      }
      setSaving(false);
    }
  }, [activeScreen, pendingEdits, projectPath, promptSaveNote, saving]);

  // Wraps setActiveScreenId with a confirm dialog when there are unsaved
  // pending edits, so a stray sidebar click doesn't silently discard the
  // user's work.
  //
  // v0.10 bug fix: clicking the already-active screen used to early-
  // return unconditionally, which trapped the user when they had
  // clicked a historical version (preview override set) and wanted to
  // get back to the latest render — the sidebar row was the obvious
  // "home" affordance but it did nothing. Now:
  //   • same id + a preview override is active → clear the override
  //     (returns to latest version). No confirm dialog because there
  //     are no pending iframe edits to discard (preview overrides are
  //     read-only).
  //   • same id + no override → genuine no-op.
  //   • different id → existing confirm-dialog + switch path.
  const handleSelectScreen = useCallback(
    async (id: string | null) => {
      if (id === activeScreenId) {
        if (preview && preview.screenId === activeScreenId) {
          // User clicked the screen header while viewing an old version
          // — interpret as "take me back to the latest". Bump reloadKey
          // so DesignPreview re-fetches and the iframe re-mounts cleanly.
          setPreview(null);
          setReloadKey((k) => k + 1);
        }
        return;
      }
      if (pendingEdits.length > 0) {
        // F1: replaces window.confirm (no-op in Electron 28+).
        const ok = await requestConfirm({
          title: 'Discard unsaved edits?',
          body: `You have ${pendingEdits.length} unsaved edit${
            pendingEdits.length === 1 ? '' : 's'
          }. Switching screens will discard them — there's no undo.`,
          confirmLabel: 'Discard',
          // v0.13 LOW #6: this IS destructive (no undo) — render as danger.
          danger: true,
        });
        if (!ok) return;
      }
      setActiveScreenId(id);
    },
    [activeScreenId, pendingEdits.length, preview, requestConfirm],
  );

  const handleDeleteScreen = useCallback(
    async (id: string) => {
      const screen = screens.find((s) => s.id === id);
      if (!screen) return;
      // F1: replaces window.confirm (no-op in Electron 28+). Uses the
      // danger style so the destructive action stands out.
      const ok = await requestConfirm({
        title: 'Delete design?',
        body: `Delete "${screen.name}"? This removes its folder under .devspace/design/screens/.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      try {
        await api.design.delete(projectPath, id);
        setScreens((prev) => prev.filter((s) => s.id !== id));
        setActiveScreenId((curr) => (curr === id ? null : curr));
      } catch (err) {
        setToolbarError((err as Error).message);
      }
    },
    [projectPath, requestConfirm, screens],
  );

  // ─── U5: keyboard shortcuts ─────────────────────────────────────────
  // DesignView only mounts when the Design tab is active, so a plain
  // document listener is fine here — no need to disambiguate against
  // other tabs.
  //   • Cmd/Ctrl+S: save edits, only when there's something to save and
  //     we're in edit mode. preventDefault to swallow the browser's
  //     "save page" dialog.
  //   • Esc: drop out of inspect/edit back to view. We deliberately
  //     don't preventDefault when mode === 'view' so dialog Esc handling
  //     (Radix) stays responsive.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isSave =
        (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's';
      if (isSave) {
        // Only handle when we'd actually save — otherwise let the event
        // pass so a textarea Cmd+S doesn't silently get eaten.
        if (mode === 'edit' && pendingEdits.length > 0 && !saving) {
          event.preventDefault();
          void handleSaveEdits();
        }
        return;
      }
      if (event.key === 'Escape') {
        // Don't fight dialogs — if the save-note or confirm dialog is
        // open, Radix already handles Esc and we shouldn't double-fire.
        if (saveNoteRequest || confirmRequest) return;
        // v0.13 MED #1: also bail for a short cooldown after a dialog
        // dismissed itself. On macOS key-repeat (~30ms) a held Esc
        // arrives again AFTER `setState(null)` propagated, so the guard
        // above is already stale — without this cooldown the second Esc
        // would silently flip the user out of edit mode mid-dismiss.
        if (Date.now() - dialogJustClosedAtRef.current < 250) return;
        if (mode === 'edit' || mode === 'inspect') {
          setMode('view');
        }
        // mode === 'view' → no-op, no preventDefault, so other handlers
        // (selects, menus, etc.) still see the Escape.
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [
    confirmRequest,
    handleSaveEdits,
    mode,
    pendingEdits.length,
    saveNoteRequest,
    saving,
  ]);

  // ─── U6: window-width watcher ───────────────────────────────────────
  // Debounced resize listener — track `isNarrow` (under 1400px) and
  // on the rising edge (was wide, now narrow) auto-collapse the brief
  // panel. Going wide again does NOT auto-open it: the user's explicit
  // open/close gesture wins until the next narrow→wide→narrow cycle.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const evaluate = () => {
      const narrow = window.innerWidth < NARROW_BREAKPOINT;
      // v0.13 LOW #3: once the user opens the panel after auto-collapse
      // (`userOverrideRef` set in the toggle handler), we treat their
      // choice as sticky for this mount. Future wide→narrow crossings
      // don't re-collapse — they only re-collapse on a fresh mount.
      if (narrow && !wasNarrowRef.current && !userOverrideRef.current) {
        setBriefPanelOpen(false);
      }
      wasNarrowRef.current = narrow;
    };
    const onResize = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(evaluate, 150);
    };
    // Seed wasNarrowRef and apply the rule at mount.
    evaluate();
    window.addEventListener('resize', onResize);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  // ─── Empty / no project guards ───────────────────────────────────────
  if (!projectPath) {
    return (
      <div className="flex h-full items-center justify-center bg-surface text-text-muted">
        <div className="text-center">
          <FolderOpen size={24} className="mx-auto mb-2 text-text-dim" />
          <div className="text-[12px]">Open a project to use Design Studio.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <DesignToolbar
        skills={skills}
        systems={systems}
        selectedSkillSlug={skillSlug}
        selectedSystemSlug={systemSlug}
        brief={brief}
        busy={busy}
        status={activeScreen?.status ?? null}
        errorMessage={activeScreen?.errorMessage ?? toolbarError}
        canGenerate={canGenerate}
        pageName={activeScreen?.pageName ?? pageName}
        onPageNameChange={setPageName}
        // v0.14 code-review HIGH-2: pageName is set at create-time and
        // immutable for the screen's lifetime. Once a screen exists,
        // disable the field so users don't see edits that have no effect.
        // Re-enables on the empty/creating state for new screens.
        pageNameLocked={activeScreen != null}
        onSkillChange={setSkillSlug}
        onSystemChange={setSystemSlug}
        onBriefChange={setBrief}
        onGenerate={() => void handleGenerate()}
        onCancel={() => void handleCancel()}
        mode={mode}
        onModeChange={setMode}
        pendingEditsCount={pendingEdits.length}
        onSaveEdits={() => void handleSaveEdits()}
        saving={saving}
      />

      {toolbarError && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-semantic-error/30 bg-semantic-error/10 px-3 py-1.5 text-[11px] text-semantic-error">
          <span className="truncate">{toolbarError}</span>
          <button
            type="button"
            onClick={() => setToolbarError(null)}
            className="rounded p-0.5 transition hover:bg-semantic-error/20"
          >
            <ChevronRight size={11} />
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <ScreenSidebar
          screens={screens}
          activeScreenId={activeScreenId}
          onSelect={(id) => void handleSelectScreen(id)}
          onDelete={(id) => void handleDeleteScreen(id)}
        />

        <main className="flex min-w-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            {/* U3: first-time inspect-mode hint banner. Lives ABOVE the
                iframe so it never overlaps the preview itself. */}
            {showInspectHint && (
              <div className="flex shrink-0 items-center gap-2 border-b border-accent/30 bg-accent/10 px-3 py-1.5 text-[11px] text-accent">
                <Info size={11} className="shrink-0" />
                <span className="flex-1">
                  Click any element in the preview to see its details.
                </span>
                <button
                  type="button"
                  onClick={dismissInspectHint}
                  title="Dismiss"
                  className="rounded p-0.5 transition hover:bg-accent/20"
                >
                  <X size={11} />
                </button>
              </div>
            )}
            {screens.length === 0 && !activeScreenId ? (
              <WelcomeStarter
                skills={skills}
                onApply={(seed) => {
                  if (seed.skillSlug) setSkillSlug(seed.skillSlug);
                  setBrief(seed.brief);
                  setBriefPanelOpen(true);
                }}
              />
            ) : (
              <DesignPreview
                projectPath={projectPath}
                screenId={activeScreenId}
                versionId={previewVersionId}
                reloadKey={reloadKey}
                mode={mode}
                iframeRef={iframeRef}
                onBridgeMessage={handleBridgeMessage}
                status={activeScreen?.status}
                emptyLabel="Select a screen"
                emptyHint="Pick a screen from the left to preview it."
              />
            )}
          </div>

          {mode !== 'view' && (
            <InspectSidePanel
              mode={mode}
              info={selectedElement}
              pendingEdits={pendingEdits}
              onChange={handleEditChange}
              onClearOverrides={handleClearOverrides}
              onClose={() => setMode('view')}
            />
          )}

          <DesignBriefPanel
            screen={activeScreen}
            activeHtmlPath={previewHtmlPath}
            open={briefPanelOpen}
            onToggle={() => {
              // v0.13 LOW #3: user toggled explicitly — record intent so
              // U6's resize listener stops auto-collapsing on every
              // wide→narrow crossing this mount.
              userOverrideRef.current = true;
              setBriefPanelOpen((v) => !v);
            }}
            messages={messages}
            onFollowUp={handleFollowUp}
            onCancel={handleCancel}
            busy={busy}
            error={toolbarError}
            onSelectVersion={handleSelectVersion}
          />
        </main>
      </div>

      {/* F1: dialogs live at the bottom of the tree so they can portal
          out without re-mounting on every state update. Both are
          controlled by a single nullable object whose resolver is
          invoked on accept/cancel. */}
      <SaveNoteDialog
        request={saveNoteRequest}
        onClose={(note) => {
          const req = saveNoteRequest;
          setSaveNoteRequest(null);
          // v0.13 MED #1: stamp the cooldown so a held Esc doesn't also
          // trigger the doc-level mode→view handler.
          dialogJustClosedAtRef.current = Date.now();
          req?.resolve(note);
        }}
      />
      <ConfirmDialog
        open={!!confirmRequest}
        title={confirmRequest?.title ?? ''}
        body={confirmRequest?.body ?? ''}
        confirmLabel={confirmRequest?.confirmLabel}
        danger={confirmRequest?.danger}
        onConfirm={() => {
          const req = confirmRequest;
          setConfirmRequest(null);
          dialogJustClosedAtRef.current = Date.now();
          req?.resolve(true);
        }}
        onCancel={() => {
          const req = confirmRequest;
          setConfirmRequest(null);
          dialogJustClosedAtRef.current = Date.now();
          req?.resolve(false);
        }}
      />
    </div>
  );
}

// U1: example briefs shown when the project has zero designs. Each card
// pre-fills the toolbar's brief field (and skill slug when specified) so
// the user only has to click Generate to see a result. We intentionally
// keep the briefs project-stack-agnostic so they make sense before any
// project context has been auto-detected.
interface WelcomeStarterProps {
  skills: DesignSkill[];
  onApply: (seed: { skillSlug: string | null; brief: string }) => void;
}

interface ExampleBrief {
  title: string;
  desc: string;
  brief: string;
  // When the recommended skill is available we'll select it. Falls back
  // to "use whatever's currently selected" if the slug isn't in the
  // user's installed skills.
  preferredSkillSlugs: string[];
}

const EXAMPLE_BRIEFS: ExampleBrief[] = [
  {
    title: 'SaaS landing page',
    desc: 'Hero, feature grid, social proof, pricing teaser',
    brief:
      'Generate a SaaS landing page for a developer tool. Sections: hero with headline + sub + dual CTA, three-column feature grid with icons, a logos strip for social proof, a 3-tier pricing teaser, and a footer with sitemap. Keep it dense and confident, not whitespace-heavy.',
    preferredSkillSlugs: ['landing-page', 'website', 'web'],
  },
  {
    title: 'Admin dashboard',
    desc: 'Sidebar + KPI cards + table + activity feed',
    brief:
      'Generate an admin dashboard layout. Left sidebar nav with 6 items (Dashboard, Customers, Orders, Products, Reports, Settings). Top bar with search + user menu. Main: 4 KPI cards across the top, then a wide chart card, a recent-orders table, and a right-rail activity feed. Use a calm, professional palette.',
    preferredSkillSlugs: ['dashboard', 'admin', 'app'],
  },
  {
    title: 'Mobile onboarding',
    desc: 'Three-step intro carousel with CTA',
    brief:
      'Generate a mobile-first onboarding screen at 390px wide. Three swipeable intro cards with illustrations placeholders, page dots, a Skip link top-right, and a primary "Get started" CTA pinned to the bottom. Light, optimistic vibe.',
    preferredSkillSlugs: ['mobile', 'onboarding', 'app'],
  },
  {
    title: 'Pricing comparison',
    desc: 'Three plans + feature matrix + FAQ',
    brief:
      'Generate a pricing page: three tier cards (Free / Pro highlighted / Team) with bullet feature lists, then a detailed feature-comparison matrix below, and an FAQ accordion of 6 common questions. Use clear hierarchy — the Pro card should feel like the obvious choice.',
    preferredSkillSlugs: ['pricing', 'landing-page', 'website'],
  },
];

function WelcomeStarter({ skills, onApply }: WelcomeStarterProps) {
  const slugSet = useMemo(() => new Set(skills.map((s) => s.slug)), [skills]);
  return (
    <div className="flex flex-1 flex-col items-center overflow-y-auto bg-surface-2 px-6 py-10">
      <div className="w-full max-w-[760px]">
        <div className="mb-1 flex items-center gap-2">
          <Paintbrush size={14} className="text-accent" />
          <h2 className="text-[15px] font-semibold text-text">
            Welcome to Design Studio
          </h2>
        </div>
        <p className="mb-6 max-w-[560px] text-[12px] leading-relaxed text-text-muted">
          Generate full HTML designs from a natural-language brief. Pick a
          starter below to pre-fill the brief — or write your own in the
          toolbar above and click Generate.
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {EXAMPLE_BRIEFS.map((ex) => {
            const matchedSkill =
              ex.preferredSkillSlugs.find((s) => slugSet.has(s)) ?? null;
            return (
              <button
                key={ex.title}
                type="button"
                onClick={() =>
                  onApply({ skillSlug: matchedSkill, brief: ex.brief })
                }
                className="group flex flex-col items-start rounded-lg border border-border-subtle bg-surface px-3 py-2.5 text-left transition hover:border-accent/40 hover:bg-surface-3"
              >
                <span className="text-[12px] font-semibold text-text group-hover:text-accent">
                  {ex.title}
                </span>
                <span className="mt-0.5 text-[10.5px] leading-snug text-text-muted">
                  {ex.desc}
                </span>
                {matchedSkill && (
                  <span className="mt-1.5 inline-flex items-center gap-1 rounded bg-surface-3 px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide text-text-dim">
                    skill: {matchedSkill}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <p className="mt-6 text-[10.5px] text-text-dim">
          Tip — DevSpace auto-detects your framework, styling stack, and
          component library so generations match your project. View what
          it's using in Settings → Design.
        </p>
      </div>
    </div>
  );
}

interface ScreenSidebarProps {
  screens: DesignScreen[];
  activeScreenId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

function ScreenSidebar({
  screens,
  activeScreenId,
  onSelect,
  onDelete,
}: ScreenSidebarProps) {
  const [collapsed, setCollapsed] = useState(false);

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        title="Show screens"
        className="flex h-full w-7 shrink-0 items-center justify-center border-r border-border bg-surface-2 text-text-muted transition hover:bg-surface-3 hover:text-text"
      >
        <ChevronRight size={12} />
      </button>
    );
  }

  return (
    <aside
      className="flex h-full w-[210px] shrink-0 flex-col border-r border-border bg-surface-2"
      aria-label="Design screens"
    >
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-3">
        <Paintbrush size={11} className="text-text-muted" />
        <span className="text-[11px] font-semibold text-text">Screens</span>
        <span className="text-[10px] text-text-dim">({screens.length})</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          title="Hide sidebar"
          className="rounded p-1 text-text-muted transition hover:bg-surface-3 hover:text-text"
        >
          <ChevronDown size={11} className="-rotate-90" />
        </button>
      </div>

      {screens.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center px-4 text-center">
          <Plus size={14} className="mb-1.5 text-text-dim" />
          <div className="text-[11px] text-text-muted">No designs yet.</div>
          <div className="mt-1 text-[10px] text-text-dim">
            Use the toolbar above to generate your first screen.
          </div>
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto py-1">
          {screens.map((s) => (
            <ScreenRow
              key={s.id}
              screen={s}
              isActive={s.id === activeScreenId}
              onClick={() => onSelect(s.id)}
              onDelete={() => onDelete(s.id)}
            />
          ))}
        </ul>
      )}
    </aside>
  );
}

interface ScreenRowProps {
  screen: DesignScreen;
  isActive: boolean;
  onClick: () => void;
  onDelete: () => void;
}

function ScreenRow({ screen, isActive, onClick, onDelete }: ScreenRowProps) {
  return (
    <li>
      <div
        className={cn(
          'group flex items-center gap-1.5 px-2 py-1.5 transition',
          isActive
            ? 'bg-[rgba(76,141,255,0.18)]'
            : 'hover:bg-surface-3',
        )}
      >
        <button
          type="button"
          onClick={onClick}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <StatusDot status={screen.status} />
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-[11.5px]',
              isActive ? 'text-text' : 'text-text-secondary',
            )}
          >
            {screen.name}
          </span>
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="Delete screen"
          className="rounded p-1 text-text-muted opacity-0 transition hover:bg-surface-4 hover:text-semantic-error group-hover:opacity-100"
        >
          <Trash2 size={10} />
        </button>
      </div>
    </li>
  );
}

interface InspectSidePanelProps {
  mode: DesignBridgeMode;
  info: DesignElementInfo | null;
  pendingEdits: DesignEditOp[];
  onChange: (op: {
    elementId: string;
    property: string;
    value: string;
  }) => void;
  onClearOverrides: () => void;
  onClose: () => void;
}

/**
 * Right-rail companion to the iframe in Phase B. In 'inspect' mode it
 * shows the read-only `ElementInspector`; in 'edit' mode it swaps to the
 * `EditPanel`. The header carries a close button that drops back to
 * 'view' mode (and clears local selection state via DesignView's effect).
 */
function InspectSidePanel({
  mode,
  info,
  pendingEdits,
  onChange,
  onClearOverrides,
  onClose,
}: InspectSidePanelProps) {
  const title = mode === 'edit' ? 'Edit element' : 'Inspect element';
  return (
    <aside
      className="flex h-full w-[320px] shrink-0 flex-col border-l border-border bg-surface-2"
      aria-label={title}
    >
      <div
        className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3"
        style={{ background: 'var(--color-surface-2)' }}
      >
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
      {mode === 'edit' ? (
        <EditPanel
          info={info}
          pendingEdits={pendingEdits}
          onChange={onChange}
          onClearOverrides={onClearOverrides}
        />
      ) : (
        <ElementInspector info={info} />
      )}
    </aside>
  );
}

function StatusDot({ status }: { status: DesignScreen['status'] }) {
  const color =
    status === 'ready'
      ? 'bg-semantic-success'
      : status === 'generating'
        ? 'bg-accent animate-pulse'
        : status === 'error'
          ? 'bg-semantic-error'
          : 'bg-text-dim';
  return (
    <span
      className={cn('h-1.5 w-1.5 shrink-0 rounded-full', color)}
      title={status}
    />
  );
}

// ─── F1: dialogs ──────────────────────────────────────────────────────
//
// Both dialogs are module-private (never re-used outside DesignView) and
// share the visual language of `PromptDialog.tsx`: bordered rounded card
// over a 40% black overlay, muted header bar, footer Cancel/Confirm pair.

interface SaveNoteDialogProps {
  request: { resolve: (note: string | null) => void } | null;
  onClose: (note: string | null) => void;
}

/**
 * Optional-note prompt shown when saving in-iframe edits as a new
 * version. Enter submits with the current value (possibly empty), Esc
 * cancels. `request` being non-null = dialog open; we mirror its
 * lifecycle into local `value` state on open.
 */
function SaveNoteDialog({ request, onClose }: SaveNoteDialogProps) {
  const [value, setValue] = useState('');
  const open = !!request;
  const ref = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (request) {
      setValue('');
      queueMicrotask(() => ref.current?.focus());
    }
  }, [request]);

  const submit = () => {
    if (!request) return;
    // Trim happens upstream — pass the raw value so '' means "no note"
    // but is still a save (vs. null = cancel).
    onClose(value);
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        // Radix calls this for Esc / overlay clicks. Map either to cancel.
        if (!o) onClose(null);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-24 z-50 w-[min(480px,85vw)] -translate-x-1/2 overflow-hidden rounded-lg border border-border-emphasis bg-surface-raised shadow-2xl">
          <Dialog.Title className="border-b border-border-subtle bg-surface-sidebar px-4 py-2 text-[12px] font-medium text-text">
            Save edits as new version
          </Dialog.Title>
          <div className="space-y-2 p-3">
            <input
              ref={ref}
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="Optional note (e.g. 'tightened header spacing')"
              className="w-full rounded border border-border bg-surface px-2 py-1.5 text-[13px] text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
            <div className="text-[10.5px] text-text-dim">
              Leave blank for no note. Press Enter to save, Esc to cancel.
            </div>
          </div>
          <div className="flex justify-end gap-2 border-t border-border-subtle bg-surface-sidebar px-3 py-2 text-[11px]">
            <button
              type="button"
              onClick={() => onClose(null)}
              className="rounded px-2 py-1 text-text-secondary hover:bg-surface-overlay hover:text-text"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              className="rounded bg-accent px-3 py-1 text-white hover:opacity-90"
            >
              Save
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: string;
  confirmLabel?: string;
  /**
   * When true the confirm button uses a destructive style. Used for the
   * delete-design flow; the discard-edits flow keeps the default style
   * because it's reversible-ish (the user can re-do their edits).
   */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Generic confirm dialog kept module-private so it can't drift from the
 * Design pane's aesthetic. Body is a single string (not children) — this
 * is intentional, so callers can't sneak in interactive content that
 * would compete with the action buttons for focus.
 */
function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
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
            {title}
          </Dialog.Title>
          <Dialog.Description className="px-4 py-3 text-[12px] text-text-secondary">
            {body}
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
              className={cn(
                'rounded px-3 py-1 text-white transition hover:opacity-90',
                danger ? 'bg-red-600 hover:bg-red-700' : 'bg-accent',
              )}
            >
              {confirmLabel ?? 'OK'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
