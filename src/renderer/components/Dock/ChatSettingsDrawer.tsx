import * as Popover from '@radix-ui/react-popover';
import { Cog, RotateCcw, Save } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import type { ChatConfig, ChatThread } from '@shared/types';

interface ChatSettingsDrawerProps {
  projectPath: string;
  thread: ChatThread | null;
  // Fired after a successful save so the parent can re-fetch the thread
  // (when a thread override changed) — the popover stays open.
  onThreadConfigChanged?: (thread: ChatThread) => void;
  // Optional controlled-mode props. When omitted the drawer manages its
  // own open state via the trigger button. When both are provided the
  // parent owns the state — used by the chat slash palette so typing
  // `/settings` programmatically pops the drawer.
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

// Claude built-in tools surfaced as checkboxes. Order roughly by how
// commonly users want to gate them. MCP tools aren't included — they
// have dynamic names and live behind a separate config (P4: MCP tab).
const TOOL_OPTIONS = [
  { id: 'Read', label: 'Read', desc: 'Read file contents' },
  { id: 'Edit', label: 'Edit', desc: 'Modify files in place' },
  { id: 'Write', label: 'Write', desc: 'Create or overwrite files' },
  { id: 'Bash', label: 'Bash', desc: 'Run shell commands' },
  { id: 'Glob', label: 'Glob', desc: 'Find files by pattern' },
  { id: 'Grep', label: 'Grep', desc: 'Search file contents' },
  { id: 'WebFetch', label: 'WebFetch', desc: 'Fetch URLs' },
  { id: 'WebSearch', label: 'WebSearch', desc: 'Search the web' },
  { id: 'Task', label: 'Task', desc: 'Dispatch sub-agents' },
  { id: 'TodoWrite', label: 'TodoWrite', desc: 'Manage todo list' },
  { id: 'NotebookEdit', label: 'NotebookEdit', desc: 'Edit Jupyter notebooks' },
];

// Common Claude model aliases. The CLI accepts the short alias OR a
// fully-qualified id — we surface aliases as ergonomic chips and let
// the user type a full id when needed.
const MODEL_PRESETS = [
  { id: '', label: 'Default', hint: '(use claude.json setting)' },
  { id: 'sonnet', label: 'Sonnet', hint: 'fast, balanced' },
  { id: 'opus', label: 'Opus', hint: 'deepest reasoning' },
  { id: 'haiku', label: 'Haiku', hint: 'fastest, cheapest' },
];

type Scope = 'project' | 'thread';

export function ChatSettingsDrawer({
  projectPath,
  thread,
  onThreadConfigChanged,
  open: controlledOpen,
  onOpenChange,
}: ChatSettingsDrawerProps) {
  // Hybrid controlled/uncontrolled. When the parent passes both `open`
  // and `onOpenChange`, we route through them; otherwise we keep local
  // state for the trigger-button workflow.
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined && onOpenChange !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = isControlled ? onOpenChange : setInternalOpen;
  // Two-level scope: 'project' edits the per-folder default that every
  // new thread inherits; 'thread' edits an override pinned to just this
  // thread. The popover loads both whenever it opens.
  const [scope, setScope] = useState<Scope>('project');
  const [projectCfg, setProjectCfg] = useState<ChatConfig>({});
  const [threadCfg, setThreadCfg] = useState<ChatConfig | null>(null);
  const [saving, setSaving] = useState(false);

  const cfg = scope === 'project' ? projectCfg : (threadCfg ?? {});

  // Load both layers on open. Keeping them in separate state lets the
  // user flip scopes without losing edits to the other.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const p = await api.chat.getConfig(projectPath);
      if (cancelled) return;
      setProjectCfg(p ?? {});
      setThreadCfg(thread?.config ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, projectPath, thread]);

  const updateCfg = useCallback(
    (patch: Partial<ChatConfig>) => {
      if (scope === 'project') {
        setProjectCfg((prev) => ({ ...prev, ...patch }));
      } else {
        setThreadCfg((prev) => ({ ...(prev ?? {}), ...patch }));
      }
    },
    [scope],
  );

  const toggleTool = useCallback(
    (toolId: string) => {
      const current = cfg.allowedTools ?? [];
      const next = current.includes(toolId)
        ? current.filter((t) => t !== toolId)
        : [...current, toolId];
      // Empty array vs undefined matters: undefined = all tools (claude
      // default), [] = no tools allowed (locked-down read-only chat).
      // Collapsing back to undefined when the user un-checks everything
      // is more useful than the hostile "all tools blocked" state.
      updateCfg({ allowedTools: next.length === 0 ? undefined : next });
    },
    [cfg.allowedTools, updateCfg],
  );

  const allowAll = useCallback(() => {
    updateCfg({ allowedTools: undefined });
  }, [updateCfg]);

  const onSave = useCallback(async () => {
    setSaving(true);
    try {
      if (scope === 'project') {
        const saved = await api.chat.setConfig(projectPath, projectCfg);
        setProjectCfg(saved);
      } else if (thread) {
        // Empty-object override is meaningless — treat it as "clear".
        const hasAnyField =
          threadCfg !== null &&
          (threadCfg.model !== undefined ||
            (threadCfg.systemPromptAppend?.trim() ?? '') !== '' ||
            threadCfg.allowedTools !== undefined ||
            threadCfg.disallowedTools !== undefined ||
            (threadCfg.extraArgs?.length ?? 0) > 0);
        const next = await api.chat.updateThreadConfig(
          projectPath,
          thread.id,
          hasAnyField ? threadCfg : null,
        );
        onThreadConfigChanged?.(next);
      }
    } finally {
      setSaving(false);
    }
  }, [scope, projectPath, projectCfg, thread, threadCfg, onThreadConfigChanged]);

