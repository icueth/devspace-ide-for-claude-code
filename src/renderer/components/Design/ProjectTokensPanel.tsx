import {
  AlertCircle,
  Loader2,
  Lock,
  Plus,
  Sparkles,
  Unlock,
  Wand2,
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
  DesignEvent,
  DesignScreen,
  ProjectDesignTokens,
} from '@shared/design';

export interface ProjectTokensPanelProps {
  projectPath: string;
}

// Caps must match src/main/services/design/ProjectTokens.ts — the
// backend silently truncates to these limits on persist, so the
// renderer needs to refuse the same boundary up-front instead of
// accepting an entry that would vanish on round-trip.
const MAX_COLORS = 8;
const MAX_FONTS = 4;
const MAX_VIBE = 200;

// Renderer-side mirror of the backend's allowlist. Backend re-validates on
// `setTokens`, but pre-validating here lets us show inline errors instead
// of forcing the user to wait for an IPC round trip.
const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const COLOR_FN_RE = /^(rgb|rgba|hsl|hsla)\(\s*[^)]+\s*\)$/i;
const NAMED_COLORS = new Set([
  'black', 'white', 'red', 'green', 'blue', 'yellow', 'orange', 'purple',
  'pink', 'brown', 'gray', 'grey', 'cyan', 'magenta', 'lime', 'teal',
  'navy', 'maroon', 'olive', 'silver', 'gold', 'transparent', 'currentcolor',
]);

function validateColorValue(raw: string): string | null {
  // Accept either "name: <value>" or just "<value>". The token name is
  // optional; what we need to validate is the color literal.
  const trimmed = raw.trim();
  if (!trimmed) return 'Empty value.';
  const colon = trimmed.indexOf(':');
  const valuePart = colon >= 0 ? trimmed.slice(colon + 1).trim() : trimmed;
  if (!valuePart) return 'Missing color value.';
  if (HEX_RE.test(valuePart)) return null;
  if (COLOR_FN_RE.test(valuePart)) return null;
  if (NAMED_COLORS.has(valuePart.toLowerCase())) return null;
  return 'Use #hex, rgb()/rgba()/hsl()/hsla(), or a named color.';
}

