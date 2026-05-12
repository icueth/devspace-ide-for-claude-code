import * as Select from '@radix-ui/react-select';
import {
  AlertCircle,
  Check,
  ChevronDown,
  CircleDot,
  Loader2,
  Paintbrush,
  Sparkles,
  X,
} from 'lucide-react';
import { useMemo } from 'react';

import { cn } from '@renderer/lib/utils';
import type {
  DesignScope,
  DesignScreenStatus,
  DesignSkill,
  DesignSystem,
} from '@shared/design';

export interface DesignToolbarProps {
  skills: DesignSkill[];
  systems: DesignSystem[];
  selectedSkillSlug: string | null;
  selectedSystemSlug: string | null;
  brief: string;
  busy: boolean;
  /**
   * Status of the *currently selected screen*, when one exists. Drives
   * the badge on the right edge. `null` is rendered as a quiet "idle"
   * state.
   */
  status: DesignScreenStatus | null;
  errorMessage?: string | null;
  /**
   * Disabled when there are no skills, no project, or generation is in
   * flight. Parent decides — toolbar only renders.
   */
  canGenerate: boolean;
  onSkillChange: (slug: string) => void;
  onSystemChange: (slug: string | null) => void;
  onBriefChange: (brief: string) => void;
  onGenerate: () => void;
  onCancel: () => void;
}

/**
 * Top bar of the Design pane. Two pickers + the brief + a single
 * Generate / Cancel action. Status of the active screen lives on the
 * right edge so users always see whether the iframe is showing fresh
 * output or stale output from before an error.
 */
export function DesignToolbar({
  skills,
  systems,
  selectedSkillSlug,
  selectedSystemSlug,
  brief,
  busy,
  status,
  errorMessage,
  canGenerate,
  onSkillChange,
  onSystemChange,
  onBriefChange,
  onGenerate,
  onCancel,
}: DesignToolbarProps) {
  const skillGroups = useMemo(() => groupByScope(skills), [skills]);
  const systemGroups = useMemo(() => groupByScope(systems), [systems]);

  const selectedSkillLabel =
    skills.find((s) => s.slug === selectedSkillSlug)?.name ??
    (skills.length === 0 ? 'No skills found' : 'Pick a skill…');
  const selectedSystemLabel =
    systems.find((s) => s.slug === selectedSystemSlug)?.name ?? 'No design system';

  const submitOnEnter = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !busy && canGenerate) {
      e.preventDefault();
      onGenerate();
    }
  };

  return (
    <div
      className="flex shrink-0 flex-col gap-2 border-b border-border px-3 py-2.5"
      style={{
        background:
          'linear-gradient(180deg, var(--color-surface-2) 0%, var(--color-surface) 100%)',
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <PickerLabel icon={<Paintbrush size={11} />} label="Skill" />
        <PickerSelect
          value={selectedSkillSlug ?? ''}
          onValueChange={(v) => onSkillChange(v)}
          placeholder={selectedSkillLabel}
          disabled={skills.length === 0 || busy}
          ariaLabel="Design skill"
          empty={skills.length === 0}
        >
          {(['project', 'global', 'builtin'] as DesignScope[]).map((scope) =>
            skillGroups[scope].length > 0 ? (
              <Select.Group key={scope}>
                <Select.Label className="px-2 py-1 text-[9.5px] font-semibold uppercase tracking-wide text-text-muted">
                  {scopeLabel(scope)}
                </Select.Label>
                {skillGroups[scope].map((s) => (
                  <SelectItem key={s.slug} value={s.slug} label={s.name}>
                    {s.description && (
                      <span className="ml-1 truncate text-[10px] text-text-dim">
                        — {s.description}
                      </span>
                    )}
                  </SelectItem>
                ))}
              </Select.Group>
            ) : null,
          )}
        </PickerSelect>

        <PickerLabel icon={<Sparkles size={11} />} label="System" />
        <PickerSelect
          value={selectedSystemSlug ?? ''}
          onValueChange={(v) => onSystemChange(v === '' ? null : v)}
          placeholder={selectedSystemLabel}
          disabled={busy}
          ariaLabel="Design system"
          empty={false}
        >
          <SelectItem value="" label="No design system" />
          {(['project', 'global', 'builtin'] as DesignScope[]).map((scope) =>
            systemGroups[scope].length > 0 ? (
              <Select.Group key={scope}>
                <Select.Label className="px-2 py-1 text-[9.5px] font-semibold uppercase tracking-wide text-text-muted">
                  {scopeLabel(scope)}
                </Select.Label>
                {systemGroups[scope].map((s) => (
                  <SelectItem key={s.slug} value={s.slug} label={s.name}>
                    {s.brand && (
                      <span className="ml-1 text-[10px] text-text-dim">
                        ({s.brand})
                      </span>
                    )}
                  </SelectItem>
                ))}
              </Select.Group>
            ) : null,
          )}
        </PickerSelect>

        <div className="flex-1" />
        <StatusBadge status={status} errorMessage={errorMessage ?? null} />
      </div>

      <div className="flex items-start gap-2">
        <textarea
          value={brief}
          onChange={(e) => onBriefChange(e.target.value)}
          onKeyDown={submitOnEnter}
          rows={2}
          disabled={busy}
          placeholder="Describe the screen you want to generate. Use ⌘↵ to submit."
          className="min-h-[44px] flex-1 resize-none rounded-[7px] border border-border-subtle bg-surface-3 px-3 py-2 text-[12px] text-text placeholder:text-text-dim focus:border-accent focus:outline-none disabled:opacity-60"
        />
        {busy ? (
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex h-[44px] shrink-0 items-center gap-1.5 rounded-[7px] border border-semantic-error/40 bg-surface-3 px-3 text-[11.5px] font-medium text-semantic-error transition hover:bg-[rgba(239,68,68,0.12)]"
          >
            <X size={12} />
            Cancel
          </button>
        ) : (
          <button
            type="button"
            onClick={onGenerate}
            disabled={!canGenerate}
            className={cn(
              'inline-flex h-[44px] shrink-0 items-center gap-1.5 rounded-[7px] px-4 text-[11.5px] font-medium transition',
              !canGenerate
                ? 'pointer-events-none border border-border bg-surface-3 text-text-muted opacity-60'
                : 'text-white hover:brightness-110',
            )}
            style={
              !canGenerate
                ? undefined
                : {
                    background:
                      'linear-gradient(135deg, var(--color-accent), var(--color-accent-3))',
                    boxShadow: '0 2px 8px rgba(76,141,255,0.25)',
                  }
            }
            title="Generate (⌘↵)"
          >
            <Sparkles size={12} />
            Generate
          </button>
        )}
      </div>
    </div>
  );
}

function PickerLabel({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-wide text-text-muted">
      {icon}
      {label}
    </span>
  );
}

interface PickerSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  placeholder: string;
  disabled?: boolean;
  ariaLabel: string;
  empty: boolean;
  children: React.ReactNode;
}

