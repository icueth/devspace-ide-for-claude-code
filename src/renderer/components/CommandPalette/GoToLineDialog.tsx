import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState } from 'react';

import { useEditorStore } from '@renderer/state/editor';

interface GoToLineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function parseTarget(v: string): { line: number; column?: number } | null {
  const m = v.trim().match(/^(\d+)(?:[:,](\d+))?$/);
  if (!m) return null;
  const line = parseInt(m[1], 10);
  if (!Number.isFinite(line) || line < 1) return null;
  const col = m[2] ? Math.max(1, parseInt(m[2], 10)) : undefined;
  return { line, column: col != null ? col - 1 : undefined };
}

export function GoToLineDialog({ open, onOpenChange }: GoToLineDialogProps) {
  const [value, setValue] = useState('');
  const openFile = useEditorStore((s) => s.open);
  const activeTabPath = useEditorStore((s) => s.activeTabPath);

  useEffect(() => {
    if (open) setValue('');
  }, [open]);

  const target = parseTarget(value);

  const submit = () => {
    if (!target || !activeTabPath) return;
    void openFile(activeTabPath, target);
    onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="fixed left-1/2 top-24 z-50 w-[min(420px,80vw)] -translate-x-1/2 overflow-hidden rounded-lg border border-border-emphasis bg-surface-raised shadow-2xl"
        >
          <Dialog.Title className="sr-only">Go to line</Dialog.Title>
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            placeholder="Line (e.g. 42 or 42:10)"
            className="w-full bg-transparent px-4 py-3 text-[13px] text-text placeholder:text-text-muted focus:outline-none"
          />
          <div className="flex items-center justify-between border-t border-border-subtle bg-surface-sidebar px-3 py-1.5 text-[10px] text-text-muted">
            <span>
              {target
                ? `Line ${target.line}${target.column != null ? `, col ${target.column + 1}` : ''}`
                : activeTabPath
                  ? 'Enter line number'
                  : 'Open a file first'}
            </span>
            <span>↵ go · esc close</span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