function validateFontValue(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return 'Empty value.';
  // Reject url() so a hostile token can't smuggle network calls.
  if (/url\s*\(/i.test(trimmed)) return 'url() is not allowed in font tokens.';
  return null;
}

/**
 * Settings sub-panel for project-wide design tokens. Surfaces the
 * `ProjectDesignTokens` record stored at `.devspace/design/tokens.json`,
 * lets users hand-edit colors / fonts / vibe, lock or unlock the set
 * (lock = "inject into every prompt"), and auto-extract a fresh palette
 * from any ready screen version.
 */
export function ProjectTokensPanel({ projectPath }: ProjectTokensPanelProps) {
  const [tokens, setTokens] = useState<ProjectDesignTokens | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [screens, setScreens] = useState<DesignScreen[]>([]);

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const [t, list] = await Promise.all([
          api.design.getTokens(projectPath),
          api.design.list(projectPath),
        ]);
        if (cancelled) return;
        setTokens(t);
        setScreens(list);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  // Subscribe to tokens_changed events so external mutations (extract
  // from another window, backend touch) sync into the panel live.
  useEffect(() => {
    if (!projectPath) return;
    let unsub: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        await api.design.subscribe(projectPath);
      } catch (err) {
        console.warn('[ProjectTokensPanel] subscribe failed:', err);
      }
      if (cancelled) return;
      unsub = api.design.onEvent(projectPath, (ev: DesignEvent) => {
        if (ev.kind === 'tokens_changed') {
          setTokens(ev.tokens ?? null);
        }
      });
    })();
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [projectPath]);

  const persist = useCallback(
    async (next: ProjectDesignTokens | null) => {
      setSaving(true);
      setError(null);
      try {
        const result = await api.design.setTokens({ projectPath, tokens: next });
        setTokens(result);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setSaving(false);
      }
    },
    [projectPath],
  );

  const handleAddColor = useCallback(
    (value: string) => {
      const v = value.trim();
      if (!v) return 'Empty value.';
      const err = validateColorValue(v);
      if (err) return err;
      const current = tokens?.colors ?? [];
      if (current.length >= MAX_COLORS) return `Maximum ${MAX_COLORS} colors.`;
      const next: ProjectDesignTokens = {
        colors: [...current, v],
        fonts: tokens?.fonts ?? [],
        vibe: tokens?.vibe ?? '',
        ...(tokens?.lockedAt !== undefined ? { lockedAt: tokens.lockedAt } : {}),
        ...(tokens?.source ? { source: tokens.source } : {}),
      };
      void persist(next);
      return null;
    },
    [persist, tokens],
  );

  const handleRemoveColor = useCallback(
    (idx: number) => {
      if (!tokens) return;
      const next: ProjectDesignTokens = {
        ...tokens,
        colors: tokens.colors.filter((_, i) => i !== idx),
      };
      void persist(next);
    },
    [persist, tokens],
  );

  const handleEditColor = useCallback(
    (idx: number, value: string): string | null => {
      if (!tokens) return 'No tokens loaded.';
      const v = value.trim();
      if (!v) return 'Empty value.';
      const err = validateColorValue(v);
      if (err) return err;
      // Single in-place replacement → single persist call. Avoids the
      // remove-then-add race where two parallel persists could revert
      // the deletion or duplicate the value.
      const next: ProjectDesignTokens = {
        ...tokens,
        colors: tokens.colors.map((c, i) => (i === idx ? v : c)),
      };
      void persist(next);
      return null;
    },
    [persist, tokens],
  );

  const handleAddFont = useCallback(
    (value: string) => {
      const v = value.trim();
      if (!v) return 'Empty value.';
      const err = validateFontValue(v);
      if (err) return err;
      const current = tokens?.fonts ?? [];
      if (current.length >= MAX_FONTS) return `Maximum ${MAX_FONTS} fonts.`;
      const next: ProjectDesignTokens = {
        colors: tokens?.colors ?? [],
        fonts: [...current, v],
        vibe: tokens?.vibe ?? '',
        ...(tokens?.lockedAt !== undefined ? { lockedAt: tokens.lockedAt } : {}),
        ...(tokens?.source ? { source: tokens.source } : {}),
      };
      void persist(next);
      return null;
    },
    [persist, tokens],
  );

  const handleRemoveFont = useCallback(
    (idx: number) => {
      if (!tokens) return;
      const next: ProjectDesignTokens = {
        ...tokens,
        fonts: tokens.fonts.filter((_, i) => i !== idx),
      };
      void persist(next);
    },
    [persist, tokens],
  );

  const handleEditFont = useCallback(
    (idx: number, value: string): string | null => {
      if (!tokens) return 'No tokens loaded.';
      const v = value.trim();
      if (!v) return 'Empty value.';
      const err = validateFontValue(v);
      if (err) return err;
      const next: ProjectDesignTokens = {
        ...tokens,
        fonts: tokens.fonts.map((f, i) => (i === idx ? v : f)),
      };
      void persist(next);
      return null;
    },
    [persist, tokens],
  );

  const handleVibeChange = useCallback(
    (vibe: string) => {
      // Optimistic local update; persist on blur to avoid hammering IPC.
      setTokens((prev) =>
        prev
          ? { ...prev, vibe }
          : { colors: [], fonts: [], vibe },
      );
    },
    [],
  );

  const handleVibeBlur = useCallback(() => {
    if (!tokens) return;
    void persist(tokens);
  }, [persist, tokens]);

  const toggleLock = useCallback(() => {
    if (!tokens) return;
    const isLocked = !!tokens.lockedAt;
    const next: ProjectDesignTokens = isLocked
      ? // Drop lockedAt by destructuring it out — required so the JSON
        // payload doesn't carry an explicit `lockedAt: undefined`.
        (() => {
          const { lockedAt: _drop, ...rest } = tokens;
          return rest;
        })()
      : { ...tokens, lockedAt: Date.now() };
    void persist(next);
  }, [persist, tokens]);

  if (loading) {
    return (
      <div className="flex h-[200px] items-center justify-center">
        <div className="flex items-center gap-2 text-[11.5px] text-text-muted">
          <Loader2 size={13} className="animate-spin text-accent" />
          Loading project tokens…
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-[820px] px-6 py-5">
        <Header tokens={tokens} saving={saving} onToggleLock={toggleLock} />

        {error && (
          <div className="mb-3 flex items-start gap-2 rounded border border-semantic-error/30 bg-semantic-error/10 px-3 py-2 text-[11.5px] text-semantic-error">
            <AlertCircle size={12} className="mt-0.5 shrink-0" />
            <span className="flex-1">{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              className="rounded p-0.5 hover:bg-semantic-error/20"
              aria-label="Dismiss"
            >
              <X size={11} />
            </button>
          </div>
        )}

        <div className="space-y-5">
          <ColorsSection
            colors={tokens?.colors ?? []}
            onAdd={handleAddColor}
            onRemove={handleRemoveColor}
            onEdit={handleEditColor}
          />
          <FontsSection
            fonts={tokens?.fonts ?? []}
            onAdd={handleAddFont}
            onRemove={handleRemoveFont}
            onEdit={handleEditFont}
          />
          <VibeSection
            vibe={tokens?.vibe ?? ''}
            onChange={handleVibeChange}
            onBlur={handleVibeBlur}
          />
          <ExtractSection
            projectPath={projectPath}
            screens={screens}
            onPreview={(preview) => setTokens(preview)}
            onError={setError}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Sub-sections ──────────────────────────────────────────────────────

function Header({
  tokens,
  saving,
  onToggleLock,
}: {
  tokens: ProjectDesignTokens | null;
  saving: boolean;
  onToggleLock: () => void;
}) {
  const isLocked = !!tokens?.lockedAt;
  const lockedDate = tokens?.lockedAt ? new Date(tokens.lockedAt) : null;
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-[14px] font-semibold text-text">Project tokens</h3>
        <p className="mt-1 text-[11.5px] leading-snug text-text-muted">
          Project-wide colors, fonts and vibe. When locked, these values are
          injected into every design generation as a hard constraint —
          giving every screen a consistent look without per-screen reuse.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {lockedDate && (
          <span className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-surface-3 px-2 py-0.5 text-[10px] text-text-muted">
            <Lock size={9} />
            Locked: {lockedDate.toLocaleDateString()}
          </span>
        )}
        <button
          type="button"
          onClick={onToggleLock}
          disabled={!tokens || saving}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-[6px] border px-3 py-[6px] text-[11px] font-medium transition',
            !tokens || saving
              ? 'pointer-events-none border-border bg-surface-3 text-text-muted opacity-50'
              : isLocked
                ? 'border-accent/40 bg-accent/10 text-accent hover:bg-accent/15'
                : 'border-border-subtle bg-surface-3 text-text hover:border-border-hi hover:bg-surface-4',
          )}
        >
          {isLocked ? <Unlock size={11} /> : <Lock size={11} />}
          {isLocked ? 'Unlock' : 'Lock theme'}
        </button>
      </div>
    </div>
  );
}

