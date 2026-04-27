import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, GitBranch, Loader2, Plus, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import { usePromptStore } from '@renderer/state/prompt';
import type { GitBranchInfo } from '@shared/types';

interface BranchPickerProps {
  projectPath: string;
  currentBranch: string | null;
  onChanged: () => void;
}

export function BranchPicker({
  projectPath,
  currentBranch,
  onChanged,
}: BranchPickerProps) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const askPrompt = usePromptStore((s) => s.ask);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setError(null);
    setLoading(true);
    api.git
      .branches(projectPath)
      .then((r) => setBranches(r.branches))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [open, projectPath]);

  const { locals, remotes } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (b: GitBranchInfo) => !q || b.name.toLowerCase().includes(q);
    return {
      locals: branches.filter((b) => !b.remote && match(b)),
      remotes: branches.filter((b) => b.remote && match(b) && !b.name.endsWith('/HEAD')),
    };
  }, [branches, query]);

  const checkout = async (name: string) => {
    setLoading(true);
    setError(null);
    try {
      const target = name.startsWith('origin/') ? name.slice('origin/'.length) : name;
      await api.git.checkout(projectPath, target);
      setOpen(false);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const createNew = () => {
    setOpen(false);
    askPrompt({
      title: 'New branch',
      placeholder: 'feature/my-thing',
      confirmLabel: 'Create & checkout',
      onConfirm: async (name) => {
        try {
          await api.git.createBranch(projectPath, name);
          onChanged();
        } catch (err) {
          setError((err as Error).message);
        }
      },
    });
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button className="flex items-center gap-1 rounded px-1.5 py-0.5 text-text hover:bg-surface-raised">
          <GitBranch size={12} className="text-text-muted" />
          <span className="font-medium">{currentBranch ?? 'detached'}</span>
          <ChevronDown size={10} className="text-text-muted" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="z-50 w-[320px] overflow-hidden rounded-md border border-border-emphasis bg-surface-raised shadow-lg animate-in fade-in-0 zoom-in-95"
        >
          <div className="relative border-b border-border-subtle px-3 py-2">
            <Search
              size={11}
              className="pointer-events-none absolute left-5 top-1/2 -translate-y-1/2 text-text-muted"
            />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find or switch branch…"
              className="h-7 w-full rounded border border-border bg-surface pl-7 pr-2 text-[12px] text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
          </div>

          <button
            onClick={createNew}
            className="flex w-full items-center gap-2 border-b border-border-subtle px-3 py-1.5 text-left text-[12px] hover:bg-surface-overlay"
          >
            <Plus size={11} className="text-accent" />
            <span>Create new branch…</span>
          </button>

          <div className="max-h-[320px] overflow-y-auto">
            {loading && (
              <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-text-muted">
                <Loader2 size={11} className="animate-spin" /> Loading…
              </div>
            )}
            {error && (
              <div className="px-3 py-2 text-[11px] text-semantic-error">{error}</div>
            )}

            {locals.length > 0 && (
              <Section label={`Local (${locals.length})`}>
                {locals.map((b) => (
                  <BranchRow
                    key={b.name}
                    branch={b}
                    active={b.current}
                    onClick={() => checkout(b.name)}
                  />
                ))}
              </Section>
            )}

            {remotes.length > 0 && (
              <Section label={`Remote (${remotes.length})`}>
                {remotes.map((b) => (
                  <BranchRow
                    key={b.name}
                    branch={b}
                    active={false}
                    onClick={() => checkout(b.name)}
                  />
                ))}
              </Section>
            )}

            {!loading && locals.length === 0 && remotes.length === 0 && !error && (
              <div className="px-3 py-2 text-[11px] text-text-muted">No branches.</div>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

interface SectionProps {
  label: string;
  children: React.ReactNode;
}

function Section({ label, children }: SectionProps) {
  return (
    <div>
      <div className="sticky top-0 z-10 bg-surface-sidebar px-3 py-1 text-[10px] uppercase tracking-wide text-text-muted">
        {label}
      </div>
      {children}
    </div>
  );
}

interface BranchRowProps {
  branch: GitBranchInfo;
  active: boolean;
  onClick: () => void;
}

function BranchRow({ branch, active, onClick }: BranchRowProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition',
        active
          ? 'bg-surface-overlay text-text'
          : 'text-text-secondary hover:bg-surface-raised hover:text-text',
      )}
    >
      <span className="w-3 shrink-0">
        {active && <Check size={11} className="text-accent" />}
      </span>
      <span className="flex-1 truncate font-mono">{branch.name}</span>
      {branch.commit && (
        <span className="shrink-0 font-mono text-[10px] text-text-muted">
          {branch.commit.slice(0, 7)}
        </span>
      )}
    </button>
  );
}
