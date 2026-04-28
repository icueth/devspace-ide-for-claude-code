import { Server, Settings as SettingsIcon } from 'lucide-react';
import { useState } from 'react';

import { TmuxConfigForm } from '@renderer/components/Settings/TmuxConfigForm';
import { TmuxSettings } from '@renderer/components/Settings/TmuxSettings';
import { cn } from '@renderer/lib/utils';

type SubTab = 'sessions' | 'config';

/**
 * Two-tab wrapper for the tmux settings page. Sessions = live tmux state
 * (list/kill/rename). Config = persisted preferences that drive how the
 * main process spawns tmux for Claude CLI / Shell sessions.
 */
export function TmuxSection() {
  const [tab, setTab] = useState<SubTab>('sessions');

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface-2/40 px-4 py-2">
        <SubTabButton
          active={tab === 'sessions'}
          onClick={() => setTab('sessions')}
          icon={<Server size={11} />}
          label="Sessions"
        />
        <SubTabButton
          active={tab === 'config'}
          onClick={() => setTab('config')}
          icon={<SettingsIcon size={11} />}
          label="Config"
        />
      </div>
      <div className="min-h-0 flex-1">
        {tab === 'sessions' ? <TmuxSettings /> : <TmuxConfigForm />}
      </div>
    </div>
  );
}

interface SubTabButtonProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}

function SubTabButton({ active, onClick, icon, label }: SubTabButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-[24px] items-center gap-1 rounded-[5px] border px-2.5 text-[11px] transition',
        active
          ? 'border-accent/40 bg-[rgba(76,141,255,0.12)] text-text'
          : 'border-border bg-surface-3 text-text-muted hover:border-border-hi hover:text-text',
      )}
    >
      {icon}
      {label}
    </button>
  );
}
