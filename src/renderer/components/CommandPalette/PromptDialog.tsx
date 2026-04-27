import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState } from 'react';

export interface PromptRequest {
  title: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
  onConfirm: (value: string) => void;
}

interface PromptDialogProps {
  request: PromptRequest | null;
  onClose: () => void;
}

export function PromptDialog({ request, onClose }: PromptDialogProps) {
  const [value, setValue] = useState('');
  const open = !!request;
  const ref = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (request) {
      setValue(request.initialValue ?? '');
      // Select the stem (before the last `.`) so the user can retype the name.
      queueMicrotask(() => {
        const input = ref.current;
        if (!input) return;
        const v = request.initialValue ?? '';
        const dot = v.lastIndexOf('.');
        if (dot > 0) input.setSelectionRange(0, dot);
        else input.select();
      });
    }
  }, [request]);

  const submit = () => {
    if (!request) return;
    const v = value.trim();
    if (!v) return;
    request.onConfirm(v);
    onClose();
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-24 z-50 w-[min(480px,85vw)] -translate-x-1/2 overflow-hidden rounded-lg border border-border-emphasis bg-surface-raised shadow-2xl">
          <Dialog.Title className="border-b border-border-subtle bg-surface-sidebar px-4 py-2 text-[12px] font-medium text-text">
            {request?.title}
          </Dialog.Title>
          <div className="p-3">
            <input
              ref={ref}
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
              placeholder={request?.placeholder}
              className="w-full rounded border border-border bg-surface px-2 py-1.5 text-[13px] text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
          </div>
          <div className="flex justify-end gap-2 border-t border-border-subtle bg-surface-sidebar px-3 py-2 text-[11px]">
            <button
              onClick={onClose}
              className="rounded px-2 py-1 text-text-secondary hover:bg-surface-overlay hover:text-text"
            >
              Cancel
            </button>
            <button
              onClick={submit}
              className="rounded bg-accent px-3 py-1 text-white hover:opacity-90"
            >
              {request?.confirmLabel ?? 'OK'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
