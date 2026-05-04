import 'highlight.js/styles/github-dark.css';

import * as Dialog from '@radix-ui/react-dialog';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, ExternalLink, Loader2, Sparkles, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import type { UpdateInfo } from '@shared/types';

interface Props {
  // The version string already shown by App header — we mirror it as fallback
  // until our own check returns. Avoids a flicker where the badge says "?".
  fallbackVersion: string;
}

/**
 * The version pill in the header bar. While idle it just shows the running
 * version; when our update check finds something newer it morphs into a
 * gradient-glow badge that opens a dialog with release notes + a one-click
 * "Download update" button.
 *
 * Auto-checks on mount and on window focus, with a 10-minute server-side
 * cache so flicking between windows doesn't spam GitHub. The user can also
 * trigger a fresh check from the dialog.
 */
export function UpdateBadge({ fallbackVersion }: Props) {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const ranFirstCheckRef = useRef(false);

  const runCheck = useCallback(async (force: boolean) => {
    setChecking(true);
    try {
      const next = await api.app.checkUpdate(force);
      setInfo(next);
    } catch {
      /* swallow — keep last known info */
    } finally {
      setChecking(false);
    }
  }, []);

  // First check on mount, then re-check on focus. Server caches for 10min,
  // so this is cheap. We don't refresh on every focus: the cached response
  // will short-circuit anyway.
  useEffect(() => {
    if (ranFirstCheckRef.current) return;
    ranFirstCheckRef.current = true;
    void runCheck(false);
    const onFocus = () => void runCheck(false);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [runCheck]);

  const hasUpdate = info?.hasUpdate === true;
  const versionLabel = `v${info?.current ?? fallbackVersion}`;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          className={cn(
            'no-drag relative inline-flex items-center gap-1 rounded-full px-2 py-[1px] text-[10.5px] transition',
            hasUpdate
              ? 'border border-accent/60 bg-accent/15 text-accent hover:brightness-110'
              : 'text-text-dim hover:text-text-secondary',
          )}
          style={
            hasUpdate
              ? {
                  // Pulsing outer glow — keyframes defined inline so we
                  // don't have to ship a global stylesheet update for one
                  // badge. Synced to a 1.6s breathe so it reads as "alive,
                  // do something" without being annoying.
                  animation: 'devspace-update-pulse 1.6s ease-in-out infinite',
                }
              : undefined
          }
          title={
            hasUpdate
              ? `Update available: ${info?.latest} — click for details`
              : `Running ${versionLabel}. Click to check for updates.`
          }
        >
          <span>{versionLabel}</span>
          {hasUpdate && (
            <span className="relative ml-0.5 inline-flex h-1.5 w-1.5">
              {/* Radar ping behind the dot — Tailwind's animate-ping
                  scales from 1 → 2.25 with fading opacity, matching the
                  classic notification-dot affordance. */}
              <span className="absolute inset-0 inline-flex animate-ping rounded-full bg-accent opacity-75" />
              <span
                className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent"
                style={{ boxShadow: '0 0 6px var(--color-accent-glow)' }}
              />
            </span>
          )}
        </button>
      </Dialog.Trigger>
      {/* Inline keyframes so the badge pulse works without touching the
          global stylesheet. The shadow swing is what reads as "blinking"
          to the user — opacity alone is too subtle on a small pill. */}
      <style>{`
        @keyframes devspace-update-pulse {
          0%, 100% {
            box-shadow: 0 0 6px rgba(76, 141, 255, 0.35),
                        0 0 0 0 rgba(76, 141, 255, 0.45);
          }
          50% {
            box-shadow: 0 0 14px rgba(76, 141, 255, 0.65),
                        0 0 0 4px rgba(76, 141, 255, 0.0);
          }
        }
      `}</style>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-[560px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-surface-raised shadow-2xl',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          )}
        >
          <div className="flex shrink-0 items-center justify-between border-b border-border-subtle px-5 py-3">
            <div className="flex items-center gap-2">
              <Sparkles size={14} className="text-accent" />
              <Dialog.Title className="text-[13px] font-semibold text-text">
                {hasUpdate ? 'Update available' : 'Up to date'}
              </Dialog.Title>
            </div>
            <Dialog.Close className="rounded p-1 text-text-muted transition hover:bg-surface-3 hover:text-text">
              <X size={13} />
            </Dialog.Close>
          </div>

          <div className="flex shrink-0 items-center gap-3 border-b border-border-subtle px-5 py-2.5 text-[11.5px]">
            <Pill label="Installed" value={`v${info?.current ?? fallbackVersion}`} />
            <Pill
              label="Latest"
              value={info?.latest ?? '—'}
              tone={hasUpdate ? 'accent' : info?.error ? 'warn' : 'muted'}
            />
            <div className="flex-1" />
            <button
              onClick={() => void runCheck(true)}
              disabled={checking}
              className="inline-flex h-[24px] items-center gap-1.5 rounded-[6px] border border-border-subtle bg-surface-3 px-2 text-[11px] text-text-secondary transition hover:border-border-hi hover:bg-surface-4 hover:text-text disabled:opacity-50"
              title="Re-check GitHub Releases"
            >
              {checking ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <Sparkles size={11} />
              )}
              <span>{checking ? 'Checking…' : 'Check now'}</span>
            </button>
          </div>

          <div className="min-h-[200px] flex-1 overflow-y-auto px-5 py-4">
            {info?.error ? (
              <div className="text-[12px] text-semantic-error">
                <div className="font-semibold">Couldn't reach GitHub</div>
                <div className="mt-1 text-[11px] text-text-muted">
                  {info.error}
                </div>
              </div>
            ) : !info ? (
              <div className="flex h-full items-center justify-center text-[12px] text-text-muted">
                Checking for updates…
              </div>
            ) : !hasUpdate ? (
              <div className="py-6 text-center text-[12px] text-text-muted">
                <div className="text-text">You're on the latest version.</div>
                <div className="mt-1">
                  Last checked {formatRelative(info.checkedAt)}.
                </div>
              </div>
            ) : (
              // Render markdown inline so it flows in normal layout — the
              // editor's MarkdownPreview uses `position: absolute` for the
              // split-pane case, which collapses inside this dialog body
              // and breaks scrolling. The prose-invert classes give us
              // matching typography to the rest of the app.
              <div className="prose prose-invert max-w-none text-[13px] leading-relaxed prose-headings:mt-4 prose-headings:mb-2 prose-h1:text-[16px] prose-h2:text-[14px] prose-h3:text-[13px] prose-p:my-2 prose-ul:my-2 prose-li:my-0.5 prose-code:rounded prose-code:bg-surface-3 prose-code:px-1 prose-code:py-0.5 prose-code:text-[12px] prose-code:before:content-none prose-code:after:content-none prose-pre:my-3 prose-pre:rounded-md prose-pre:bg-surface-3 prose-pre:p-3 prose-pre:text-[11.5px] prose-a:text-accent prose-a:no-underline hover:prose-a:underline">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[[rehypeHighlight, { detect: true }]]}
                >
                  {info.releaseNotes ?? '_No release notes provided._'}
                </ReactMarkdown>
              </div>
            )}
          </div>

          {hasUpdate && (
            // Footer wraps when the dialog narrows so neither the unsigned
            // hint nor the action buttons get squashed off-screen.
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-border-subtle px-5 py-3">
              <div className="min-w-0 flex-1 basis-[220px] text-[10.5px] text-text-muted">
                DevSpace is unsigned — drag the new app into{' '}
                <code className="rounded bg-surface-3 px-1">/Applications</code>{' '}
                replacing the old one.
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {info?.releaseUrl && (
                  <button
                    onClick={() => {
                      void api.app.openExternal(info.releaseUrl!);
                    }}
                    className="inline-flex h-[28px] items-center gap-1.5 rounded-[7px] border border-border-subtle bg-surface-3 px-3 text-[11.5px] text-text-secondary transition hover:border-border-hi hover:bg-surface-4 hover:text-text"
                  >
                    <ExternalLink size={11} />
                    <span>Release page</span>
                  </button>
                )}
                <button
                  onClick={() => {
                    const url = info?.downloadUrl ?? info?.releaseUrl;
                    if (url) void api.app.openExternal(url);
                  }}
                  disabled={!info?.downloadUrl && !info?.releaseUrl}
                  className="inline-flex h-[28px] items-center gap-1.5 rounded-[7px] px-3 text-[11.5px] font-medium text-white transition hover:brightness-110 disabled:opacity-50"
                  style={{
                    background:
                      'linear-gradient(135deg, var(--color-accent), #a855f7)',
                    boxShadow: '0 2px 8px var(--color-accent-glow)',
                  }}
                >
                  <Download size={11.5} strokeWidth={2.2} />
                  <span>Download {info?.latest}</span>
                </button>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Pill({
  label,
  value,
  tone = 'muted',
}: {
  label: string;
  value: string;
  tone?: 'muted' | 'accent' | 'warn';
}) {
  const tones = {
    muted: 'text-text-muted',
    accent: 'text-accent',
    warn: 'text-semantic-warning',
  } as const;
  return (
    <div className="inline-flex items-baseline gap-1.5">
      <span className="text-[10px] uppercase tracking-wider text-text-dim">
        {label}
      </span>
      <span className={cn('font-mono tabular-nums text-[12px]', tones[tone])}>
        {value}
      </span>
    </div>
  );
}

function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))}h ago`;
  return new Date(ms).toLocaleString();
}
