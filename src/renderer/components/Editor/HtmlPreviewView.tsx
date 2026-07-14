import {
  AlertCircle,
  FileWarning,
  FolderOpen,
  Loader2,
  RotateCw,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import type { PreviewFileInfo } from '@shared/preview';

export interface HtmlPreviewViewProps {
  projectPath: string;
  htmlPath: string;
  /**
   * Cache-buster bumped by the store on PREVIEW_CHANGED / reopen. Changing it
   * forces a re-read + Blob rebuild even when `htmlPath` is unchanged.
   */
  reloadKey?: number;
}

/**
 * Derive the toolbar/title label from an absolute preview file path. Falls
 * back to the full path when there is no separator, and to a stable default
 * when the path is empty. Exported so the rendering rules can be pinned in a
 * test without standing up the iframe.
 */
export function derivePreviewName(htmlPath: string): string {
  if (!htmlPath) return 'preview.html';
  const idx = Math.max(htmlPath.lastIndexOf('/'), htmlPath.lastIndexOf('\\'));
  const base = idx >= 0 ? htmlPath.slice(idx + 1) : htmlPath;
  return base || 'preview.html';
}

/**
 * Pick the most-recently-modified preview file from a list, or `null` when
 * the list is empty. Ties on `mtime` are broken by `path` (ascending) so the
 * result is deterministic. Exported for the "Open latest HTML preview"
 * Spotlight command + its test — keeps the selection rule out of the React
 * tree so it can be pinned without IPC.
 */
export function pickLatestPreview(
  files: ReadonlyArray<PreviewFileInfo>,
): PreviewFileInfo | null {
  let best: PreviewFileInfo | null = null;
  for (const f of files) {
    if (
      !best ||
      f.mtime > best.mtime ||
      (f.mtime === best.mtime && f.path < best.path)
    ) {
      best = f;
    }
  }
  return best;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; blobUrl: string }
  | { status: 'error'; message: string };

/**
 * Renders a standalone HTML preview file (written by Claude under
 * `<project>/.devspace/preview/`) inside a hardened, sandboxed iframe.
 *
 * Security model (mirrors the old DesignPreview):
 *   • The HTML is fetched as a string over IPC and wrapped in a Blob URL, so
 *     the iframe document lives at an opaque `blob:` origin — it can't reach
 *     the renderer's globals, localStorage, or open `file://` URLs.
 *   • `sandbox="allow-scripts"` ONLY. No `allow-same-origin` (would defeat the
 *     opaque-origin isolation), no `allow-popups`, no `allow-top-navigation`.
 *   • The Blob URL is revoked whenever we rebuild or unmount, so we never leak
 *     object URLs across reloads.
 */
export function HtmlPreviewView({
  projectPath,
  htmlPath,
  reloadKey,
}: HtmlPreviewViewProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  // Hold the live Blob URL in a ref so the cleanup/refetch paths can revoke
  // the *previous* one without racing React state.
  const blobUrlRef = useRef<string | null>(null);

  const name = derivePreviewName(htmlPath);

  const revoke = useCallback(() => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
  }, []);

  const load = useCallback(async () => {
    if (!htmlPath) {
      setState({ status: 'error', message: 'No preview file selected.' });
      return;
    }
    setState({ status: 'loading' });
    try {
      // Read via the workspace-scoped fs API (NOT preview.readHtml, which is
      // restricted to <project>/.devspace/preview/) so ANY html file the user
      // right-clicks → Live Preview renders — not only generated previews.
      const html = await api.fs.readFile(htmlPath);
      // Revoke any URL from a prior load before minting the new one.
      revoke();
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      blobUrlRef.current = url;
      setState({ status: 'ready', blobUrl: url });
    } catch (err) {
      revoke();
      const message =
        err instanceof Error ? err.message : 'Failed to read preview file.';
      // Backend rejects with a path-not-found style error when the file was
      // deleted out from under us — surface a friendlier line for that case.
      const friendly = /not\s*exist|no\s*such|ENOENT/i.test(message)
        ? 'Preview file no longer exists.'
        : message;
      setState({ status: 'error', message: friendly });
    }
  }, [htmlPath, revoke]);

  // Re-read + rebuild the Blob URL whenever the file or the reload key flips.
  useEffect(() => {
    void load();
    return () => {
      // Tear down the object URL when the tab unmounts or the deps change so
      // the previous Blob doesn't linger.
      revoke();
    };
  }, [load, reloadKey, revoke]);

  const handleReveal = useCallback(() => {
    if (htmlPath) void api.fs.reveal(htmlPath).catch(() => undefined);
  }, [htmlPath]);

  // Empty placeholder when the tab has no file bound (defensive — the store
  // always sets a path, but keeps the view safe if wired without one).
  if (!htmlPath) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-surface text-text-muted">
        <div className="text-center">
          <FileWarning size={20} className="mx-auto mb-2 opacity-60" />
          <div className="text-[12px]">No preview file selected</div>
          <div className="mt-1 text-[11px] text-text-dim">
            Claude writes previews to{' '}
            <span className="font-mono">.devspace/preview/</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-surface">
      <Toolbar
        name={name}
        htmlPath={htmlPath}
        onRefresh={() => void load()}
        onReveal={handleReveal}
        loading={state.status === 'loading'}
      />
      <div className="relative min-h-0 flex-1">
        {state.status === 'loading' && (
          <div className="flex h-full w-full items-center justify-center text-[11px] text-text-muted">
            <Loader2 size={14} className="mr-2 animate-spin" />
            Loading {name}…
          </div>
        )}
        {state.status === 'error' && (
          <div className="flex h-full w-full items-center justify-center p-6">
            <div className="max-w-md text-center">
              <AlertCircle
                size={20}
                className="mx-auto mb-2 text-semantic-error"
              />
              <div className="text-[12px] font-medium text-semantic-error">
                {state.message}
              </div>
              <button
                type="button"
                onClick={() => void load()}
                className="mt-3 inline-flex items-center gap-1.5 rounded-[6px] border border-border-subtle bg-surface-3 px-3 py-1.5 text-[11px] text-text-secondary transition hover:bg-surface-4 hover:text-text"
              >
                <RotateCw size={11} />
                Retry
              </button>
            </div>
          </div>
        )}
        {state.status === 'ready' && (
          <iframe
            // Keying on the Blob URL forces a fresh document each rebuild —
            // the iframe can't be "reloaded" in place because the src changes.
            key={state.blobUrl}
            src={state.blobUrl}
            title={`HTML preview — ${name}`}
            // SECURITY: allow-scripts ONLY. No allow-same-origin / allow-popups
            // — the page stays at an opaque blob: origin, isolated from the
            // renderer and unable to open local file URLs.
            sandbox="allow-scripts"
            className="h-full w-full border-0 bg-white"
          />
        )}
      </div>
    </div>
  );
}

