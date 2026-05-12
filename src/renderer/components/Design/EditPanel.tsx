import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Eraser,
  Pencil,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { cn } from '@renderer/lib/utils';
import type { DesignEditOp, DesignElementInfo } from '@shared/design';

export interface EditPanelChange {
  elementId: string;
  property: string;
  value: string;
}

export interface EditPanelProps {
  info: DesignElementInfo | null;
  pendingEdits: DesignEditOp[];
  onChange: (op: EditPanelChange) => void;
  onClearOverrides: () => void;
}

type LengthUnit = 'px' | 'rem' | 'em';

const FONT_WEIGHTS = ['100', '200', '300', '400', '500', '600', '700', '800', '900'] as const;
const DISPLAY_OPTIONS = ['block', 'flex', 'grid', 'inline-block', 'inline', 'none'] as const;
const ALIGN_OPTIONS: Array<{ value: string; icon: React.ReactNode; title: string }> = [
  { value: 'left', icon: <AlignLeft size={11} />, title: 'Left' },
  { value: 'center', icon: <AlignCenter size={11} />, title: 'Center' },
  { value: 'right', icon: <AlignRight size={11} />, title: 'Right' },
  { value: 'justify', icon: <AlignJustify size={11} />, title: 'Justify' },
];

// CSS named/keyword colors that don't round-trip through the <input
// type=color> control. Returning '' makes the colour picker fall back
// to its default (black) without confusing the hex input.
function parseColorToHex(value: string | undefined): string {
  if (!value) return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('#')) {
    if (trimmed.length === 7) return trimmed;
    if (trimmed.length === 4) {
      const r = trimmed[1]!;
      const g = trimmed[2]!;
      const b = trimmed[3]!;
      return `#${r}${r}${g}${g}${b}${b}`;
    }
    return '';
  }
  const m = trimmed.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (m) {
    const r = Number(m[1]).toString(16).padStart(2, '0');
    const g = Number(m[2]).toString(16).padStart(2, '0');
    const b = Number(m[3]).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`;
  }
  return '';
}

function parseLength(value: string | undefined): { num: string; unit: LengthUnit } {
  if (!value) return { num: '', unit: 'px' };
  const m = value.trim().match(/^(-?\d*\.?\d+)(px|rem|em)?$/i);
  if (!m) return { num: '', unit: 'px' };
  const unit = (m[2]?.toLowerCase() ?? 'px') as LengthUnit;
  return { num: m[1] ?? '', unit };
}

/**
 * Editable CSS controls for the currently-selected element. Each
 * control fires `onChange` with the canonical kebab-case CSS property
 * and a stringified value. Text fields debounce by ~150ms to avoid
 * flooding the postMessage bridge while the user types.
 */
export function EditPanel({
  info,
  pendingEdits,
  onChange,
  onClearOverrides,
}: EditPanelProps) {
  // Hooks must run unconditionally — keep the empty-state branch below
  // the hook block.
  const elementId = info?.elementId ?? '';
  const elementPendingEdits = useMemo(
    () => pendingEdits.filter((op) => op.elementId === elementId),
    [pendingEdits, elementId],
  );

  // Effective value = pending override (latest) or computed style.
  const effective = useCallback(
    (property: string, fallback: string | undefined): string => {
      const op = elementPendingEdits.find((e) => e.property === property);
      return op?.value ?? fallback ?? '';
    },
    [elementPendingEdits],
  );

  const fire = useCallback(
    (property: string, value: string) => {
      if (!elementId) return;
      onChange({ elementId, property, value });
    },
    [onChange, elementId],
  );

  if (!info) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-4 text-center">
        <Pencil size={14} className="mb-1.5 text-text-dim" />
        <div className="text-[11px] text-text-muted">Select an element to edit</div>
        <div className="mt-1 text-[10px] text-text-dim">
          Hover the preview to highlight, click to start editing.
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <section className="flex flex-col gap-2 border-b border-border-subtle px-3 py-3">
          <Label>Target</Label>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center rounded-[4px] bg-[rgba(76,141,255,0.18)] px-1.5 py-0.5 font-mono text-[10.5px] text-accent">
              &lt;{info.tagName.toLowerCase()}&gt;
            </span>
            {elementPendingEdits.length > 0 && (
              <span className="inline-flex items-center rounded-[4px] bg-[rgba(34,197,94,0.16)] px-1.5 py-0.5 text-[10px] text-semantic-success">
                {elementPendingEdits.length} pending
              </span>
            )}
          </div>
        </section>

        <ColorRow
          label="Text color"
          property="color"
          value={effective('color', info.computedStyles.color)}
          onChange={fire}
        />
        <ColorRow
          label="Background"
          property="background-color"
          value={effective('background-color', info.computedStyles.backgroundColor)}
          onChange={fire}
        />

        <LengthRow
          label="Font size"
          property="font-size"
          value={effective('font-size', info.computedStyles.fontSize)}
          onChange={fire}
        />

        <SelectRow
          label="Font weight"
          property="font-weight"
          value={effective('font-weight', info.computedStyles.fontWeight)}
          options={FONT_WEIGHTS as readonly string[]}
          onChange={fire}
        />

        <TextRow
          label="Padding"
          property="padding"
          value={effective('padding', info.computedStyles.padding)}
          placeholder="8px 12px"
          onChange={fire}
        />
        <TextRow
          label="Margin"
          property="margin"
          value={effective('margin', info.computedStyles.margin)}
          placeholder="0 auto"
          onChange={fire}
        />

        <LengthRow
          label="Border radius"
          property="border-radius"
          value={effective('border-radius', info.computedStyles.borderRadius)}
          onChange={fire}
          unitsAllowed={['px', 'rem']}
        />

        <SelectRow
          label="Display"
          property="display"
          value={effective('display', info.computedStyles.display)}
          options={DISPLAY_OPTIONS as readonly string[]}
          onChange={fire}
        />

        <AlignRow
          label="Text align"
          value={effective('text-align', info.computedStyles.textAlign)}
          onChange={fire}
        />
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-3 py-2">
        <span className="text-[10px] text-text-dim">
          {pendingEdits.length} edit{pendingEdits.length === 1 ? '' : 's'} pending
        </span>
        <button
          type="button"
          onClick={onClearOverrides}
          className="inline-flex items-center gap-1 rounded-[5px] border border-border-subtle bg-surface-3 px-2 py-1 text-[10.5px] text-text-secondary transition hover:border-semantic-error/40 hover:text-semantic-error"
          title="Remove all overrides on the iframe and clear pending edits"
        >
          <Eraser size={10} />
          Clear overrides
        </button>
      </div>
    </div>
  );
}

// ─── Rows ───────────────────────────────────────────────────────────────

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5 border-b border-border-subtle px-3 py-2.5">
      <Label>{label}</Label>
      <div className="flex items-center gap-1.5">{children}</div>
    </section>
  );
}

function ColorRow({
  label,
  property,
  value,
  onChange,
}: {
  label: string;
  property: string;
  value: string;
  onChange: (property: string, value: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const hex = parseColorToHex(text || value);
  const debounced = useDebouncedCallback(
    (next: string) => onChange(property, next),
    150,
  );

  return (
    <Row label={label}>
      <input
        type="color"
        value={hex || '#000000'}
        onChange={(e) => {
          setText(e.target.value);
          // Color picker is already discrete — fire immediately.
          onChange(property, e.target.value);
        }}
        className="h-6 w-8 shrink-0 cursor-pointer rounded-[4px] border border-border-subtle bg-surface-3"
        aria-label={`${label} swatch`}
      />
      <input
        type="text"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          debounced(e.target.value);
        }}
        placeholder="#3366ff"
        className="min-w-0 flex-1 rounded-[4px] border border-border-subtle bg-surface-3 px-2 py-1 font-mono text-[11px] text-text placeholder:text-text-dim focus:border-accent focus:outline-none"
      />
    </Row>
  );
}

function LengthRow({
  label,
  property,
  value,
  onChange,
  unitsAllowed = ['px', 'rem', 'em'],
}: {
  label: string;
  property: string;
  value: string;
  onChange: (property: string, value: string) => void;
  unitsAllowed?: LengthUnit[];
}) {
  const parsed = parseLength(value);
  const [num, setNum] = useState(parsed.num);
  const [unit, setUnit] = useState<LengthUnit>(parsed.unit);
  useEffect(() => {
    const p = parseLength(value);
    setNum(p.num);
    setUnit(p.unit);
  }, [value]);

  const debounced = useDebouncedCallback(
    (next: string) => onChange(property, next),
    150,
  );

  return (
    <Row label={label}>
      <input
        type="number"
        value={num}
        onChange={(e) => {
          setNum(e.target.value);
          debounced(e.target.value === '' ? '' : `${e.target.value}${unit}`);
        }}
        placeholder="16"
        className="min-w-0 flex-1 rounded-[4px] border border-border-subtle bg-surface-3 px-2 py-1 font-mono text-[11px] text-text placeholder:text-text-dim focus:border-accent focus:outline-none"
      />
      <select
        value={unit}
        onChange={(e) => {
          const nextUnit = e.target.value as LengthUnit;
          setUnit(nextUnit);
          if (num !== '') onChange(property, `${num}${nextUnit}`);
        }}
        className="shrink-0 rounded-[4px] border border-border-subtle bg-surface-3 px-1.5 py-1 text-[11px] text-text focus:border-accent focus:outline-none"
        aria-label={`${label} unit`}
      >
        {unitsAllowed.map((u) => (
          <option key={u} value={u}>
            {u}
          </option>
        ))}
      </select>
    </Row>
  );
}

function SelectRow({
  label,
  property,
  value,
  options,
  onChange,
}: {
  label: string;
  property: string;
  value: string;
  options: readonly string[];
  onChange: (property: string, value: string) => void;
}) {
  return (
    <Row label={label}>
      <select
        value={value}
        onChange={(e) => onChange(property, e.target.value)}
        className="min-w-0 flex-1 rounded-[4px] border border-border-subtle bg-surface-3 px-2 py-1 text-[11px] text-text focus:border-accent focus:outline-none"
      >
        <option value="">—</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </Row>
  );
}

function TextRow({
  label,
  property,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  property: string;
  value: string;
  placeholder?: string;
  onChange: (property: string, value: string) => void;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  const debounced = useDebouncedCallback(
    (next: string) => onChange(property, next),
    150,
  );

  return (
    <Row label={label}>
      <input
        type="text"
        value={local}
        onChange={(e) => {
          setLocal(e.target.value);
          debounced(e.target.value);
        }}
        placeholder={placeholder}
        className="min-w-0 flex-1 rounded-[4px] border border-border-subtle bg-surface-3 px-2 py-1 font-mono text-[11px] text-text placeholder:text-text-dim focus:border-accent focus:outline-none"
      />
    </Row>
  );
}

function AlignRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (property: string, value: string) => void;
}) {
  return (
    <Row label={label}>
      <div className="inline-flex overflow-hidden rounded-[5px] border border-border-subtle bg-surface-3">
        {ALIGN_OPTIONS.map((opt) => {
          const active = value === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              title={opt.title}
              onClick={() => onChange('text-align', opt.value)}
              className={cn(
                'inline-flex items-center justify-center px-2 py-1 transition',
                active
                  ? 'bg-[rgba(76,141,255,0.18)] text-accent'
                  : 'text-text-muted hover:bg-surface-4 hover:text-text',
              )}
            >
              {opt.icon}
            </button>
          );
        })}
      </div>
    </Row>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">
      {children}
    </div>
  );
}

// ─── Debounce ───────────────────────────────────────────────────────────

function useDebouncedCallback<T extends (...args: never[]) => void>(
  fn: T,
  delay: number,
): (...args: Parameters<T>) => void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return useCallback(
    (...args: Parameters<T>) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => fnRef.current(...args), delay);
    },
    [delay],
  );
}
