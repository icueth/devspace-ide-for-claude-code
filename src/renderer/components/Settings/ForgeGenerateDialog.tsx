import { Loader2, Sparkles, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import type { ForgeDraft, ForgeKind, ForgeScope } from '@shared/types';

// v0.25: shared Claude-generation dialog for skills + agents. Reused
// from SkillsSettings + AgentsSettings — keeps Forge backend (createDraft
// + generateDraft + saveDraft) wired without exposing the retired
// ForgeView surface. Lazy-loaded so the heavy markdown deps in the
// underlying body editor don't ship with the Settings bundle.
//
// Flow:
//   1. User picks scope (project/global), enters slug + brief
//   2. createDraft → server returns draft with empty body
//   3. generateDraft kicks off; we subscribe to forge events and append
//      streaming deltas into the preview pane
//   4. On complete: enable Save → saveDraft writes the SKILL.md/agent .md
//      and triggers the parent reload via onSaved
//   5. On Cancel during stream: cancelDraft kills the run + deletes draft

interface Props {
  open: boolean;
  kind: ForgeKind;
  projectPath: string | null;
  initialBrief?: string;
  onClose: () => void;
  onSaved: (saved: { path: string; key: string }) => void;
}

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function deriveSlug(brief: string): string {
  return brief
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60)
    .replace(/^-|-$/g, '');
}

