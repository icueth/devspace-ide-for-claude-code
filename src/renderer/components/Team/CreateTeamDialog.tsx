import * as Dialog from '@radix-ui/react-dialog';
import { Minus, Plus, Users } from 'lucide-react';
import { useEffect, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string | null;
}

const ROLES: { id: string; label: string; color: string }[] = [
  { id: 'architect', label: 'Architect', color: '#a855f7' },
  { id: 'backend engineer', label: 'Backend', color: '#3b82f6' },
  { id: 'frontend engineer', label: 'Frontend', color: '#06b6d4' },
  { id: 'API gateway specialist', label: 'API / Gateway', color: '#0ea5e9' },
  { id: 'database engineer', label: 'Database', color: '#14b8a6' },
  { id: 'security auditor', label: 'Security', color: '#ef4444' },
  { id: 'performance engineer', label: 'Performance', color: '#f59e0b' },
  { id: 'test engineer', label: 'Testing / QA', color: '#22c55e' },
  { id: 'code reviewer', label: 'Code review', color: '#84cc16' },
  { id: 'devops engineer', label: 'DevOps', color: '#d97706' },
  { id: 'data engineer', label: 'Data', color: '#10b981' },
  { id: 'docs writer', label: 'Docs', color: '#a3a3a3' },
  { id: 'ux / design', label: 'UX / Design', color: '#ec4899' },
  { id: 'devil’s advocate', label: "Devil's advocate", color: '#fb7185' },
];