function PickerSelect({
  value,
  onValueChange,
  placeholder,
  disabled,
  ariaLabel,
  empty,
  children,
}: PickerSelectProps) {
  return (
    <Select.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <Select.Trigger
        aria-label={ariaLabel}
        className={cn(
          'inline-flex h-[26px] min-w-[140px] items-center gap-1.5 rounded-[6px] border px-2 text-[11px] transition focus:outline-none',
          disabled
            ? 'cursor-not-allowed border-border-subtle bg-surface-3 text-text-muted opacity-60'
            : 'border-border-subtle bg-surface-3 text-text hover:border-border-hi',
        )}
      >
        <Select.Value placeholder={placeholder} />
        <Select.Icon asChild>
          <ChevronDown size={11} className="text-text-muted" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          className="z-50 max-h-[320px] min-w-[var(--radix-select-trigger-width)] overflow-y-auto rounded-[7px] border border-border bg-surface-2 py-1 text-[11px] shadow-[0_8px_24px_rgba(0,0,0,0.35)]"
        >
          <Select.Viewport>
            {empty ? (
              <div className="px-3 py-2 text-text-muted">No options available.</div>
            ) : (
              children
            )}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

interface SelectItemProps {
  value: string;
  label: string;
  children?: React.ReactNode;
}

function SelectItem({ value, label, children }: SelectItemProps) {
  return (
    <Select.Item
      value={value}
      className="relative flex cursor-pointer items-center gap-1 rounded-[5px] px-2 py-1.5 pl-6 text-[11px] text-text-secondary outline-none transition data-[highlighted]:bg-[rgba(76,141,255,0.16)] data-[highlighted]:text-text data-[state=checked]:text-text"
    >
      <Select.ItemIndicator className="absolute left-1.5 top-1/2 -translate-y-1/2 text-accent">
        <Check size={10} />
      </Select.ItemIndicator>
      <Select.ItemText>
        <span className="font-mono">{label}</span>
      </Select.ItemText>
      {children}
    </Select.Item>
  );
}

function groupByScope<T extends { scope: DesignScope }>(items: T[]): Record<DesignScope, T[]> {
  const groups: Record<DesignScope, T[]> = { project: [], global: [], builtin: [] };
  for (const item of items) groups[item.scope].push(item);
  return groups;
}

function scopeLabel(scope: DesignScope): string {
  if (scope === 'project') return 'Project';
  if (scope === 'global') return 'Global';
  return 'Built-in';
}

interface StatusBadgeProps {
  status: DesignScreenStatus | null;
  errorMessage: string | null;
}

function StatusBadge({ status, errorMessage }: StatusBadgeProps) {
  if (!status) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-surface-3 px-2 py-[2px] text-[10px] text-text-muted">
        <CircleDot size={9} />
        idle
      </span>
    );
  }
  if (status === 'generating') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[rgba(76,141,255,0.18)] px-2 py-[2px] text-[10px] text-accent">
        <Loader2 size={9} className="animate-spin" />
        generating
      </span>
    );
  }
  if (status === 'ready') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[rgba(34,197,94,0.18)] px-2 py-[2px] text-[10px] text-semantic-success">
        <Check size={9} />
        ready
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span
        title={errorMessage ?? undefined}
        className="inline-flex max-w-[200px] items-center gap-1 truncate rounded-full bg-[rgba(239,68,68,0.18)] px-2 py-[2px] text-[10px] text-semantic-error"
      >
        <AlertCircle size={9} />
        error
      </span>
    );
  }
  // pending
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-surface-3 px-2 py-[2px] text-[10px] text-text-muted">
      <CircleDot size={9} />
      pending
    </span>
  );
}
