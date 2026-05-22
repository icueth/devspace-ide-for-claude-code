import {
  AlertTriangle,
  CheckCircle2,
  Edit,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  ShieldAlert,
  Terminal,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  type CliProfileDraft,
  type CliProfileFormErrors,
  cliProfileFromDraft,
  draftFromCliProfile,
  isInsecureHttpUrl,
  newCliProfileDraft,
  validateCliProfile,
} from '@renderer/components/Settings/cliProfileForm';
import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import type { CliDetectionResult, CliProfile } from '@shared/types';

/**
 * v0.30: Settings section for non-Claude CLI runtime profiles. Lives
 * under the LLM tab as a sibling to "Chat profiles" — mental model:
 * "Chat profiles" = HTTP API endpoints; "CLI runtimes" = spawn-an-actual-
 * binary OpenCode/Codex/Gemini with provider config.
 *
 * Stored at `~/.devspace/cli-profiles.json` by the backend. Selecting a
 * CLI profile in the chat panel creates a NEW thread bound to it via
 * `ChatThread.cliProfileId` — provider lock is per-thread, never
 * mutating an existing thread (same pattern as LlmChatProfile in v0.29).
 */
export function CliSettings() {
  const [profiles, setProfiles] = useState<CliProfile[]>([]);
  const [detection, setDetection] = useState<CliDetectionResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<CliProfileDraft | null>(null);
  // Section-level error survives the ProfileEditor unmount — same
  // pattern as LlmSettings' ChatProfilesSection.
  const [sectionError, setSectionError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [list, det] = await Promise.all([
        api.cli.listProfiles(),
        api.cli.detect(),
      ]);
      setProfiles(list);
      setDetection(det);
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

  // Look up detection result for a given cliId. Returns a sentinel
  // 'installed: false' record when the backend hasn't returned a row
  // for that id yet — defensive against future runtimes that haven't
  // been wired into the detection probe.
  const detectFor = useCallback(
    (cliId: 'opencode'): CliDetectionResult => {
      return (
        detection.find((d) => d.cliId === cliId) ?? {
          cliId,
          installed: false,
        }
      );
    },
    [detection],
  );

  const opencode = detectFor('opencode');

  const onAdd = useCallback(() => {
    setEditing(newCliProfileDraft('opencode'));
  }, []);

  const onEdit = useCallback((profile: CliProfile) => {
    setEditing(draftFromCliProfile(profile));
  }, []);

  const onDelete = useCallback(
    async (profile: CliProfile) => {
      const ok = window.confirm(
        `Delete CLI profile "${profile.name}"? Threads already bound to it will show "unknown CLI" until you switch them.`,
      );
      if (!ok) return;
      await api.cli.deleteProfile(profile.id);
      await reload();
      window.dispatchEvent(new CustomEvent('devspace:cli-profiles-changed'));
    },
    [reload],
  );

  const onSaved = useCallback(
    async (saved: CliProfile) => {
      setEditing(null);
      // Optimistic merge so the card reflects the save before reload
      // round-trips (matches LlmSettings.ChatProfilesSection).
      setProfiles((prev) => {
        const exists = prev.some((p) => p.id === saved.id);
        return exists
          ? prev.map((p) => (p.id === saved.id ? saved : p))
          : [...prev, saved];
      });
      try {
        window.dispatchEvent(
          new CustomEvent('devspace:cli-profiles-changed'),
        );
        await reload();
      } catch (err) {
        setSectionError(`Saved, but refresh failed: ${(err as Error).message}`);
      }
    },
    [reload],
  );

  return (
    <section className="mt-8 border-t border-border-subtle pt-6">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[14px] font-semibold text-text">
            <Terminal size={13} className="text-accent" />
            CLI runtimes
          </h2>
          <p className="mt-0.5 max-w-[640px] text-[11.5px] text-text-muted">
            Non-Claude CLI agents (OpenCode today; Codex / Gemini later) that
            DevSpace spawns with isolated config dirs — your own{' '}
            <code className="rounded bg-surface-3 px-1">~/.config/&lt;cli&gt;/</code>{' '}
            is never mutated. Each profile binds a CLI to a provider endpoint
            and model. Stored at{' '}
            <code className="rounded bg-surface-3 px-1">
              ~/.devspace/cli-profiles.json
            </code>
            .
          </p>
        </div>
        {!editing && (
          <button
            onClick={onAdd}
            disabled={!opencode.installed}
            title={
              opencode.installed
                ? 'Add a new OpenCode profile'
                : 'OpenCode is not installed — see install hint below'
            }
            className="inline-flex h-[28px] shrink-0 items-center gap-1.5 rounded-[7px] border border-border-subtle bg-surface-3 px-3 text-[11.5px] text-text-secondary transition hover:border-border-hi hover:bg-surface-4 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus size={11} />
            <span>Add OpenCode profile</span>
          </button>
        )}
      </div>

      {/* Detection summary banner — green when installed, amber + install
          link when missing. Drives the disabled state on "+ Add" above. */}
      <DetectionBanner detection={opencode} />

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
          Loading CLI profiles…
        </div>
      ) : (
        <div className="space-y-2">
          {profiles.length === 0 && !editing && (
            <div className="rounded-[8px] border border-dashed border-border bg-surface-2 px-3 py-4 text-center text-[11.5px] text-text-muted">
              No CLI profiles yet. Add one to run OpenCode against an OpenAI-
              compatible endpoint inside DevSpace chat.
            </div>
          )}
          {profiles.map((p) => (
            <CliProfileCard
              key={p.id}
              profile={p}
              detection={detectFor(p.cliId)}
              disabled={!!editing}
              onEdit={() => onEdit(p)}
              onDelete={() => void onDelete(p)}
            />
          ))}
          {editing && (
            <CliProfileEditor
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

// ─── Detection banner ───────────────────────────────────────────────────────

function DetectionBanner({ detection }: { detection: CliDetectionResult }) {
  const openInstallDocs = useCallback(() => {
    void api.app.openExternal('https://opencode.ai');
  }, []);

  if (detection.installed) {
    return (
      <div className="mb-3 flex items-center gap-2 rounded-[8px] border border-semantic-success/40 bg-semantic-success/10 px-3 py-2 text-[11.5px] text-semantic-success">
        <CheckCircle2 size={13} className="shrink-0" />
        <span className="font-medium">OpenCode detected</span>
        {detection.version && (
          <span className="text-text-muted">· v{detection.version}</span>
        )}
        {detection.bin && (
          <span className="ml-auto truncate font-mono text-[10.5px] text-text-muted">
            {detection.bin.replace(/^\/Users\/[^/]+/, '~')}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="mb-3 flex items-start gap-2 rounded-[8px] border border-semantic-warning/40 bg-semantic-warning/10 px-3 py-2 text-[11.5px] text-semantic-warning">
      <AlertTriangle size={13} className="mt-0.5 shrink-0" />
      <div className="flex-1">
        <div className="font-medium">OpenCode not installed</div>
        <p className="mt-0.5 text-[10.5px] text-text-muted">
          DevSpace looks for the <code className="rounded bg-surface-3 px-1">opencode</code>{' '}
          binary on PATH. Install from opencode.ai, then this banner will turn
          green and the "+ Add" button above will enable.
        </p>
      </div>
      <button
        type="button"
        onClick={openInstallDocs}
        className="inline-flex h-[24px] shrink-0 items-center gap-1 rounded-[6px] border border-semantic-warning/40 bg-surface-3 px-2 text-[10.5px] text-semantic-warning transition hover:bg-surface-4"
      >
        <ExternalLink size={10} />
        <span>opencode.ai</span>
      </button>
    </div>
  );
}

// ─── Profile card ───────────────────────────────────────────────────────────

function CliProfileCard({
  profile,
  detection,
  disabled,
  onEdit,
  onDelete,
}: {
  profile: CliProfile;
  detection: CliDetectionResult;
  disabled: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  // Show the URL host only (not full URL) on the row, so long
  // provider URLs don't blow out the layout.
  const host = useMemo(() => {
    try {
      return new URL(profile.provider.baseURL).host;
    } catch {
      return profile.provider.baseURL;
    }
  }, [profile.provider.baseURL]);

  return (
    <div className="flex items-center gap-3 rounded-[8px] border border-border-subtle bg-surface-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[12px] font-medium text-text">
            {profile.name}
          </span>
          <span className="shrink-0 rounded-full bg-surface-3 px-1.5 py-[1px] text-[9.5px] uppercase text-text-muted">
            {profile.cliId}
          </span>
          {!detection.installed && (
            <span
              className="shrink-0 rounded-full border border-semantic-warning/40 bg-semantic-warning/10 px-1.5 py-[1px] text-[9.5px] uppercase text-semantic-warning"
              title={`${profile.cliId} binary not detected on PATH`}
            >
              missing
            </span>
          )}
          {detection.installed && detection.version && (
            <span className="shrink-0 rounded-full border border-semantic-success/40 bg-semantic-success/10 px-1.5 py-[1px] text-[9.5px] text-semantic-success">
              v{detection.version}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-2 truncate font-mono text-[10.5px] text-text-muted">
          <span className="truncate">{profile.provider.model}</span>
          <span className="text-text-dim">·</span>
          <span className="truncate text-text-dim">{host}</span>
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

// ─── Profile editor ─────────────────────────────────────────────────────────

interface CliProfileEditorProps {
  draft: CliProfileDraft;
  existingIds: string[];
  onChange: (next: CliProfileDraft) => void;
  onCancel: () => void;
  onSaved: (saved: CliProfile) => Promise<void> | void;
}

function CliProfileEditor({
  draft,
  existingIds,
  onChange,
  onCancel,
  onSaved,
}: CliProfileEditorProps) {
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const isEdit = existingIds.includes(draft.id);

  const errors: CliProfileFormErrors = useMemo(
    () => validateCliProfile(draft),
    [draft],
  );
  const hasErrors = Object.keys(errors).length > 0;

  const httpWarning = isInsecureHttpUrl(draft.baseURL);

  const update = useCallback(
    <K extends keyof CliProfileDraft>(key: K, value: CliProfileDraft[K]) => {
      setSaveError(null);
      onChange({ ...draft, [key]: value });
    },
    [draft, onChange],
  );

  const onSave = useCallback(async () => {
    if (hasErrors || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const profile = cliProfileFromDraft(draft);
      const saved = await api.cli.upsertProfile(profile);
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
        {isEdit ? 'Edit CLI profile' : 'New CLI profile'}
      </div>
      <div className="space-y-3">
        <CliField label="Name" error={errors.name}>
          <CliInput
            value={draft.name}
            onChange={(v) => update('name', v)}
            placeholder="e.g. AEON Qwen3.6"
          />
        </CliField>

        <CliField
          label="Runtime"
          hint="Which CLI binary DevSpace will spawn for threads bound to this profile."
        >
          <div className="inline-flex h-[28px] items-center gap-2 rounded-[7px] border border-border-subtle bg-surface-3 px-3 text-[11.5px] text-text">
            <Terminal size={11} className="text-accent" />
            <span className="font-mono">opencode</span>
            <span className="text-text-dim">·</span>
            <span className="text-text-muted">
              OpenAI-compatible endpoint adapter
            </span>
          </div>
        </CliField>

        <CliField label="Base URL" error={errors.baseURL}>
          <CliInput
            value={draft.baseURL}
            onChange={(v) => update('baseURL', v)}
            placeholder="https://api.openai.com/v1"
          />
          {httpWarning && !errors.baseURL && (
            <div
              className="mt-1 flex items-start gap-2 rounded-[7px] border border-semantic-warning/40 bg-semantic-warning/10 px-2.5 py-1.5 text-[10.5px] text-semantic-warning"
              role="alert"
            >
              <ShieldAlert size={11} className="mt-0.5 shrink-0" />
              <span>
                Plain HTTP — your API key will travel unencrypted. Fine for a
                LAN / VPN endpoint; avoid over the public internet.
              </span>
            </div>
          )}
        </CliField>

        <CliField label="API key" error={errors.apiKey}>
          <div className="relative">
            <CliInput
              type={showKey ? 'text' : 'password'}
              value={draft.apiKey}
              onChange={(v) => update('apiKey', v)}
              placeholder="sk-…"
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
        </CliField>

        <CliField label="Model" error={errors.model}>
          <CliInput
            value={draft.model}
            onChange={(v) => update('model', v)}
            placeholder="AEON-7/Qwen3.6-27B-AEON-Ultimate-Uncensored-BF16"
          />
        </CliField>

        <div className="grid grid-cols-2 gap-3">
          <CliField
            label="Context limit"
            error={errors.contextLimit}
            hint="Optional. Max tokens the model accepts in context. Leave empty to use the runner default."
          >
            <CliInput
              type="number"
              value={draft.contextLimit}
              onChange={(v) => update('contextLimit', v)}
              placeholder="128000"
            />
          </CliField>
          <CliField
            label="Output limit"
            error={errors.outputLimit}
            hint="Optional. Max tokens per response. Leave empty to use the runner default."
          >
            <CliInput
              type="number"
              value={draft.outputLimit}
              onChange={(v) => update('outputLimit', v)}
              placeholder="4096"
            />
          </CliField>
        </div>

        <CliField
          label="System prompt"
          error={errors.systemPrompt}
          hint="Optional — prepended after project memory + devlog preambles on every turn. Max 4096 chars."
        >
          <textarea
            value={draft.systemPrompt}
            onChange={(e) => update('systemPrompt', e.target.value)}
            placeholder="You are a helpful coding assistant…"
            rows={4}
            className="w-full resize-y rounded-[7px] border border-border-subtle bg-surface-3 px-3 py-1.5 font-mono text-[12px] text-text placeholder:text-text-dim focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40"
          />
        </CliField>

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

// ─── Tiny field/input primitives (scoped to this file, parallel to the
// ones in LlmSettings so the visual style stays consistent) ────────────

function CliField({
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

function CliInput({
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
      className={cn(
        'w-full rounded-[7px] border border-border-subtle bg-surface-3 px-3 py-1.5 font-mono text-[12px] text-text placeholder:text-text-dim focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40',
      )}
    />
  );
}
