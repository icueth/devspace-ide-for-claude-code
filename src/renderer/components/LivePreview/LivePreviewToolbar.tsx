import {
  AlertCircle,
  Check,
  ChevronDown,
  CircleDot,
  Copy,
  Eye,
  Loader2,
  MousePointer,
  Pencil,
  Play,
  RotateCw,
  Square,
} from 'lucide-react';
import { useState } from 'react';

import { cn } from '@renderer/lib/utils';
import type {
  DesignWebviewMode,
  DevServerInfo,
  DevServerKind,
  DevServerStatus,
} from '@shared/design';

export interface LivePreviewToolbarProps {
  info: DevServerInfo;
  onStart: () => void;
  onStop: () => void;
  onReload: () => void;
  /** Re-run framework detection (no PTY churn). */
  onRefresh: () => void;
  /** True while a detection refresh is in flight. */
  refreshing?: boolean;
  /**
   * Compact script picker on the toolbar (only meaningful when the server
   * is running and `info.candidateScripts.length > 1`). Selecting a new
   * value asks the host to confirm + restart with the new script.
   */
  onScriptChange?: (scriptName: string) => void;
  mode: DesignWebviewMode;
  onModeChange: (mode: DesignWebviewMode) => void;
  /** Disable start/stop while a transition is in flight. */
  busy?: boolean;
}

const FRAMEWORK_LABEL: Record<DevServerKind, string> = {
  vite: 'Vite',
  next: 'Next.js',
  astro: 'Astro',
  remix: 'Remix',
  sveltekit: 'SvelteKit',
  nuxt: 'Nuxt',
  gatsby: 'Gatsby',
  angular: 'Angular',
  'vue-cli': 'Vue CLI',
  cra: 'CRA',
  storybook: 'Storybook',
  vitepress: 'VitePress',
  docusaurus: 'Docusaurus',
  static: 'Static',
  unknown: 'Unknown',
};

/**
 * Top bar for the Live Preview pane. Mirrors `DesignToolbar` visual
 * language: a gradient strip with a status pill on one side, a URL
 * chip + action button cluster on the other, and a mode toggle that
 * gates inspection in the webview.
 */
export function LivePreviewToolbar({
  info,
  onStart,
  onStop,
  onReload,
  onRefresh,
  refreshing,
  onScriptChange,
  mode,
  onModeChange,
  busy,
}: LivePreviewToolbarProps) {
  const running = info.status === 'running';
  const starting = info.status === 'starting';
  const canStop = running || starting;
  const canStart = !canStop;
  // Mode controls only matter once the webview can host the bridge.
  // Disabling them in other states avoids users wondering why clicks
  // don't do anything.
  const modeDisabled = !running;
  // Refresh is unsafe mid-spawn: the detection mutation would race with
  // the PTY URL parser. Block it.
  const refreshDisabled = starting || !!busy;
  const candidateScripts = info.candidateScripts ?? [];
  const showRunningScriptPicker =
    running && candidateScripts.length > 1 && !!onScriptChange;

  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2"
      style={{
        background:
          'linear-gradient(180deg, var(--color-surface-2) 0%, var(--color-surface) 100%)',
      }}
    >
      <StatusPill status={info.status} errorMessage={info.errorMessage} />
      <FrameworkBadge kind={info.kind} scriptName={info.scriptName} />
      <UrlChip url={info.url} />

      <RefreshButton
        onClick={onRefresh}
        disabled={refreshDisabled}
        refreshing={!!refreshing}
      />

      {showRunningScriptPicker && (
        <ToolbarScriptPicker
          candidates={candidateScripts}
          activeScript={info.scriptName}
          onChange={(name) => onScriptChange?.(name)}
          disabled={!!busy}
        />
      )}

      <ModeToggle
        mode={mode}
        onChange={onModeChange}
        disabled={modeDisabled}
      />

      <div className="flex-1" />

      {running && (
        <button
          type="button"
          onClick={onReload}
          disabled={busy}
          title="Reload webview"
          className={cn(
            'inline-flex h-[26px] items-center gap-1.5 rounded-[6px] border border-border-subtle bg-surface-3 px-2.5 text-[11px] text-text-secondary transition hover:bg-surface-4 hover:text-text',
            busy && 'pointer-events-none opacity-60',
          )}
        >
          <RotateCw size={11} />
          Reload
        </button>
      )}

      {canStart && (
        <button
          type="button"
          onClick={onStart}
          disabled={busy || info.kind === 'unknown' && !info.scriptName}
          className={cn(
            'inline-flex h-[26px] items-center gap-1.5 rounded-[6px] px-3 text-[11px] font-medium transition',
            busy || (info.kind === 'unknown' && !info.scriptName)
              ? 'pointer-events-none border border-border bg-surface-3 text-text-muted opacity-60'
              : 'text-white hover:brightness-110',
          )}
          style={
            busy || (info.kind === 'unknown' && !info.scriptName)
              ? undefined
              : {
                  background:
                    'linear-gradient(135deg, var(--color-accent), var(--color-accent-3))',
                  boxShadow: '0 2px 8px rgba(76,141,255,0.25)',
                }
          }
          title={
            info.kind === 'unknown'
              ? 'No supported framework detected'
              : `Start ${FRAMEWORK_LABEL[info.kind]} dev server`
          }
        >
          <Play size={11} />
          {info.kind === 'unknown'
            ? 'Start dev server'
            : `Start ${FRAMEWORK_LABEL[info.kind]}`}
        </button>
      )}

      {canStop && (
        <button
          type="button"
          onClick={onStop}
          disabled={busy}
          className={cn(
            'inline-flex h-[26px] items-center gap-1.5 rounded-[6px] border border-semantic-error/40 bg-surface-3 px-3 text-[11px] font-medium text-semantic-error transition hover:bg-[rgba(239,68,68,0.12)]',
            busy && 'pointer-events-none opacity-60',
          )}
        >
          {starting ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <Square size={11} />
          )}
          {starting ? 'Starting…' : 'Stop'}
        </button>
      )}
    </div>
  );
}

