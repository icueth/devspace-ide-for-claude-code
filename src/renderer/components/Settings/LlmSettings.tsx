import {
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import { useTabActive } from '@renderer/components/Settings/SettingsPage';
import type { LlmConfig, LlmTestResult } from '@shared/types';

/**
 * Settings tab for the generic non-Claude LLM connection. First consumer
 * is the editor's inline ghost-text autocomplete; future consumers
 * (Cmd+K refactor, commit-message gen, …) read the same config.
 *
 * Stores config in `~/.devspace/llm-config.json`. The Test button hits
 * the configured endpoint with a tiny ping so the user can verify the
 * URL/key/model combo before saving.
 */
export function LlmSettings() {
  // R1 keep-mounted (v0.30.7): defer fetching the config (which contains an
  // API key) until the user actually opens the LLM tab — otherwise the
  // unsaved-draft state would sit in renderer memory whenever Settings is
  // open, even if the user never visits this tab.
  const tabActive = useTabActive();
  const [hasBeenActive, setHasBeenActive] = useState(false);
  useEffect(() => {
    if (tabActive && !hasBeenActive) setHasBeenActive(true);
  }, [tabActive, hasBeenActive]);

  const [config, setConfig] = useState<LlmConfig | null>(null);
  const [draft, setDraft] = useState<LlmConfig | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<LlmTestResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!hasBeenActive) return;
    void api.llm.getConfig().then((c) => {
      setConfig(c);
      setDraft(c);
    });
  }, [hasBeenActive]);

  const dirty = !!config && !!draft && JSON.stringify(config) !== JSON.stringify(draft);

  const update = useCallback(<K extends keyof LlmConfig>(key: K, value: LlmConfig[K]) => {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
    // Test result is only meaningful for the exact config tested. Any
    // edit invalidates it.
    setTestResult(null);
  }, []);

  const onTest = useCallback(async () => {
    if (!draft) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.llm.test(draft);
      setTestResult(res);
    } catch (err) {
      setTestResult({ ok: false, error: (err as Error).message });
    } finally {
      setTesting(false);
    }
  }, [draft]);

  const onSave = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const saved = await api.llm.setConfig(draft);
      setConfig(saved);
      setDraft(saved);
      setSavedAt(Date.now());
      // Tell every open editor pane that the LLM config has changed —
      // the CodeMirror inline-completion extension listens for this and
      // hot-reloads its enabled/debounce flags without a remount.
      window.dispatchEvent(new CustomEvent('devspace:llm-config-saved'));
    } finally {
      setSaving(false);
    }
  }, [draft]);

  if (!draft) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-text-muted">
        Loading…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto px-6 py-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[14px] font-semibold text-text">
            <Sparkles size={13} className="text-accent" />
            LLM connection
          </h2>
          <p className="mt-0.5 max-w-[640px] text-[11.5px] text-text-muted">
            A separate LLM endpoint used by features that aren't part of the
            Claude Code CLI dock — currently editor inline-autocomplete, and
            growing. Stored at{' '}
            <code className="rounded bg-surface-3 px-1">~/.devspace/llm-config.json</code>
            .
          </p>
        </div>
        {savedAt && !dirty && (
          <span className="shrink-0 rounded-full border border-semantic-success/40 bg-semantic-success/10 px-2 py-0.5 text-[10.5px] text-semantic-success">
            Saved
          </span>
        )}
      </div>

      <div className="space-y-4">
        <Field label="Provider" hint="Which API protocol to use.">
          <div className="inline-flex h-[28px] items-stretch rounded-[7px] border border-border-subtle bg-surface-3 text-[11.5px]">
            <ProviderBtn
              active={draft.provider === 'openai'}
              onClick={() => {
                update('provider', 'openai');
                if (draft.baseUrl === 'https://api.anthropic.com') {
                  update('baseUrl', 'https://api.openai.com/v1');
                }
              }}
            >
              OpenAI-compatible
            </ProviderBtn>
            <ProviderBtn
              active={draft.provider === 'anthropic'}
              onClick={() => {
                update('provider', 'anthropic');
                if (draft.baseUrl === 'https://api.openai.com/v1') {
                  update('baseUrl', 'https://api.anthropic.com');
                }
              }}
            >
              Anthropic
            </ProviderBtn>
          </div>
          <p className="mt-1 text-[10.5px] text-text-dim">
            {draft.provider === 'openai'
              ? 'Works with OpenAI proper, OpenRouter, Azure OpenAI, Together.ai, Ollama (/v1 endpoint), LM Studio, vLLM, llama.cpp server, and any other OpenAI-compatible server.'
              : "Hits Anthropic's /v1/messages directly. Use this if you have an Anthropic API key (separate from your Claude Code CLI subscription)."}
          </p>
        </Field>

        <Field
          label="Base URL"
          hint={
            draft.provider === 'openai'
              ? 'OpenAI uses https://api.openai.com/v1 — third-party proxies are similar with their own host.'
              : 'Anthropic uses https://api.anthropic.com — the /v1/messages suffix is added automatically.'
          }
        >
          <Input
            value={draft.baseUrl}
            onChange={(v) => update('baseUrl', v)}
            placeholder={
              draft.provider === 'openai'
                ? 'https://api.openai.com/v1'
                : 'https://api.anthropic.com'
            }
          />
        </Field>

        <Field label="API key" hint="Stored in plaintext on disk; treat the config file like any credential file.">
          <div className="relative">
            <Input
              type={showKey ? 'text' : 'password'}
              value={draft.apiKey}
              onChange={(v) => update('apiKey', v)}
              placeholder={draft.provider === 'openai' ? 'sk-…' : 'sk-ant-…'}
            />
            <button
              type="button"
              onClick={() => setShowKey((s) => !s)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-text-muted hover:text-text"
              tabIndex={-1}
            >
              {showKey ? <EyeOff size={11} /> : <Eye size={11} />}
            </button>
          </div>
        </Field>

        <Field
          label="Model"
          hint="Whatever model id the provider exposes — e.g. gpt-4o-mini, claude-haiku-4-5, llama3.1:70b for Ollama, etc."
        >
          <Input
            value={draft.model}
            onChange={(v) => update('model', v)}
            placeholder={
              draft.provider === 'openai' ? 'gpt-4o-mini' : 'claude-haiku-4-5'
            }
          />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Temperature" hint="0 = deterministic, 1 = creative. 0.1–0.3 is right for code completion.">
            <Input
              type="number"
              value={String(draft.temperature ?? 0.2)}
              onChange={(v) => update('temperature', Number(v))}
              placeholder="0.2"
            />
          </Field>
          <Field
            label="Max tokens"
            hint="Upper bound on response length per request. 256 is plenty for non-thinking models. Thinking-mode models (DeepSeek-R1, Qwen3, Xiaomi MiMo, gpt-oss reasoning, …) emit a long chain-of-thought into a separate reasoning_content field before the answer — they need ≥ 2048 here or autocomplete returns empty because reasoning ate the budget."
          >
            <Input
              type="number"
              value={String(draft.maxTokens ?? 256)}
              onChange={(v) => update('maxTokens', Number(v))}
              placeholder="256"
            />
          </Field>
        </div>

        <div className="rounded-[8px] border border-border-subtle bg-surface-2 p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-medium text-text">
                Editor inline autocomplete
              </div>
              <p className="mt-0.5 text-[10.5px] text-text-muted">
                Ghost-text suggestions in the CodeMirror editor while you type.
                Press <kbd className="rounded bg-surface-3 px-1">Tab</kbd> to
                accept, <kbd className="rounded bg-surface-3 px-1">Esc</kbd> or
                continue typing to dismiss.
              </p>
            </div>
            <Toggle
              on={draft.autocompleteEnabled}
              onChange={(v) => update('autocompleteEnabled', v)}
            />
          </div>
          {draft.autocompleteEnabled && (
            <div className="mt-3 grid grid-cols-2 gap-4">
              <Field label="Debounce (ms)" hint="How long to wait after the last keystroke before requesting a suggestion.">
                <Input
                  type="number"
                  value={String(draft.autocompleteDebounceMs)}
                  onChange={(v) => update('autocompleteDebounceMs', Number(v))}
                  placeholder="500"
                />
              </Field>
            </div>
          )}
        </div>

        {testResult && (
          <div
            className={cn(
              'flex items-start gap-2 rounded-[8px] border px-3 py-2 text-[11.5px]',
              testResult.ok
                ? 'border-semantic-success/40 bg-semantic-success/10 text-semantic-success'
                : 'border-semantic-error/40 bg-semantic-error/10 text-semantic-error',
            )}
          >
            {testResult.ok ? (
              <CheckCircle2 size={13} className="mt-0.5 shrink-0" />
            ) : (
              <XCircle size={13} className="mt-0.5 shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              {testResult.ok ? (
                <>
                  <div className="font-medium">
                    Connected · {testResult.latencyMs}ms
                    {testResult.modelEcho && testResult.modelEcho !== draft.model && (
                      <span className="ml-2 text-text-muted">
                        (server returned {testResult.modelEcho})
                      </span>
                    )}
                  </div>
                  {testResult.sample && (
                    <div className="mt-0.5 truncate font-mono text-[10.5px] text-text-muted">
                      sample: {testResult.sample}
                    </div>
                  )}
                </>
              ) : (
                <div className="font-mono whitespace-pre-wrap text-[10.5px]">
                  {testResult.error}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            onClick={onTest}
            disabled={testing || !draft.apiKey || !draft.baseUrl || !draft.model}
            className="inline-flex h-[28px] items-center gap-1.5 rounded-[7px] border border-border-subtle bg-surface-3 px-3 text-[11.5px] text-text-secondary transition hover:border-border-hi hover:bg-surface-4 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
          >
            {testing ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <Sparkles size={11} />
            )}
            <span>{testing ? 'Testing…' : 'Test connection'}</span>
          </button>
          <button
            onClick={onSave}
            disabled={!dirty || saving}
            className="inline-flex h-[28px] items-center gap-1.5 rounded-[7px] px-3 text-[11.5px] font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            style={{
              background:
                'linear-gradient(135deg, var(--color-accent), #a855f7)',
              boxShadow: '0 2px 8px var(--color-accent-glow)',
            }}
          >
            {saving ? <Loader2 size={11} className="animate-spin" /> : null}
            <span>{saving ? 'Saving…' : 'Save'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-[11px] font-medium text-text-secondary">{label}</div>
      {children}
      {hint && <p className="mt-1 text-[10.5px] text-text-dim">{hint}</p>}
    </label>
  );
}

function Input({
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: 'text' | 'password' | 'number';
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-[7px] border border-border-subtle bg-surface-3 px-3 py-1.5 font-mono text-[12px] text-text placeholder:text-text-dim focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40"
    />
  );
}

function ProviderBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center px-3 transition first:rounded-l-[7px] last:rounded-r-[7px]',
        active
          ? 'bg-surface-4 text-text'
          : 'text-text-secondary hover:bg-surface-4 hover:text-text',
      )}
    >
      {children}
    </button>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      className={cn(
        'relative h-[20px] w-[34px] shrink-0 rounded-full transition',
        on ? 'bg-accent' : 'bg-surface-4',
      )}
    >
      <span
        className={cn(
          'absolute top-[2px] h-[16px] w-[16px] rounded-full bg-white transition',
          on ? 'left-[16px]' : 'left-[2px]',
        )}
      />
    </button>
  );
}
