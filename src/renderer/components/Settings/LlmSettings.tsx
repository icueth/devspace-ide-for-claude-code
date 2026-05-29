import {
  CheckCircle2,
  Edit,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { CliSettings } from '@renderer/components/Settings/CliSettings';
import {
  draftFromProfile,
  type LlmChatProfileDraft,
  newProfileDraft,
  profileFromDraft,
  type ProfileFormErrors,
  validateProfileForm,
} from '@renderer/components/Settings/llmProfileForm';
import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import { useTabActive } from '@renderer/components/Settings/SettingsPage';
import { modelSupportsThinking } from '@shared/types';
import type { ClaudeEffort, LlmChatProfile, LlmConfig, LlmTestResult } from '@shared/types';

// v0.37: curated Anthropic model registry. Used as a datalist so the
// existing free-text input still accepts third-party proxy ids and
// upcoming model names without a code change.
const ANTHROPIC_MODELS: Array<{ id: string; label: string }> = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8 (Smartest, supports effort)' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7 (supports effort)' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (supports effort)' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

const EFFORT_OPTIONS: Array<{ value: ClaudeEffort | ''; label: string }> = [
  { value: '', label: 'Default (no thinking)' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'X-High' },
  { value: 'ultracode', label: 'Ultracode' },
];

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

      {/* Chat profiles — separate persistence (~/.devspace/llm-chat-profiles.json)
          from the inline-autocomplete config above. Each profile is a
          distinct LLM endpoint the user can pick from the chat panel's
          provider dropdown. Wholly additive: deleting all profiles
          leaves the autocomplete form untouched. */}
      <ChatProfilesSection />

      {/* v0.30: CLI runtime profiles — sibling capability to "Chat
          profiles" above. Distinct mental model: chat profiles are
          HTTP API endpoints; CLI runtimes spawn an actual binary
          (OpenCode today; Codex / Gemini later) with isolated config.
          Lives inside the LLM tab per design — same "alternative
          backend" mental bucket from the user's POV. Self-contained
          component so SettingsPage navigation stays unchanged. */}
      <CliSettings />
    </div>
  );
}

// ─── Chat profiles section ───────────────────────────────────────────────────

