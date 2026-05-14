import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowLeft,
  GripVertical,
  Loader2,
  Plus,
  Sparkles,
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

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import type {
  DesignAppPlan,
  DesignEvent,
  DesignSkill,
  PlannedScreen,
} from '@shared/design';

export interface AppPlanDialogProps {
  open: boolean;
  onClose: () => void;
  projectPath: string;
  /**
   * Optional plan to open the dialog at Stage 2 (review). When omitted the
   * dialog opens at Stage 1 (brief) and asks Claude to plan a fresh app.
   */
  initialPlan?: DesignAppPlan | null;
  /**
   * Called once `approvePlan` resolves. The parent typically toasts +
   * refreshes its app list.
   */
  onApproved: (plan: DesignAppPlan) => void;
}

type Stage = 'brief' | 'planning' | 'review';

const MAX_BRIEF = 8 * 1024;
const MIN_SCREENS = 3;
const MAX_SCREENS = 12;
const DEFAULT_MAX_SCREENS = 6;

/**
 * Two-stage modal that owns the multi-screen "Plan an app" UX:
 *   1. Brief — user describes the app, optionally names it, picks a screen
 *      cap. While Claude is planning the dialog stays open showing a
 *      shimmer status; an `app_plan_error` event aborts back to stage 1.
 *   2. Review — editable plan: name, theme (vibe + colors + fonts), and a
 *      sortable list of planned screens (name + pageName + brief + skill).
 *      "Approve & Materialize" calls `approvePlan` and closes the dialog.
 */
