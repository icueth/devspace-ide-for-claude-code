import {
  AlertTriangle,
  Check,
  ChevronRight,
  FileCode2,
  Loader2,
  Pencil,
  Plus,
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
  DesignAdapterDetectResult,
  DesignElementInfo,
  DesignWriteBackApplied,
  DesignWriteBackEdit,
  DesignWriteBackResult,
  StyleAdapterKind,
} from '@shared/design';

// ─── Curated property list ─────────────────────────────────────────────
//
// We keep this list short on purpose. The Edit panel is for the 80% case
// — set a colour, nudge a padding, swap a font weight. Anything beyond
// that ships as a free-form "Add property" row at the bottom. Order is
// the order rows render in.
//
// Each property is one of three editor kinds:
//   • color  — native <input type="color"> + hex text field
//   • length — number stepper + unit suffix (px / rem / %)
//   • select — fixed enum list (font-weight, display)

type EditorKind = 'color' | 'length' | 'select' | 'text';

interface PropertyDef {
  property: string;          // kebab-case CSS property name
  label: string;             // human label rendered in the row
  kind: EditorKind;
  // For 'length' rows — units offered in the dropdown (px first wins).
  units?: ReadonlyArray<string>;
  // For 'select' rows — fixed enum.
  options?: ReadonlyArray<string>;
  // Optional pre-populated placeholder for text/length inputs.
  placeholder?: string;
}

const CURATED_PROPERTIES: ReadonlyArray<PropertyDef> = [
  {
    property: 'background-color',
    label: 'Background',
    kind: 'color',
  },
  {
    property: 'color',
    label: 'Text color',
    kind: 'color',
  },
  {
    property: 'padding',
    label: 'Padding',
    kind: 'text',
    placeholder: '16px or 8px 12px',
  },
  {
    property: 'margin',
    label: 'Margin',
    kind: 'text',
    placeholder: '0 or 0 auto',
  },
  {
    property: 'font-size',
    label: 'Font size',
    kind: 'length',
    units: ['px', 'rem', '%'],
  },
  {
    property: 'font-weight',
    label: 'Font weight',
    kind: 'select',
    options: ['400', '500', '600', '700', '800', '900'],
  },
  {
    property: 'border-radius',
    label: 'Border radius',
    kind: 'length',
    units: ['px', 'rem', '%'],
  },
  {
    property: 'display',
    label: 'Display',
    kind: 'select',
    options: ['block', 'flex', 'inline-flex', 'grid', 'inline-block', 'inline', 'none'],
  },
];

// Properties the user can add via "+ Add property". Surfaces beyond the
// 8 curated rows without bloating the default UI.
const EXTRA_PROPERTIES: ReadonlyArray<PropertyDef> = [
  { property: 'gap', label: 'Gap', kind: 'length', units: ['px', 'rem'] },
  { property: 'line-height', label: 'Line height', kind: 'text', placeholder: '1.5 or 24px' },
  { property: 'letter-spacing', label: 'Letter spacing', kind: 'length', units: ['px', 'em'] },
  { property: 'opacity', label: 'Opacity', kind: 'text', placeholder: '0.0 – 1.0' },
  { property: 'border', label: 'Border', kind: 'text', placeholder: '1px solid #333' },
  { property: 'box-shadow', label: 'Box shadow', kind: 'text', placeholder: '0 1px 2px rgba(0,0,0,.1)' },
];

// Pretty-print a `StyleAdapterKind` for the adapter selector.
function adapterLabel(k: StyleAdapterKind): string {
  switch (k) {
    case 'tailwind':
      return 'Tailwind';
    case 'vanilla-css':
      return 'Vanilla CSS';
    case 'styled-components':
      return 'styled-components';
    case 'css-modules':
      return 'CSS Modules';
    case 'unknown':
    default:
      return 'Unknown';
  }
}