// ─── URL chip with copy-to-clipboard ─────────────────────────────────

interface UrlChipProps {
  url: string | null;
}

function UrlChip({ url }: UrlChipProps) {
  const [copied, setCopied] = useState(false);

  if (!url) {
    return (
      <span className="inline-flex h-[26px] items-center rounded-[6px] border border-border-subtle bg-surface-3 px-2 font-mono text-[10.5px] text-text-dim">
        — no URL —
      </span>
    );
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard can reject in restricted contexts. Silent fail — the
      // URL is visible in the chip itself so the user can still
      // hand-copy.
    }
  };

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      title={copied ? 'Copied!' : `Copy ${url}`}
      className="group inline-flex h-[26px] max-w-[280px] items-center gap-1.5 rounded-[6px] border border-border-subtle bg-surface-3 px-2 font-mono text-[10.5px] text-text-secondary transition hover:border-border-hi hover:bg-surface-4 hover:text-text"
    >
      <span className="truncate">{url}</span>
      {copied ? (
        <Check size={10} className="shrink-0 text-semantic-success" />
      ) : (
        <Copy size={10} className="shrink-0 text-text-muted group-hover:text-text" />
      )}
    </button>
  );
}

// ─── Framework + script badge ────────────────────────────────────────

interface FrameworkBadgeProps {
  kind: DevServerKind;
  scriptName: string;
}

function FrameworkBadge({ kind, scriptName }: FrameworkBadgeProps) {
  const label = FRAMEWORK_LABEL[kind];
  const isKnown = kind !== 'unknown';
  return (
    <span
      className={cn(
        'inline-flex h-[26px] items-center gap-1 rounded-[6px] border px-2 text-[10.5px] font-medium',
        isKnown
          ? 'border-accent/30 bg-[rgba(76,141,255,0.12)] text-accent'
          : 'border-border-subtle bg-surface-3 text-text-muted',
      )}
      title={scriptName ? `pnpm/npm run ${scriptName}` : undefined}
    >
      {label}
      {scriptName && (
        <span className="font-mono text-text-dim">· {scriptName}</span>
      )}
    </span>
  );
}

// ─── Status pill ─────────────────────────────────────────────────────

interface StatusPillProps {
  status: DevServerStatus;
  errorMessage?: string;
}

const STATUS_STYLE: Record<
  DevServerStatus,
  { color: string; dotClass: string; label: string }
> = {
  idle: {
    color: 'bg-surface-3 text-text-muted border-border-subtle',
    dotClass: 'bg-text-dim',
    label: 'idle',
  },
  starting: {
    color: 'bg-[rgba(76,141,255,0.18)] text-accent border-accent/30',
    dotClass: 'bg-accent animate-pulse',
    label: 'starting',
  },
  running: {
    color:
      'bg-[rgba(34,197,94,0.18)] text-semantic-success border-semantic-success/30',
    dotClass: 'bg-semantic-success',
    label: 'running',
  },
  stopped: {
    color: 'bg-surface-3 text-text-muted border-border-subtle',
    dotClass: 'bg-text-dim',
    label: 'stopped',
  },
  error: {
    color: 'bg-[rgba(239,68,68,0.18)] text-semantic-error border-semantic-error/30',
    dotClass: 'bg-semantic-error',
    label: 'error',
  },
};

