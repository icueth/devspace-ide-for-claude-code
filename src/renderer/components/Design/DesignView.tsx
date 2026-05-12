import {
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Paintbrush,
  Plus,
  Trash2,
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

  // ─── Handlers ───────────────────────────────────────────────────────
  const handleGenerate = useCallback(async () => {
    if (!canGenerate || !skillSlug) return;
    setToolbarError(null);
    setCreating(true);
    try {
      const screen = await api.design.create({
        projectPath,
        // Use a short slug derived from the brief so the sidebar reads
        // sensibly even before the backend renames things.
        name: brief.trim().split(/\n/)[0]!.slice(0, 60) || 'Untitled screen',
        skillSlug,
        designSystemSlug: systemSlug ?? undefined,
        brief: brief.trim(),
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
    } catch (err) {
      setToolbarError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }, [brief, canGenerate, projectPath, skillSlug, systemSlug]);

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
    async (text: string) => {
      if (!activeScreenId) return;
      setToolbarError(null);
      try {
        await api.design.followUp({
          projectPath,
          screenId: activeScreenId,
          message: text,
          designSystemSlug: systemSlug ?? undefined,
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
    const note = window.prompt(
      'Save edits as a new version. Optional note:',
      '',
    );
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
  }, [activeScreen, pendingEdits, projectPath, saving]);

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
    (id: string | null) => {
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
        const ok = window.confirm(
          `Discard ${pendingEdits.length} unsaved edit${pendingEdits.length > 1 ? 's' : ''}?`,
        );
        if (!ok) return;
      }
      setActiveScreenId(id);
    },
    [activeScreenId, pendingEdits.length, preview],
  );

  const handleDeleteScreen = useCallback(
    async (id: string) => {
      const screen = screens.find((s) => s.id === id);
      if (!screen) return;
      const ok = window.confirm(
        `Delete design "${screen.name}"?\nThis removes its folder under .devspace/design/screens/.`,
      );
      if (!ok) return;
      try {
        await api.design.delete(projectPath, id);
        setScreens((prev) => prev.filter((s) => s.id !== id));
        setActiveScreenId((curr) => (curr === id ? null : curr));
      } catch (err) {
        setToolbarError((err as Error).message);
      }
    },
    [projectPath, screens],
  );

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
          onSelect={handleSelectScreen}
          onDelete={(id) => void handleDeleteScreen(id)}
        />

        <main className="flex min-w-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <DesignPreview
              projectPath={projectPath}
              screenId={activeScreenId}
              versionId={previewVersionId}
              reloadKey={reloadKey}
              mode={mode}
              iframeRef={iframeRef}
              onBridgeMessage={handleBridgeMessage}
              emptyLabel={
                screens.length === 0 ? 'No designs yet' : 'Select a screen'
              }
              emptyHint={
                screens.length === 0
                  ? 'Pick a skill, write a brief, click Generate.'
                  : 'Pick a screen from the left to preview it.'
              }
            />
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
            onToggle={() => setBriefPanelOpen((v) => !v)}
            messages={messages}
            onFollowUp={handleFollowUp}
            onCancel={handleCancel}
            busy={busy}
            error={toolbarError}
            onSelectVersion={handleSelectVersion}
          />
        </main>
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
