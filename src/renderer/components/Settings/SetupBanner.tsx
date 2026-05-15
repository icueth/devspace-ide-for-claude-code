import { Sparkles, Wrench, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import type { SetupStatus } from '@shared/setup';

const DISMISSED_KEY = 'devspace.setupBanner.dismissedFor';

/**
 * Soft top banner that nudges users toward the Setup tab when devspace's
 * required tools (Claude / tmux / rtk / jq / hooks / MemPalace) aren't all
 * present. Non-blocking — users can dismiss for the current set of missing
 * tools, and the banner reappears later if a *new* tool becomes missing.
 *
 * Strategy:
 *   • Dismiss state is keyed by a stable signature of the missing tools, so
 *     once the environment changes (e.g. user installs Claude but tmux
 *     breaks) the banner returns automatically.
 *   • All work happens client-side after first paint — initial render is a
 *     null so the banner never causes a flash on cold load.
 */
export function SetupBanner({
  onOpenSetup,
}: {
  onOpenSetup: () => void;
}) {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [dismissedSig, setDismissedSig] = useState<string | null>(null);

  useEffect(() => {
    try {
      setDismissedSig(localStorage.getItem(DISMISSED_KEY));
    } catch {
      // localStorage can throw in some restricted environments
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void api.setup
      .getStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!status) return null;
  if (status.complete) return null;
  if (status.platform !== 'darwin') return null;

  const missing = status.checks.filter(
    (c) => c.state === 'missing' || c.state === 'blocked',
  );
  if (missing.length === 0) return null;

  const sig = missing.map((c) => c.id).sort().join(',');
  if (dismissedSig === sig) return null;

  const dismiss = (): void => {
    try {
      localStorage.setItem(DISMISSED_KEY, sig);
    } catch {
      // ignore
    }
    setDismissedSig(sig);
  };

  const top3 = missing.slice(0, 3).map((c) => c.label).join(', ');
  const more = missing.length > 3 ? ` + ${missing.length - 3} more` : '';

  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-2 border-b border-border-subtle px-3 py-1.5 text-[11px]',
      )}
      style={{
        background:
          'linear-gradient(90deg, rgba(34,211,238,0.06), rgba(168,85,247,0.04))',
      }}
    >
      <Wrench size={11} className="shrink-0 text-[#22d3ee]" />
      <span className="truncate text-text-secondary">
        Setup not complete — missing {top3}
        {more}.
      </span>
      <div className="flex-1" />
      <button
        type="button"
        onClick={onOpenSetup}
        className="inline-flex items-center gap-1 rounded-[5px] border border-border bg-surface-3 px-2 py-[3px] text-[10.5px] text-text-secondary transition hover:border-border-hi hover:bg-surface-4 hover:text-text"
      >
        <Sparkles size={10} />
        Open Setup
      </button>
      <button
        type="button"
        onClick={dismiss}
        title="Dismiss"
        className="flex h-5 w-5 items-center justify-center rounded-[4px] text-text-muted transition hover:bg-surface-3 hover:text-text"
      >
        <X size={11} />
      </button>
    </div>
  );
}
