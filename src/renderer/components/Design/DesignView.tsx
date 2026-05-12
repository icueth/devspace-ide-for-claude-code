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
import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import type {
  DesignEvent,
  DesignScreen,
  DesignScreenVersion,
  DesignSkill,
  DesignSystem,
} from '@shared/design';

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
  const onEventRef = useRef<((ev: DesignEvent) => void) | null>(null);

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

  const handleRegenerate = useCallback(
    async (nextBrief: string) => {
      if (!activeScreenId) return;
      setToolbarError(null);
      try {
        const updated = await api.design.regenerate({
          projectPath,
          screenId: activeScreenId,
          brief: nextBrief,
          designSystemSlug: systemSlug ?? undefined,
        });
        setScreens((prev) =>
          prev.map((s) => (s.id === updated.id ? updated : s)),
        );
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
          onSelect={setActiveScreenId}
          onDelete={(id) => void handleDeleteScreen(id)}
        />

        <main className="flex min-w-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <DesignPreview
              projectPath={projectPath}
              screenId={activeScreenId}
              versionId={previewVersionId}
              reloadKey={reloadKey}
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

          <DesignBriefPanel
            screen={activeScreen}
            activeHtmlPath={previewHtmlPath}
            open={briefPanelOpen}
            onToggle={() => setBriefPanelOpen((v) => !v)}
            onRegenerate={handleRegenerate}
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