export function AppPlanDialog({
  open,
  onClose,
  projectPath,
  initialPlan,
  onApproved,
}: AppPlanDialogProps) {
  // Default-stage logic: if we received an initialPlan, jump straight to
  // review. Otherwise start at the brief composer.
  const initialStage: Stage = initialPlan ? 'review' : 'brief';
  const [stage, setStage] = useState<Stage>(initialStage);
  const [skills, setSkills] = useState<DesignSkill[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Stage 1 state.
  const [brief, setBrief] = useState('');
  const [name, setName] = useState('');
  const [maxScreens, setMaxScreens] = useState<number>(DEFAULT_MAX_SCREENS);

  // Stage 2 state — the editable plan.
  const [plan, setPlan] = useState<DesignAppPlan | null>(initialPlan ?? null);
  const [submitting, setSubmitting] = useState(false);

  const planAppIdRef = useRef<string | null>(null);
  // Mirror current stage so the long-lived event subscription can read
  // it without re-binding on every stage transition.
  const stageRef = useRef<Stage>('brief');
  useEffect(() => {
    stageRef.current = stage;
  }, [stage]);

  // Reset the dialog whenever it (re-)opens so a stale draft from a
  // previous mount doesn't bleed through.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setSubmitting(false);
    if (initialPlan) {
      setPlan(initialPlan);
      setStage('review');
      planAppIdRef.current = initialPlan.appId;
    } else {
      setBrief('');
      setName('');
      setMaxScreens(DEFAULT_MAX_SCREENS);
      setPlan(null);
      setStage('brief');
      planAppIdRef.current = null;
    }
  }, [open, initialPlan]);

  // Load the skill catalog once per mount — used by the screen rows'
  // skill picker dropdowns. Skills are fast to fetch and small.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await api.design.listSkills(projectPath);
        if (!cancelled) setSkills(list);
      } catch (err) {
        // Best-effort — falling back to an empty list lets the user still
        // approve a plan, just without skill validation.
        console.warn('[AppPlanDialog] listSkills failed:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, projectPath]);

  // Subscribe to design events so we can surface `app_plan_error` while
  // a plan is in flight, and patch the local plan when the backend
  // emits `app_plan_ready` (in case the renderer's await resolves later).
  useEffect(() => {
    if (!open) return;
    let unsub: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        await api.design.subscribe(projectPath);
      } catch (err) {
        console.warn('[AppPlanDialog] subscribe failed:', err);
      }
      if (cancelled) return;
      unsub = api.design.onEvent(projectPath, (ev: DesignEvent) => {
        if (!ev.appPlan) return;
        // Match logic:
        //  - ref set + matches → accept (paired with our planApp call)
        //  - ref set + mismatches → drop (event for a different app)
        //  - ref unset + we are mid-plan (stage==='planning') AND the
        //    event is the started/ready/error for the plan we just kicked
        //    off → accept and adopt the appId.
        //  - ref unset + we are NOT mid-plan → drop (stale event from a
        //    prior dialog session or another window).
        const ref = planAppIdRef.current;
        if (ref) {
          if (ev.appPlan.appId !== ref) return;
        } else if (stageRef.current !== 'planning') {
          return;
        }
        if (ev.kind === 'app_plan_ready') {
          planAppIdRef.current = ev.appPlan.appId;
          setPlan(ev.appPlan);
          setStage('review');
          setError(null);
        } else if (ev.kind === 'app_plan_error') {
          planAppIdRef.current = ev.appPlan.appId;
          setError(ev.message ?? 'Planning failed.');
          setStage('brief');
        } else if (ev.kind === 'app_plan_started') {
          // Adopt the appId so subsequent events route correctly even
          // before our awaited planApp() resolves.
          planAppIdRef.current = ev.appPlan.appId;
        }
      });
    })();
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [open, projectPath]);

  const handlePlan = useCallback(async () => {
    const trimmed = brief.trim();
    if (!trimmed || trimmed.length > MAX_BRIEF) {
      setError(`Brief must be 1–${MAX_BRIEF} characters.`);
      return;
    }
    setError(null);
    setStage('planning');
    try {
      const result = await api.design.planApp({
        projectPath,
        brief: trimmed,
        ...(name.trim() ? { name: name.trim() } : {}),
        maxScreens,
      });
      planAppIdRef.current = result.appId;
      setPlan(result);
      // The backend may emit `app_plan_ready` separately — both paths
      // converge on the same setStage('review') here so a slow event
      // doesn't double-render.
      if (result.planError) {
        setError(result.planError);
        setStage('brief');
      } else {
        setStage('review');
      }
    } catch (err) {
      setError((err as Error).message);
      setStage('brief');
    }
  }, [brief, maxScreens, name, projectPath]);

  const handleApprove = useCallback(async () => {
    if (!plan || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      // Save edits first so any unsaved field-level changes are persisted
      // before approval validation runs server-side.
      const saved = await api.design.updatePlan({ projectPath, appId: plan.appId, plan });
      const approved = await api.design.approvePlan({
        projectPath,
        appId: saved.appId,
        plan: saved,
      });
      onApproved(approved);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }, [onApproved, onClose, plan, projectPath, submitting]);

  // ─── Plan editors (Stage 2) ─────────────────────────────────────────
  const updateField = useCallback(
    <K extends keyof DesignAppPlan>(key: K, value: DesignAppPlan[K]) => {
      setPlan((prev) => (prev ? { ...prev, [key]: value } : prev));
    },
    [],
  );

  const updateTheme = useCallback(
    (next: Partial<DesignAppPlan['theme']>) => {
      setPlan((prev) =>
        prev ? { ...prev, theme: { ...prev.theme, ...next } } : prev,
      );
    },
    [],
  );

  const updateScreen = useCallback(
    (id: string, patch: Partial<PlannedScreen>) => {
      setPlan((prev) =>
        prev
          ? {
              ...prev,
              screens: prev.screens.map((s) =>
                s.id === id ? { ...s, ...patch } : s,
              ),
            }
          : prev,
      );
    },
    [],
  );

  const removeScreen = useCallback((id: string) => {
    setPlan((prev) =>
      prev ? { ...prev, screens: prev.screens.filter((s) => s.id !== id) } : prev,
    );
  }, []);

  const moveScreen = useCallback((id: string, dir: -1 | 1) => {
    setPlan((prev) => {
      if (!prev) return prev;
      const idx = prev.screens.findIndex((s) => s.id === id);
      const target = idx + dir;
      if (idx < 0 || target < 0 || target >= prev.screens.length) return prev;
      const next = prev.screens.slice();
      const [item] = next.splice(idx, 1);
      next.splice(target, 0, item!);
      return { ...prev, screens: next };
    });
  }, []);

  const removeColor = useCallback(
    (idx: number) => {
      const colors = plan?.theme.colors ?? [];
      updateTheme({ colors: colors.filter((_, i) => i !== idx) });
    },
    [plan, updateTheme],
  );

  const addColor = useCallback(
    (value: string) => {
      const colors = plan?.theme.colors ?? [];
      updateTheme({ colors: [...colors, value] });
    },
    [plan, updateTheme],
  );

  const removeFont = useCallback(
    (idx: number) => {
      const fonts = plan?.theme.fonts ?? [];
      updateTheme({ fonts: fonts.filter((_, i) => i !== idx) });
    },
    [plan, updateTheme],
  );

  const addFont = useCallback(
    (value: string) => {
      const fonts = plan?.theme.fonts ?? [];
      updateTheme({ fonts: [...fonts, value] });
    },
    [plan, updateTheme],
  );

  const skillOptions = useMemo(() => {
    return skills.map((s) => ({ slug: s.slug, label: s.name || s.slug }));
  }, [skills]);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-12 z-50 flex max-h-[88vh] w-[min(720px,92vw)] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-border-emphasis bg-surface-raised shadow-2xl">
          <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle bg-surface-sidebar px-4 py-2.5">
            <Sparkles size={13} className="text-accent" />
            <Dialog.Title className="flex-1 text-[12.5px] font-semibold text-text">
              {stage === 'review'
                ? 'Review app plan'
                : stage === 'planning'
                  ? 'Planning your app'
                  : 'Plan an app'}
            </Dialog.Title>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-text-muted transition hover:bg-surface-overlay hover:text-text"
              aria-label="Close"
            >
              <X size={12} />
            </button>
          </div>

          {error && (
            <div className="shrink-0 border-b border-semantic-error/30 bg-semantic-error/10 px-4 py-2 text-[11px] text-semantic-error">
              {error}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto">
            {stage === 'review' && plan ? (
              <ReviewStage
                plan={plan}
                skills={skillOptions}
                updateField={updateField}
                updateScreen={updateScreen}
                removeScreen={removeScreen}
                moveScreen={moveScreen}
                addColor={addColor}
                removeColor={removeColor}
                addFont={addFont}
                removeFont={removeFont}
                updateTheme={updateTheme}
              />
            ) : (
              <BriefStage
                brief={brief}
                onBriefChange={setBrief}
                name={name}
                onNameChange={setName}
                maxScreens={maxScreens}
                onMaxScreensChange={setMaxScreens}
                planning={stage === 'planning'}
              />
            )}
          </div>

          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border-subtle bg-surface-sidebar px-3 py-2 text-[11px]">
            {stage === 'review' ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setStage('brief');
                    setError(null);
                  }}
                  disabled={submitting || !!initialPlan}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-text-secondary hover:bg-surface-overlay hover:text-text disabled:opacity-40"
                >
                  <ArrowLeft size={11} />
                  Back
                </button>
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={onClose}
                  disabled={submitting}
                  className="rounded px-2 py-1 text-text-secondary hover:bg-surface-overlay hover:text-text disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleApprove()}
                  disabled={submitting || !plan?.screens.length}
                  className="inline-flex items-center gap-1 rounded bg-accent px-3 py-1 text-white transition hover:opacity-90 disabled:opacity-40"
                >
                  {submitting ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <Sparkles size={11} />
                  )}
                  {submitting ? 'Approving…' : 'Approve & Materialize'}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={onClose}
                  disabled={stage === 'planning'}
                  className="rounded px-2 py-1 text-text-secondary hover:bg-surface-overlay hover:text-text disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handlePlan()}
                  disabled={stage === 'planning' || brief.trim().length === 0}
                  className="inline-flex items-center gap-1 rounded bg-accent px-3 py-1 text-white transition hover:opacity-90 disabled:opacity-40"
                >
                  {stage === 'planning' ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <Sparkles size={11} />
                  )}
                  {stage === 'planning' ? 'Planning…' : 'Plan with Claude'}
                </button>
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ─── Stage 1 ───────────────────────────────────────────────────────────

