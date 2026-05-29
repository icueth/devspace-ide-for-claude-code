import {
  Bot,
  Brain,
  ChevronDown,
  Circle,
  Loader2,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import type {
  RufloAgent,
  RufloDashAgentsResult,
  RufloDashMemoryResult,
  RufloDashSwarmsResult,
  RufloMemoryResult,
  RufloProjectStatus,
  RufloSwarmSession,
} from '@shared/ruflo';

/**
 * Side drawer overlay surfaced on top of ClaudeCliPane in Terminal mode.
 *
 * Phase 3 MVP: two tabs (Agents, Memory). The tab array is intentionally
 * data-driven so adding Workers/Doctor/Goals in 3.1+ stays a one-line edit.
 * State is component-local — each open call refetches from main on demand.
 * Drawer is fully unmounted when closed (`open === false` → return null).
 *
 * Install + project-init gates run before either tab can fetch:
 *   1. `dashboard.isInstalled()` — if false, prompt to Setup tab.
 *   2. `getProjectStatus(projectPath)` — if `.claude-flow/` is missing,
 *      prompt to Settings → Ruflo.
 *   3. Only then does the per-tab fetcher fire.
 */

interface RufloOverlayProps {
  open: boolean;
  projectPath: string;
  onClose: () => void;
}

type OverlayTab = 'agents' | 'memory';

type GateState =
  | { kind: 'loading' }
  | { kind: 'not-installed' }
  | { kind: 'not-initialized' }
  | { kind: 'ready' };

// Tab descriptor — extending the array adds a tab. Each tab body is a
// dedicated component keyed off the descriptor's id.
const TABS: Array<{ id: OverlayTab; label: string; icon: typeof Bot }> = [
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'memory', label: 'Memory', icon: Brain },
];