interface ChipListSectionProps {
  title: string;
  count: number;
  max: number;
  values: string[];
  onAdd: (value: string) => string | null;
  onRemove: (idx: number) => void;
  // v0.15: single-call edit (replaces remove+add) to avoid persist
  // races. Returns null on success or an inline error message.
  onEdit: (idx: number, value: string) => string | null;
  placeholder: string;
  withSwatch?: boolean;
}

function ChipListSection({
  title,
  count,
  max,
  values,
  onAdd,
  onRemove,
  onEdit,
  placeholder,
  withSwatch,
}: ChipListSectionProps) {
  const [input, setInput] = useState('');
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editValue, setEditValue] = useState('');
  const [inlineError, setInlineError] = useState<string | null>(null);

  const submit = () => {
    const err = onAdd(input);
    if (err) {
      setInlineError(err);
      return;
    }
    setInlineError(null);
    setInput('');
  };

  return (
    <section>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] font-medium text-text-secondary">
          {title}
        </span>
        <span className="text-[10px] text-text-dim">
          {count}/{max}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {values.length === 0 ? (
          <span className="text-[10.5px] text-text-dim">No tokens yet.</span>
        ) : (
          values.map((v, i) => (
            <Chip
              key={`${v}-${i}`}
              label={v}
              swatch={withSwatch ? extractSwatch(v) : null}
              onRemove={() => onRemove(i)}
              onEdit={(next) => {
                if (next === v) {
                  setEditingIdx(null);
                  return;
                }
                const err = onEdit(i, next);
                if (err) setInlineError(err);
                else setInlineError(null);
                setEditingIdx(null);
              }}
              editing={editingIdx === i}
              startEdit={() => {
                setEditingIdx(i);
                setEditValue(v);
              }}
              editValue={editValue}
              setEditValue={setEditValue}
            />
          ))
        )}
      </div>
      <div className="mt-2 flex gap-2">
        <input
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            if (inlineError) setInlineError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && input.trim()) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          disabled={count >= max}
          className="flex-1 rounded border border-border bg-surface px-2 py-1 text-[11.5px] text-text placeholder:text-text-muted focus:border-accent focus:outline-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!input.trim() || count >= max}
          className="inline-flex items-center gap-1 rounded border border-border-subtle bg-surface-3 px-2 py-1 text-[11px] text-text-secondary hover:border-accent/40 hover:text-text disabled:opacity-40"
        >
          <Plus size={10} /> Add
        </button>
      </div>
      {inlineError && (
        <div className="mt-1 text-[10.5px] text-semantic-error">{inlineError}</div>
      )}
    </section>
  );
}

