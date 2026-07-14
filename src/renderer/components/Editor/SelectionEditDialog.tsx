import * as Dialog from '@radix-ui/react-dialog';
import { Check, Loader2, Sparkles, X } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';

const DiffView = lazy(() =>
  import('@renderer/components/Editor/DiffView').then((m) => ({ default: m.DiffView })),
);

export interface SelectionEditRequest {
  selection: string;
  context: string;
  filename: string;
  startLine: number;
  endLine: number;
}

interface Props {
  open: boolean;
  request: SelectionEditRequest | null;
  onCancel: () => void;
  onAccept: (newText: string) => void;
}

/**
 * Cursor-style ⌘K dialog. The editor opens this with the user's current
 * selection (plus the file context for style hints). The user types an
 * instruction, sees a diff preview of the LLM's proposed replacement,
 * and accepts (Enter) or rejects (Esc).
 */
export function SelectionEditDialog({ open, request, onCancel, onAccept }: Props) {
  const [instruction, setInstruction] = useState('');
  const [running, setRunning] = useState(false);
  const [proposed, setProposed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Reset state on every open so the dialog doesn't show a stale
  // proposal from a previous selection.
  useEffect(() => {
    if (!open) return;
    setInstruction('');
    setProposed(null);
    setError(null);
    setLatencyMs(null);
    setRunning(false);
    // Microtask focus — Radix's mount cycle is one frame, so a sync
    // focus call gets stolen by the dialog's own auto-focus logic.
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const submit = useCallback(async () => {
    if (!request || !instruction.trim() || running) return;
    setRunning(true);
    setError(null);
    setProposed(null);
    try {
      const res = await api.llm.edit({
        selection: request.selection,
        instruction: instruction.trim(),
        context: request.context,
        filename: request.filename,
        startLine: request.startLine,
        endLine: request.endLine,
      });
      setLatencyMs(res.latencyMs);
      if (res.error) {
        setError(res.error);
      } else if (!res.text) {
        setError('Model returned an empty response.');
      } else {
        setProposed(res.text);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }, [request, instruction, running]);

  const accept = useCallback(() => {
    if (proposed) onAccept(proposed);
  }, [proposed, onAccept]);

  // Keymap inside the textarea — Enter submits unless Shift is held
  // (multi-line instructions still possible). When a proposal is on
  // screen, Enter accepts.
  const onTextareaKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (proposed) accept();
        else void submit();
      }
    },
    [proposed, accept, submit],
  );

  // Esc anywhere in the dialog cancels.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-[760px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-surface-raised shadow-2xl',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          )}
        >
          <div className="flex shrink-0 items-center justify-between border-b border-border-subtle px-5 py-3">
            <div className="flex items-center gap-2">
              <Sparkles size={14} className="text-accent" />
              <Dialog.Title className="text-[13px] font-semibold text-text">
                Edit selection with AI
              </Dialog.Title>
              {request && (
                <span className="text-[10.5px] text-text-muted">
                  {request.filename.split('/').pop()} · lines {request.startLine}–{request.endLine}
                </span>
              )}
            </div>
            <Dialog.Close className="rounded p-1 text-text-muted transition hover:bg-surface-3 hover:text-text">
              <X size={13} />
            </Dialog.Close>
          </div>

          <div className="shrink-0 border-b border-border-subtle px-5 py-3">
            <textarea
              ref={inputRef}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={onTextareaKeyDown}
              placeholder="Tell the model how to rewrite this — e.g. ‘convert to async/await’, ‘extract a helper’, ‘add error handling’"
              rows={2}
              className="w-full resize-none rounded-[7px] border border-border-subtle bg-surface-3 px-3 py-2 text-[12.5px] text-text placeholder:text-text-dim focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40"
            />
            <div className="mt-1.5 flex items-center justify-between text-[10.5px] text-text-dim">
              <span>
                <kbd className="rounded bg-surface-3 px-1">Enter</kbd> to{' '}
                {proposed ? 'accept' : 'submit'},{' '}
                <kbd className="rounded bg-surface-3 px-1">Shift+Enter</kbd> for
                newline,{' '}
                <kbd className="rounded bg-surface-3 px-1">Esc</kbd> to cancel
              </span>
              {latencyMs !== null && (
                <span className="font-mono text-text-muted">
                  {latencyMs}ms
                </span>
              )}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-hidden">
            {error ? (
              <div className="px-5 py-4 text-[12px] text-semantic-error">
                <div className="font-semibold">Couldn't get a proposal</div>
                <pre className="mt-1 whitespace-pre-wrap font-mono text-[10.5px] text-text-muted">
                  {error}
                </pre>
              </div>
            ) : proposed && request ? (
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center text-[12px] text-text-muted">
                    Loading diff…
                  </div>
                }
              >
                <DiffView
                  fileName={request.filename}
                  oldContent={request.selection}
                  newContent={proposed}
                />
              </Suspense>
            ) : running ? (
              <div className="flex h-full items-center justify-center gap-2 text-[12px] text-text-muted">
                <Loader2 size={13} className="animate-spin" />
                <span>Asking the model…</span>
              </div>
            ) : (
              <div className="flex h-full items-center justify-center px-8 text-center">
                <div className="max-w-[480px] text-[11.5px] text-text-muted">
                  Type an instruction above and press{' '}
                  <kbd className="rounded bg-surface-3 px-1">Enter</kbd>. The
                  model receives your selection plus the surrounding file as
                  style context, and returns a drop-in replacement. Configure
                  the endpoint in <strong className="text-text-secondary">Settings → LLM</strong>.
                </div>
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center justify-end gap-1.5 border-t border-border-subtle px-5 py-3">
            <button
              onClick={onCancel}
              className="inline-flex h-[28px] items-center gap-1.5 rounded-[7px] border border-border-subtle bg-surface-3 px-3 text-[11.5px] text-text-secondary transition hover:border-border-hi hover:bg-surface-4 hover:text-text"
            >
              <span>Cancel</span>
            </button>
            {proposed ? (
              <button
                onClick={accept}
                className="inline-flex h-[28px] items-center gap-1.5 rounded-[7px] px-3 text-[11.5px] font-medium text-white transition hover:brightness-110"
                style={{
                  background:
                    'var(--color-accent-3)',
                  boxShadow: '0 2px 8px var(--color-accent-glow)',
                }}
              >
                <Check size={11.5} strokeWidth={2.2} />
                <span>Accept replacement</span>
              </button>
            ) : (
              <button
                onClick={() => void submit()}
                disabled={!instruction.trim() || running}
                className="inline-flex h-[28px] items-center gap-1.5 rounded-[7px] px-3 text-[11.5px] font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                style={{
                  background:
                    'var(--color-accent-3)',
                  boxShadow: '0 2px 8px var(--color-accent-glow)',
                }}
              >
                {running ? (
                  <Loader2 size={11.5} className="animate-spin" />
                ) : (
                  <Sparkles size={11.5} strokeWidth={2.2} />
                )}
                <span>{running ? 'Working…' : 'Generate'}</span>
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
