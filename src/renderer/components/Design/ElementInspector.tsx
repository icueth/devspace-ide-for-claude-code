import { MousePointer } from 'lucide-react';

import type { DesignElementInfo } from '@shared/design';

export interface ElementInspectorProps {
  info: DesignElementInfo | null;
}

/**
 * Read-only details panel for an inspected element. Renders the tag
 * name, class chips, an inner-text preview, and the subset of computed
 * styles the bridge ships back. Styling mirrors `DesignBriefPanel` so
 * the right-edge panel feels uniform across modes.
 */
export function ElementInspector({ info }: ElementInspectorProps) {
  if (!info) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-4 text-center">
        <MousePointer size={14} className="mb-1.5 text-text-dim" />
        <div className="text-[11px] text-text-muted">Click an element to inspect</div>
        <div className="mt-1 text-[10px] text-text-dim">
          Hover the preview to highlight, click to lock the selection.
        </div>
      </div>
    );
  }

  const styles = info.computedStyles;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <section className="flex flex-col gap-2 border-b border-border-subtle px-3 py-3">
        <Label>Element</Label>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center rounded-[4px] bg-[rgba(76,141,255,0.18)] px-1.5 py-0.5 font-mono text-[10.5px] text-accent">
            &lt;{info.tagName.toLowerCase()}&gt;
          </span>
          {info.classes.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {info.classes.slice(0, 8).map((cls) => (
                <span
                  key={cls}
                  className="inline-flex items-center rounded-[4px] border border-border-subtle bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-text-secondary"
                  title={cls}
                >
                  .{cls}
                </span>
              ))}
              {info.classes.length > 8 && (
                <span className="text-[10px] text-text-dim">
                  +{info.classes.length - 8} more
                </span>
              )}
            </div>
          )}
        </div>
        {info.innerTextPreview ? (
          <p className="whitespace-pre-wrap rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-1.5 text-[11px] leading-snug text-text-secondary">
            {info.innerTextPreview}
          </p>
        ) : (
          <p className="text-[10.5px] italic text-text-dim">No text content.</p>
        )}
      </section>

      <section className="flex flex-col gap-2 border-b border-border-subtle px-3 py-3">
        <Label>Layout</Label>
        <RectRow label="X" value={info.rect.x} />
        <RectRow label="Y" value={info.rect.y} />
        <RectRow label="Width" value={info.rect.width} />
        <RectRow label="Height" value={info.rect.height} />
      </section>

      <section className="flex flex-col gap-1 px-3 py-3">
        <Label>Computed styles</Label>
        <StyleRow name="color" value={styles.color} />
        <StyleRow name="background-color" value={styles.backgroundColor} />
        <StyleRow name="font-family" value={styles.fontFamily} />
        <StyleRow name="font-size" value={styles.fontSize} />
        <StyleRow name="font-weight" value={styles.fontWeight} />
        <StyleRow name="padding" value={styles.padding} />
        <StyleRow name="margin" value={styles.margin} />
        <StyleRow name="border" value={styles.border} />
        <StyleRow name="border-radius" value={styles.borderRadius} />
        <StyleRow name="display" value={styles.display} />
        <StyleRow name="text-align" value={styles.textAlign} />
      </section>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
      {children}
    </div>
  );
}

function RectRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between text-[11px]">
      <span className="text-text-muted">{label}</span>
      <span className="font-mono text-text-secondary">{Math.round(value)}px</span>
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
