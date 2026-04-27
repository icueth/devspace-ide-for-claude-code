import { ChevronDown, Terminal as TerminalIcon, GitBranch, Search } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';

import { GitStatusPanel } from '@renderer/components/Bottom/GitStatusPanel';
import { cn } from '@renderer/lib/utils';
import { useLayoutStore } from '@renderer/state/layout';

// Lazy-load heavy tabs so the boot path stays lean. Each tab stays mounted
// after its first activation to preserve its own state (terminal scrollback,
// search results, etc.).
const SearchPanel = lazy(() =>
  import('@renderer/components/Bottom/SearchPanel').then((m) => ({ default: m.SearchPanel })),
);
const TerminalPane = lazy(() =>
  import('@renderer/components/Bottom/TerminalPane').then((m) => ({ default: m.TerminalPane })),
);

interface BottomPanelProps {
  projectId: string;
  projectPath: string;
  initialTab?: Tab;
}

type Tab = 'terminal' | 'git' | 'search';

export function BottomPanel({ projectId, projectPath, initialTab }: BottomPanelProps) {
  const [active, setActive] = useState<Tab>(initialTab ?? 'terminal');
  const setBottomOpen = useLayoutStore((s) => s.setBottomOpen);
  const [mountedTabs, setMountedTabs] = useState<Set<Tab>>(
    () => new Set<Tab>([initialTab ?? 'terminal']),
  );

  useEffect(() => {
    if (initialTab) {
      setActive(initialTab);
      setMountedTabs((prev) => (prev.has(initialTab) ? prev : new Set(prev).add(initialTab)));
    }
  }, [initialTab]);

  const activate = (tab: Tab) => {
    setActive(tab);
    setMountedTabs((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)));
  };

  return (
    <div className="flex h-full flex-col">
      <div
        className="flex h-9 shrink-0 items-center justify-between border-b border-border px-1"
        style={{ background: 'var(--color-surface-2)' }}
      >
        <div className="flex items-stretch">
          <TabButton
            active={active === 'terminal'}
            onClick={() => activate('terminal')}
            icon={<TerminalIcon size={12} />}
            label="Terminal"
          />
          <TabButton
            active={active === 'git'}
            onClick={() => activate('git')}
            icon={<GitBranch size={12} />}
            label="Git"
          />
          <TabButton
            active={active === 'search'}
            onClick={() => activate('search')}
            icon={<Search size={12} />}
            label="Search"
          />
        </div>
        <button
          onClick={() => setBottomOpen(false)}
          className="flex h-6 w-6 items-center justify-center rounded hover:bg-surface-raised"
          title="Close panel"
        >
          <ChevronDown size={13} />
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        {mountedTabs.has('terminal') && (
          <div
            style={{
              visibility: active === 'terminal' ? 'visible' : 'hidden',
              pointerEvents: active === 'terminal' ? 'auto' : 'none',
              zIndex: active === 'terminal' ? 1 : 0,
            }}
            className="absolute inset-0"
          >
            <Suspense fallback={null}>
              <TerminalPane
                projectId={projectId}
                projectPath={projectPath}
                isActive={active === 'terminal'}
              />
            </Suspense>
          </div>
        )}
        {mountedTabs.has('git') && (
          <div
            style={{
              visibility: active === 'git' ? 'visible' : 'hidden',
              pointerEvents: active === 'git' ? 'auto' : 'none',
              zIndex: active === 'git' ? 1 : 0,
            }}
            className="absolute inset-0"
          >
            <GitStatusPanel projectId={projectId} projectPath={projectPath} />
          </div>
        )}
        {mountedTabs.has('search') && (
          <div
            style={{
              visibility: active === 'search' ? 'visible' : 'hidden',
              pointerEvents: active === 'search' ? 'auto' : 'none',
              zIndex: active === 'search' ? 1 : 0,
            }}
            className="absolute inset-0"
          >
            <Suspense fallback={null}>
              <SearchPanel projectPath={projectPath} isActive={active === 'search'} />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  );
}

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}

function TabButton({ active, onClick, icon, label }: TabButtonProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'relative flex items-center gap-1.5 px-3.5 text-[11.5px] transition',
        active ? 'text-text' : 'text-text-muted hover:text-text-secondary',
      )}
    >
      {active && (
        <span
          className="absolute inset-x-2 bottom-0 h-[2px] rounded-t-sm"
          style={{ background: 'linear-gradient(90deg, var(--color-accent), #a855f7)' }}
        />
      )}
      <span className={active ? 'text-accent-2' : 'text-text-muted'}>{icon}</span>
      <span>{label}</span>
    </button>
  );
}