  const onReset = useCallback(() => {
    if (scope === 'project') {
      setProjectCfg({});
    } else {
      setThreadCfg(null);
    }
  }, [scope]);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          title="Chat settings — model, system prompt, tools"
          className={cn(
            'rounded p-1.5 text-text-muted transition hover:bg-surface-3 hover:text-text',
            open && 'bg-surface-3 text-text',
          )}
        >
          <Cog size={13} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-50 w-[380px] rounded-[10px] border border-border bg-surface-2 p-3 shadow-2xl outline-none"
        >
          <div className="mb-2 flex items-center gap-1">
            <ScopeTab
              active={scope === 'project'}
              onClick={() => setScope('project')}
            >
              Project default
            </ScopeTab>
            <ScopeTab
              active={scope === 'thread'}
              onClick={() => setScope('thread')}
              disabled={!thread}
            >
              This thread
            </ScopeTab>
            <div className="flex-1" />
            <button
              onClick={onReset}
              title="Reset to empty"
              className="rounded p-1 text-text-muted transition hover:bg-surface-3 hover:text-text"
            >
              <RotateCcw size={11} />
            </button>
          </div>

          <div className="space-y-3">
            <Field
              label="Model"
              hint={
                scope === 'thread'
                  ? 'Override only for this thread'
                  : 'Default for new threads in this project'
              }
            >
              <div className="flex flex-wrap gap-1.5">
                {MODEL_PRESETS.map((m) => (
                  <button
                    key={m.id || 'default'}
                    onClick={() => updateCfg({ model: m.id || undefined })}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-[6px] border px-2 py-1 text-[11px] transition',
                      (cfg.model ?? '') === m.id
                        ? 'border-accent bg-accent/10 text-text'
                        : 'border-border-subtle bg-surface-3 text-text-secondary hover:border-border-hi hover:text-text',
                    )}
                  >
                    <span className="font-medium">{m.label}</span>
                    <span className="text-[10px] text-text-dim">{m.hint}</span>
                  </button>
                ))}
              </div>
              <input
                type="text"
                placeholder="or full model id (e.g. claude-sonnet-4-5)"
                value={cfg.model ?? ''}
                onChange={(e) =>
                  updateCfg({ model: e.target.value || undefined })
                }
                className="mt-1.5 w-full rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-1.5 font-mono text-[11px] text-text placeholder:text-text-dim focus:border-accent focus:outline-none"
              />
            </Field>

            <Field
              label="Append system prompt"
              hint="Added on top of Claude's built-in system prompt"
            >
              <textarea
                value={cfg.systemPromptAppend ?? ''}
                onChange={(e) =>
                  updateCfg({
                    systemPromptAppend: e.target.value || undefined,
                  })
                }
                rows={3}
                placeholder="e.g. Always run typecheck after edits. Prefer concise responses."
                className="w-full resize-none rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-1.5 text-[11.5px] text-text placeholder:text-text-dim focus:border-accent focus:outline-none"
              />
            </Field>

            <Field
              label="Allowed tools"
              hint={
                cfg.allowedTools === undefined
                  ? 'All tools allowed (default)'
                  : `Only ${cfg.allowedTools.length} tool(s) allowed`
              }
              action={
                cfg.allowedTools !== undefined ? (
                  <button
                    onClick={allowAll}
                    className="text-[10px] text-accent hover:underline"
                  >
                    allow all
                  </button>
                ) : null
              }
            >
              <div className="grid grid-cols-2 gap-1">
                {TOOL_OPTIONS.map((t) => {
                  const allowedList = cfg.allowedTools;
                  // When allowedList is undefined every tool is allowed —
                  // render checkbox as checked so the user sees the
                  // baseline rather than an all-empty grid.
                  const checked = !allowedList || allowedList.includes(t.id);
                  return (
                    <label
                      key={t.id}
                      title={t.desc}
                      className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-surface-3"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleTool(t.id)}
                        className="h-3 w-3 accent-accent"
                      />
                      <span className="font-mono text-[11px] text-text-secondary">
                        {t.label}
                      </span>
                    </label>
                  );
                })}
              </div>
            </Field>
          </div>

          <div className="mt-3 flex items-center justify-between border-t border-border-subtle pt-2.5">
            <div className="text-[10px] text-text-dim">
              {scope === 'project' ? (
                <>Saved to <span className="font-mono">.devspace/chat-config.json</span></>
              ) : (
                <>Pinned to thread JSON</>
              )}
            </div>
            <button
              onClick={() => void onSave()}
              disabled={saving || (scope === 'thread' && !thread)}
              className="inline-flex items-center gap-1.5 rounded-[6px] px-2.5 py-1 text-[11px] font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
              style={{
                background:
                  'linear-gradient(135deg, var(--color-accent), #a855f7)',
              }}
            >
              <Save size={10} />
              <span>{saving ? 'Saving…' : 'Save'}</span>
            </button>
          </div>

          <Popover.Arrow className="fill-surface-2" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ScopeTab({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'rounded-[6px] px-2 py-1 text-[11px] transition',
        active
          ? 'bg-surface-4 text-text'
          : 'text-text-secondary hover:bg-surface-3 hover:text-text',
        disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent',
      )}
    >
      {children}
    </button>
  );
}

function Field({
  label,
  hint,
  action,
  children,
}: {
  label: string;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <div className="text-[11px] font-medium text-text">
          {label}
          {hint && (
            <span className="ml-1.5 text-[10px] font-normal text-text-dim">
              {hint}
            </span>
          )}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}