function ColorsSection({
  colors,
  onAdd,
  onRemove,
  onEdit,
}: {
  colors: string[];
  onAdd: (v: string) => string | null;
  onRemove: (idx: number) => void;
  onEdit: (idx: number, v: string) => string | null;
}) {
  return (
    <ChipListSection
      title="Colors"
      count={colors.length}
      max={MAX_COLORS}
      values={colors}
      onAdd={onAdd}
      onRemove={onRemove}
      onEdit={onEdit}
      placeholder="brand: #4c8dff"
      withSwatch
    />
  );
}

function FontsSection({
  fonts,
  onAdd,
  onRemove,
  onEdit,
}: {
  fonts: string[];
  onAdd: (v: string) => string | null;
  onRemove: (idx: number) => void;
  onEdit: (idx: number, v: string) => string | null;
}) {
  return (
    <ChipListSection
      title="Fonts"
      count={fonts.length}
      max={MAX_FONTS}
      values={fonts}
      onAdd={onAdd}
      onRemove={onRemove}
      onEdit={onEdit}
      placeholder="sans: Inter"
    />
  );
}

function VibeSection({
  vibe,
  onChange,
  onBlur,
}: {
  vibe: string;
  onChange: (v: string) => void;
  onBlur: () => void;
}) {
  const remaining = MAX_VIBE - vibe.length;
  return (
    <section>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] font-medium text-text-secondary">
          Vibe
        </span>
        <span
          className={cn(
            'text-[10px]',
            remaining < 0 ? 'text-semantic-error' : 'text-text-dim',
          )}
        >
          {remaining} chars left
        </span>
      </div>
      <textarea
        value={vibe}
        maxLength={MAX_VIBE}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        rows={3}
        placeholder="e.g. Clean modern dashboard, deep navy + warm accents"
        className="w-full resize-y rounded border border-border bg-surface px-2 py-1.5 text-[12px] text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
      />
    </section>
  );
}

interface ExtractSectionProps {
  projectPath: string;
  screens: DesignScreen[];
  onPreview: (tokens: ProjectDesignTokens) => void;
  onError: (msg: string) => void;
}

