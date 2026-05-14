import { Pin, Save, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import type {
  MemoryEntry,
  MemoryInboxItem,
  MemoryScope,
  MemoryType,
} from '@shared/types';

// Slug validator — matches the on-disk filename constraint described in
// shared/types.ts ("kebab-case, ASCII, ≤ 80 chars"). Anchored so partial
// matches don't leak through.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

const TYPE_OPTIONS: Array<{ value: MemoryType; label: string; hint: string }> = [
  { value: 'user', label: 'User', hint: 'A fact or preference about the user' },
  {
    value: 'feedback',
    label: 'Feedback',
    hint: 'A correction or improvement note from the user',
  },
  { value: 'project', label: 'Project', hint: 'A project-specific decision or constraint' },
  { value: 'reference', label: 'Reference', hint: 'A reusable snippet or example' },
];

export interface EntryEditorProps {
  // The entry being edited. When `null`, the editor is in create mode and
  // `initialScope` / `initialProjectHash` drive where the new entry lands.
  entry: MemoryEntry | null;
  // Required when creating a new entry — the scope determines the on-disk
  // path the backend writes to. Ignored for updates (scope is immutable).
  initialScope?: MemoryScope;
  // Project abspath when `initialScope === 'project'`. Backend hashes the
  // path internally; we pass the path so we don't depend on the renderer
  // having access to the SHA-1.
  initialProjectPath?: string;
  // Default type when creating. Falls back to 'project' if unset.
  initialType?: MemoryType;
  // Optional auto-capture suggestion that should pre-fill the form. When
  // present, the save handler routes through `resolveInbox` so the
  // backend cleans up the inbox row atomically with the create.
  prefill?: MemoryInboxItem;
  onClose: () => void;
  // Called after a successful save/delete so the parent can re-fetch.
  onSaved?: (entry: MemoryEntry) => void;
  onDeleted?: (id: string) => void;
}

export function EntryEditor({
  entry,
  initialScope = 'project',
  initialProjectPath,
  initialType = 'project',
  prefill,
  onClose,
  onSaved,
  onDeleted,
}: EntryEditorProps) {
  const isCreate = entry === null;

  const [type, setType] = useState<MemoryType>(
    entry?.type ?? prefill?.suggestedType ?? initialType,
  );
  const [slug, setSlug] = useState(entry?.slug ?? prefill?.suggestedSlug ?? '');
  const [description, setDescription] = useState(
    entry?.description ?? prefill?.suggestedDescription ?? '',
  );
  const [body, setBody] = useState(entry?.body ?? prefill?.body ?? '');
  const [tagsInput, setTagsInput] = useState(entry?.tags.join(', ') ?? '');
  const [pinned, setPinned] = useState(entry?.pinned ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // For existing entries we lazy-load the body once on mount — the list
  // only carries `preview`, not the full markdown, so we have to round-
  // trip through `api.memory.getEntry` to populate the textarea.
  useEffect(() => {
    if (!entry || entry.body !== undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const full = await api.memory.getEntry(entry.id);
        if (cancelled || !full) return;
        setBody(full.body ?? '');
      } catch (err) {
        console.error('[entry-editor] getEntry failed', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entry]);

  // Esc to close — modeled on Design Studio's drawer behavior.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving && !confirmDelete) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving, confirmDelete]);

  // Normalized tag chips for live preview + payload. We strip empties and
  // collapse whitespace so users can paste comma-separated lists.
  const tags = useMemo(
    () =>
      tagsInput
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0),
    [tagsInput],
  );

  const slugValid = isCreate ? SLUG_RE.test(slug) : true;
  const descriptionValid = description.trim().length > 0;
  const canSave =
    !saving && descriptionValid && (isCreate ? slugValid : true);

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      let saved: MemoryEntry;
      if (entry) {
        // Update path. Note that slug/type/scope are immutable on the
        // backend — only description/body/tags can change.
        saved = await api.memory.updateEntry({
          id: entry.id,
          description: description.trim(),
          body,
          tags,
        });
        // Pinned is a separate toggle endpoint, so apply it after if the
        // user flipped it during this edit session.
        if (saved.pinned !== pinned) {
          saved = await api.memory.togglePin(saved.id);
        }
      } else if (prefill) {
        // Accept-inbox path. resolveInbox atomically promotes the
        // suggestion to a real entry and removes it from the inbox —
        // strictly better than create+dismiss because there's no
        // moment the user sees both.
        saved = await api.memory.resolveInbox({
          inboxId: prefill.id,
          type,
          slug: slug.trim() || undefined,
          description: description.trim(),
          body,
        });
        if (pinned) {
          saved = await api.memory.togglePin(saved.id);
        }
      } else {
        saved = await api.memory.createEntry({
          scope: initialScope,
          projectPath:
            initialScope === 'project' ? initialProjectPath : undefined,
          type,
          slug: slug.trim() || undefined,
          description: description.trim(),
          body,
          tags,
        });
        if (pinned) {
          saved = await api.memory.togglePin(saved.id);
        }
      }
      onSaved?.(saved);
      onClose();
    } catch (err) {
      setError((err as Error).message ?? 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!entry) return;
    setSaving(true);
    try {
      await api.memory.deleteEntry(entry.id);
      onDeleted?.(entry.id);
      onClose();
    } catch (err) {
      setError((err as Error).message ?? 'Delete failed.');
      setSaving(false);
      setConfirmDelete(false);
    }
  };

  return (
    <div
      className="fixed inset-y-0 right-0 z-50 flex w-[520px] max-w-[90vw] flex-col border-l border-border bg-surface shadow-[0_0_40px_rgba(0,0,0,0.5)]"
      role="dialog"
      aria-label={isCreate ? 'Create memory entry' : 'Edit memory entry'}
    >
      <header className="flex shrink-0 items-center justify-between border-b border-border-subtle px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-[13px] font-semibold text-text">
            {isCreate ? 'New memory entry' : 'Edit entry'}
          </h2>
          {entry && (
            <span className="font-mono text-[10px] text-text-dim">
              {entry.scope}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex h-6 w-6 items-center justify-center rounded-[5px] text-text-muted transition hover:bg-surface-3 hover:text-text"
          title="Close (Esc)"
          aria-label="Close"
        >
          <X size={12} />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        {/* Type — radio group (immutable on edit) */}
        <Field label="Type">
          <div className="flex flex-wrap gap-1.5">
            {TYPE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => isCreate && setType(opt.value)}
                disabled={!isCreate}
                title={opt.hint}
                className={cn(
                  'rounded-[6px] border px-2.5 py-1 text-[11px] transition',
                  type === opt.value
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-border-subtle bg-surface-2 text-text-secondary hover:border-border-hi hover:text-text',
                  !isCreate && 'cursor-not-allowed opacity-60',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </Field>

        {/* Slug — only editable at create time */}
        <Field
          label="Slug"
          hint={
            isCreate
              ? 'kebab-case, lowercase ASCII, ≤ 80 chars (auto-generated if blank)'
              : 'immutable after creation'
          }
        >
          <input
            type="text"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            placeholder="my-decision"
            disabled={!isCreate}
            className={cn(
              'w-full rounded-[6px] border bg-surface-2 px-2.5 py-1.5 text-[12px] text-text outline-none transition',
              !isCreate && 'cursor-not-allowed opacity-60',
              isCreate && slug && !slugValid
                ? 'border-semantic-error focus:border-semantic-error'
                : 'border-border-subtle focus:border-accent',
            )}
          />
          {isCreate && slug && !slugValid && (
            <p className="mt-1 text-[10.5px] text-semantic-error">
              Slug must be lowercase ASCII, kebab-case, ≤ 80 chars.
            </p>
          )}
        </Field>

        <Field label="Description" hint="One-line summary shown in lists">
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this entry is about"
            className="w-full rounded-[6px] border border-border-subtle bg-surface-2 px-2.5 py-1.5 text-[12px] text-text outline-none transition focus:border-accent"
          />
        </Field>

        <Field label="Tags" hint="Comma-separated, lowercased automatically">
          <input
            type="text"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            placeholder="decision, sidebar, ux"
            className="w-full rounded-[6px] border border-border-subtle bg-surface-2 px-2.5 py-1.5 text-[12px] text-text outline-none transition focus:border-accent"
          />
          {tags.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full border border-border-subtle bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-text-secondary"
                >
                  #{tag}
                </span>
              ))}
            </div>
          )}
        </Field>

        <Field label="Body" hint="Markdown supported (rendered on display)">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={14}
            placeholder="Write the memory body here…"
            className="w-full resize-y rounded-[6px] border border-border-subtle bg-surface-2 px-2.5 py-2 font-mono text-[12px] leading-relaxed text-text outline-none transition focus:border-accent"
          />
        </Field>

        <label className="flex cursor-pointer items-center gap-2 text-[12px] text-text-secondary">
          <input
            type="checkbox"
            checked={pinned}
            onChange={(e) => setPinned(e.target.checked)}
            className="h-3.5 w-3.5 cursor-pointer accent-accent"
          />
          <Pin size={11} className={pinned ? 'text-accent' : 'text-text-muted'} />
          <span>Pin to top of project</span>
        </label>

        {error && (
          <div className="rounded-[6px] border border-semantic-error/30 bg-semantic-error/10 px-2.5 py-1.5 text-[11px] text-semantic-error">
            {error}
          </div>
        )}
      </div>

      <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border-subtle bg-surface-2 px-4 py-2.5">
        {entry ? (
          confirmDelete ? (
            <div className="flex items-center gap-2 text-[11px] text-semantic-error">
              <span>Delete this entry?</span>
              <button
                type="button"
                onClick={handleDelete}
                disabled={saving}
                className="rounded-[5px] border border-semantic-error/30 bg-semantic-error/10 px-2 py-1 text-[11px] font-medium text-semantic-error hover:bg-semantic-error/20"
              >
                Yes, delete
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                disabled={saving}
                className="rounded-[5px] border border-border-subtle bg-surface-3 px-2 py-1 text-[11px] text-text-secondary hover:text-text"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-[6px] border border-border-subtle bg-surface-3 px-2.5 py-1.5 text-[11px] text-text-secondary transition hover:border-semantic-error/40 hover:text-semantic-error"
            >
              <Trash2 size={11} />
              Delete
            </button>
          )
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-[6px] border border-border-subtle bg-surface-3 px-3 py-1.5 text-[11px] text-text-secondary transition hover:bg-surface-4 hover:text-text"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-[6px] border px-3 py-1.5 text-[11px] font-medium transition',
              canSave
                ? 'border-accent bg-accent text-white hover:brightness-110'
                : 'cursor-not-allowed border-border-subtle bg-surface-3 text-text-muted opacity-60',
            )}
          >
            <Save size={11} />
            {saving ? 'Saving…' : isCreate ? 'Create' : 'Save'}
          </button>
        </div>
      </footer>
    </div>
  );
}

interface FieldProps {
  label: string;
  hint?: string;
  children: React.ReactNode;
}

function Field({ label, hint, children }: FieldProps) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <label className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
          {label}
        </label>
        {hint && <span className="text-[10px] text-text-dim">{hint}</span>}
      </div>
      {children}
    </div>
  );
}