function ChatProfilesSection() {
  const [profiles, setProfiles] = useState<LlmChatProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<LlmChatProfileDraft | null>(null);
  // Section-level error survives ProfileEditor unmount — any failure
  // during the post-save reload / dispatch that fires AFTER the editor
  // has been torn down would otherwise be invisible to the user (React
  // setState-on-unmounted warning + lost diagnostic).
  const [sectionError, setSectionError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.llm.listChatProfiles();
      setProfiles(list);
      setSectionError(null);
    } catch (err) {
      setSectionError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onAdd = useCallback(() => {
    setEditing(newProfileDraft());
  }, []);

  const onEdit = useCallback((profile: LlmChatProfile) => {
    setEditing(draftFromProfile(profile));
  }, []);

  const onDelete = useCallback(
    async (profile: LlmChatProfile) => {
      const ok = window.confirm(
        `Delete chat profile "${profile.name}"? Threads already bound to it will show "unknown LLM" until you switch them.`,
      );
      if (!ok) return;
      await api.llm.deleteChatProfile(profile.id);
      await reload();
      window.dispatchEvent(new CustomEvent('devspace:llm-chat-profiles-changed'));
    },
    [reload],
  );

  const onSaved = useCallback(
    async (saved: LlmChatProfile) => {
      setEditing(null);
      // Optimistic merge so the card reflects the save before the
      // reload round-trip completes.
      setProfiles((prev) => {
        const exists = prev.some((p) => p.id === saved.id);
        return exists
          ? prev.map((p) => (p.id === saved.id ? saved : p))
          : [...prev, saved];
      });
      // Wrap in try/catch — this runs AFTER the editor has unmounted,
      // so any throw here can't reach ProfileEditor's catch block (the
      // setState would land on an unmounted component and React would
      // swallow it). Route to the section-level banner instead.
      try {
        window.dispatchEvent(
          new CustomEvent('devspace:llm-chat-profiles-changed'),
        );
        await reload();
      } catch (err) {
        setSectionError(
          `Saved, but refresh failed: ${(err as Error).message}`,
        );
      }
    },
    [reload],
  );

  return (
    <section className="mt-8 border-t border-border-subtle pt-6">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[14px] font-semibold text-text">
            <Sparkles size={13} className="text-accent" />
            Chat profiles
          </h2>
          <p className="mt-0.5 max-w-[640px] text-[11.5px] text-text-muted">
            Add LLM endpoints to use in the chat panel's provider dropdown.
            The inline autocomplete config above is separate and unaffected.
            Stored at{' '}
            <code className="rounded bg-surface-3 px-1">
              ~/.devspace/llm-chat-profiles.json
            </code>
            .
          </p>
        </div>
        {!editing && (
          <button
            onClick={onAdd}
            className="inline-flex h-[28px] shrink-0 items-center gap-1.5 rounded-[7px] border border-border-subtle bg-surface-3 px-3 text-[11.5px] text-text-secondary transition hover:border-border-hi hover:bg-surface-4 hover:text-text"
          >
            <Plus size={11} />
            <span>Add profile</span>
          </button>
        )}
      </div>

      {sectionError && (
        <div className="mb-2 flex items-start justify-between gap-2 rounded-[8px] border border-semantic-error/40 bg-semantic-error/10 px-3 py-2 text-[11.5px] text-semantic-error">
          <span className="flex-1">{sectionError}</span>
          <button
            type="button"
            onClick={() => setSectionError(null)}
            className="shrink-0 text-text-muted hover:text-text"
            aria-label="Dismiss"
          >
            <XCircle size={12} />
          </button>
        </div>
      )}

      {loading ? (
        <div className="rounded-[8px] border border-border-subtle bg-surface-2 px-3 py-4 text-center text-[11px] text-text-muted">
          Loading profiles…
        </div>
      ) : (
        <div className="space-y-2">
          {profiles.length === 0 && !editing && (
            <div className="rounded-[8px] border border-dashed border-border bg-surface-2 px-3 py-4 text-center text-[11.5px] text-text-muted">
              No chat profiles yet. Add one to use a non-Claude LLM in chat.
            </div>
          )}
          {profiles.map((p) => (
            <ProfileCard
              key={p.id}
              profile={p}
              disabled={!!editing}
              onEdit={() => onEdit(p)}
              onDelete={() => void onDelete(p)}
            />
          ))}
          {editing && (
            <ProfileEditor
              draft={editing}
              existingIds={profiles.map((p) => p.id)}
              onChange={setEditing}
              onCancel={() => setEditing(null)}
              onSaved={onSaved}
            />
          )}
        </div>
      )}
    </section>
  );
}

function ProfileCard({
  profile,
  disabled,
  onEdit,
  onDelete,
}: {
  profile: LlmChatProfile;
  disabled: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-[8px] border border-border-subtle bg-surface-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[12px] font-medium text-text">
            {profile.name}
          </span>
          <span className="shrink-0 rounded-full bg-surface-3 px-1.5 py-[1px] text-[9.5px] uppercase text-text-muted">
            {profile.provider}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-2 truncate font-mono text-[10.5px] text-text-muted">
          <span className="truncate">{profile.model}</span>
          <span className="text-text-dim">·</span>
          <span className="truncate text-text-dim">{profile.baseUrl}</span>
        </div>
      </div>
      <button
        onClick={onEdit}
        disabled={disabled}
        className="rounded p-1.5 text-text-muted transition hover:bg-surface-3 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
        title="Edit profile"
      >
        <Edit size={12} />
      </button>
      <button
        onClick={onDelete}
        disabled={disabled}
        className="rounded p-1.5 text-text-muted transition hover:bg-surface-3 hover:text-semantic-error disabled:cursor-not-allowed disabled:opacity-40"
        title="Delete profile"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

interface ProfileEditorProps {
  draft: LlmChatProfileDraft;
  existingIds: string[];
  onChange: (next: LlmChatProfileDraft) => void;
  onCancel: () => void;
  onSaved: (saved: LlmChatProfile) => Promise<void> | void;
}

function ProfileEditor({
  draft,
  existingIds,
  onChange,
  onCancel,
  onSaved,
}: ProfileEditorProps) {
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<LlmTestResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const isEdit = existingIds.includes(draft.id);

  const errors: ProfileFormErrors = useMemo(
    () => validateProfileForm(draft),
    [draft],
  );
  const hasErrors = Object.keys(errors).length > 0;

  const update = useCallback(
    <K extends keyof LlmChatProfileDraft>(
      key: K,
      value: LlmChatProfileDraft[K],
    ) => {
      // Invalidate any cached test result on edit — same UX as the
      // autocomplete form.
      setTestResult(null);
      setSaveError(null);
      onChange({ ...draft, [key]: value });
    },
    [draft, onChange],
  );

  const onTest = useCallback(async () => {
    if (hasErrors) return;
    setTesting(true);
    setTestResult(null);
    try {
      // Backend duck-types on apiKey/baseUrl/model/provider — same test
      // endpoint handles LlmConfig + LlmChatProfile.
      const profile = profileFromDraft(draft);
      const res = await api.llm.test(profile);
      setTestResult(res);
    } catch (err) {
      setTestResult({ ok: false, error: (err as Error).message });
    } finally {
      setTesting(false);
    }
  }, [draft, hasErrors]);

  const onSave = useCallback(async () => {
    if (hasErrors || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const profile = profileFromDraft(draft);
      const saved = await api.llm.upsertChatProfile(profile);
      await onSaved(saved);
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [draft, hasErrors, saving, onSaved]);

  return (
    <div className="rounded-[8px] border border-accent/40 bg-surface-2 p-4">
      <div className="mb-3 text-[12px] font-medium text-text">
        {isEdit ? 'Edit profile' : 'New profile'}
      </div>
      <div className="space-y-3">
        <ProfileField label="Name" error={errors.name}>
          <ProfileInput
            value={draft.name}
            onChange={(v) => update('name', v)}
            placeholder="e.g. GPT-4o (work)"
          />
        </ProfileField>

        <ProfileField label="Provider">
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
        </ProfileField>

        <ProfileField label="Base URL" error={errors.baseUrl}>
          <ProfileInput
            value={draft.baseUrl}
            onChange={(v) => update('baseUrl', v)}
            placeholder={
              draft.provider === 'openai'
                ? 'https://api.openai.com/v1'
                : 'https://api.anthropic.com'
            }
          />
        </ProfileField>

        <ProfileField label="API key" error={errors.apiKey}>
          <div className="relative">
            <ProfileInput
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
        </ProfileField>

        <ProfileField label="Model" error={errors.model}>
          {draft.provider === 'anthropic' ? (
            <>
              <ProfileInput
                value={draft.model}
                onChange={(v) => update('model', v)}
                placeholder="claude-opus-4-8"
                list="anthropic-model-suggestions"
              />
              {/* Datalist keeps the input free-form for proxy ids / future models
                  while surfacing curated Anthropic IDs as suggestions. */}
              <datalist id="anthropic-model-suggestions">
                {ANTHROPIC_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </datalist>
            </>
          ) : (
            <ProfileInput
              value={draft.model}
              onChange={(v) => update('model', v)}
              placeholder="gpt-4o-mini"
            />
          )}
        </ProfileField>

        {/* v0.37: extended-thinking budget tier. Anthropic + whitelisted models
            only — OpenAI silently disables the control. The control stays
            mounted even for OpenAI so the user sees why it's greyed out. */}
        <ProfileField
          label="Effort (extended thinking)"
          hint={
            draft.provider !== 'anthropic'
              ? 'Anthropic-only — switch provider to enable.'
              : modelSupportsThinking(draft.model.trim())
                ? 'Maps to Anthropic thinking.budget_tokens. Higher = deeper reasoning, more tokens spent.'
                : 'This model does not support extended thinking (Haiku / pre-4.6 Sonnet / pre-4.7 Opus).'
          }
          error={errors.effort}
        >
          <select
            value={draft.effort}
            disabled={
              draft.provider !== 'anthropic' ||
              !modelSupportsThinking(draft.model.trim())
            }
            onChange={(e) => update('effort', e.target.value as typeof draft.effort)}
            className="w-full rounded-[7px] border border-border-subtle bg-surface-3 px-3 py-1.5 font-mono text-[12px] text-text focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {EFFORT_OPTIONS.map((o) => (
              <option key={o.value || 'default'} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </ProfileField>

        <div className="grid grid-cols-2 gap-3">
          <ProfileField label="Temperature" error={errors.temperature}>
            <ProfileInput
              type="number"
              value={draft.temperature}
              onChange={(v) => update('temperature', v)}
              placeholder="0.7"
            />
          </ProfileField>
          <ProfileField label="Max tokens" error={errors.maxTokens}>
            <ProfileInput
              type="number"
              value={draft.maxTokens}
              onChange={(v) => update('maxTokens', v)}
              placeholder="1024"
            />
          </ProfileField>
        </div>

        <ProfileField
          label="System prompt"
          hint="Optional — prepended after project memory + devlog preambles on every turn."
        >
          <textarea
            value={draft.systemPrompt}
            onChange={(e) => update('systemPrompt', e.target.value)}
            placeholder="You are a helpful coding assistant…"
            rows={4}
            className="w-full resize-y rounded-[7px] border border-border-subtle bg-surface-3 px-3 py-1.5 font-mono text-[12px] text-text placeholder:text-text-dim focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40"
          />
        </ProfileField>

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
                    {testResult.modelEcho &&
                      testResult.modelEcho !== draft.model && (
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

        {saveError && (
          <div className="rounded-[8px] border border-semantic-error/40 bg-semantic-error/10 px-3 py-2 text-[11.5px] text-semantic-error">
            {saveError}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            onClick={onCancel}
            disabled={saving}
            className="inline-flex h-[28px] items-center gap-1.5 rounded-[7px] border border-border-subtle bg-surface-3 px-3 text-[11.5px] text-text-secondary transition hover:border-border-hi hover:bg-surface-4 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={onTest}
            disabled={
              testing ||
              hasErrors ||
              !draft.baseUrl.trim() ||
              !draft.model.trim()
            }
            className="inline-flex h-[28px] items-center gap-1.5 rounded-[7px] border border-border-subtle bg-surface-3 px-3 text-[11.5px] text-text-secondary transition hover:border-border-hi hover:bg-surface-4 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
          >
            {testing ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <Sparkles size={11} />
            )}
            <span>{testing ? 'Testing…' : 'Test'}</span>
          </button>
          <button
            onClick={onSave}
            disabled={hasErrors || saving}
            className="inline-flex h-[28px] items-center gap-1.5 rounded-[7px] px-3 text-[11.5px] font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            style={{
              background:
                'linear-gradient(135deg, var(--color-accent), #a855f7)',
              boxShadow: '0 2px 8px var(--color-accent-glow)',
            }}
          >
            {saving ? <Loader2 size={11} className="animate-spin" /> : null}
            <span>{saving ? 'Saving…' : 'Save profile'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function ProfileField({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-[11px] font-medium text-text-secondary">
        {label}
      </div>
      {children}
      {error ? (
        <p className="mt-1 text-[10.5px] text-semantic-error">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-[10.5px] text-text-dim">{hint}</p>
      ) : null}
    </label>
  );
}

function ProfileInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  list,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: 'text' | 'password' | 'number';
  list?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      list={list}
      className="w-full rounded-[7px] border border-border-subtle bg-surface-3 px-3 py-1.5 font-mono text-[12px] text-text placeholder:text-text-dim focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40"
    />
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
