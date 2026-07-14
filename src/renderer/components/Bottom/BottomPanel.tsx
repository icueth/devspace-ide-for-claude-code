import { ChevronDown, Terminal as TerminalIcon, GitBranch, Search } from 'lucide-react';
import { lazy, memo, Suspense, useEffect, useMemo, useState } from 'react';

import { GitStatusPanel } from '@renderer/components/Bottom/GitStatusPanel';
import { cn } from '@renderer/lib/utils';
import { useRenderTrace } from '@renderer/lib/renderTrace';
import { useLayoutStore } from '@renderer/state/layout';
import { useShellTabsStore } from '@renderer/state/shellTabs';

// Lazy-load heavy tabs so the boot path stays lean. Each tab stays mounted
// after its first activation to preserve its own state (terminal scrollback,
// search results, etc.).
const SearchPanel = lazy(() =>
  import('@renderer/components/Bottom/SearchPanel').then((m) => ({ default: m.SearchPanel })),
);
const TerminalPane = lazy(() =>
  import('@renderer/components/Bottom/TerminalPane').then((m) => ({ default: m.TerminalPane })),
);
const TerminalTabs = lazy(() =>
  import('@renderer/components/Bottom/TerminalTabs').then((m) => ({ default: m.TerminalTabs })),
);

interface BottomPanelProps {
  projectId: string;
  projectPath: string;
  tabRequest?: { tab: BottomPanelTab; requestId: number };
  onActiveTabChange?: (tab: BottomPanelTab) => void;
  onClose?: () => void;
  // When false the entire panel is hidden (display:none) — used by App.tsx
  // to keep one BottomPanel per docked project mounted at all times so dev
  // servers stay visually live across project switches without the buffer
  // replay flicker.
  //
  // v0.38 trade-off: hidden panels no longer pre-mount their terminal —
  // with 8 docked projects that was 8 xterms + 8 live zsh PTYs for panels
  // never looked at. The first view of a never-viewed panel now pays a
  // one-time PTY spawn (or rolling-buffer replay for a PTY a dev server is
  // already running in — the `${projectId}:shell:default` key reattaches).
  // Once viewed, a panel stays mounted, so the no-flicker property above
  // still holds for everything the user actually uses.
  isVisible?: boolean;
}

export type BottomPanelTab = 'terminal' | 'git' | 'search';

export const BottomPanel = memo(function BottomPanel({
  projectId,
  projectPath,
  tabRequest,
  onActiveTabChange,
  onClose,
  isVisible = true,
}: BottomPanelProps) {
  useRenderTrace('BottomPanel');
  const [active, setActive] = useState<BottomPanelTab>(tabRequest?.tab ?? 'terminal');
  const setBottomOpen = useLayoutStore((s) => s.setBottomOpen);
  const [mountedTabs, setMountedTabs] = useState<Set<BottomPanelTab>>(
    () => new Set<BottomPanelTab>(isVisible ? [tabRequest?.tab ?? 'terminal'] : []),
  );

  // Hidden panels mount nothing; the first time this panel becomes visible,
  // mount whatever tab is active (covers requested git/search tabs too).
  // Idempotent with activate() below.
  useEffect(() => {
    if (!isVisible) return;
    setMountedTabs((prev) => (prev.has(active) ? prev : new Set(prev).add(active)));
  }, [isVisible, active]);

  // Per-project shell tabs, keyed by projectId. Reading by projectId means
  // each panel only re-renders when its own tabs change — switching active
  // project doesn't slosh state into siblings.
  const ensureTabsForProject = useShellTabsStore((s) => s.ensureTabsForProject);
  const shellTabs = useShellTabsStore(
    (s) => s.tabsByProject[projectId] ?? [],
  );
  const activeShellTabId = useShellTabsStore(
    (s) => s.activeTabIdByProject[projectId] ?? null,
  );

  useEffect(() => {
    if (!tabRequest) return;
    setActive(tabRequest.tab);
    setMountedTabs((prev) =>
      prev.has(tabRequest.tab) ? prev : new Set(prev).add(tabRequest.tab),
    );
    onActiveTabChange?.(tabRequest.tab);
  }, [tabRequest]);

  // Seed at least one shell tab the first time we render this project's
  // panel — uses the legacy 'default' tab id so any pre-existing PTY keyed
  // `${projectId}:shell:default` reattaches with its rolling buffer.
  useEffect(() => {
    if (shellTabs.length === 0) {
      ensureTabsForProject(projectId);
    }
  }, [projectId, shellTabs.length, ensureTabsForProject]);

  const tabs = shellTabs.length > 0 ? shellTabs : ensureTabsForProject(projectId);
  const resolvedActiveShellId = useMemo(() => {
    if (activeShellTabId && tabs.some((t) => t.id === activeShellTabId)) {
      return activeShellTabId;
    }
    return tabs[0]?.id ?? null;
  }, [activeShellTabId, tabs]);

  const activate = (tab: BottomPanelTab) => {
    setActive(tab);
    setMountedTabs((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)));
    onActiveTabChange?.(tab);
  };

  return (
    <div
      className="flex h-full flex-col"
      style={{ display: isVisible ? 'flex' : 'none' }}
    >
      <div
        className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-surface-2 px-1.5"
      >
        <div className="flex items-stretch">
          <TabButton
            active={active === 'terminal'}
            onClick={() => activate('terminal')}
            icon={<TerminalIcon size={12} />}
            label="Terminal"
            count={shellTabs.length > 1 ? shellTabs.length : undefined}
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
          onClick={() => {
            setBottomOpen(false);
            onClose?.();
          }}
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
            className="absolute inset-0 flex flex-col"
          >
            <Suspense fallback={null}>
              <TerminalTabs
                projectId={projectId}
                tabs={tabs}
                activeTabId={resolvedActiveShellId}
              />
              <div className="relative min-h-0 flex-1">
                {tabs.map((tab) => {
                  const isActiveShell = tab.id === resolvedActiveShellId;
                  return (
                    <div
                      key={tab.id}
                      style={{
                        visibility:
                          isVisible && active === 'terminal' && isActiveShell
                            ? 'visible'
                            : 'hidden',
                        pointerEvents:
                          active === 'terminal' && isActiveShell ? 'auto' : 'none',
                        zIndex: isActiveShell ? 1 : 0,
                      }}
                      className="absolute inset-0"
                    >
                      <TerminalPane
                        projectId={projectId}
                        projectPath={projectPath}
                        tabId={tab.id}
                        isActive={
                          isVisible && active === 'terminal' && isActiveShell
                        }
                      />
                    </div>
                  );
                })}
              </div>
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
});

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count?: number;
}

function TabButton({ active, onClick, icon, label, count }: TabButtonProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'relative flex h-7 items-center gap-1.5 rounded-[6px] border px-2.5 text-[11px] transition',
        active
          ? 'border-border-emphasis bg-surface-4 text-text shadow-sm'
          : 'border-transparent text-text-muted hover:bg-surface-3 hover:text-text-secondary',
      )}
    >
      {active && (
        <span
          className="absolute inset-x-2 bottom-0 h-0.5 rounded-t bg-accent"
        />
      )}
      <span className={active ? 'text-accent-2' : 'text-text-muted'}>{icon}</span>
      <span>{label}</span>
      {count !== undefined && (
        <span
          className={cn(
            'ml-0.5 rounded-full px-1.5 text-[9.5px] leading-[14px]',
            active ? 'bg-accent/20 text-accent-2' : 'bg-surface-raised text-text-muted',
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}
