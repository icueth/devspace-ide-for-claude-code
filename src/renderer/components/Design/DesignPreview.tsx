import { Paintbrush } from 'lucide-react';
import { useEffect, useState } from 'react';

import { api } from '@renderer/lib/api';

/**
 * Sandboxed iframe rendering a generated design screen.
 *
 * Phase A renders via a Blob URL (created from HTML fetched through
 * `api.design.readHtml`) rather than `file://`. Three reasons:
 *   1. file:// + spaces / unicode / Windows backslashes is fragile;
 *      Blob URLs sidestep the entire URL-encoding mess.
 *   2. The Blob URL pairs with `sandbox="allow-scripts"` (no
 *      `allow-same-origin`) → effective origin is opaque, so the
 *      generated page can't reach DevSpace's renderer state.
 *   3. Without `allow-popups` + file://, a hostile design HTML can't
 *      `window.open('file:///Users/.ssh/...')` to surface local paths
 *      to the user via the system handler.
 *
 * The page is also hardened server-side (`hardenGeneratedHtml` in
 * DesignService) — remote `<script src>` / iframes / objects are
 * stripped, `javascript:` URLs neutralized, and a strict CSP meta is
 * injected before the HTML hits disk.
 */
export interface DesignPreviewProps {
  /** Project root. Pass an empty string to render the empty state. */
  projectPath: string;
  /**
   * Screen identifier (the active screen's `id`). When `null`, the
   * empty state is rendered.
   */
  screenId: string | null;
  /**
   * Optional version id when previewing a historical revision. `null`
   * means "preview the latest".
   */
  versionId?: string | null;
  /**
   * Cache buster — bumped whenever a regeneration completes so the
   * iframe reloads even if `(screenId, versionId)` is unchanged.
   */
  reloadKey?: number | string;
  emptyLabel?: string;
  emptyHint?: string;
}

export function DesignPreview({
  projectPath,
  screenId,
  versionId,
  reloadKey,
  emptyLabel,
  emptyHint,
}: DesignPreviewProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectPath || !screenId) {
      setBlobUrl(null);
      setError(null);
      return;
    }
    let cancelled = false;
    let createdUrl: string | null = null;
    setError(null);
    (async () => {
      try {
        const html = await api.design.readHtml(
          projectPath,
          screenId,
          versionId ?? undefined,
        );
        if (cancelled) return;
        const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
        createdUrl = URL.createObjectURL(blob);
        setBlobUrl(createdUrl);
      } catch (err) {
        if (cancelled) return;
        const message = (err as Error).message ?? 'failed to load preview';
        // Treat ENOENT as the empty state — the screen exists but has no
        // generated HTML yet (e.g. status still 'pending').
        if (/ENOENT|no such file/i.test(message)) {
          setBlobUrl(null);
          setError(null);
        } else {
          setError(message);
          setBlobUrl(null);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [projectPath, screenId, versionId, reloadKey]);

  if (error) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-surface">
        <div className="max-w-md px-6 text-center">
          <div className="text-[12px] font-medium text-semantic-error">
            Preview failed to load
          </div>
          <pre className="mt-2 whitespace-pre-wrap text-[11px] text-text-muted">
            {error}
          </pre>
        </div>
      </div>
    );
  }

  if (!blobUrl) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-surface">
        <div className="max-w-sm text-center">
          <div
            className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-[10px]"
            style={{
              background:
                'linear-gradient(135deg, rgba(76,141,255,0.18), rgba(168,85,247,0.18))',
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)',
            }}
          >
            <Paintbrush size={20} className="text-accent" />
          </div>
          <div className="text-[13px] font-medium text-text">
            {emptyLabel ?? 'No designs yet'}
          </div>
          <div className="mt-1.5 text-[11px] text-text-muted">
            {emptyHint ?? 'Pick a skill, write a brief, click Generate.'}
          </div>
        </div>
      </div>
    );
  }

  return (
    <iframe
      key={blobUrl}
      src={blobUrl}
      // CRITICAL: no `allow-same-origin` → effective origin is opaque so
      // the embedded HTML can't reach window.devspace / localStorage.
      // `allow-popups` is intentionally OMITTED — it would let hostile
      // HTML window.open() to file:// or javascript: URLs.
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      title="Design preview"
      className="h-full w-full border-0 bg-white"
    />
  );
}