function StatusPill({ status, errorMessage }: StatusPillProps) {
  const style = STATUS_STYLE[status];
  return (
    <span
      title={errorMessage}
      className={cn(
        'inline-flex h-[26px] items-center gap-1.5 rounded-full border px-2.5 text-[10.5px] font-medium',
        style.color,
      )}
    >
      {status === 'error' ? (
        <AlertCircle size={11} />
      ) : status === 'starting' ? (
        <Loader2 size={10} className="animate-spin" />
      ) : (
        <span className={cn('h-1.5 w-1.5 rounded-full', style.dotClass)} />
      )}
      {style.label}
      {status === 'idle' && (
        // Sub-label keeps the toolbar legible when no run has started.
        <CircleDot size={9} className="opacity-0" aria-hidden />
      )}
    </span>
  );
}

// ─── Mode toggle (View / Inspect / Edit) ─────────────────────────────

interface ModeToggleProps {
  mode: DesignWebviewMode;
  onChange: (mode: DesignWebviewMode) => void;
  disabled?: boolean;
}

const MODE_OPTIONS: Array<{
  value: DesignWebviewMode;
  icon: React.ReactNode;
  label: string;
  title: string;
}> = [
  { value: 'view', icon: <Eye size={11} />, label: 'View', title: 'View only' },
  {
    value: 'inspect',
    icon: <MousePointer size={11} />,
    label: 'Inspect',
    title: 'Hover to highlight, click to inspect element',
  },
  {
    value: 'edit',
    icon: <Pencil size={11} />,
    label: 'Edit',
    title: 'Inline style edits (read-only preview in Phase C — write-back lands in 0.8)',
  },
];

// ─── Refresh button (re-runs detection only) ─────────────────────────

interface RefreshButtonProps {
  onClick: () => void;
  disabled: boolean;
  refreshing: boolean;
}

function RefreshButton({ onClick, disabled, refreshing }: RefreshButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || refreshing}
      title="Refresh detection"
      aria-label="Refresh detection"
      className={cn(
        'relative inline-flex h-[26px] w-[26px] items-center justify-center rounded-[6px] border border-border-subtle bg-surface-3 text-text-muted transition hover:bg-surface-4 hover:text-text',
        (disabled || refreshing) && 'pointer-events-none opacity-60',
      )}
    >
      {refreshing ? (
        <Loader2 size={12} className="animate-spin" />
      ) : (
        <RotateCw size={12} />
      )}
    </button>
  );
}

// ─── Compact script picker shown on the toolbar while running ────────

interface ToolbarScriptPickerProps {
  candidates: Array<{ name: string; body: string }>;
  activeScript: string;
  onChange: (scriptName: string) => void;
  disabled?: boolean;
}

function ToolbarScriptPicker({
  candidates,
  activeScript,
  onChange,
  disabled,
}: ToolbarScriptPickerProps) {
  return (
    <label
      className={cn(
        'relative inline-flex h-[26px] items-center rounded-[6px] border border-border-subtle bg-surface-3 pl-2 pr-1 text-[10.5px] font-medium text-text-muted',
        disabled && 'pointer-events-none opacity-60',
      )}
      title="Switch dev script (will restart the server)"
    >
      <span className="mr-1 text-text-dim">script</span>
      <span className="font-mono text-text-secondary">{activeScript || '—'}</span>
      <ChevronDown size={10} className="ml-1 text-text-dim" />
      <select
        value={activeScript}
        disabled={disabled}
        onChange={(e) => {
          const next = e.target.value;
          if (next && next !== activeScript) onChange(next);
        }}
        className="absolute inset-0 cursor-pointer opacity-0"
        aria-label="Switch dev script"
      >
        {/* Make sure the active script is always selectable even if it
            doesn't appear in candidateScripts (defensive fallback). */}
        {!candidates.some((c) => c.name === activeScript) && activeScript && (
          <option value={activeScript}>{activeScript}</option>
        )}
        {candidates.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name} — {truncate(c.body, 48)}
          </option>
        ))}
      </select>
    </label>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

function ModeToggle({ mode, onChange, disabled }: ModeToggleProps) {
  return (
    <div
      className={cn(
        'inline-flex overflow-hidden rounded-[6px] border border-border-subtle bg-surface-3',
        disabled && 'opacity-50',
      )}
      role="group"
      aria-label="Preview mode"
    >
      {MODE_OPTIONS.map((opt) => {
        const active = mode === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            title={opt.title}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            aria-pressed={active}
            className={cn(
              'inline-flex h-[26px] items-center gap-1 px-2 text-[10.5px] font-medium transition',
              active
                ? 'bg-[rgba(76,141,255,0.18)] text-accent'
                : 'text-text-muted hover:bg-surface-4 hover:text-text',
              disabled && 'pointer-events-none',
            )}
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