export function CreateTeamDialog({ open, onOpenChange, projectId }: Props) {
  const [task, setTask] = useState('');
  const [count, setCount] = useState(3);
  const [roles, setRoles] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setTask('');
      setCount(3);
      setRoles(new Set());
      setPreview(false);
      setBusy(false);
    }
  }, [open]);

  // Auto-sync count with the number of selected roles when the user is
  // picking from presets — but don't lock them: they can still bump count
  // up or down to ask Claude for duplicates or open slots.
  useEffect(() => {
    if (roles.size > 0 && roles.size > count) setCount(roles.size);
  }, [roles, count]);

  const toggleRole = (id: string) => {
    setRoles((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const rolesList = Array.from(roles);
  const canSubmit = !busy && !!projectId && task.trim().length > 2;

  const prompt = buildPrompt(task.trim(), count, rolesList);

  const submit = async () => {
    if (!canSubmit || !projectId) return;
    setBusy(true);
    try {
      const sessionId = `${projectId}:claude-cli`;
      // Send the multi-line prompt plus a newline so the CLI submits it.
      await api.pty.write(sessionId, `${prompt}\n`);
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/55 backdrop-blur-[3px]" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[71] w-[620px] max-w-[92vw] max-h-[92vh] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-xl border border-border-emphasis bg-surface-raised p-5 shadow-[0_20px_60px_rgba(0,0,0,0.5)] outline-none"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <Dialog.Title className="flex items-center gap-2 text-[15px] font-semibold text-text">
            <Users size={14} className="text-accent" />
            Create Claude agent team
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-[12px] leading-relaxed text-text-muted">
            Builds a prompt and sends it to the active project's Claude CLI. Claude Code spawns
            teammates via <code className="rounded bg-surface-overlay px-1">tmux</code> and
            handles the rest.
          </Dialog.Description>

          {!projectId && (
            <div className="mt-4 rounded border border-semantic-warning/40 bg-semantic-warning/10 px-3 py-2 text-[11.5px] text-semantic-warning">
              Open a project first — the team needs a leader CLI to talk to.
            </div>
          )}

          <label className="mb-1 mt-5 block text-[10px] font-semibold uppercase tracking-wider text-text-muted">
            ให้ทำอะไร
          </label>
          <textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            rows={4}
            placeholder={
              'e.g. review PR #142 for security, performance, and test coverage\n' +
              'หรือ: refactor src/auth/ ให้ modular ขึ้น'
            }
            className="w-full rounded border border-border-emphasis bg-surface px-2.5 py-1.5 text-[13px] text-text outline-none focus:border-accent"
          />

          <div className="mt-5 grid grid-cols-[auto_1fr] items-center gap-4">
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                จำนวนคน
              </label>
              <div className="inline-flex items-center rounded border border-border-emphasis bg-surface">
                <button
                  onClick={() => setCount((c) => Math.max(1, c - 1))}
                  className="flex h-8 w-8 items-center justify-center text-text-muted hover:bg-surface-overlay hover:text-text"
                  aria-label="decrease"
                >
                  <Minus size={12} />
                </button>
                <span className="min-w-[36px] px-2 text-center font-mono text-[14px] text-text">
                  {count}
                </span>
                <button
                  onClick={() => setCount((c) => Math.min(12, c + 1))}
                  className="flex h-8 w-8 items-center justify-center text-text-muted hover:bg-surface-overlay hover:text-text"
                  aria-label="increase"
                >
                  <Plus size={12} />
                </button>
              </div>
            </div>
            <div className="text-[11px] text-text-muted">
              {roles.size > 0
                ? `${roles.size} role${roles.size === 1 ? '' : 's'} selected · Claude picks the rest if count > roles`
                : 'Claude picks roles automatically unless you tick below'}
            </div>
          </div>

          <label className="mb-2 mt-5 block text-[10px] font-semibold uppercase tracking-wider text-text-muted">
            ตำแหน่ง
          </label>
          <div className="flex flex-wrap gap-1.5">
            {ROLES.map((r) => {
              const on = roles.has(r.id);
              return (
                <button
                  key={r.id}
                  onClick={() => toggleRole(r.id)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] transition',
                    on
                      ? 'border-transparent text-surface'
                      : 'border-border-emphasis bg-surface text-text-secondary hover:border-accent hover:text-text',
                  )}
                  style={on ? { background: r.color } : undefined}
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{
                      background: on ? 'rgba(0,0,0,0.45)' : r.color,
                    }}
                  />
                  {r.label}
                </button>
              );
            })}
          </div>

          <div className="mt-5 rounded border border-border-subtle bg-surface">
            <button
              onClick={() => setPreview((v) => !v)}
              className="flex w-full items-center justify-between px-3 py-2 text-[11px] text-text-muted hover:bg-surface-overlay"
            >
              <span>Prompt preview</span>
              <span>{preview ? 'hide' : 'show'}</span>
            </button>
            {preview && (
              <pre className="border-t border-border-subtle px-3 py-2 font-mono text-[11px] leading-relaxed text-text-secondary whitespace-pre-wrap">
                {prompt}
              </pre>
            )}
          </div>

          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button className="rounded px-3 py-1.5 text-[12px] text-text-muted hover:bg-surface-overlay hover:text-text">
                Cancel
              </button>
            </Dialog.Close>
            <button
              onClick={() => void submit()}
              disabled={!canSubmit}
              className="flex items-center gap-1.5 rounded bg-accent px-4 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Users size={12} />
              {busy ? 'Sending…' : 'Send to CLI'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function buildPrompt(task: string, count: number, roles: string[]): string {
  // Claude Code handles display mode automatically (picks tmux when the
  // session runs inside one). Explicit instructions like "Use tmux split-
  // pane mode" make Claude attempt manual tmux setup instead of the native
  // Agent tool, so keep the prompt clean and declarative.
  if (roles.length === 0) {
    return (
      `Create an agent team to ${task || '<describe the task>'}. ` +
      `Spawn ${count} teammates; you decide the roles based on the task.`
    );
  }
  const rolePart =
    roles.length === 1
      ? `a ${roles[0]}`
      : `${roles.slice(0, -1).join(', ')} and ${roles[roles.length - 1]}`;
  const countClause =
    count > roles.length
      ? `Spawn ${count} teammates including ${rolePart}; add extra teammates as needed.`
      : count < roles.length
        ? `Spawn ${count} teammates covering ${rolePart}.`
        : `Spawn ${count} teammates: ${rolePart}.`;
  return `Create an agent team to ${task || '<describe the task>'}. ${countClause}`;
}