export function ForgeGenerateDialog(props: Props) {
  const { open, kind, projectPath, initialBrief, onClose, onSaved } = props;
  const [scope, setScope] = useState<ForgeScope>(
    projectPath ? 'project' : 'global',
  );
  const [slug, setSlug] = useState('');
  const [brief, setBrief] = useState('');
  const [draft, setDraft] = useState<ForgeDraft | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [streamBody, setStreamBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const draftIdRef = useRef<string | null>(null);
  const bodyPaneRef = useRef<HTMLDivElement | null>(null);

  // Reset state when dialog opens fresh.
  useEffect(() => {
    if (open) {
      setScope(projectPath ? 'project' : 'global');
      setSlug(deriveSlug(initialBrief ?? ''));
      setBrief(initialBrief ?? '');
      setDraft(null);
      setStreaming(false);
      setStreamBody('');
      setError(null);
      setSaving(false);
      draftIdRef.current = null;
    }
  }, [open, initialBrief, projectPath]);

  // Subscribe to forge events while the dialog is open + a draft is in flight.
  useEffect(() => {
    if (!open) return undefined;
    const unsub = api.forge.onEvent((ev) => {
      const id = draftIdRef.current;
      if (!id) return;
      // ForgeEvent schema: draft_streaming carries `delta` (not bodyDelta),
      // draft_ready/draft_error carry only ids — we must re-fetch the draft
      // through getDraft to populate the final body + error message.
      if (
        ev.kind === 'draft_streaming' &&
        'draftId' in ev &&
        ev.draftId === id &&
        'delta' in ev &&
        typeof ev.delta === 'string'
      ) {
        setStreamBody((prev) => prev + ev.delta);
        queueMicrotask(() => {
          const el = bodyPaneRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        });
      } else if (
        ev.kind === 'draft_ready' &&
        'draftId' in ev &&
        ev.draftId === id
      ) {
        void api.forge
          .getDraft(id)
          .then((fresh) => {
            if (draftIdRef.current !== id) return;
            if (fresh) setDraft(fresh);
            setStreaming(false);
          })
          .catch((err) => {
            if (draftIdRef.current !== id) return;
            setError((err as Error).message);
            setStreaming(false);
          });
      } else if (
        ev.kind === 'draft_error' &&
        'draftId' in ev &&
        ev.draftId === id
      ) {
        void api.forge
          .getDraft(id)
          .then((fresh) => {
            if (draftIdRef.current !== id) return;
            setError(fresh?.errorMessage ?? 'Generation failed');
            setStreaming(false);
          })
          .catch(() => {
            if (draftIdRef.current !== id) return;
            setError('Generation failed');
            setStreaming(false);
          });
      }
    });
    return unsub;
  }, [open]);

  const canGenerate = useMemo(() => {
    if (streaming || saving) return false;
    if (!SLUG_RE.test(slug)) return false;
    if (slug.length > 80) return false;
    if (brief.trim().length < 12) return false;
    if (scope === 'project' && !projectPath) return false;
    return true;
  }, [slug, brief, scope, projectPath, streaming, saving]);

  const onGenerate = async () => {
    setError(null);
    setStreamBody('');
    setDraft(null);
    setStreaming(true);
    try {
      const d = await api.forge.createDraft({
        projectPath: projectPath ?? '',
        kind,
        scope,
        slug,
        brief: brief.trim(),
      });
      draftIdRef.current = d.id;
      setDraft(d);
      await api.forge.generateDraft({ draftId: d.id });
    } catch (err) {
      setError((err as Error).message);
      setStreaming(false);
    }
  };

  const onCancel = async () => {
    const id = draftIdRef.current;
    if (id && streaming) {
      try {
        await api.forge.cancelDraft(id);
      } catch {
        // best-effort
      }
    }
    onClose();
  };

  const onSave = async () => {
    const id = draftIdRef.current;
    if (!id || !draft) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await api.forge.saveDraft({ draftId: id });
      onSaved(saved);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  const displayBody = streaming
    ? streamBody
    : (draft?.body ?? streamBody);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) void onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px]" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 flex h-[85vh] w-[min(900px,95vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[10px] border border-border bg-surface-1 shadow-2xl focus:outline-none"
          aria-describedby={undefined}
        >
          <div className="flex items-center justify-between border-b border-border bg-surface-2 px-4 py-2.5">
            <Dialog.Title className="flex items-center gap-2 text-[13px] font-semibold text-text">
              <Sparkles size={14} className="text-accent" />
              Generate {kind} with Claude
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                className="rounded p-1 text-text-muted hover:bg-surface-3 hover:text-text"
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </Dialog.Close>
          </div>

          <div className="grid flex-1 grid-cols-[300px_1fr] overflow-hidden">
            {/* Left — form */}
            <div className="flex flex-col gap-3 overflow-y-auto border-r border-border bg-surface-2/40 p-4">
              <label className="flex flex-col gap-1">
                <span className="text-[10.5px] font-medium uppercase tracking-wide text-text-muted">
                  Scope
                </span>
                <select
                  value={scope}
                  onChange={(e) => setScope(e.target.value as ForgeScope)}
                  disabled={streaming || saving}
                  className="rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-1.5 text-[11.5px] text-text focus:border-accent focus:outline-none disabled:opacity-50"
                >
                  <option value="project" disabled={!projectPath}>
                    Project ({projectPath ? '.claude/' : 'no active project'})
                  </option>
                  <option value="global">Global (~/.claude/)</option>
                </select>
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-[10.5px] font-medium uppercase tracking-wide text-text-muted">
                  Slug
                </span>
                <input
                  type="text"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value.toLowerCase())}
                  disabled={streaming || saving}
                  placeholder="kebab-case-name"
                  className="rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-1.5 font-mono text-[11.5px] text-text placeholder:text-text-dim focus:border-accent focus:outline-none disabled:opacity-50"
                />
                {slug && !SLUG_RE.test(slug) && (
                  <span className="text-[10px] text-rose-400">
                    Must be lowercase letters/digits with hyphens
                  </span>
                )}
              </label>

              <label className="flex flex-1 flex-col gap-1">
                <span className="text-[10.5px] font-medium uppercase tracking-wide text-text-muted">
                  Brief — what should it do?
                </span>
                <textarea
                  value={brief}
                  onChange={(e) => setBrief(e.target.value)}
                  disabled={streaming || saving}
                  rows={8}
                  placeholder={
                    kind === 'skill'
                      ? 'e.g. analyze vitest failures and suggest fixes from the snapshot diff'
                      : 'e.g. backend-developer who refactors API routes following our auth middleware patterns'
                  }
                  className="min-h-[120px] flex-1 resize-none rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-1.5 text-[11.5px] text-text placeholder:text-text-dim focus:border-accent focus:outline-none disabled:opacity-50"
                />
                <span className="text-[10px] text-text-dim">
                  {brief.length} chars
                </span>
              </label>

              {error && (
                <div className="rounded-[6px] border border-rose-500/40 bg-rose-500/10 p-2 text-[11px] text-rose-300">
                  {error}
                </div>
              )}

              <div className="flex flex-col gap-2 pt-1">
                {!draft && !streaming ? (
                  <button
                    onClick={() => void onGenerate()}
                    disabled={!canGenerate}
                    className={cn(
                      'inline-flex items-center justify-center gap-1.5 rounded-[7px] px-3 py-2 text-[11.5px] font-medium transition',
                      canGenerate
                        ? 'bg-gradient-to-r from-accent to-fuchsia-500 text-white hover:brightness-110'
                        : 'cursor-not-allowed bg-surface-3 text-text-muted',
                    )}
                  >
                    <Sparkles size={12} />
                    Generate with Claude
                  </button>
                ) : streaming ? (
                  <button
                    onClick={() => void onCancel()}
                    className="inline-flex items-center justify-center gap-1.5 rounded-[7px] border border-border-subtle bg-surface-3 px-3 py-2 text-[11.5px] text-text-secondary hover:bg-surface-4 hover:text-text"
                  >
                    <Loader2 size={12} className="animate-spin" />
                    Cancel generation
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() => void onSave()}
                      disabled={saving}
                      className={cn(
                        'inline-flex items-center justify-center gap-1.5 rounded-[7px] px-3 py-2 text-[11.5px] font-medium transition',
                        saving
                          ? 'cursor-wait bg-surface-3 text-text-muted'
                          : 'bg-accent text-white hover:brightness-110',
                      )}
                    >
                      Save {kind}
                    </button>
                    <button
                      onClick={() => void onGenerate()}
                      disabled={saving}
                      className="inline-flex items-center justify-center gap-1.5 rounded-[7px] border border-border-subtle bg-surface-3 px-3 py-2 text-[11.5px] text-text-secondary hover:bg-surface-4 hover:text-text"
                    >
                      Regenerate
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Right — preview pane */}
            <div className="flex flex-col overflow-hidden">
              <div className="flex items-center justify-between border-b border-border-subtle bg-surface-2/30 px-3 py-1.5">
                <span className="font-mono text-[10.5px] text-text-muted">
                  {draft?.frontmatter?.name ?? slug ?? '<no slug yet>'}
                </span>
                {streaming && (
                  <span className="inline-flex items-center gap-1 text-[10.5px] text-accent">
                    <Loader2 size={10} className="animate-spin" />
                    streaming…
                  </span>
                )}
              </div>
              <div
                ref={bodyPaneRef}
                className="flex-1 overflow-y-auto whitespace-pre-wrap p-4 font-mono text-[11.5px] leading-relaxed text-text"
              >
                {displayBody ||
                  (streaming
                    ? 'Waiting for Claude to start…'
                    : `Enter a brief on the left, then click "Generate with Claude" to draft a ${kind}.`)}
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
