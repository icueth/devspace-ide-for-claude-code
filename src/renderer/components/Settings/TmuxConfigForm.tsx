import {
  Check,
  Clipboard,
  ClipboardCheck,
  RefreshCw,
  Save,
  TerminalSquare,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import type { TmuxConfig } from '@shared/types';

type Status =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'ok'; ts: number }
  | { kind: 'error'; message: string };

const PREFIX_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'C-b', label: 'Ctrl+B  (default)' },
  { value: 'C-a', label: 'Ctrl+A  (screen-style)' },
  { value: 'C-q', label: 'Ctrl+Q' },
  { value: 'C-s', label: 'Ctrl+S' },
];

export function TmuxConfigForm() {
  const [cfg, setCfg] = useState<TmuxConfig | null>(null);
  const [original, setOriginal] = useState<TmuxConfig | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [snippet, setSnippet] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [resolved, setResolved] = useState<{ path: string | null; configured: string | null } | null>(null);

  const refreshAll = async () => {
    try {
      const [next, bin] = await Promise.all([
        api.tmux.getConfig(),
        api.tmux.resolveBinary(),
      ]);
      setCfg(next);
      setOriginal(next);
      setResolved(bin);
      const s = await api.tmux.renderConf(next);
      setSnippet(s);
    } catch (err) {
      setStatus({ kind: 'error', message: (err as Error).message });
    }
  };

  useEffect(() => {
    void refreshAll();
  }, []);

  // Re-render the snippet whenever the user toggles a relevant field — read-only
  // preview, no save needed.
  useEffect(() => {
    if (!cfg) return;
    let cancelled = false;
    void api.tmux.renderConf(cfg).then((s) => {
      if (!cancelled) setSnippet(s);
    });
    return () => {
      cancelled = true;
    };
  }, [cfg]);

  // Settle the saved-status pill back to idle.
  useEffect(() => {
    if (status.kind !== 'ok') return;
    const id = window.setTimeout(() => setStatus({ kind: 'idle' }), 2500);
    return () => clearTimeout(id);
  }, [status]);

  const dirty = useMemo(() => {
    if (!cfg || !original) return false;
    return JSON.stringify(cfg) !== JSON.stringify(original);
  }, [cfg, original]);

  const update = <K extends keyof TmuxConfig>(key: K, value: TmuxConfig[K]): void => {
    setCfg((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const handleSave = async () => {
    if (!cfg || !dirty) return;
    setStatus({ kind: 'saving' });
    try {
      const saved = await api.tmux.setConfig(cfg);
      setCfg(saved);
      setOriginal(saved);
      setStatus({ kind: 'ok', ts: Date.now() });
      const s = await api.tmux.renderConf(saved);
      setSnippet(s);
      // Re-resolve binary in case the user typed a new path.
      const bin = await api.tmux.resolveBinary();
      setResolved(bin);
    } catch (err) {
      setStatus({ kind: 'error', message: (err as Error).message });
    }
  };

  const handleReset = () => {
    if (original) setCfg({ ...original });
  };

  const copySnippet = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard denied */
    }
  };

  if (!cfg) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-text-muted">
        Loading tmux config…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border bg-surface-2/60 px-4 py-2.5">
        <TerminalSquare size={13} className="text-text-muted" />
        <span className="text-[12px] font-semibold text-text">tmux config</span>
        <span className="rounded-full border border-border-subtle bg-surface-3 px-2 py-[1px] text-[10px] text-text-muted">
          ~/.devspace/tmux-config.json
        </span>
        <div className="flex-1" />
        {status.kind === 'ok' && (
          <span className="flex items-center gap-1 text-[10.5px] text-semantic-success">
            <Check size={10} /> Saved
          </span>
        )}
        {status.kind === 'error' && (
          <span className="truncate text-[10.5px] text-semantic-error">
            {status.message}
          </span>
        )}
        <button
          type="button"
          onClick={() => void refreshAll()}
          className="inline-flex items-center gap-1 rounded-[6px] border border-border bg-surface-3 px-2 py-[4px] text-[11px] text-text-secondary transition hover:border-border-hi hover:bg-surface-4 hover:text-text"
          title="Reload from disk"
        >
          <RefreshCw size={11} />
          Reload
        </button>
        <button
          type="button"
          onClick={handleReset}
          disabled={!dirty}
          className={cn(
            'inline-flex items-center gap-1 rounded-[6px] border border-border bg-surface-3 px-2 py-[4px] text-[11px] text-text-secondary transition',
            dirty
              ? 'hover:border-border-hi hover:bg-surface-4 hover:text-text'
              : 'pointer-events-none opacity-50',
          )}
        >
          Revert
        </button>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!dirty || status.kind === 'saving'}
          className={cn(
            'inline-flex items-center gap-1 rounded-[6px] px-3 py-[5px] text-[11px] font-medium transition',
            !dirty || status.kind === 'saving'
              ? 'pointer-events-none border border-border bg-surface-3 text-text-muted opacity-50'
              : 'text-white hover:brightness-110',
          )}
          style={
            !dirty || status.kind === 'saving'
              ? undefined
              : {
                  background:
                    'linear-gradient(135deg, var(--color-accent), var(--color-accent-3))',
                  boxShadow: '0 2px 8px rgba(76,141,255,0.25)',
                }
          }
        >
          <Save size={11} />
          {status.kind === 'saving' ? 'Saving…' : 'Save'}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Integration">
            <Toggle
              label="Enable tmux"
              hint="When off, Claude CLI + Shell launch directly without tmux backing. You lose persistence-on-restart."
              checked={cfg.enabled}
              onChange={(v) => update('enabled', v)}
            />
            <Field
              label="tmux binary path"
              hint={
                resolved?.path
                  ? `Auto-resolved → ${resolved.path}`
                  : 'tmux not found on PATH — set an absolute path here.'
              }
            >
              <input
                type="text"
                value={cfg.binaryPath ?? ''}
                onChange={(e) => update('binaryPath', e.target.value || null)}
                placeholder="/opt/homebrew/bin/tmux"
                className="w-full rounded-[6px] border border-border bg-surface px-2.5 py-1.5 font-mono text-[11.5px] text-text outline-none transition focus:border-accent"
              />
            </Field>
            <Field
              label="Socket name"
              hint="DevSpace runs on its own tmux socket so kill-server never touches sessions you spawned outside the app."
            >
              <input
                type="text"
                value={cfg.socketName}
                onChange={(e) =>
                  update('socketName', e.target.value.replace(/[^a-zA-Z0-9_-]/g, ''))
                }
                className="w-full rounded-[6px] border border-border bg-surface px-2.5 py-1.5 font-mono text-[11.5px] text-text outline-none transition focus:border-accent"
              />
            </Field>
            <Field
              label="Session name prefix"
              hint="Sessions are named `<prefix>-cli-<projectId>` and `<prefix>-shell-<projectId>`."
            >
              <input
                type="text"
                value={cfg.sessionPrefix}
                onChange={(e) =>
                  update(
                    'sessionPrefix',
                    e.target.value.replace(/[^a-zA-Z0-9_-]/g, ''),
                  )
                }
                className="w-full rounded-[6px] border border-border bg-surface px-2.5 py-1.5 font-mono text-[11.5px] text-text outline-none transition focus:border-accent"
              />
            </Field>
          </Card>

          <Card title="Behavior">
            <Field
              label="Prefix key"
              hint="The right-click menu sends this control sequence. Match what you have in ~/.tmux.conf."
            >
              <select
                value={
                  PREFIX_OPTIONS.find((p) => p.value === cfg.prefixKey)
                    ? cfg.prefixKey
                    : 'custom'
                }
                onChange={(e) => {
                  if (e.target.value !== 'custom') update('prefixKey', e.target.value);
                }}
                className="w-full rounded-[6px] border border-border bg-surface px-2.5 py-1.5 text-[11.5px] text-text outline-none transition focus:border-accent"
              >
                {PREFIX_OPTIONS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
                <option value="custom">Custom…</option>
              </select>
              {!PREFIX_OPTIONS.find((p) => p.value === cfg.prefixKey) && (
                <input
                  type="text"
                  value={cfg.prefixKey}
                  onChange={(e) => update('prefixKey', e.target.value)}
                  placeholder="C-x"
                  className="mt-2 w-full rounded-[6px] border border-border bg-surface px-2.5 py-1.5 font-mono text-[11.5px] text-text outline-none transition focus:border-accent"
                />
              )}
            </Field>
            <Toggle
              label="Mouse mode"
              hint="Click to focus pane, scroll wheel to scroll, drag border to resize."
              checked={cfg.mouseMode}
              onChange={(v) => update('mouseMode', v)}
            />
            <Toggle
              label="tmux status bar"
              hint="DevSpace has its own UI — turning this off saves a row."
              checked={cfg.statusBar}
              onChange={(v) => update('statusBar', v)}
            />
            <Toggle
              label="Kill DevSpace tmux server on quit"
              hint="Off (default): sessions stay alive — re-opening the app reattaches with state intact. On: clean slate every launch."
              checked={cfg.killSessionsOnQuit}
              onChange={(v) => update('killSessionsOnQuit', v)}
            />
            <Field
              label="Escape time (ms)"
              hint="Vim/Helix users: 0 makes Esc instantaneous."
            >
              <input
                type="number"
                min={0}
                max={1000}
                value={cfg.escapeTimeMs}
                onChange={(e) =>
                  update('escapeTimeMs', Math.max(0, Math.min(1000, Number(e.target.value) || 0)))
                }
                className="w-full rounded-[6px] border border-border bg-surface px-2.5 py-1.5 font-mono text-[11.5px] text-text outline-none transition focus:border-accent"
              />
            </Field>
            <Field
              label="History limit"
              hint="Lines of scrollback per pane. Bigger values cost RAM."
            >
              <input
                type="number"
                min={1000}
                max={1_000_000}
                step={5000}
                value={cfg.historyLimit}
                onChange={(e) =>
                  update(
                    'historyLimit',
                    Math.max(1000, Math.min(1_000_000, Number(e.target.value) || 50000)),
                  )
                }
                className="w-full rounded-[6px] border border-border bg-surface px-2.5 py-1.5 font-mono text-[11.5px] text-text outline-none transition focus:border-accent"
              />
            </Field>
          </Card>
        </div>

        <Card
          title="Recommended ~/.tmux.conf snippet"
          rightSlot={
            <button
              type="button"
              onClick={() => void copySnippet()}
              className="inline-flex items-center gap-1 rounded-[5px] border border-border bg-surface-3 px-2 py-[3px] text-[10.5px] text-text-secondary transition hover:bg-surface-4 hover:text-text"
            >
              {copied ? <ClipboardCheck size={10} /> : <Clipboard size={10} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          }
        >
          <p className="mb-2 text-[11px] leading-relaxed text-text-muted">
            DevSpace will <strong>not</strong> overwrite{' '}
            <code className="rounded bg-surface-3 px-1 font-mono text-[10.5px]">
              ~/.tmux.conf
            </code>
            . Copy this snippet and paste it into your config so options like
            mouse mode and history-limit take effect inside the tmux server we
            spawn.
          </p>
          <pre className="overflow-auto rounded-[6px] border border-border-subtle bg-surface-2 p-3 font-mono text-[11px] leading-snug text-text-secondary">
            {snippet}
          </pre>
        </Card>
      </div>
    </div>
  );
}

interface CardProps {
  title: string;
  rightSlot?: React.ReactNode;
  children: React.ReactNode;
}

function Card({ title, rightSlot, children }: CardProps) {
  return (
    <section className="mb-4 overflow-hidden rounded-[10px] border border-border-subtle bg-surface-2/40">
      <header className="flex items-center justify-between gap-2 border-b border-border-subtle bg-surface-2/70 px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
          {title}
        </span>
        {rightSlot}
      </header>
      <div className="flex flex-col gap-3 px-3 py-3">{children}</div>
    </section>
  );
}

interface FieldProps {
  label: string;
  hint?: string;
  children: React.ReactNode;
}

function Field({ label, hint, children }: FieldProps) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11.5px] font-medium text-text">{label}</span>
      {children}
      {hint && <span className="text-[10.5px] leading-relaxed text-text-muted">{hint}</span>}
    </label>
  );
}

interface ToggleProps {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}

function Toggle({ label, hint, checked, onChange }: ToggleProps) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-[11.5px] font-medium text-text">{label}</span>
        {hint && (
          <span className="text-[10.5px] leading-relaxed text-text-muted">{hint}</span>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex h-[20px] w-[36px] shrink-0 items-center rounded-full transition',
          checked ? 'bg-accent' : 'bg-surface-3 ring-1 ring-border',
        )}
      >
        <span
          className={cn(
            'inline-block h-[14px] w-[14px] rounded-full bg-white shadow transition',
            checked ? 'translate-x-[19px]' : 'translate-x-[3px]',
          )}
        />
      </button>
    </div>
  );
}
