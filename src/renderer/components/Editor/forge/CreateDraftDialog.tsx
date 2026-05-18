import * as Dialog from '@radix-ui/react-dialog';
import { Bot, Hammer, Loader2, Sparkles, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import type { ForgeDraft, ForgeKind, ForgeScope } from '@shared/types';

// Briefs are capped to 4KB on the wire — match that here so the
// counter visually warns the user before the service rejects them.
export const BRIEF_MAX = 4096;

// Slugs must be kebab-case ASCII: lowercase a-z, digits, dashes; cannot
// start or end with a dash and cannot contain `..` (path-traversal guard).
// Length cap matches the service-side filename ≤ 80 chars.
export interface SlugValidation {
  ok: boolean;
  cleaned: string;
  error?: string;
}

export function validateSlug(input: string): SlugValidation {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, cleaned: '', error: 'Slug is required' };
  // Reject path traversal up front — `..` is illegal anywhere in the slug.
  if (trimmed.includes('..')) {
    return { ok: false, cleaned: trimmed, error: 'Slug cannot contain "..".' };
  }
  // Reject any whitespace (spaces, tabs) — slugs are kebab-case only.
  if (/\s/.test(trimmed)) {
    return { ok: false, cleaned: trimmed, error: 'Slug cannot contain whitespace' };
  }
  // Reject uppercase letters explicitly so the user can fix capitalization
  // themselves; auto-lowercasing would mask the intent.
  if (/[A-Z]/.test(trimmed)) {
    return { ok: false, cleaned: trimmed, error: 'Slug must be lowercase' };
  }
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(trimmed)) {
    return {
      ok: false,
      cleaned: trimmed,
      error: 'Use kebab-case: a-z, 0-9, dashes (no leading/trailing dash)',
    };
  }
  if (trimmed.length > 80) {
    return { ok: false, cleaned: trimmed.slice(0, 80), error: 'Slug must be ≤ 80 chars' };
  }
  return { ok: true, cleaned: trimmed };
}

interface CreateDraftDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectPath: string;
  // Optional pre-filled fields when launched from chat slash command,
  // discover banner, or suggestions inbox.
  prefillKind?: ForgeKind;
  prefillScope?: ForgeScope;
  prefillSlug?: string;
  prefillBrief?: string;
  onCreated?: (draft: ForgeDraft) => void;
}

