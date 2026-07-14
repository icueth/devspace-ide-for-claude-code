import {
  Bot,
  CheckSquare2,
  Files,
  GitBranch,
  Settings,
  Terminal,
  Workflow,
} from 'lucide-react';

import { cn } from '@renderer/lib/utils';

export type WorkbenchDestination =
  | 'workspace'
  | 'tasks'
  | 'sessions'
  | 'codeflow'
  | 'git'
  | 'settings';

interface Props {
  active: WorkbenchDestination;
  hasProject: boolean;
  hasSessions: boolean;
  onNavigate: (destination: WorkbenchDestination) => void;
}

const destinations = [
  { id: 'workspace', label: 'Workspace', icon: Files },
  { id: 'tasks', label: 'Tasks', icon: CheckSquare2 },
  { id: 'sessions', label: 'CLI sessions', icon: Terminal },
  { id: 'codeflow', label: 'Codeflow', icon: Workflow },
  { id: 'git', label: 'Git changes', icon: GitBranch },
] as const;

export function WorkbenchRail({
  active,
  hasProject,
  hasSessions,
  onNavigate,
}: Props) {
  return (
    <nav
      aria-label="Workbench"
      className="no-drag flex w-12 shrink-0 flex-col items-center gap-1.5 border-r border-border bg-[var(--color-surface-rail)] px-1.5 py-2"
    >
      <div
        className="mb-1 flex h-8 w-8 items-center justify-center rounded-[7px] border border-accent/30 bg-accent/10 text-accent"
        title="DevSpace workbench"
      >
        <Bot size={15} />
      </div>

      {destinations.map(({ id, label, icon: Icon }) => {
        const disabled =
          (id === 'codeflow' || id === 'git') && !hasProject
            ? true
            : id === 'sessions' && !hasSessions;
        return (
          <button
            key={id}
            type="button"
            disabled={disabled}
            onClick={() => onNavigate(id)}
            title={label}
            aria-label={label}
            aria-current={active === id ? 'page' : undefined}
            className={cn(
              'relative flex h-8 w-8 items-center justify-center rounded-[7px] border transition',
              active === id
                ? 'border-accent/30 bg-accent/10 text-accent'
                : 'border-transparent text-text-muted hover:border-border hover:bg-surface-3 hover:text-text',
              disabled && 'cursor-not-allowed opacity-30',
            )}
          >
            {active === id && (
              <span className="absolute -left-[7px] h-4 w-0.5 rounded-r bg-accent" />
            )}
            <Icon size={14} />
          </button>
        );
      })}

      <div className="flex-1" />
      <button
        type="button"
        onClick={() => onNavigate('settings')}
        title="Settings"
        aria-label="Settings"
        aria-current={active === 'settings' ? 'page' : undefined}
        className={cn(
          'relative flex h-8 w-8 items-center justify-center rounded-[7px] border transition',
          active === 'settings'
            ? 'border-accent/30 bg-accent/10 text-accent'
            : 'border-transparent text-text-muted hover:border-border hover:bg-surface-3 hover:text-text',
        )}
      >
        {active === 'settings' && (
          <span className="absolute -left-[7px] h-4 w-0.5 rounded-r bg-accent" />
        )}
        <Settings size={14} />
      </button>
    </nav>
  );
}
