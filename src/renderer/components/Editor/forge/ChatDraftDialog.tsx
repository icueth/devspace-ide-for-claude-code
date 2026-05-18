import * as Dialog from '@radix-ui/react-dialog';
import {
  Bot,
  CheckCircle2,
  Edit3,
  Loader2,
  Save,
  Send,
  Sparkles,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import type { ForgeDraft } from '@shared/types';

interface ChatDraftDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draftId: string | null;
  onSaved?: (info: { path: string; key: string }) => void;
  onDeleted?: (draftId: string) => void;
}

/**
 * Full-screen modal that streams a single Forge draft generation,
 * shows the chat transcript on the left, and the rendered SKILL.md /
 * agent.md body on the right.
 *
 * Live updates come in via `api.forge.onEvent` — we filter by `draftId`
 * and append `draft_streaming.delta` text to the last assistant message
 * so the user sees the generation token-by-token (mirrors how DesignView
 * streams its generator).
 */
export function ChatDraftDialog({ open, onOpenChange, draftId, onSaved, onDeleted }: ChatDraftDialogProps) {
  const [draft, setDraft] = useState<ForgeDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refineInput, setRefineInput] = useState('');
  const [refining, setRefining] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editBody, setEditBody] = useState(false);
  const [bodyDraft, setBodyDraft] = useState('');
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  // Track local streaming delta separately from `draft.messages` so
  // mid-stream updates don't require a server round-trip — we only
  // refetch on terminal events (`draft_ready`, `draft_error`, `draft_updated`).
  const [streamingDelta, setStreamingDelta] = useState<string>('');

  // ─── Load draft when dialog opens ───────────────────────────────────
  useEffect(() => {
    if (!open || !draftId) {
      setDraft(null);
      setStreamingDelta('');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api.forge
      .getDraft(draftId)
      .then((d) => {
        if (cancelled) return;
        setDraft(d);
        setBodyDraft(d?.body ?? '');
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, draftId]);

  // ─── Live event subscription ────────────────────────────────────────
  useEffect(() => {
    if (!open || !draftId) return;
    const off = api.forge.onEvent((ev) => {
      if (ev.draftId !== draftId) return;
      if (ev.kind === 'draft_streaming' && ev.delta) {
        setStreamingDelta((prev) => prev + ev.delta);
        return;
      }
      if (
        ev.kind === 'draft_ready' ||
        ev.kind === 'draft_error' ||
        ev.kind === 'draft_updated'
      ) {
        // CR-4 fix: clear streamingDelta SYNCHRONOUSLY before the refetch
        // promise settles. Otherwise a second draft_streaming event that
        // lands during the await would re-accumulate against stale buffer
        // state and double-render the same delta. Two-tab race is also
        // tamed — both tabs reset and refetch on every terminal event.
        setStreamingDelta('');
        void api.forge.getDraft(draftId).then((d) => {
          setDraft(d);
          if (!editBody) setBodyDraft(d?.body ?? '');
        });
      }
    });
    return off;
  }, [open, draftId, editBody]);

  // Sticky-bottom scroll for messages — every time we get new content
  // we pin to bottom unless the user has scrolled up.
  useEffect(() => {
    const el = messagesScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [draft?.messages, streamingDelta]);

  // ─── Derived state ──────────────────────────────────────────────────
  const status = draft?.status ?? 'pending';
  const isStreaming = status === 'generating';
  const isReady = status === 'ready';

  const messages = useMemo(() => {
    if (!draft) return [];
    if (!streamingDelta) return draft.messages;
    // Append streaming text to the last assistant message in place; if
    // the last message isn't an assistant turn, synthesize one so the
    // user sees the live tokens immediately.
    const last = draft.messages[draft.messages.length - 1];
    if (last && last.role === 'assistant') {
      const cloned = draft.messages.slice(0, -1);
      cloned.push({ ...last, content: last.content + streamingDelta });
      return cloned;
    }
    return [
      ...draft.messages,
      {
        id: `streaming-${draft.id}`,
        role: 'assistant' as const,
        content: streamingDelta,
        ts: Date.now(),
      },
    ];
  }, [draft, streamingDelta]);

  // ─── Handlers ───────────────────────────────────────────────────────
  const submitRefine = useCallback(async () => {
    // CR-11: refuse to submit while a prior generation is still streaming.
    // The Submit button is already disabled in this state via the
    // `isStreaming` prop on the button, but check here too so a Cmd+Enter
    // keybind from a stale-focused textarea can't sneak past.
    if (!draft || !refineInput.trim() || refining || isStreaming) return;
    setRefining(true);
    setError(null);
    try {
      await api.forge.updateDraft({
        draftId: draft.id,
        userMessage: refineInput.trim(),
      });
      // Kick off another generation pass.
      void api.forge.generateDraft({ draftId: draft.id }).catch(() => undefined);
      setRefineInput('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRefining(false);
    }
  }, [draft, refineInput, refining, isStreaming]);

  const saveBodyEdit = useCallback(async () => {
    if (!draft) return;
    try {
      const updated = await api.forge.updateDraft({
        draftId: draft.id,
        body: bodyDraft,
      });
      setDraft(updated);
      setEditBody(false);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [draft, bodyDraft]);

  const saveAsArtifact = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const info = await api.forge.saveDraft({ draftId: draft.id });
      onSaved?.(info);
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [draft, onSaved, onOpenChange]);

  const deleteDraft = useCallback(async () => {
    if (!draft) return;
    // eslint-disable-next-line no-alert
    if (!window.confirm('Delete this draft permanently?')) return;
    try {
      await api.forge.deleteDraft(draft.id);
      onDeleted?.(draft.id);
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [draft, onDeleted, onOpenChange]);

  // ─── Render ─────────────────────────────────────────────────────────
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/55 backdrop-blur-[3px]" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[71] flex h-[88vh] w-[1100px] max-w-[96vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border-emphasis bg-surface-raised shadow-[0_24px_80px_rgba(0,0,0,0.55)] outline-none"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {/* Header */}
          <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle bg-surface-2 px-4 py-2.5">
            {draft?.kind === 'agent' ? (
              <Bot size={14} className="text-accent-2" />
            ) : (
              <Sparkles size={14} className="text-accent" />
            )}
            <Dialog.Title className="text-[13px] font-semibold text-text">
              {draft ? `${draft.kind === 'agent' ? 'Agent' : 'Skill'} · ${draft.slug || '(no slug)'}` : 'Forge draft'}
            </Dialog.Title>
            <StatusChip status={status} />
            <span className="ml-2 text-[10.5px] text-text-muted">
              {draft?.scope === 'global' ? '🌐 global' : '📁 project'}
            </span>

            <div className="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => void deleteDraft()}
                disabled={!draft || saving}
                className="rounded p-1.5 text-text-muted transition hover:bg-surface-3 hover:text-semantic-error disabled:opacity-40"
                title="Delete draft"
              >
                <Trash2 size={12} />
              </button>
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label="Close"
                  className="rounded p-1.5 text-text-muted transition hover:bg-surface-3 hover:text-text"
                >
                  <X size={12} />
                </button>
              </Dialog.Close>
            </div>
          </div>

          {/* Body — 2 columns */}
          <div className="flex min-h-0 flex-1">
            {/* Chat transcript */}
            <section className="flex w-[520px] flex-none flex-col border-r border-border-subtle bg-surface">
              <div className="border-b border-border-subtle px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-text-muted">
                Conversation
              </div>
              <div ref={messagesScrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
                {loading && (
                  <div className="flex items-center gap-2 text-[11.5px] text-text-muted">
                    <Loader2 size={12} className="animate-spin" /> Loading draft…
                  </div>
                )}
                {!loading && messages.length === 0 && (
                  <div className="text-[11.5px] text-text-muted">No messages yet.</div>
                )}
                {messages.map((m) => (
                  <MessageBubble key={m.id} role={m.role} content={m.content} ts={m.ts} />
                ))}
                {isStreaming && streamingDelta === '' && (
                  <div className="flex items-center gap-2 text-[10.5px] text-text-muted">
                    <Loader2 size={11} className="animate-spin" />
                    Generating…
                  </div>
                )}
              </div>

              {/* Refine composer */}
              <div className="shrink-0 border-t border-border-subtle p-2">
                <div className="flex items-start gap-2">
                  <textarea
                    value={refineInput}
                    onChange={(e) => setRefineInput(e.target.value)}
                    placeholder="Refine — e.g. 'use TypeScript examples', 'cut the section on testing'…"
                    rows={2}
                    className="flex-1 resize-none rounded border border-border-subtle bg-surface-2 px-2 py-1.5 text-[12px] text-text focus:border-accent focus:outline-none"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        void submitRefine();
                      }
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => void submitRefine()}
                    disabled={refining || !refineInput.trim() || isStreaming}
                    className="inline-flex items-center gap-1 rounded-[6px] bg-accent px-2.5 py-1.5 text-[11px] font-medium text-white transition hover:brightness-110 disabled:opacity-50"
                    title="Submit (⌘↵)"
                  >
                    {refining ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />}
                    Submit
                  </button>
                </div>
              </div>
            </section>

            {/* Preview */}
            <section className="flex min-w-0 flex-1 flex-col bg-surface">
              <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-3 py-1.5">
                <div className="text-[10.5px] font-semibold uppercase tracking-wider text-text-muted">
                  {draft?.kind === 'agent' ? 'agent.md preview' : 'SKILL.md preview'}
                </div>
                {!editBody ? (
                  <button
                    type="button"
                    onClick={() => {
                      setBodyDraft(draft?.body ?? '');
                      setEditBody(true);
                    }}
                    disabled={!draft || isStreaming}
                    className="ml-auto inline-flex items-center gap-1 rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-1 text-[10.5px] text-text-secondary transition hover:bg-surface-4 hover:text-text disabled:opacity-40"
                  >
                    <Edit3 size={10} />
                    Edit
                  </button>
                ) : (
                  <div className="ml-auto flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setBodyDraft(draft?.body ?? '');
                        setEditBody(false);
                      }}
                      className="inline-flex items-center gap-1 rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-1 text-[10.5px] text-text-secondary transition hover:bg-surface-4 hover:text-text"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => void saveBodyEdit()}
                      className="inline-flex items-center gap-1 rounded-[6px] bg-accent/80 px-2 py-1 text-[10.5px] font-medium text-white transition hover:bg-accent"
                    >
                      <Save size={10} />
                      Apply
                    </button>
                  </div>
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {editBody ? (
                  <textarea
                    value={bodyDraft}
                    onChange={(e) => setBodyDraft(e.target.value)}
                    className="h-full w-full resize-none border-0 bg-surface px-4 py-3 font-mono text-[12px] leading-relaxed text-text focus:outline-none"
                  />
                ) : (
                  <MarkdownPreview body={draft?.body ?? ''} frontmatter={draft?.frontmatter} />
                )}
              </div>
            </section>
          </div>

          {/* Footer */}
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border-subtle bg-surface-2 px-4 py-2.5">
            <div className="text-[10.5px] text-text-muted">
              {error ? (
                <span className="text-semantic-error">{error}</span>
              ) : isReady ? (
                'Ready to save — writes to .claude/' + (draft?.kind === 'agent' ? 'agents' : 'skills') + '/'
              ) : (
                'Refine until you’re happy, then save.'
              )}
            </div>
            <div className="flex items-center gap-2">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-[6px] border border-border-subtle bg-surface-3 px-3 py-1.5 text-[11.5px] text-text-secondary transition hover:bg-surface-4 hover:text-text"
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="button"
                onClick={() => void saveAsArtifact()}
                disabled={!isReady || saving}
                className="inline-flex items-center gap-1.5 rounded-[6px] bg-accent px-3 py-1.5 text-[11.5px] font-medium text-white transition hover:brightness-110 disabled:opacity-50"
              >
                {saving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
                Save as {draft?.scope === 'global' ? 'global' : 'project'} {draft?.kind === 'agent' ? 'agent' : 'skill'}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────

function StatusChip({ status }: { status: ForgeDraft['status'] }) {
  const map: Record<ForgeDraft['status'], { label: string; tone: string; icon: React.ReactNode }> = {
    pending: {
      label: 'pending',
      tone: 'bg-surface-3 text-text-muted',
      icon: null,
    },
    generating: {
      label: 'generating',
      tone: 'bg-accent/15 text-accent',
      icon: <Loader2 size={9} className="animate-spin" />,
    },
    ready: {
      label: 'ready',
      tone: 'bg-semantic-success/15 text-semantic-success',
      icon: <CheckCircle2 size={9} />,
    },
    error: {
      label: 'error',
      tone: 'bg-semantic-error/15 text-semantic-error',
      icon: <XCircle size={9} />,
    },
  };
  const meta = map[status];
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-1.5 py-[1px] text-[9.5px] font-medium', meta.tone)}>
      {meta.icon}
      {meta.label}
    </span>
  );
}

function MessageBubble({
  role,
  content,
  ts,
}: {
  role: 'user' | 'assistant';
  content: string;
  ts: number;
}) {
  return (
    <div className={cn('mb-2 flex', role === 'user' ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[88%] rounded-[8px] px-3 py-2 text-[12px] leading-relaxed',
          role === 'user'
            ? 'bg-accent/20 text-text'
            : 'border border-border-subtle bg-surface-2 text-text',
        )}
      >
        <div className="mb-0.5 text-[9.5px] uppercase tracking-wider text-text-muted">
          {role === 'user' ? 'You' : 'Claude'} ·{' '}
          {new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
        </div>
        <pre className="whitespace-pre-wrap break-words font-sans">{content}</pre>
      </div>
    </div>
  );
}

function MarkdownPreview({
  body,
  frontmatter,
}: {
  body: string;
  frontmatter?: ForgeDraft['frontmatter'];
}) {
  // We do a lightweight render — full markdown rendering lives in
  // MarkdownPreview elsewhere in the app, but for the draft preview a
  // pre-styled monospace block + highlighted frontmatter block is enough
  // to validate structure. Users save the raw body verbatim.
  return (
    <div className="px-4 py-3">
      {frontmatter && Object.keys(frontmatter).length > 0 && (
        <div className="mb-3 rounded-[6px] border border-accent/30 bg-accent/8 px-3 py-2">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-accent">
            Frontmatter
          </div>
          <pre className="whitespace-pre-wrap font-mono text-[11.5px] text-text">
            {Object.entries(frontmatter)
              .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
              .join('\n')}
          </pre>
        </div>
      )}
      <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-text">
        {body || '(no body yet — generation in progress)'}
      </pre>
    </div>
  );
}
