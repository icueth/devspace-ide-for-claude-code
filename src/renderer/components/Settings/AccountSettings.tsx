import { Eye, EyeOff, KeyRound, Save, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';

// claude-code reads these from the `env` block of ~/.claude/settings.json
// at startup. Putting them in the file (vs. shell rc) keeps the override
// scoped to claude — other tools the user invokes from the same shell stay
// pointed at their normal Anthropic creds.
const API_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
] as const;
type Mode = 'subscription' | 'api';

interface EnvPayload {
  baseUrl: string;
  authToken: string;
  model: string;
  smallFastModel: string;
}

export function AccountSettings() {
  const [path, setPath] = useState<string | null>(null);
  const [raw, setRaw] = useState<string | null>(null);
  const [parsed, setParsed] = useState<Record<string, unknown> | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('subscription');
  const [env, setEnv] = useState<EnvPayload>({
    baseUrl: '',
    authToken: '',
    model: '',
    smallFastModel: '',
  });
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'ok'; ts: number }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const home = await api.app.getHome();
      if (cancelled) return;
      const p = `${home}/.claude/settings.json`;
      setPath(p);
      const text = await api.settings.read(p);
      if (cancelled) return;
      setRaw(text);
      if (!text.trim()) {
        setParsed({});
        setParseError(null);
        return;
      }
      try {
        const data = JSON.parse(text) as Record<string, unknown>;
        setParsed(data);
        setParseError(null);
        const envBlock = (data.env ?? {}) as Record<string, string>;
        const baseUrl = envBlock.ANTHROPIC_BASE_URL ?? '';
        const authToken = envBlock.ANTHROPIC_AUTH_TOKEN ?? '';
        const model = envBlock.ANTHROPIC_MODEL ?? '';
        const smallFastModel = envBlock.ANTHROPIC_SMALL_FAST_MODEL ?? '';
        setEnv({ baseUrl, authToken, model, smallFastModel });
        setMode(authToken ? 'api' : 'subscription');
      } catch (err) {
        setParsed(null);
        setParseError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (): Promise<void> => {
    if (saving || !path) return;
    setSaving(true);
    setStatus({ kind: 'idle' });
    try {
      const base = (parsed ?? {}) as Record<string, unknown>;
      const prevEnv = (base.env ?? {}) as Record<string, string>;
      const nextEnv: Record<string, string> = { ...prevEnv };
      // Strip the API-mode vars first, then re-set them only if the user
      // picked API mode. This keeps unrelated env entries (e.g.
      // CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS) untouched.
      for (const k of API_KEYS) delete nextEnv[k];
      if (mode === 'api') {
        if (env.baseUrl.trim()) nextEnv.ANTHROPIC_BASE_URL = env.baseUrl.trim();
        if (env.authToken.trim()) nextEnv.ANTHROPIC_AUTH_TOKEN = env.authToken.trim();
        if (env.model.trim()) nextEnv.ANTHROPIC_MODEL = env.model.trim();
        if (env.smallFastModel.trim())
          nextEnv.ANTHROPIC_SMALL_FAST_MODEL = env.smallFastModel.trim();
      }
      const next = { ...base, env: nextEnv };
      const text = `${JSON.stringify(next, null, 2)}\n`;
      await api.settings.write(path, text);
      setRaw(text);
      setParsed(next);
      setStatus({ kind: 'ok', ts: Date.now() });
    } catch (err) {
      setStatus({ kind: 'error', message: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const previewEnv: Record<string, string> = {
    ...((parsed?.env ?? {}) as Record<string, string>),
  };
  for (const k of API_KEYS) delete previewEnv[k];
  if (mode === 'api') {
    if (env.baseUrl.trim()) previewEnv.ANTHROPIC_BASE_URL = env.baseUrl.trim();
    if (env.authToken.trim()) previewEnv.ANTHROPIC_AUTH_TOKEN = env.authToken.trim();
    if (env.model.trim()) previewEnv.ANTHROPIC_MODEL = env.model.trim();
    if (env.smallFastModel.trim())
      previewEnv.ANTHROPIC_SMALL_FAST_MODEL = env.smallFastModel.trim();
  }

  if (raw === null || !path) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-text-muted">
        Loading account config…
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-[820px] flex-col gap-5 overflow-y-auto p-6">
      {parseError && (
        <div className="rounded-[8px] border border-semantic-error/40 bg-semantic-error/10 px-3 py-2 text-[11.5px] text-semantic-error">
          {path} has invalid JSON ({parseError}). Editing here will rewrite the
          file from scratch — switch to the Files tab to inspect first.
        </div>
      )}

      <Section
        title="Authentication mode"
        hint="Picks how Claude Code authenticates when devspace spawns it."
      >
        <ModeChoice
          icon={<ShieldCheck size={14} />}
          label="Subscription"
          desc="Use your Claude Max / Pro login. claude-code handles auth itself."
          selected={mode === 'subscription'}
          onSelect={() => setMode('subscription')}
        />
        <ModeChoice
          icon={<KeyRound size={14} />}
          label="Custom API"
          desc="Point claude-code at a different endpoint via ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN (Anthropic, OpenRouter, proxy, etc.)."
          selected={mode === 'api'}
          onSelect={() => setMode('api')}
        />
      </Section>

      {mode === 'api' && (
        <Section
          title="API endpoint"
          hint="claude-code reads these on every spawn. Reload your CLI tabs (right-click chip → Reload tab) after saving."
        >
          <Field
            label="ANTHROPIC_BASE_URL"
            placeholder="https://token-plan-sgp.xiaomimimo.com/anthropic"
            value={env.baseUrl}
            onChange={(v) => setEnv((e) => ({ ...e, baseUrl: v }))}
            mono
          />
          <Field
            label="ANTHROPIC_AUTH_TOKEN"
            placeholder="tp-…"
            value={env.authToken}
            onChange={(v) => setEnv((e) => ({ ...e, authToken: v }))}
            type={showKey ? 'text' : 'password'}
            mono
            adornment={
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="text-text-muted transition hover:text-text"
                title={showKey ? 'Hide token' : 'Show token'}
              >
                {showKey ? <EyeOff size={12} /> : <Eye size={12} />}
              </button>
            }
          />
          <Field
            label="ANTHROPIC_MODEL"
            placeholder="MiMo-V2.5"
            value={env.model}
            onChange={(v) => setEnv((e) => ({ ...e, model: v }))}
            mono
          />
          <Field
            label="ANTHROPIC_SMALL_FAST_MODEL"
            placeholder="MiMo-V2.5"
            value={env.smallFastModel}
            onChange={(v) => setEnv((e) => ({ ...e, smallFastModel: v }))}
            mono
          />
          <div className="rounded-[8px] border border-border-subtle bg-surface-3/40 p-3 text-[11px] text-text-secondary">
            <div className="mb-1 font-semibold text-text">Quick links</div>
            <ul className="space-y-0.5 text-text-muted">
              <li>• OpenRouter: <span className="font-mono">https://openrouter.ai/api/v1</span></li>
              <li>• Anthropic direct: <span className="font-mono">https://api.anthropic.com</span></li>
              <li>• Custom proxy / self-hosted: paste the URL here.</li>
            </ul>
          </div>
        </Section>
      )}

      <Section title="Resulting env block" hint={`Saved to ${path.replace(/^\/Users\/[^/]+/, '~')}`}>
        <pre className="overflow-x-auto rounded-[8px] border border-border-subtle bg-surface-2/80 p-3 font-mono text-[11px] text-text-secondary">
          {`"env": ${JSON.stringify(previewEnv, null, 2)}`}
        </pre>
      </Section>

      <div className="sticky bottom-0 flex items-center gap-3 border-t border-border bg-surface-raised/80 pb-1 pt-3 backdrop-blur">
        {status.kind === 'ok' && (
          <span className="text-[11px] text-semantic-success">
            Saved · reload your CLI tabs to pick up the new env.
          </span>
        )}
        {status.kind === 'error' && (
          <span className="truncate text-[11px] text-semantic-error">
            {status.message}
          </span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-[7px] px-3.5 py-2 text-[12px] font-medium text-white transition',
            saving && 'opacity-60',
          )}
          style={{
            background:
              'linear-gradient(135deg, var(--color-accent), var(--color-accent-3))',
            boxShadow: '0 2px 10px rgba(76,141,255,0.25)',
          }}
        >
          <Save size={12} />
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}

interface SectionProps {
  title: string;
  hint?: string;
  children: React.ReactNode;
}

function Section({ title, hint, children }: SectionProps) {
  return (
    <section className="flex flex-col gap-2">
      <div>
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-text">
          {title}
        </h3>
        {hint && <p className="mt-0.5 text-[11px] text-text-muted">{hint}</p>}
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

interface ModeChoiceProps {
  icon: React.ReactNode;
  label: string;
  desc: string;
  selected: boolean;
  onSelect: () => void;
}

function ModeChoice({ icon, label, desc, selected, onSelect }: ModeChoiceProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex items-start gap-3 rounded-[10px] border px-3.5 py-3 text-left transition',
        selected
          ? 'border-[rgba(76,141,255,0.55)] bg-[rgba(76,141,255,0.10)]'
          : 'border-border bg-surface-2 hover:border-border-hi hover:bg-surface-3',
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border',
          selected
            ? 'border-[rgba(76,141,255,0.7)] bg-[rgba(76,141,255,0.18)] text-[#bcd1ff]'
            : 'border-border bg-surface-3 text-text-muted',
        )}
      >
        {icon}
      </span>
      <span className="flex flex-col gap-0.5">
        <span className={cn('text-[12.5px] font-semibold', selected ? 'text-text' : 'text-text-secondary')}>
          {label}
        </span>
        <span className="text-[11px] leading-[1.4] text-text-muted">{desc}</span>
      </span>
      <span className="ml-auto self-center">
        <span
          className={cn(
            'block h-3.5 w-3.5 rounded-full border',
            selected
              ? 'border-[#4c8dff]'
              : 'border-border-hi',
          )}
        >
          {selected && (
            <span
              className="m-[2px] block h-2 w-2 rounded-full"
              style={{
                background: 'linear-gradient(135deg, #4c8dff, #a855f7)',
              }}
            />
          )}
        </span>
      </span>
    </button>
  );
}

interface FieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: 'text' | 'password';
  mono?: boolean;
  adornment?: React.ReactNode;
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  mono,
  adornment,
}: FieldProps) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10.5px] font-semibold uppercase tracking-wide text-text-muted">
        {label}
      </span>
      <div className="flex items-center gap-2 rounded-[8px] border border-border bg-surface-2 px-3 py-2 transition focus-within:border-[rgba(76,141,255,0.55)]">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          type={type}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className={cn(
            'flex-1 bg-transparent text-[12px] text-text outline-none placeholder:text-text-dim',
            mono && 'font-mono text-[11.5px]',
          )}
        />
        {adornment}
      </div>
    </label>
  );
}