interface ToolbarProps {
  name: string;
  htmlPath: string;
  onRefresh: () => void;
  onReveal: () => void;
  loading: boolean;
}

function Toolbar({ name, htmlPath, onRefresh, onReveal, loading }: ToolbarProps) {
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2"
      style={{
        background:
          'linear-gradient(180deg, var(--color-surface-2) 0%, var(--color-surface) 100%)',
      }}
    >
      <span
        className="inline-flex h-[26px] max-w-[320px] items-center gap-1.5 rounded-[6px] border border-accent/30 bg-accent/10 px-2 text-[10.5px] font-medium text-accent"
        title={htmlPath}
      >
        <span className="truncate font-mono">{name}</span>
      </span>

      <div className="flex-1" />

      <button
        type="button"
        onClick={onReveal}
        title="Reveal in file manager"
        aria-label="Reveal preview file in file manager"
        className="inline-flex h-[26px] items-center gap-1.5 rounded-[6px] border border-border-subtle bg-surface-3 px-2.5 text-[11px] text-text-secondary transition hover:bg-surface-4 hover:text-text"
      >
        <FolderOpen size={11} />
        Open folder
      </button>

      <button
        type="button"
        onClick={onRefresh}
        disabled={loading}
        title="Re-read preview file"
        aria-label="Refresh preview"
        className={cn(
          'inline-flex h-[26px] w-[26px] items-center justify-center rounded-[6px] border border-border-subtle bg-surface-3 text-text-muted transition hover:bg-surface-4 hover:text-text',
          loading && 'pointer-events-none opacity-60',
        )}
      >
        {loading ? (
          <Loader2 size={12} className="animate-spin" />
        ) : (
          <RotateCw size={12} />
        )}
      </button>
    </div>
  );
}
