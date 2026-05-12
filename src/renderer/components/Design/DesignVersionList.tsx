import { Clock, History, Pencil, Sparkles } from 'lucide-react';
import { useMemo } from 'react';

import { cn } from '@renderer/lib/utils';
import type { DesignScreenVersion } from '@shared/design';

export interface DesignVersionListProps {
  versions: DesignScreenVersion[];
  /**
   * `htmlPath` of the version that is currently being previewed. The
   * "current" entry (the latest version on a `ready` screen) is the
   * row whose `htmlPath` matches the screen's top-level `htmlPath`.
   */
  activeHtmlPath: string | null;
  /**
   * Fired when the user picks a version. The parent is responsible for
   * resolving the `htmlPath` into a preview src (which on Phase A just
   * means setting the iframe `src` to that file:// URL).
   */
  onSelect: (version: DesignScreenVersion) => void;
}

/**
 * Compact, scrollable list of previous generations for a screen. Each
 * row shows the relative timestamp, an excerpt of the brief, and a
 * subtle border-flash when active. The latest version is always pinned
 * to the top — the registry already stores versions newest-first, so we
 * don't re-sort.
 */
export function DesignVersionList({
  versions,
  activeHtmlPath,
  onSelect,
}: DesignVersionListProps) {
  if (versions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-4 py-6 text-center text-[11px] text-text-muted">
        <History size={14} className="mb-1.5 text-text-dim" />
        <div>No versions yet.</div>
        <div className="mt-0.5 text-[10px] text-text-dim">
          Each regeneration archives the previous HTML here.
        </div>
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-1 px-1 py-1">
      {versions.map((v, idx) => (
        <VersionRow
          key={v.id}
          version={v}
          isActive={activeHtmlPath === v.htmlPath}
          isLatest={idx === 0}
          onClick={() => onSelect(v)}
        />
      ))}
    </ul>
  );
}

interface VersionRowProps {
  version: DesignScreenVersion;
  isActive: boolean;
  isLatest: boolean;
  onClick: () => void;
}

function VersionRow({ version, isActive, isLatest, onClick }: VersionRowProps) {
  const relTime = useMemo(() => formatRelative(version.createdAt), [version.createdAt]);
  // U7: prefer the user's note when set (it's the most informative
  // label), otherwise fall back to a brief excerpt. Edit-origin versions
  // often have a note like "tighter hero" but no brief, so without this
  // fallback the row would render empty.
  const summary = useMemo(() => {
    const noteRaw = (version.note ?? '').trim();
    if (noteRaw) {
      const collapsed = noteRaw.replace(/\s+/g, ' ');
      return collapsed.length > 90 ? `${collapsed.slice(0, 87)}…` : collapsed;
    }
    const trimmed = (version.brief ?? '').trim().replace(/\s+/g, ' ');
    return trimmed.length > 90 ? `${trimmed.slice(0, 87)}…` : trimmed;
  }, [version.brief, version.note]);
  const isEdit = version.origin === 'edit';
  const editCount = version.edits?.length ?? 0;

  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'group flex w-full flex-col gap-1 rounded-[6px] border px-2 py-1.5 text-left transition',
          isActive
            ? 'border-accent/40 bg-[rgba(76,141,255,0.12)]'
            : 'border-border-subtle bg-surface-3 hover:border-border-hi hover:bg-surface-4',
        )}
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <Clock size={10} className="shrink-0 text-text-dim" />
          <span className="font-mono text-[10px] tabular-nums text-text-secondary">
            {relTime}
          </span>
          {isLatest && (
            <span className="rounded-full bg-[rgba(34,197,94,0.18)] px-1.5 text-[8.5px] uppercase tracking-wide text-semantic-success">
              latest
            </span>
          )}
          {isActive && !isLatest && (
            <span className="rounded-full bg-[rgba(76,141,255,0.18)] px-1.5 text-[8.5px] uppercase tracking-wide text-accent">
              viewing
            </span>
          )}
          {/* U7: origin badge — "edit" rows look visually distinct from
              fresh generations so users don't confuse a manual CSS save
              with a re-generated screen. */}
          {isEdit ? (
            <span
              className="inline-flex items-center gap-0.5 rounded-full bg-[rgba(168,85,247,0.18)] px-1.5 text-[8.5px] uppercase tracking-wide text-[#c084fc]"
              title={
                editCount > 0
                  ? `Manual edit save (${editCount} CSS op${editCount > 1 ? 's' : ''})`
                  : 'Manual edit save'
              }
            >
              <Pencil size={8} />
              edit{editCount > 0 ? ` · ${editCount}` : ''}
            </span>
          ) : (
            <span
              className="inline-flex items-center gap-0.5 rounded-full bg-surface-4 px-1.5 text-[8.5px] uppercase tracking-wide text-text-muted"
              title="Generated from Claude"
            >
              <Sparkles size={8} />
              gen
            </span>
          )}
        </div>
        <div className="text-[10.5px] leading-snug text-text">
          {summary || <span className="italic text-text-dim">(no brief)</span>}
        </div>
      </button>
    </li>
  );
}

function formatRelative(ts: number): string {
  const now = Date.now();
  const diff = Math.max(0, now - ts);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}