interface BriefStageProps {
  brief: string;
  onBriefChange: (v: string) => void;
  name: string;
  onNameChange: (v: string) => void;
  maxScreens: number;
  onMaxScreensChange: (n: number) => void;
  planning: boolean;
}

function BriefStage({
  brief,
  onBriefChange,
  name,
  onNameChange,
  maxScreens,
  onMaxScreensChange,
  planning,
}: BriefStageProps) {
  return (
    <div className="space-y-4 px-4 py-4">
      <div>
        <label className="mb-1 block text-[11px] font-medium text-text-secondary">
          App brief
        </label>
        <textarea
          value={brief}
          onChange={(e) => onBriefChange(e.target.value)}
          disabled={planning}
          rows={6}
          placeholder="e.g. Stock management app for a small warehouse — track inventory, receive shipments, run audits, view low-stock alerts."
          className="w-full resize-y rounded border border-border bg-surface px-2.5 py-2 text-[12.5px] text-text placeholder:text-text-muted focus:border-accent focus:outline-none disabled:opacity-60"
        />
        <div className="mt-1 text-[10.5px] text-text-dim">
          Claude breaks this down into 3–12 screens plus a shared theme.
          You'll review the plan before any screen is generated.
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-[11px] font-medium text-text-secondary">
            App name (optional)
          </label>
          <input
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            disabled={planning}
            placeholder="Auto-derived from brief if blank"
            className="w-full rounded border border-border bg-surface px-2 py-1.5 text-[12.5px] text-text placeholder:text-text-muted focus:border-accent focus:outline-none disabled:opacity-60"
          />
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-medium text-text-secondary">
            Max screens: <span className="font-mono text-accent">{maxScreens}</span>
          </label>
          <input
            type="range"
            min={MIN_SCREENS}
            max={MAX_SCREENS}
            value={maxScreens}
            onChange={(e) => onMaxScreensChange(Number(e.target.value))}
            disabled={planning}
            className="w-full disabled:opacity-60"
          />
          <div className="flex justify-between text-[10px] text-text-dim">
            <span>{MIN_SCREENS}</span>
            <span>{MAX_SCREENS}</span>
          </div>
        </div>
      </div>

      {planning && (
        <div className="flex items-center gap-2 rounded border border-accent/30 bg-accent/5 px-3 py-2 text-[11.5px] text-accent">
          <Loader2 size={12} className="animate-spin" />
          <span className="shimmer">Claude is planning your app…</span>
        </div>
      )}
    </div>
  );
}

