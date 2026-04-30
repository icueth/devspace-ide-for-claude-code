import * as Dialog from '@radix-ui/react-dialog';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Download, ExternalLink, Loader2, Sparkles, X } from 'lucide-react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import type { UpdateInfo } from '@shared/types';

const MarkdownPreview = lazy(() =>
  import('@renderer/components/Editor/MarkdownPreview').then((m) => ({
    default: m.MarkdownPreview,
  })),
);

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
            'no-drag inline-flex items-center gap-1 rounded-full px-1.5 text-[10.5px] transition',
            hasUpdate
              ? 'border border-accent/60 bg-accent/15 text-accent shadow-[0_0_8px_var(--color-accent-glow)] hover:brightness-110'
              : 'text-text-dim hover:text-text-secondary',
          )}
          title={
            hasUpdate
              ? `Update available: ${info?.latest} — click for details`
              : `Running ${versionLabel}. Click to check for updates.`
          }
        >
          <span>{versionLabel}</span>
          {hasUpdate && (
            <span
              className="ml-0.5 h-1.5 w-1.5 rounded-full bg-accent"
              style={{ boxShadow: '0 0 4px var(--color-accent-glow)' }}
            />
          )}
        </button>
      </Dialog.Trigger>

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

          <div className="min-h-[200px] flex-1 overflow-y-auto">
            {info?.error ? (
              <div className="px-5 py-4 text-[12px] text-semantic-error">
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
              <div className="px-5 py-6 text-center text-[12px] text-text-muted">
                <div className="text-text">You're on the latest version.</div>
                <div className="mt-1">
                  Last checked {formatRelative(info.checkedAt)}.
                </div>
              </div>
            ) : (
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center text-[11px] text-text-muted">
                    Loading release notes…
                  </div>
                }
              >
                <MarkdownPreview
                  markdown={info.releaseNotes ?? '_No release notes provided._'}
                />
              </Suspense>
            )}
          </div>

          {hasUpdate && (
            <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border-subtle px-5 py-3">
              <div className="text-[10.5px] text-text-muted">
                DevSpace is unsigned — drag the new app into{' '}
                <code className="rounded bg-surface-3 px-1">/Applications</code>{' '}
                replacing the old one.
              </div>
              <div className="flex items-center gap-1.5">
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
