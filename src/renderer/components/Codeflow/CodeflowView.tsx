import { Network, Search, Zap } from 'lucide-react';
import { useCallback, useState } from 'react';

import type { CodeflowGraphStats } from '@renderer/components/Codeflow/CodeflowGraph';
import { CodeflowGraphView } from '@renderer/components/Codeflow/CodeflowGraph';
import { QueryPanel } from '@renderer/components/Codeflow/QueryPanel';
import { useClaudeVersion } from '@renderer/hooks/useClaudeVersion';
import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import { claudeCliSessionId, useCliTabsStore } from '@renderer/state/cliTabs';

// v0.37: claude-code 2.1.154 introduced `/code-review ultra` (cloud deep review).
const MIN_CLAUDE_FOR_ULTRA_REVIEW = { major: 2, minor: 1, patch: 154 };

// Codeflow is now graphify-backed (v0.38): a live symbol/dependency graph plus a
// queryable graph (query/path/explain). The old Claude-generated static docs
// (codebase.md / flow-*.md) were removed — ask the graph instead via the Query
// tab.
const VIZ_TAB = '__viz__';
const QUERY_TAB = '__query__';

interface CodeflowViewProps {
  projectPath: string;
}

export function CodeflowView({ projectPath }: CodeflowViewProps) {
  const [tab, setTab] = useState<string>(VIZ_TAB);
  // Static-analysis stats (cycles / dead code) surfaced by CodeflowGraphView.
  const [graphStats, setGraphStats] = useState<CodeflowGraphStats | null>(null);
  const [ultraHint, setUltraHint] = useState<string | null>(null);

  // v0.37: Ultra-Review — write `/code-review ultra` into the active Claude
  // tab's PTY. Confirms first (billed). Orthogonal to graphify.
  const onUltraReview = useCallback(() => {
    const ok = window.confirm(
      '/code-review ultra runs a deep cloud review. This is billed. Continue?',
    );
    if (!ok) return;
    const store = useCliTabsStore.getState();
    const projectId = store.activeDockedProjectId;
    const activeTab = projectId ? store.getActiveTab(projectId) : null;
    if (!activeTab || !projectId) {
      setUltraHint('Open a Claude tab first');
      window.setTimeout(() => setUltraHint(null), 3000);
      return;
    }
    void api.pty
      .write(claudeCliSessionId(projectId, activeTab.id), '/code-review ultra\r')
      .catch(() => undefined);
  }, []);

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-surface">
      <Toolbar onUltraReview={onUltraReview} ultraHint={ultraHint} />
      {tab === VIZ_TAB &&
        graphStats &&
        (graphStats.cycleCount > 0 || graphStats.deadCodeCount > 0) && (
          <GraphStatsBar
            cycleCount={graphStats.cycleCount}
            deadCodeCount={graphStats.deadCodeCount}
          />
        )}
      <TabStrip tab={tab} onSelect={setTab} />
      <div className="relative min-h-0 flex-1">
        {/* Native D3 viz: mounts once visited, stays alive (hidden) so tab
            switches don't tear down the simulation. */}
        <CodeflowGraphView
          projectPath={projectPath}
          visible={tab === VIZ_TAB}
          onStatsChange={setGraphStats}
        />
        {tab === QUERY_TAB && (
          <div className="absolute inset-0">
            <QueryPanel projectPath={projectPath} />
          </div>
        )}
      </div>
    </div>
  );
}

function Toolbar({
  onUltraReview,
  ultraHint,
}: {
  onUltraReview: () => void;
  ultraHint: string | null;
}) {
  const { meets } = useClaudeVersion();
  const ultraSupported = meets(MIN_CLAUDE_FOR_ULTRA_REVIEW);

  return (
    <div
      className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2"
      style={{
        background:
          'linear-gradient(180deg, var(--color-surface-2), var(--color-surface))',
      }}
    >
      <Network size={12} className="text-accent" />
      <span className="text-[11.5px] font-medium text-text">Codeflow</span>
      <span className="text-[10.5px] text-text-muted">· graphify</span>
      <div className="flex-1" />
      {ultraHint && (
        <span className="text-[10.5px] text-semantic-warning">{ultraHint}</span>
      )}
      <button
        onClick={onUltraReview}
        disabled={!ultraSupported}
        className={cn(
          'inline-flex h-[26px] items-center gap-1.5 rounded-[7px] border border-border-subtle bg-surface-3 px-2.5 text-[11px] text-text-secondary transition hover:border-border-hi hover:bg-surface-4 hover:text-text',
          !ultraSupported && 'pointer-events-none opacity-40',
        )}
        title={
          ultraSupported
            ? 'Run /code-review ultra in the active Claude tab — billed cloud deep review'
            : 'Requires claude CLI 2.1.154 or newer'
        }
      >
        <Zap size={11} className="text-accent" />
        <span>Ultra Review</span>
      </button>
    </div>
  );
}

function TabStrip({ tab, onSelect }: { tab: string; onSelect: (t: string) => void }) {
  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-border bg-surface-2">
      <TabButton active={tab === VIZ_TAB} onClick={() => onSelect(VIZ_TAB)} title="Codeflow graph">
        <Network size={11} className="shrink-0" />
        <span>Visualization</span>
      </TabButton>
      <TabButton active={tab === QUERY_TAB} onClick={() => onSelect(QUERY_TAB)} title="Query the graph (graphify)">
        <Search size={11} className="shrink-0" />
        <span>Query</span>
      </TabButton>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        'group relative flex shrink-0 items-center gap-2 border-r border-border-subtle px-4 text-[12px] transition',
        active
          ? 'bg-surface text-text'
          : 'text-text-muted hover:bg-white/[0.02] hover:text-text-secondary',
      )}
    >
      {active && (
        <span
          className="absolute inset-x-0 top-0 h-[2px] rounded-b-sm"
          style={{
            background: 'linear-gradient(90deg, var(--color-accent), #a855f7)',
          }}
        />
      )}
      {children}
    </button>
  );
}

/**
 * Compact stats bar on the Viz tab when the graph has non-zero cycle or
 * dead-code counts.
 */
function GraphStatsBar({
  cycleCount,
  deadCodeCount,
}: {
  cycleCount: number;
  deadCodeCount: number;
}) {
  return (
    <div
      className="flex shrink-0 items-center gap-3 border-b border-border-subtle px-3 py-1"
      style={{ background: 'var(--color-surface-2)' }}
    >
      <span className="text-[10px] font-semibold uppercase tracking-wider text-text-dim">
        Graph
      </span>
      {cycleCount > 0 && (
        <span className="inline-flex items-center gap-1 text-[10.5px]">
          <span className="inline-block h-2 w-2 rounded-full border-2 border-semantic-error bg-transparent" />
          <span className="font-medium text-semantic-error">Circular deps:</span>{' '}
          <span className="font-mono tabular-nums text-text">{cycleCount}</span>
        </span>
      )}
      {deadCodeCount > 0 && (
        <span className="inline-flex items-center gap-1 text-[10.5px]">
          <span className="inline-block h-2 w-2 rounded-sm border border-dashed border-text-muted bg-transparent" />
          <span className="font-medium text-text-muted">Dead code:</span>{' '}
          <span className="font-mono tabular-nums text-text">{deadCodeCount} files</span>
        </span>
      )}
    </div>
  );
}
