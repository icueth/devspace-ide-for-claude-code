import * as Dialog from '@radix-ui/react-dialog';
import { File as FileIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import { useEditorStore } from '@renderer/state/editor';
import { getFileIcon } from '@renderer/utils/fileIcons';

interface QuickOpenDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectPath: string | null;
}

interface Candidate {
  relPath: string;
  fileName: string;
  score: number;
}

/**
 * Score a filename + path against a lowercase query. Higher is better.
 * 0 means no match.
 */
function scoreMatch(rel: string, name: string, q: string): number {
  if (!q) return 1;
  const relLower = rel.toLowerCase();
  const nameLower = name.toLowerCase();
  if (nameLower === q) return 1000;
  if (nameLower.startsWith(q)) return 600 - nameLower.length;
  const nameIdx = nameLower.indexOf(q);
  if (nameIdx >= 0) return 400 - nameIdx - nameLower.length;
  const relIdx = relLower.indexOf(q);
  if (relIdx >= 0) return 200 - relIdx - relLower.length;
  // Fuzzy fallback: every char must appear in order.
  let i = 0;
  for (let c = 0; c < relLower.length && i < q.length; c++) {
    if (relLower[c] === q[i]) i++;
  }
  if (i === q.length) return 50 - relLower.length;
  return 0;
}

function basename(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(idx + 1) : p;
}

export function QuickOpenDialog({ open, onOpenChange, projectPath }: QuickOpenDialogProps) {
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  const openFile = useEditorStore((s) => s.open);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelected(0);
    if (!projectPath) return;
    void api.fs.listFiles(projectPath).then(setFiles).catch(() => setFiles([]));
  }, [open, projectPath]);

  const candidates = useMemo<Candidate[]>(() => {
    const q = query.trim().toLowerCase();
    const scored = files
      .map((rel): Candidate => {
        const name = basename(rel);
        return { relPath: rel, fileName: name, score: scoreMatch(rel, name, q) };
      })
      .filter((c) => c.score > 0);
    scored.sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath));
    return scored.slice(0, 100);
  }, [query, files]);

  const activate = useCallback(
    (idx: number) => {
      const c = candidates[idx];
      if (!c || !projectPath) return;
      void openFile(`${projectPath}/${c.relPath}`);
      onOpenChange(false);
    },
    [candidates, projectPath, openFile, onOpenChange],
  );

  const onKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelected((i) => Math.min(candidates.length - 1, i + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        activate(selected);
      }
    },
    [candidates.length, selected, activate],
  );

  // Keep selected row in view.
  useEffect(() => {
    const host = listRef.current;
    if (!host) return;
    const el = host.querySelector<HTMLElement>(`[data-idx="${selected}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected, candidates]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[1px]" />
        <Dialog.Content
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="fixed left-1/2 top-24 z-50 w-[min(640px,90vw)] -translate-x-1/2 overflow-hidden rounded-lg border border-border-emphasis bg-surface-raised shadow-2xl"
        >
          <Dialog.Title className="sr-only">Quick open</Dialog.Title>
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            onKeyDown={onKey}
            placeholder={projectPath ? 'Search files by name…' : 'Open a project first'}
            className="w-full bg-transparent px-4 py-3 text-[13px] text-text placeholder:text-text-muted focus:outline-none"
          />
          <div className="border-t border-border-subtle" />
          <div ref={listRef} className="max-h-[60vh] overflow-y-auto py-1">
            {candidates.length === 0 ? (
              <div className="px-4 py-3 text-[12px] text-text-muted">No matches.</div>
            ) : (
              candidates.map((c, i) => {
                const spec = getFileIcon(c.fileName);
                const Icon = spec.Icon;
                const dir = c.relPath.slice(0, c.relPath.length - c.fileName.length - 1);
                return (
                  <button
                    key={c.relPath}
                    data-idx={i}
                    onMouseEnter={() => setSelected(i)}
                    onClick={() => activate(i)}
                    className={cn(
                      'flex w-full items-center gap-2 px-4 py-1.5 text-left text-[12px]',
                      i === selected
                        ? 'bg-surface-overlay text-text'
                        : 'text-text-secondary hover:bg-surface-raised',
                    )}
                  >
                    <Icon size={12} className="shrink-0" style={{ color: spec.color }} />
                    <span className="truncate font-medium">{c.fileName}</span>
                    {dir && <span className="truncate text-[11px] text-text-muted">{dir}</span>}
                  </button>
                );
              })
            )}
          </div>
          <div className="flex items-center gap-3 border-t border-border-subtle bg-surface-sidebar px-3 py-1.5 text-[10px] text-text-muted">
            <span>↑↓ navigate</span>
            <span>↵ open</span>
            <span>esc close</span>
            <span className="ml-auto">
              {candidates.length} of {files.length} files
            </span>
          </div>
          <FileIcon className="sr-only" aria-hidden />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