// Map a computed style string to the `<input type="color">` value (#rrggbb).
// Empty string when the value isn't a representable colour — the picker
// falls back to its default black without lying about the underlying value.
function parseColorToHex(value: string | undefined): string {
  if (!value) return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('#')) {
    if (trimmed.length === 7) return trimmed.toLowerCase();
    if (trimmed.length === 4) {
      const r = trimmed[1]!;
      const g = trimmed[2]!;
      const b = trimmed[3]!;
      return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
    }
    return '';
  }
  const m = trimmed.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (m) {
    const r = Number(m[1]).toString(16).padStart(2, '0');
    const g = Number(m[2]).toString(16).padStart(2, '0');
    const b = Number(m[3]).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`.toLowerCase();
  }
  return '';
}

// Split "16px" / "1.25rem" / "50%" into { num, unit }. Returns empty
// num for values that don't match — the row falls back to the placeholder.
function parseLength(value: string | undefined): { num: string; unit: string } {
  if (!value) return { num: '', unit: 'px' };
  const m = value.trim().match(/^(-?\d*\.?\d+)(px|rem|em|%)?$/i);
  if (!m) return { num: '', unit: 'px' };
  return { num: m[1] ?? '', unit: (m[2]?.toLowerCase() ?? 'px') };
}

function defForProperty(property: string): PropertyDef | null {
  return (
    CURATED_PROPERTIES.find((p) => p.property === property) ??
    EXTRA_PROPERTIES.find((p) => p.property === property) ??
    null
  );
}

// Read the current value for a property from `info.computedStyles`.
// Returns undefined when the bridge didn't pre-compute it.
function readComputed(info: DesignElementInfo, property: string): string | undefined {
  const cs = info.computedStyles;
  switch (property) {
    case 'color':
      return cs.color;
    case 'background-color':
      return cs.backgroundColor;
    case 'font-size':
      return cs.fontSize;
    case 'font-family':
      return cs.fontFamily;
    case 'font-weight':
      return cs.fontWeight;
    case 'padding':
      return cs.padding;
    case 'margin':
      return cs.margin;
    case 'border-radius':
      return cs.borderRadius;
    case 'border':
      return cs.border;
    case 'display':
      return cs.display;
    case 'text-align':
      return cs.textAlign;
    default:
      return undefined;
  }
}

export interface EditPanelProps {
  selectedElement: DesignElementInfo | null;
  projectPath: string;
  onClose: () => void;
}

// Per-row local pending state.  Keyed by CSS property.
type PendingMap = Record<string, string>;

// Status of the most recent dry-run / write-back call.
type RunState =
  | { kind: 'idle' }
  | { kind: 'preview-loading' }
  | { kind: 'preview-ready'; result: DesignWriteBackResult }
  | { kind: 'applying' }
  | { kind: 'applied'; result: DesignWriteBackResult }
  | { kind: 'error'; message: string };

/**
 * Right-rail Edit panel for Live Preview. Owned by Phase 0.8 — captures
 * user edits, runs a debounced dry-run against `styleAdapter.writeBack`
 * for the diff preview, and commits on Apply.
 *
 * Layout (top → bottom):
 *   1. Element header — tag + source.ref (read-only).
 *   2. Quick-edit rows — curated CSS properties.
 *   3. Adapter selector — Tailwind / vanilla-css / etc.
 *   4. Preview pane — unified diff returned by dryRun.
 *   5. Cancel / Apply.
 *
 * The webview's transient inline overrides (Phase B) are unaffected by
 * Cancel — that's intentional, the user can keep iterating visually.
 * "Apply" is the only thing that touches disk.
 */
export function EditPanel({ selectedElement, projectPath, onClose }: EditPanelProps) {
  // ─── Empty state ────────────────────────────────────────────────────
  // Hooks must run unconditionally — the empty branch is rendered below
  // the hook block so React's call order stays stable across renders.
  const sourceRef = selectedElement?.source?.ref ?? '';
  const className = selectedElement?.source?.className ?? '';

  // ─── Adapter detection ──────────────────────────────────────────────
  const [adapterInfo, setAdapterInfo] =
    useState<DesignAdapterDetectResult | null>(null);
  const [adapter, setAdapter] = useState<StyleAdapterKind>('unknown');
  const [adapterError, setAdapterError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectPath) return;
    let cancelled = false;
    void (async () => {
      try {
        const detected = await api.styleAdapter.detect(projectPath);
        if (cancelled) return;
        setAdapterInfo(detected);
        setAdapter(detected.preferred);
      } catch (err) {
        if (cancelled) return;
        // Backend may not be wired yet — swallow and surface a small
        // banner in the adapter section. The UI still renders.
        setAdapterError((err as Error).message);
        // eslint-disable-next-line no-console
        console.warn('[live-preview] adapter detect failed:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  // ─── Pending edits ──────────────────────────────────────────────────
  // Keyed by property so a second edit on the same prop overwrites the
  // first (the diff only ever shows the latest pending value).
  const [pending, setPending] = useState<PendingMap>({});
  // Extra rows the user added via "+ Add property". Tracked separately
  // so they keep their place in the panel even before they have a value.
  const [extraRows, setExtraRows] = useState<string[]>([]);
  const [showAddMenu, setShowAddMenu] = useState(false);

  // Reset on element change — pending state from element A shouldn't
  // leak into element B. Bumping reqIdRef invalidates any in-flight
  // dry-run from the previous element so its result can't paint the
  // panel after the new element has already mounted.
  useEffect(() => {
    setPending({});
    setExtraRows([]);
    setShowAddMenu(false);
    setRun({ kind: 'idle' });
    reqIdRef.current++;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reqIdRef captured implicitly
  }, [selectedElement?.elementId, sourceRef]);

  const setProperty = useCallback((property: string, value: string) => {
    setPending((prev) => {
      // Empty value clears the override — keeps the diff focused on
      // properties the user actually meant to set.
      if (!value) {
        const next = { ...prev };
        delete next[property];
        return next;
      }
      return { ...prev, [property]: value };
    });
  }, []);

  const removeRow = useCallback((property: string) => {
    setPending((prev) => {
      const next = { ...prev };
      delete next[property];
      return next;
    });
    setExtraRows((prev) => prev.filter((p) => p !== property));
  }, []);

  // ─── Build the DesignWriteBackEdit[] payload ────────────────────────
  const edits = useMemo<DesignWriteBackEdit[]>(() => {
    const source = selectedElement?.source;
    if (!source) return [];
    return Object.entries(pending).map(([property, value]) => ({
      source,
      property,
      value,
    }));
  }, [pending, selectedElement?.source]);

  // ─── Dry-run preview ────────────────────────────────────────────────
  const [run, setRun] = useState<RunState>({ kind: 'idle' });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqIdRef = useRef(0);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!projectPath || edits.length === 0) {
      // No edits — collapse back to idle so the preview pane shows the
      // empty placeholder instead of a stale diff.
      setRun({ kind: 'idle' });
      return;
    }
    setRun({ kind: 'preview-loading' });
    const reqId = ++reqIdRef.current;
    debounceRef.current = setTimeout(() => {
      void (async () => {
        try {
          const result = await api.styleAdapter.writeBack({
            projectPath,
            preferredAdapter: adapter,
            edits,
            dryRun: true,
          });
          // Late responses (user typed faster than the round-trip) get
          // dropped — only the most recent request wins.
          if (reqId !== reqIdRef.current) return;
          setRun({ kind: 'preview-ready', result });
        } catch (err) {
          if (reqId !== reqIdRef.current) return;
          setRun({ kind: 'error', message: (err as Error).message });
        }
      })();
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [edits, projectPath, adapter]);

  // ─── Apply ──────────────────────────────────────────────────────────
  // Sync guard — React state updates are batched so the `disabled` prop
  // doesn't reflect setRun('applying') until the next render. A user
  // spam-clicking before paint can fire handleApply twice. The ref
  // flips synchronously so the second call short-circuits.
  const inFlightRef = useRef(false);
  const handleApply = useCallback(async () => {
    if (!projectPath || edits.length === 0) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setRun({ kind: 'applying' });
    try {
      const result = await api.styleAdapter.writeBack({
        projectPath,
        preferredAdapter: adapter,
        edits,
        dryRun: false,
      });
      setRun({ kind: 'applied', result });
      // Don't clear pending on success — the user might want to keep
      // iterating. The Apply button stays disabled (see canApply) until
      // they actually change something.
    } catch (err) {
      setRun({ kind: 'error', message: (err as Error).message });
    } finally {
      inFlightRef.current = false;
    }
  }, [adapter, edits, projectPath]);

  const handleCancel = useCallback(() => {
    setPending({});
    setExtraRows([]);
    setRun({ kind: 'idle' });
  }, []);

  // Apply is disabled when nothing pending, the dry-run is mid-flight,
  // or the result we already applied is still the freshest one. Also
  // disabled when the selected adapter isn't implemented in 0.8 — the
  // only supported adapter today is Tailwind; everything else ships in
  // 0.9 (vanilla-css / styled-components / css-modules).
  const canApply =
    edits.length > 0 &&
    adapter === 'tailwind' &&
    run.kind !== 'preview-loading' &&
    run.kind !== 'applying' &&
    !(run.kind === 'applied' && run.result.ok);

  // Rows to render: curated first, then user-added extras (in order of
  // addition). Filter the "+ Add property" menu options so the user
  // can't add a row that's already shown.
  const visibleProperties = useMemo<string[]>(() => {
    const curated = CURATED_PROPERTIES.map((p) => p.property);
    return [...curated, ...extraRows.filter((p) => !curated.includes(p))];
  }, [extraRows]);

  const availableExtras = useMemo<PropertyDef[]>(() => {
    return EXTRA_PROPERTIES.filter((p) => !visibleProperties.includes(p.property));
  }, [visibleProperties]);

  // Indexed look-up of `applied[i].summary` and `applied[i].error` by
  // property so we can show inline feedback on each row.
  const appliedByProperty = useMemo<Record<string, DesignWriteBackApplied | undefined>>(
    () => {
      const r =
        run.kind === 'preview-ready' || run.kind === 'applied' ? run.result : null;
      if (!r) return {};
      const out: Record<string, DesignWriteBackApplied | undefined> = {};
      r.applied.forEach((a, i) => {
        const edit = edits[i];
        if (edit) out[edit.property] = a;
      });
      return out;
    },
    [run, edits],
  );

  // ─── Adapter mismatch warning ───────────────────────────────────────
  // 0.8 only implements the Tailwind adapter. Any non-tailwind selection
  // gets a warning banner — the project may genuinely use that styling
  // stack, but write-back lands in v0.9.0.
  const showAdapterUnsupportedWarning =
    adapter !== 'tailwind' && adapter !== 'unknown';
  const showAdapterMismatchWarning =
    adapter === 'vanilla-css' &&
    adapterInfo?.preferred === 'tailwind';

  // ─── Empty state ────────────────────────────────────────────────────
  if (!selectedElement) {
    return (
      <aside
        className="flex h-full w-[320px] shrink-0 flex-col border-l border-border bg-surface-2"
        aria-label="Edit element"
      >
        <PanelHeader title="Edit element" onClose={onClose} />
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <Pencil size={14} className="mb-1.5 text-text-dim" />
          <div className="text-[11px] text-text-muted">
            Click an element in the preview to start editing
          </div>
          <div className="mt-1 text-[10px] text-text-dim">
            Hover the preview to highlight, click to lock the selection.
          </div>
        </div>
      </aside>
    );
  }

  return (
    <aside
      className="flex h-full w-[320px] shrink-0 flex-col border-l border-border bg-surface-2"
      aria-label="Edit element"
    >
      <PanelHeader title="Edit element" onClose={onClose} />

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {/* ─── Element header ─────────────────────────────────────── */}
        <section className="flex flex-col gap-2 border-b border-border-subtle px-3 py-3">
          <Label>Element</Label>
          <div className="rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-1.5 font-mono text-[10.5px] leading-snug text-text-secondary">
            <span className="text-accent">
              &lt;{selectedElement.tagName.toLowerCase()}
            </span>
            {className && (
              <>
                <span className="text-text-muted"> class=</span>
                <span
                  className="break-all text-semantic-success"
                  title={className}
                >
                  &quot;{className}&quot;
                </span>
              </>
            )}
            <span className="text-accent">&gt;</span>
          </div>
          {sourceRef ? (
            <div className="flex items-start gap-1.5">
              <FileCode2
                size={11}
                className="mt-0.5 shrink-0 text-text-dim"
              />
              <span
                className="min-w-0 break-all font-mono text-[10.5px] text-text-muted"
                title={sourceRef}
              >
                {sourceRef}
              </span>
            </div>
          ) : (
            <div className="text-[10.5px] italic text-text-dim">
              No source ref — adapter will use computed selector fallback.
            </div>
          )}
        </section>

        {/* ─── Quick edits ────────────────────────────────────────── */}
        <section className="flex flex-col border-b border-border-subtle">
          <div className="flex items-center justify-between gap-2 px-3 pb-1 pt-3">
            <Label>Quick edits</Label>
            {Object.keys(pending).length > 0 && (
              <span className="inline-flex items-center rounded-[4px] bg-[rgba(34,197,94,0.16)] px-1.5 py-0.5 text-[10px] text-semantic-success">
                {Object.keys(pending).length} pending
              </span>
            )}
          </div>

          {visibleProperties.map((property) => {
            const def = defForProperty(property);
            if (!def) return null;
            const pendingValue = pending[property];
            const computed = readComputed(selectedElement, property);
            const value = pendingValue ?? computed ?? '';
            const applied = appliedByProperty[property];
            const removable = extraRows.includes(property);
            return (
              <PropertyRow
                key={property}
                def={def}
                value={value}
                hasPending={pendingValue !== undefined}
                summary={pendingValue !== undefined ? applied?.summary : undefined}
                error={pendingValue !== undefined ? applied?.error : undefined}
                onChange={(v) => setProperty(property, v)}
                onRemove={removable ? () => removeRow(property) : undefined}
              />
            );
          })}

          {/* "+ Add property" menu */}
          {availableExtras.length > 0 && (
            <div className="relative px-3 pb-3 pt-1.5">
              <button
                type="button"
                onClick={() => setShowAddMenu((v) => !v)}
                className="inline-flex items-center gap-1 rounded-[5px] border border-dashed border-border-subtle px-2 py-1 text-[11px] text-text-muted transition hover:border-accent/40 hover:text-text"
              >
                <Plus size={10} />
                Add property
              </button>
              {showAddMenu && (
                <div
                  role="menu"
                  className="absolute left-3 z-10 mt-1 w-[180px] overflow-hidden rounded-[6px] border border-border bg-surface-3 shadow-lg"
                >
                  {availableExtras.map((p) => (
                    <button
                      key={p.property}
                      role="menuitem"
                      type="button"
                      onClick={() => {
                        setExtraRows((prev) => [...prev, p.property]);
                        setShowAddMenu(false);
                      }}
                      className="block w-full px-2 py-1.5 text-left text-[11px] text-text-secondary transition hover:bg-surface-4 hover:text-text"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>

        {/* ─── Adapter selector ───────────────────────────────────── */}
        <section className="flex flex-col gap-1.5 border-b border-border-subtle px-3 py-3">
          <Label>Adapter</Label>
          <div className="flex items-center gap-1.5">
            <select
              value={adapter}
              onChange={(e) => setAdapter(e.target.value as StyleAdapterKind)}
              className="min-w-0 flex-1 rounded-[4px] border border-border-subtle bg-surface-3 px-2 py-1 text-[11px] text-text focus:border-accent focus:outline-none"
              aria-label="Style adapter"
            >
              {/* Show every adapter the detector found, plus the
                  preferred one if it's somehow missing from `available`. */}
              {dedupeAdapters([
                ...(adapterInfo?.available ?? []),
                adapterInfo?.preferred ?? 'unknown',
              ]).map((k) => (
                <option key={k} value={k}>
                  {adapterLabel(k)}
                  {adapterInfo?.preferred === k ? '  (detected)' : ''}
                </option>
              ))}
            </select>
          </div>
          {adapterError && (
            <div className="text-[10px] italic text-text-dim">
              Detection unavailable — using {adapterLabel(adapter)}.
            </div>
          )}
          {showAdapterUnsupportedWarning && (
            <div className="flex items-start gap-1.5 rounded-[6px] border border-semantic-warn/30 bg-[rgba(234,179,8,0.08)] px-2 py-1.5 text-[10.5px] text-semantic-warn">
              <AlertTriangle size={11} className="mt-0.5 shrink-0" />
              <span>
                {adapterLabel(adapter)} write-back ships in v0.9.0 — Apply is
                disabled. Switch to Tailwind to write back this release, or
                stick with the dry-run preview.
              </span>
            </div>
          )}
          {showAdapterMismatchWarning && !showAdapterUnsupportedWarning && (
            <div className="flex items-start gap-1.5 rounded-[6px] border border-semantic-warn/30 bg-[rgba(234,179,8,0.08)] px-2 py-1.5 text-[10.5px] text-semantic-warn">
              <AlertTriangle size={11} className="mt-0.5 shrink-0" />
              <span>
                Vanilla CSS write-back arrives in v0.9.0 — falling back to
                style-prop write.
              </span>
            </div>
          )}
          {adapterInfo?.evidence && adapterInfo.evidence.length > 0 && (
            <details className="group text-[10px] text-text-dim">
              <summary className="cursor-pointer select-none transition hover:text-text-muted">
                Why this adapter?
              </summary>
              <ul className="mt-1 space-y-0.5 pl-3">
                {adapterInfo.evidence.map((e) => (
                  <li key={e} className="break-all">
                    {e}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>

        {/* ─── Preview pane ───────────────────────────────────────── */}
        <section className="flex flex-col gap-1.5 border-b border-border-subtle px-3 py-3">
          <Label>Preview</Label>
          <PreviewPane state={run} editCount={edits.length} />
        </section>
      </div>

      {/* ─── Footer: Cancel / Apply ──────────────────────────────── */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border bg-surface-3 px-3 py-2">
        <button
          type="button"
          onClick={handleCancel}
          disabled={edits.length === 0 && run.kind === 'idle'}
          className="inline-flex items-center gap-1 rounded-[5px] border border-border-subtle bg-surface-2 px-2.5 py-1 text-[11px] text-text-secondary transition hover:border-border hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void handleApply()}
          disabled={!canApply}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-[5px] px-2.5 py-1 text-[11px] font-medium transition',
            canApply
              ? 'text-white hover:brightness-110'
              : 'pointer-events-none border border-border bg-surface-2 text-text-muted opacity-60',
          )}
          style={
            canApply
              ? {
                  background:
                    'linear-gradient(135deg, var(--color-accent), var(--color-accent-3))',
                  boxShadow: '0 1px 4px rgba(76,141,255,0.25)',
                }
              : undefined
          }
        >
          {run.kind === 'applying' ? (
            <>
              <Loader2 size={11} className="animate-spin" />
              Applying…
            </>
          ) : (
            <>
              Apply
              <ChevronRight size={11} />
            </>
          )}
        </button>
      </div>
    </aside>
  );
}

// ─── Panel header ──────────────────────────────────────────────────────

function PanelHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
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
  );
}

// ─── Property rows ────────────────────────────────────────────────────

interface PropertyRowProps {
  def: PropertyDef;
  value: string;          // effective value (pending ?? computed)
  hasPending: boolean;
  summary?: string;       // applied[i].summary from dryRun
  error?: string;
  onChange: (next: string) => void;
  onRemove?: () => void;  // shown only for user-added rows
}

function PropertyRow({
  def,
  value,
  hasPending,
  summary,
  error,
  onChange,
  onRemove,
}: PropertyRowProps) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1 border-t border-border-subtle px-3 py-2',
        hasPending && 'bg-[rgba(76,141,255,0.05)]',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10.5px] font-medium text-text-muted">
          {def.label}
        </span>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            title="Remove property"
            className="rounded p-0.5 text-text-dim transition hover:bg-surface-3 hover:text-semantic-error"
          >
            <X size={10} />
          </button>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        {def.kind === 'color' && (
          <ColorInput value={value} onChange={onChange} />
        )}
        {def.kind === 'length' && (
          <LengthInput
            value={value}
            units={def.units ?? ['px']}
            onChange={onChange}
          />
        )}
        {def.kind === 'select' && (
          <SelectInput
            value={value}
            options={def.options ?? []}
            onChange={onChange}
          />
        )}
        {def.kind === 'text' && (
          <TextInput
            value={value}
            placeholder={def.placeholder}
            onChange={onChange}
          />
        )}
      </div>
      {error && (
        <div className="text-[10px] text-semantic-error">{error}</div>
      )}
      {!error && summary && hasPending && (
        <div className="flex items-start gap-1 text-[10px] text-semantic-success">
          <Check size={9} className="mt-[1px] shrink-0" />
          <span className="min-w-0 break-words">{summary}</span>
        </div>
      )}
    </div>
  );
}

function ColorInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const hex = parseColorToHex(text || value);

  return (
    <>
      <input
        type="color"
        value={hex || '#000000'}
        onChange={(e) => {
          setText(e.target.value);
          onChange(e.target.value);
        }}
        className="h-6 w-8 shrink-0 cursor-pointer rounded-[4px] border border-border-subtle bg-surface-3"
        aria-label="Color swatch"
      />
      <input
        type="text"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(e.target.value);
        }}
        placeholder="#3b82f6"
        className="min-w-0 flex-1 rounded-[4px] border border-border-subtle bg-surface-3 px-2 py-1 font-mono text-[11px] text-text placeholder:text-text-dim focus:border-accent focus:outline-none"
      />
    </>
  );
}

function LengthInput({
  value,
  units,
  onChange,
}: {
  value: string;
  units: ReadonlyArray<string>;
  onChange: (next: string) => void;
}) {
  const parsed = parseLength(value);
  const fallbackUnit = units[0] ?? 'px';
  const [num, setNum] = useState(parsed.num);
  const [unit, setUnit] = useState<string>(
    units.includes(parsed.unit) ? parsed.unit : fallbackUnit,
  );
  useEffect(() => {
    const p = parseLength(value);
    setNum(p.num);
    setUnit(units.includes(p.unit) ? p.unit : fallbackUnit);
  }, [value, units, fallbackUnit]);

  return (
    <>
      <input
        type="number"
        value={num}
        onChange={(e) => {
          setNum(e.target.value);
          // Spec: send `value: "16px"` raw — the adapter handles unit
          // normalisation. Empty number clears the pending edit.
          onChange(e.target.value === '' ? '' : `${e.target.value}${unit}`);
        }}
        placeholder="16"
        className="min-w-0 flex-1 rounded-[4px] border border-border-subtle bg-surface-3 px-2 py-1 font-mono text-[11px] text-text placeholder:text-text-dim focus:border-accent focus:outline-none"
      />
      <select
        value={unit}
        onChange={(e) => {
          setUnit(e.target.value);
          if (num !== '') onChange(`${num}${e.target.value}`);
        }}
        className="shrink-0 rounded-[4px] border border-border-subtle bg-surface-3 px-1.5 py-1 text-[11px] text-text focus:border-accent focus:outline-none"
        aria-label="Unit"
      >
        {units.map((u) => (
          <option key={u} value={u}>
            {u}
          </option>
        ))}
      </select>
    </>
  );
}

function SelectInput({
  value,
  options,
  onChange,
}: {
  value: string;
  options: ReadonlyArray<string>;
  onChange: (next: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="min-w-0 flex-1 rounded-[4px] border border-border-subtle bg-surface-3 px-2 py-1 text-[11px] text-text focus:border-accent focus:outline-none"
    >
      <option value="">—</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

function TextInput({
  value,
  placeholder,
  onChange,
}: {
  value: string;
  placeholder?: string;
  onChange: (next: string) => void;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  return (
    <input
      type="text"
      value={local}
      onChange={(e) => {
        setLocal(e.target.value);
        onChange(e.target.value);
      }}
      placeholder={placeholder}
      className="min-w-0 flex-1 rounded-[4px] border border-border-subtle bg-surface-3 px-2 py-1 font-mono text-[11px] text-text placeholder:text-text-dim focus:border-accent focus:outline-none"
    />
  );
}

// ─── Preview pane ─────────────────────────────────────────────────────

function PreviewPane({
  state,
  editCount,
}: {
  state: RunState;
  editCount: number;
}) {
  if (editCount === 0 || state.kind === 'idle') {
    return (
      <div className="rounded-[6px] border border-dashed border-border-subtle bg-surface-3 px-2 py-3 text-center text-[10.5px] italic text-text-dim">
        Change a property to preview the diff.
      </div>
    );
  }
  if (state.kind === 'preview-loading' || state.kind === 'applying') {
    return (
      <div className="flex items-center gap-1.5 rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-2 text-[10.5px] text-text-muted">
        <Loader2 size={11} className="animate-spin" />
        {state.kind === 'applying' ? 'Writing to disk…' : 'Computing diff…'}
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="flex items-start gap-1.5 rounded-[6px] border border-semantic-error/30 bg-[rgba(239,68,68,0.05)] px-2 py-1.5 text-[10.5px] text-semantic-error">
        <AlertTriangle size={11} className="mt-0.5 shrink-0" />
        <span className="min-w-0 break-words">{state.message}</span>
      </div>
    );
  }
  // preview-ready or applied — render the diff(s) returned by the adapter.
  const { result } = state;
  const isApplied = state.kind === 'applied';
  if (!result.ok && result.errorMessage) {
    return (
      <div className="flex items-start gap-1.5 rounded-[6px] border border-semantic-error/30 bg-[rgba(239,68,68,0.05)] px-2 py-1.5 text-[10.5px] text-semantic-error">
        <AlertTriangle size={11} className="mt-0.5 shrink-0" />
        <span className="min-w-0 break-words">{result.errorMessage}</span>
      </div>
    );
  }
  // Show the actual file paths the adapter touched (deduped). Useful in
  // both preview ("we'll write to X") and applied ("we wrote to X") states.
  const touchedFiles = Array.from(
    new Set(result.applied.map((a) => a.filePath).filter(Boolean)),
  );
  // Concatenate every applied[i].diff that came back. Most batches only
  // touch one file so this is usually a single hunk.
  const combinedDiff = result.applied
    .map((a) => a.diff)
    .filter((d): d is string => typeof d === 'string' && d.length > 0)
    .join('\n');

  return (
    <div className="flex flex-col gap-1.5">
      {isApplied && (
        <div className="flex items-center gap-1.5 rounded-[6px] border border-semantic-success/30 bg-[rgba(34,197,94,0.08)] px-2 py-1.5 text-[10.5px] text-semantic-success">
          <Check size={11} />
          Edits applied.
        </div>
      )}
      {touchedFiles.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {touchedFiles.map((f) => (
            <div
              key={f}
              className="flex items-start gap-1 font-mono text-[10px] text-text-muted"
              title={f}
            >
              <FileCode2 size={10} className="mt-0.5 shrink-0 text-text-dim" />
              <span className="min-w-0 break-all">{f}</span>
            </div>
          ))}
        </div>
      )}
      {combinedDiff ? (
        <pre className="max-h-48 overflow-auto whitespace-pre rounded-[6px] border border-border-subtle bg-[rgba(0,0,0,0.18)] px-2 py-1.5 font-mono text-[10.5px] leading-snug text-text-secondary">
          {combinedDiff}
        </pre>
      ) : (
        <div className="rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-1.5 text-[10px] italic text-text-dim">
          No diff returned — the adapter handled this edit via runtime
          style-prop write.
        </div>
      )}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">
      {children}
    </div>
  );
}

function dedupeAdapters(list: StyleAdapterKind[]): StyleAdapterKind[] {
  const seen = new Set<StyleAdapterKind>();
  const out: StyleAdapterKind[] = [];
  for (const a of list) {
    if (seen.has(a)) continue;
    seen.add(a);
    out.push(a);
  }
  return out;
}