// ─── Stage 2 ───────────────────────────────────────────────────────────

interface ReviewStageProps {
  plan: DesignAppPlan;
  skills: Array<{ slug: string; label: string }>;
  updateField: <K extends keyof DesignAppPlan>(
    key: K,
    value: DesignAppPlan[K],
  ) => void;
  updateScreen: (id: string, patch: Partial<PlannedScreen>) => void;
  removeScreen: (id: string) => void;
  moveScreen: (id: string, dir: -1 | 1) => void;
  addColor: (value: string) => void;
  removeColor: (idx: number) => void;
  addFont: (value: string) => void;
  removeFont: (idx: number) => void;
  updateTheme: (next: Partial<DesignAppPlan['theme']>) => void;
}

function ReviewStage({
  plan,
  skills,
  updateField,
  updateScreen,
  removeScreen,
  moveScreen,
  addColor,
  removeColor,
  addFont,
  removeFont,
  updateTheme,
}: ReviewStageProps) {
  const [colorInput, setColorInput] = useState('');
  const [fontInput, setFontInput] = useState('');

  return (
    <div className="space-y-5 px-4 py-4">
      {/* App name + vibe */}
      <section className="space-y-2.5">
        <div>
          <label className="mb-1 block text-[11px] font-medium text-text-secondary">
            App name
          </label>
          <input
            value={plan.name}
            onChange={(e) => updateField('name', e.target.value)}
            className="w-full rounded border border-border bg-surface px-2 py-1.5 text-[12.5px] text-text focus:border-accent focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-medium text-text-secondary">
            Theme vibe
          </label>
          <input
            value={plan.theme.vibe}
            onChange={(e) => updateTheme({ vibe: e.target.value })}
            placeholder="e.g. Clean modern dashboard, deep navy + warm accents"
            className="w-full rounded border border-border bg-surface px-2 py-1.5 text-[12.5px] text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
        </div>
      </section>

      {/* Theme colors */}
      <section>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-medium text-text-secondary">
            Colors
          </span>
          <span className="text-[10px] text-text-dim">
            {plan.theme.colors.length}/8
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {plan.theme.colors.map((c, i) => (
            <ChipPill
              key={`${c}-${i}`}
              label={c}
              onRemove={() => removeColor(i)}
              swatch={extractSwatch(c)}
            />
          ))}
        </div>
        <div className="mt-2 flex gap-2">
          <input
            value={colorInput}
            onChange={(e) => setColorInput(e.target.value)}
            placeholder="brand: #4c8dff"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && colorInput.trim()) {
                e.preventDefault();
                addColor(colorInput.trim());
                setColorInput('');
              }
            }}
            disabled={plan.theme.colors.length >= 8}
            className="flex-1 rounded border border-border bg-surface px-2 py-1 text-[11.5px] text-text placeholder:text-text-muted focus:border-accent focus:outline-none disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => {
              if (colorInput.trim()) {
                addColor(colorInput.trim());
                setColorInput('');
              }
            }}
            disabled={!colorInput.trim() || plan.theme.colors.length >= 8}
            className="inline-flex items-center gap-1 rounded border border-border-subtle bg-surface-3 px-2 py-1 text-[11px] text-text-secondary hover:border-accent/40 hover:text-text disabled:opacity-40"
          >
            <Plus size={10} /> Add
          </button>
        </div>
      </section>

      {/* Theme fonts */}
      <section>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-medium text-text-secondary">
            Fonts
          </span>
          <span className="text-[10px] text-text-dim">
            {plan.theme.fonts.length}/4
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {plan.theme.fonts.map((f, i) => (
            <ChipPill key={`${f}-${i}`} label={f} onRemove={() => removeFont(i)} />
          ))}
        </div>
        <div className="mt-2 flex gap-2">
          <input
            value={fontInput}
            onChange={(e) => setFontInput(e.target.value)}
            placeholder="sans: Inter"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && fontInput.trim()) {
                e.preventDefault();
                addFont(fontInput.trim());
                setFontInput('');
              }
            }}
            disabled={plan.theme.fonts.length >= 4}
            className="flex-1 rounded border border-border bg-surface px-2 py-1 text-[11.5px] text-text placeholder:text-text-muted focus:border-accent focus:outline-none disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => {
              if (fontInput.trim()) {
                addFont(fontInput.trim());
                setFontInput('');
              }
            }}
            disabled={!fontInput.trim() || plan.theme.fonts.length >= 4}
            className="inline-flex items-center gap-1 rounded border border-border-subtle bg-surface-3 px-2 py-1 text-[11px] text-text-secondary hover:border-accent/40 hover:text-text disabled:opacity-40"
          >
            <Plus size={10} /> Add
          </button>
        </div>
      </section>

      {/* Screens */}
      <section>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-medium text-text-secondary">
            Screens ({plan.screens.length})
          </span>
        </div>
        <ul className="space-y-2">
          {plan.screens.map((screen, idx) => (
            <li
              key={screen.id}
              className="rounded border border-border-subtle bg-surface-2 p-2.5"
            >
              <div className="flex items-start gap-2">
                <div className="flex flex-col items-center gap-0.5 pt-1">
                  <button
                    type="button"
                    onClick={() => moveScreen(screen.id, -1)}
                    disabled={idx === 0}
                    title="Move up"
                    className="rounded p-0.5 text-text-muted hover:bg-surface-3 hover:text-text disabled:opacity-30"
                  >
                    <GripVertical size={11} />
                  </button>
                  <span className="text-[10px] text-text-dim">{idx + 1}</span>
                  <button
                    type="button"
                    onClick={() => moveScreen(screen.id, 1)}
                    disabled={idx === plan.screens.length - 1}
                    title="Move down"
                    className="rounded p-0.5 text-text-muted hover:bg-surface-3 hover:text-text disabled:opacity-30"
                  >
                    <GripVertical size={11} />
                  </button>
                </div>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex gap-2">
                    <input
                      value={screen.name}
                      onChange={(e) =>
                        updateScreen(screen.id, { name: e.target.value })
                      }
                      placeholder="Screen name"
                      className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1 text-[12px] text-text focus:border-accent focus:outline-none"
                    />
                    <input
                      value={screen.pageName}
                      onChange={(e) =>
                        updateScreen(screen.id, { pageName: e.target.value })
                      }
                      placeholder="Page name"
                      className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1 text-[12px] text-text focus:border-accent focus:outline-none"
                    />
                  </div>
                  <textarea
                    value={screen.brief}
                    onChange={(e) =>
                      updateScreen(screen.id, { brief: e.target.value })
                    }
                    rows={2}
                    placeholder="Per-screen brief"
                    className="w-full resize-y rounded border border-border bg-surface px-2 py-1 text-[11.5px] text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
                  />
                  <div className="flex items-center gap-2">
                    <span className="text-[10.5px] text-text-dim">Skill:</span>
                    <select
                      value={screen.skillSlug}
                      onChange={(e) =>
                        updateScreen(screen.id, { skillSlug: e.target.value })
                      }
                      className={cn(
                        'min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1 text-[11.5px] text-text focus:border-accent focus:outline-none',
                      )}
                    >
                      {skills.length === 0 && (
                        <option value={screen.skillSlug}>
                          {screen.skillSlug}
                        </option>
                      )}
                      {!skills.some((s) => s.slug === screen.skillSlug) &&
                        screen.skillSlug && (
                          <option value={screen.skillSlug}>
                            {screen.skillSlug} (missing)
                          </option>
                        )}
                      {skills.map((s) => (
                        <option key={s.slug} value={s.slug}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => removeScreen(screen.id)}
                  title="Remove screen"
                  className="rounded p-1 text-text-muted hover:bg-semantic-error/15 hover:text-semantic-error"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            </li>
          ))}
          {plan.screens.length === 0 && (
            <li className="rounded border border-dashed border-border bg-surface px-3 py-4 text-center text-[11px] text-text-muted">
              No screens — go back and re-plan, or close the dialog.
            </li>
          )}
        </ul>
      </section>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────

interface ChipPillProps {
  label: string;
  onRemove: () => void;
  swatch?: string | null;
}

function ChipPill({ label, onRemove, swatch }: ChipPillProps) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-surface-3 py-0.5 pl-1.5 pr-1 text-[10.5px] text-text-secondary">
      {swatch && (
        <span
          className="h-3 w-3 shrink-0 rounded-full border border-border-subtle"
          style={{ background: swatch }}
        />
      )}
      <span className="font-mono">{label}</span>
      <button
        type="button"
        onClick={onRemove}
        className="rounded-full p-0.5 text-text-muted transition hover:bg-surface-overlay hover:text-text"
        aria-label={`Remove ${label}`}
      >
        <X size={9} />
      </button>
    </span>
  );
}

// Best-effort hex/named-color extraction so the chip can render a swatch
// preview. Returns null when no recognizable color literal is present.
function extractSwatch(value: string): string | null {
  const hex = value.match(/#([0-9a-f]{3,8})/i);
  if (hex) return `#${hex[1]}`;
  const fn = value.match(/(rgb|rgba|hsl|hsla)\([^)]+\)/i);
  if (fn) return fn[0];
  return null;
}