export function RufloOverlay({ open, projectPath, onClose }: RufloOverlayProps) {
  const [activeTab, setActiveTab] = useState<OverlayTab>('agents');
  const [gate, setGate] = useState<GateState>({ kind: 'loading' });

  // Re-run gate checks each time the drawer opens (and on projectPath
  // change). Cheap (cached install check + one fs stat) so we don't cache
  // between open/close cycles — keeps stale state away after a Settings
  // change.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setGate({ kind: 'loading' });
    void (async () => {
      try {
        const installed = await api.ruflo.dashboard.isInstalled();
        if (cancelled) return;
        if (!installed) {
          setGate({ kind: 'not-installed' });
          return;
        }
        const status: RufloProjectStatus =
          await api.ruflo.getProjectStatus(projectPath);
        if (cancelled) return;
        if (!status.initialized) {
          setGate({ kind: 'not-initialized' });
          return;
        }
        setGate({ kind: 'ready' });
      } catch (err) {
        if (cancelled) return;
        console.warn('[ruflo-overlay] gate check failed:', err);
        setGate({ kind: 'not-installed' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, projectPath]);

  if (!open) return null;

  return (
    <div
      className={cn(
        'absolute right-0 top-0 bottom-0 z-30 flex w-[320px] flex-col',
        'border-l border-border bg-surface-2 shadow-xl',
        'transition-transform duration-200',
        'translate-x-0',
      )}
      // The drawer sits inside ClaudeCliPane's relative content container so
      // `top-0 bottom-0` already aligns with the chat/terminal viewport.
      aria-label="Ruflo overlay"
    >
      <DrawerHeader
        activeTab={activeTab}
        onChangeTab={setActiveTab}
        onClose={onClose}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {gate.kind === 'loading' && <LoadingState label="Checking Ruflo…" />}
        {gate.kind === 'not-installed' && <NotInstalledGate />}
        {gate.kind === 'not-initialized' && <NotInitializedGate />}
        {gate.kind === 'ready' && activeTab === 'agents' && (
          <AgentsTab projectPath={projectPath} />
        )}
        {gate.kind === 'ready' && activeTab === 'memory' && (
          <MemoryTab projectPath={projectPath} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header — tab bar + close button. Same pill style as ModeToggle so the two
// feel like siblings.
// ---------------------------------------------------------------------------

function DrawerHeader({
  activeTab,
  onChangeTab,
  onClose,
}: {
  activeTab: OverlayTab;
  onChangeTab: (tab: OverlayTab) => void;
  onClose: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface-3 px-2 py-1.5">
      <div className="inline-flex h-[22px] items-stretch overflow-hidden rounded-[6px] border border-border-subtle bg-surface-2 text-[10.5px]">
        {TABS.map((tab) => (
          <TabBtn
            key={tab.id}
            active={activeTab === tab.id}
            onClick={() => onChangeTab(tab.id)}
          >
            <tab.icon size={10} />
            <span>{tab.label}</span>
          </TabBtn>
        ))}
      </div>
      <div className="flex-1" />
      <button
        type="button"
        onClick={onClose}
        title="Close Ruflo overlay"
        aria-label="Close Ruflo overlay"
        className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-[6px] text-text-secondary transition hover:bg-surface-4 hover:text-text"
      >
        <X size={11} />
      </button>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 px-2 transition first:rounded-l-[5px] last:rounded-r-[5px]',
        active
          ? 'bg-surface-4 text-text'
          : 'text-text-secondary hover:bg-surface-4 hover:text-text',
      )}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Gate states
// ---------------------------------------------------------------------------

function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-4 text-[11px] text-text-muted">
      <Loader2 size={12} className="animate-spin" />
      {label}
    </div>
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    <p className="break-words text-[10.5px] text-semantic-error">{message}</p>
  );
}

function GateCard({
  title,
  body,
  cta,
}: {
  title: string;
  body: string;
  cta: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex flex-col gap-2 px-3 py-4">
      <div className="flex items-center gap-1.5">
        <Circle size={10} className="text-text-muted" />
        <span className="text-[12px] font-semibold text-text">{title}</span>
      </div>
      <p className="text-[11px] leading-snug text-text-muted">{body}</p>
      <button
        type="button"
        onClick={cta.onClick}
        className="mt-1 inline-flex items-center gap-1 self-start rounded-[6px] border border-accent/40 bg-accent/10 px-2.5 py-1 text-[10.5px] text-accent transition hover:bg-accent/20"
      >
        {cta.label}
      </button>
    </div>
  );
}

function NotInstalledGate() {
  return (
    <GateCard
      title="Ruflo not installed"
      body="Install ruflo to enable the agents, swarm, and memory overlay."
      cta={{
        label: 'Open Setup',
        onClick: () => {
          // Same custom-event pattern RufloSettings uses to cross-link to
          // the Setup tab. Listened to in Settings.tsx.
          window.dispatchEvent(
            new CustomEvent('devspace:switch-settings-tab', {
              detail: { tab: 'setup' },
            }),
          );
        },
      }}
    />
  );
}

function NotInitializedGate() {
  return (
    <GateCard
      title="Project not initialized"
      body="Run ruflo init inside this project from Settings → Ruflo to populate .claude-flow/."
      cta={{
        label: 'Open Ruflo settings',
        onClick: () => {
          window.dispatchEvent(
            new CustomEvent('devspace:switch-settings-tab', {
              detail: { tab: 'ruflo' },
            }),
          );
        },
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Agents tab — two collapsible sections: agent types + active swarms.
// ---------------------------------------------------------------------------

function AgentsTab({ projectPath }: { projectPath: string }) {
  const [agents, setAgents] = useState<RufloDashAgentsResult | null>(null);
  const [swarms, setSwarms] = useState<RufloDashSwarmsResult | null>(null);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [swarmsLoading, setSwarmsLoading] = useState(true);

  const refreshAgents = useCallback(async () => {
    setAgentsLoading(true);
    try {
      const res = await api.ruflo.dashboard.listAgents();
      setAgents(res);
    } catch (err) {
      setAgents({
        ok: false,
        agents: [],
        error: (err as Error).message || 'listAgents failed',
      });
    } finally {
      setAgentsLoading(false);
    }
  }, []);

  const refreshSwarms = useCallback(async () => {
    setSwarmsLoading(true);
    try {
      const res = await api.ruflo.dashboard.listSwarms(projectPath);
      setSwarms(res);
    } catch (err) {
      setSwarms({
        ok: false,
        sessions: [],
        error: (err as Error).message || 'listSwarms failed',
      });
    } finally {
      setSwarmsLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    // Parallel fan-out keeps the drawer feeling instant even if one of the
    // two `ruflo` calls is slow — the other section can render first.
    void refreshAgents();
    void refreshSwarms();
  }, [refreshAgents, refreshSwarms]);

  return (
    <div className="flex flex-col gap-2 p-2.5">
      <Section
        title="Available agent types"
        loading={agentsLoading}
        onRefresh={() => void refreshAgents()}
      >
        {!agentsLoading && agents && <AgentsBody agents={agents} />}
      </Section>
      <Section
        title="Active swarms"
        loading={swarmsLoading}
        onRefresh={() => void refreshSwarms()}
      >
        {!swarmsLoading && swarms && <SwarmsBody swarms={swarms} />}
      </Section>
    </div>
  );
}

function AgentsBody({ agents }: { agents: RufloDashAgentsResult }) {
  if (agents.error) return <ErrorLine message={agents.error} />;
  if (agents.agents.length === 0) {
    return (
      <p className="text-[11px] text-text-muted">
        No agents reported by ruflo.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-1">
      {agents.agents.map((a) => (
        <AgentChip key={a.name} agent={a} />
      ))}
    </div>
  );
}

function AgentChip({ agent }: { agent: RufloAgent }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-surface-3 px-2 py-[2px] text-[10px] text-text-secondary"
      title={agent.role ? `${agent.name} — ${agent.role}` : agent.name}
    >
      <Bot size={9} className="text-accent" />
      <span className="font-medium text-text">{agent.name}</span>
      {agent.role && (
        <span className="text-text-muted">· {agent.role}</span>
      )}
    </span>
  );
}

function SwarmsBody({ swarms }: { swarms: RufloDashSwarmsResult }) {
  if (swarms.error) return <ErrorLine message={swarms.error} />;
  if (swarms.sessions.length === 0) {
    return (
      <p className="text-[11px] text-text-muted">No active swarms.</p>
    );
  }
  return (
    <ul className="flex flex-col gap-1">
      {swarms.sessions.map((s) => (
        <SwarmRow key={s.id} session={s} />
      ))}
    </ul>
  );
}

function SwarmRow({ session }: { session: RufloSwarmSession }) {
  return (
    <li className="rounded-[6px] border border-border-subtle bg-surface-3/50 px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <span className="truncate font-mono text-[10px] text-accent">
          {session.id}
        </span>
        {session.status && (
          <span className="rounded-full bg-surface-3 px-1.5 py-[1px] text-[9px] uppercase text-text-muted">
            {session.status}
          </span>
        )}
      </div>
      {session.objective && (
        <p className="mt-0.5 line-clamp-2 text-[10.5px] text-text-secondary">
          {session.objective}
        </p>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Memory tab — query input + result list.
// ---------------------------------------------------------------------------

function MemoryTab({ projectPath }: { projectPath: string }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<RufloDashMemoryResult | null>(null);
  const [loading, setLoading] = useState(false);

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    try {
      const res = await api.ruflo.dashboard.searchMemory(projectPath, q, 10);
      setResults(res);
    } catch (err) {
      setResults({
        ok: false,
        results: [],
        error: (err as Error).message || 'searchMemory failed',
      });
    } finally {
      setLoading(false);
    }
  }, [projectPath, query]);

  const onKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void runSearch();
    }
  };

  return (
    <div className="flex flex-col gap-2 p-2.5">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <Search size={11} className="text-text-muted" />
          <span className="text-[10.5px] font-semibold uppercase tracking-wide text-text-muted">
            Vector memory search
          </span>
        </div>
        <textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="What do you want to recall?"
          rows={2}
          className="w-full resize-none rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-1.5 text-[11px] text-text placeholder:text-text-dim focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
        />
        <button
          type="button"
          onClick={() => void runSearch()}
          disabled={!query.trim() || loading}
          className={cn(
            'inline-flex h-[22px] items-center justify-center gap-1 self-end rounded-[6px] border border-accent/40 bg-accent/10 px-2.5 text-[10.5px] text-accent transition hover:bg-accent/20 disabled:pointer-events-none disabled:opacity-50',
          )}
          title="Search (Cmd+Enter)"
        >
          {loading ? (
            <Loader2 size={10} className="animate-spin" />
          ) : (
            <Search size={10} />
          )}
          {loading ? 'Searching…' : 'Search'}
        </button>
      </div>

      <MemoryResults loading={loading} results={results} />
    </div>
  );
}

function MemoryResults({
  loading,
  results,
}: {
  loading: boolean;
  results: RufloDashMemoryResult | null;
}) {
  if (loading) return <LoadingState label="Searching memory…" />;
  if (!results) {
    return (
      <p className="px-1 text-[11px] text-text-muted">
        Type a query above to search Ruflo&apos;s vector memory.
      </p>
    );
  }
  if (results.error) return <ErrorLine message={results.error} />;
  if (results.results.length === 0) {
    return (
      <p className="px-1 text-[11px] text-text-muted">No matches.</p>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {results.results.map((r, i) => (
        <MemoryResultCard key={i} result={r} />
      ))}
    </ul>
  );
}

function MemoryResultCard({ result }: { result: RufloMemoryResult }) {
  // Pre-truncate to ~120 chars so the renderer never paints a giant blob if
  // ruflo returns an unexpectedly long line. The full text is in the title
  // attribute so hovering reveals everything.
  const display =
    result.text.length > 120 ? `${result.text.slice(0, 117).trimEnd()}…` : result.text;
  return (
    <li
      className="rounded-[6px] border border-border-subtle bg-surface-3/50 px-2 py-1.5"
      title={result.text}
    >
      <p className="text-[11px] leading-snug text-text">{display}</p>
      {(result.namespace || result.score !== undefined) && (
        <div className="mt-1 flex items-center gap-1.5 text-[9.5px] text-text-muted">
          {result.namespace && (
            <span className="rounded-full bg-surface-3 px-1.5 py-[1px] font-mono">
              {result.namespace}
            </span>
          )}
          {result.score !== undefined && (
            <span className="font-mono">
              {result.score.toFixed(2)}
            </span>
          )}
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Section primitive — collapsible header with title + refresh button.
// ---------------------------------------------------------------------------

function Section({
  title,
  loading,
  onRefresh,
  children,
}: {
  title: string;
  loading?: boolean;
  onRefresh?: () => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="overflow-hidden rounded-[8px] border border-border-subtle bg-surface-3/40">
      <div className="flex items-center gap-1 border-b border-border-subtle px-2 py-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-wide text-text-muted transition hover:text-text"
        >
          <ChevronDown
            size={10}
            className={cn(
              'transition-transform',
              open ? '' : '-rotate-90',
            )}
          />
          {title}
        </button>
        <div className="flex-1" />
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            title="Refresh"
            className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-[5px] text-text-muted transition hover:bg-surface-4 hover:text-text disabled:pointer-events-none disabled:opacity-50"
          >
            {loading ? (
              <Loader2 size={9} className="animate-spin" />
            ) : (
              <RefreshCw size={9} />
            )}
          </button>
        )}
      </div>
      {open && <div className="px-2 py-1.5">{children}</div>}
    </div>
  );
}