export function CreateDraftDialog({
  open,
  onOpenChange,
  projectPath,
  prefillKind,
  prefillScope,
  prefillSlug,
  prefillBrief,
  onCreated,
}: CreateDraftDialogProps) {
  const [kind, setKind] = useState<ForgeKind>(prefillKind ?? 'skill');
  const [scope, setScope] = useState<ForgeScope>(prefillScope ?? 'project');
  const [slug, setSlug] = useState<string>(prefillSlug ?? '');
  const [brief, setBrief] = useState<string>(prefillBrief ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset / hydrate form state when the dialog opens (so a second open
  // with new prefill doesn't show stale values from the previous open).
  useEffect(() => {
    if (!open) return;
    setKind(prefillKind ?? 'skill');
    setScope(prefillScope ?? 'project');
    setSlug(prefillSlug ?? '');
    setBrief(prefillBrief ?? '');
    setBusy(false);
    setError(null);
  }, [open, prefillKind, prefillScope, prefillSlug, prefillBrief]);

  const slugCheck = validateSlug(slug);
  const briefLen = brief.length;
  const briefOk = briefLen > 0 && briefLen <= BRIEF_MAX;
  const canSubmit = !busy && !!projectPath && slugCheck.ok && briefOk;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const draft = await api.forge.createDraft({
        projectPath,
        kind,
        scope,
        slug: slugCheck.cleaned,
        brief: brief.trim(),
      });
      // Fire-and-forget the generation kickoff so the dialog can close
      // immediately — Forge view picks up the new draft via onEvent.
      void api.forge.generateDraft({ draftId: draft.id }).catch(() => undefined);
      onCreated?.(draft);
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/55 backdrop-blur-[3px]" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[71] w-[560px] max-w-[92vw] max-h-[92vh] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-xl border border-border-emphasis bg-surface-raised p-5 shadow-[0_20px_60px_rgba(0,0,0,0.5)] outline-none"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <Dialog.Title className="flex items-center gap-2 text-[14px] font-semibold text-text">
            <Hammer size={14} className="text-accent" />
            New Forge draft
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-[11.5px] leading-relaxed text-text-muted">
            Generate a SKILL.md or agent.md tailored to this project. Claude
            drafts in the background — you can refine before saving.
          </Dialog.Description>

          {/* Kind toggle */}
          <div className="mt-4">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
              Kind
            </div>
            <div className="flex gap-1.5">
              <ToggleButton
                active={kind === 'skill'}
                onClick={() => setKind('skill')}
                icon={<Sparkles size={11} />}
                label="Skill"
              />
              <ToggleButton
                active={kind === 'agent'}
                onClick={() => setKind('agent')}
                icon={<Bot size={11} />}
                label="Agent"
              />
            </div>
          </div>

          {/* Scope toggle */}
          <div className="mt-4">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
              Scope
            </div>
            <div className="flex gap-1.5">
              <ToggleButton
                active={scope === 'project'}
                onClick={() => setScope('project')}
                label="Project"
                hint=".claude/ in this repo"
              />
              <ToggleButton
                active={scope === 'global'}
                onClick={() => setScope('global')}
                label="Global"
                hint="~/.claude/ (all projects)"
              />
            </div>
          </div>

          {/* Slug */}
          <label className="mb-1 mt-4 block text-[10px] font-semibold uppercase tracking-wider text-text-muted">
            Slug
          </label>
          <input
            type="text"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="kebab-case-name"
            className={cn(
              'w-full rounded border bg-surface px-2.5 py-1.5 font-mono text-[12.5px] text-text focus:outline-none',
              slug.length === 0
                ? 'border-border-emphasis focus:border-accent'
                : slugCheck.ok
                  ? 'border-semantic-success/50 focus:border-semantic-success'
                  : 'border-semantic-error/50 focus:border-semantic-error',
            )}
            autoFocus
          />
          {slug.length > 0 && !slugCheck.ok && slugCheck.error && (
            <div className="mt-1 text-[10.5px] text-semantic-error">{slugCheck.error}</div>
          )}

          {/* Brief */}
          <label className="mb-1 mt-4 block text-[10px] font-semibold uppercase tracking-wider text-text-muted">
            Brief
          </label>
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value.slice(0, BRIEF_MAX))}
            rows={6}
            placeholder="One paragraph: what should this skill / agent do, and when?"
            className="w-full rounded border border-border-emphasis bg-surface px-2.5 py-1.5 text-[12.5px] text-text focus:border-accent focus:outline-none"
          />
          <div className="mt-1 flex items-center justify-between text-[10.5px] text-text-muted">
            <span>4KB cap — anything longer gets truncated.</span>
            <span className={briefLen > BRIEF_MAX * 0.9 ? 'text-semantic-warning' : ''}>
              {briefLen} / {BRIEF_MAX}
            </span>
          </div>

          {error && (
            <div className="mt-3 rounded border border-semantic-error/40 bg-semantic-error/10 px-3 py-2 text-[11px] text-semantic-error">
              {error}
            </div>
          )}

          <div className="mt-5 flex items-center justify-end gap-2">
            <Dialog.Close asChild>
              <button
                type="button"
                disabled={busy}
                className="rounded-[6px] border border-border-subtle bg-surface-3 px-3 py-1.5 text-[11.5px] text-text-secondary transition hover:bg-surface-4 hover:text-text disabled:opacity-50"
              >
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canSubmit}
              className="inline-flex items-center gap-1.5 rounded-[6px] bg-accent px-3 py-1.5 text-[11.5px] font-medium text-white transition hover:brightness-110 disabled:opacity-50"
            >
              {busy ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
              Generate
            </button>
          </div>

          <Dialog.Close asChild>
            <button
              type="button"
              aria-label="Close"
              className="absolute right-3 top-3 rounded p-1 text-text-muted transition hover:bg-surface-3 hover:text-text"
            >
              <X size={12} />
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ToggleButton({
  active,
  onClick,
  icon,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
  label: string;
  hint?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex flex-col items-start gap-0.5 rounded-[6px] border px-3 py-1.5 text-left text-[11.5px] transition',
        active
          ? 'border-accent bg-accent/15 text-text'
          : 'border-border-subtle bg-surface-3 text-text-secondary hover:bg-surface-4 hover:text-text',
      )}
    >
      <span className="flex items-center gap-1.5 font-medium">
        {icon}
        {label}
      </span>
      {hint && <span className="text-[10px] text-text-muted">{hint}</span>}
    </button>
  );
}