function ExtractSection({
  projectPath,
  screens,
  onPreview,
  onError,
}: ExtractSectionProps) {
  const [open, setOpen] = useState(false);
  const [screenId, setScreenId] = useState<string>('');
  const [versionId, setVersionId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // Default to the first screen with a ready version.
  const readyScreens = useMemo(
    () => screens.filter((s) => s.versions.length > 0),
    [screens],
  );

  useEffect(() => {
    if (!open) return;
    if (!screenId && readyScreens[0]) {
      const first = readyScreens[0];
      setScreenId(first.id);
      setVersionId(first.versions[first.versions.length - 1]?.id ?? '');
    }
  }, [open, readyScreens, screenId]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!popoverRef.current) return;
      if (!popoverRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onClick, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const activeScreen = useMemo(
    () => readyScreens.find((s) => s.id === screenId) ?? null,
    [readyScreens, screenId],
  );

  const submit = useCallback(async () => {
    if (!screenId || !versionId || busy) return;
    setBusy(true);
    try {
      const preview = await api.design.extractTokens({
        projectPath,
        screenId,
        versionId,
        lock: false,
      });
      onPreview(preview);
      setOpen(false);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [busy, onError, onPreview, projectPath, screenId, versionId]);

  return (
    <section className="relative">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-[11px] font-medium text-text-secondary">
            Auto-extract from screen
          </div>
          <div className="text-[10.5px] text-text-dim">
            Pick a generated screen version — DevSpace will pull its colors
            + fonts into a preview. Lock to commit.
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={readyScreens.length === 0}
          className="inline-flex items-center gap-1.5 rounded-[6px] border border-border-subtle bg-surface-3 px-3 py-[6px] text-[11px] font-medium text-text transition hover:border-accent/40 hover:bg-surface-4 disabled:opacity-40"
        >
          <Wand2 size={11} />
          Extract…
        </button>
      </div>

      {open && (
        <div
          ref={popoverRef}
          className="absolute right-0 top-[110%] z-30 w-[360px] rounded-[10px] border border-border bg-surface-2 p-3 shadow-[0_18px_40px_rgba(0,0,0,0.5)]"
        >
          <div className="mb-2 flex items-center gap-1.5 text-[11px] text-text-secondary">
            <Sparkles size={11} className="text-accent" />
            Extract tokens from screen
          </div>
          {readyScreens.length === 0 ? (
            <div className="text-[10.5px] text-text-dim">
              No ready versions to extract from.
            </div>
          ) : (
            <div className="space-y-2">
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-wide text-text-dim">
                  Screen
                </label>
                <select
                  value={screenId}
                  onChange={(e) => {
                    setScreenId(e.target.value);
                    const next = readyScreens.find((s) => s.id === e.target.value);
                    setVersionId(next?.versions[next.versions.length - 1]?.id ?? '');
                  }}
                  className="w-full rounded border border-border bg-surface px-2 py-1 text-[11.5px] text-text focus:border-accent focus:outline-none"
                >
                  {readyScreens.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-wide text-text-dim">
                  Version
                </label>
                <select
                  value={versionId}
                  onChange={(e) => setVersionId(e.target.value)}
                  className="w-full rounded border border-border bg-surface px-2 py-1 text-[11.5px] text-text focus:border-accent focus:outline-none"
                >
                  {(activeScreen?.versions ?? []).map((v, i) => (
                    <option key={v.id} value={v.id}>
                      v{i + 1}
                      {v.note ? ` — ${v.note}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded px-2 py-1 text-[11px] text-text-secondary hover:bg-surface-overlay hover:text-text"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={busy || !screenId || !versionId}
                  className="inline-flex items-center gap-1 rounded bg-accent px-3 py-1 text-[11px] text-white hover:opacity-90 disabled:opacity-40"
                >
                  {busy ? (
                    <Loader2 size={10} className="animate-spin" />
                  ) : (
                    <Wand2 size={10} />
                  )}
                  Preview
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────

interface ChipProps {
  label: string;
  swatch?: string | null;
  onRemove: () => void;
  onEdit: (next: string) => void;
  editing: boolean;
  startEdit: () => void;
  editValue: string;
  setEditValue: (v: string) => void;
}

function Chip({
  label,
  swatch,
  onRemove,
  onEdit,
  editing,
  startEdit,
  editValue,
  setEditValue,
}: ChipProps) {
  if (editing) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-surface py-0.5 pl-1.5 pr-1 text-[10.5px]">
        <input
          autoFocus
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={() => onEdit(editValue.trim())}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onEdit(editValue.trim());
            } else if (e.key === 'Escape') {
              onEdit(label);
            }
          }}
          className="w-[140px] bg-transparent font-mono text-[10.5px] text-text focus:outline-none"
        />
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-surface-3 py-0.5 pl-1.5 pr-1 text-[10.5px] text-text-secondary">
      {swatch && (
        <span
          className="h-3 w-3 shrink-0 rounded-full border border-border-subtle"
          style={{ background: swatch }}
        />
      )}
      <button
        type="button"
        onClick={startEdit}
        className="font-mono hover:text-text"
        title="Click to edit"
      >
        {label}
      </button>
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

function extractSwatch(value: string): string | null {
  const hex = value.match(/#([0-9a-f]{3,8})/i);
  if (hex) return `#${hex[1]}`;
  const fn = value.match(/(rgb|rgba|hsl|hsla)\([^)]+\)/i);
  if (fn) return fn[0];
  const trimmed = value.trim().toLowerCase();
  if (NAMED_COLORS.has(trimmed)) return trimmed;
  return null;
}

