import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  CircleSlash,
  FolderOpen,
  Loader2,
  Network,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';

import { CodeflowGraphView } from '@renderer/components/Codeflow/CodeflowGraph';
import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import type { CodeflowDoc, CodeflowStage, CodeflowStatus } from '@shared/types';

const MarkdownPreview = lazy(() =>
  import('@renderer/components/Editor/MarkdownPreview').then((m) => ({
    default: m.MarkdownPreview,
  })),
);

interface CodeflowViewProps {
  projectPath: string;
}

const STAGE_LABELS: Record<CodeflowStage, string> = {
  idle: 'Ready',
  walking: 'Scanning files',
  overview: 'Generating codebase.md',
  flows: 'Generating flow docs',
  done: 'Up to date',
  cancelled: 'Cancelled',
  error: 'Error',
};

function isRunning(stage: CodeflowStage): boolean {
  return stage === 'walking' || stage === 'overview' || stage === 'flows';
}

// Sentinel name for the visualization tab. Stored alongside doc filenames in
// the same activeName state so the tabs strip can render uniformly.
const VIZ_TAB = '__viz__';

export function CodeflowView({ projectPath }: CodeflowViewProps) {
  const [status, setStatus] = useState<CodeflowStatus | null>(null);
  const [activeName, setActiveName] = useState<string | null>(VIZ_TAB);
  const [docContent, setDocContent] = useState<string>('');
  const [docLoading, setDocLoading] = useState(false);

  // Subscribe to status updates from the main process. The first call also
  // registers this WebContents so progress events arrive.
  useEffect(() => {
    let cancelled = false;
    void api.codeflow
      .getStatus(projectPath)
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => undefined);
    const unsub = api.codeflow.onProgress(projectPath, (s) => {
      setStatus(s);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [projectPath]);

  // The visualization tab is always available; doc tabs only appear after a
  // successful run. If the active selection is a doc that's been deleted
  // (e.g. user wiped .claude/codeflow/), fall back to viz.
  useEffect(() => {
    if (!status) return;
    if (activeName === VIZ_TAB) return;
    if (activeName === null) return;
    if (!status.docs.some((d) => d.name === activeName)) {
      setActiveName(status.docs[0]?.name ?? VIZ_TAB);
    }
  }, [status?.docs, activeName, status]);

  // Resolve the active doc to its current entry so a re-analyze that bumps
  // mtime triggers a re-read.
  const activeDoc: CodeflowDoc | null = useMemo(() => {
    if (!status || !activeName || activeName === VIZ_TAB) return null;
    return status.docs.find((d) => d.name === activeName) ?? null;
  }, [status?.docs, activeName, status]);

  // Load the active doc's content when selection or its mtime changes.
  useEffect(() => {
    if (!activeDoc) {
      setDocContent('');
      return;
    }
    let cancelled = false;
    setDocLoading(true);
    void api.codeflow
      .readDoc(activeDoc.path)
      .then((text) => {
        if (!cancelled) setDocContent(text);
      })
      .catch((err: Error) => {
        if (!cancelled) setDocContent(`# Error loading doc\n\n${err.message}`);
      })
      .finally(() => {
        if (!cancelled) setDocLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeDoc?.path, activeDoc?.mtime]);

  const onAnalyze = useCallback(
    (force: boolean) => {
      void api.codeflow.analyze(projectPath, { force });
    },
    [projectPath],
  );

  const onCancel = useCallback(() => {
    void api.codeflow.cancel(projectPath);
  }, [projectPath]);

  const onOpenDir = useCallback(() => {
    void api.codeflow.openDir(projectPath);
  }, [projectPath]);

  const stage: CodeflowStage = status?.stage ?? 'idle';
  const running = isRunning(stage);
  const hasResult = (status?.docs.length ?? 0) > 0;
  const stale = status?.stale ?? false;

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-surface">
      <Toolbar
        status={status}
        running={running}
        hasResult={hasResult}
        stale={stale}
        onAnalyze={onAnalyze}
        onCancel={onCancel}
        onOpenDir={onOpenDir}
      />
      <ProgressBar status={status} />
      <ActivityLine status={status} running={running} />
      <DocsTabs
        docs={status?.docs ?? []}
        activeName={activeName}
        onSelect={setActiveName}
      />
      <div className="relative min-h-0 flex-1">
        {/* Native D3 viz mounts only after the user has visited the tab once,
            then stays alive (just hidden) so switching tabs doesn't tear down
            the simulation. Mount-on-demand keeps boot cheap when the user
            opens Codeflow only to read the docs. */}
        <CodeflowGraphView
          projectPath={projectPath}
          visible={activeName === VIZ_TAB}
        />
        {activeName !== VIZ_TAB && activeDoc && (
          <div className="absolute inset-0">
            {docLoading ? (
              <div className="flex h-full items-center justify-center text-[12px] text-text-muted">
                Loading {activeName}…
              </div>
            ) : (
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center text-[12px] text-text-muted">
                    Loading preview…
                  </div>
                }
              >
                <MarkdownPreview markdown={docContent} />
              </Suspense>
            )}
          </div>
        )}
        {!hasResult && activeName !== VIZ_TAB && (
          <div className="absolute inset-0">
            <EmptyState
              status={status}
              running={running}
              onAnalyze={() => onAnalyze(false)}
            />
          </div>
        )}
      </div>
    </div>
  );
}


interface ToolbarProps {
  status: CodeflowStatus | null;
  running: boolean;
  hasResult: boolean;
  stale: boolean;
  onAnalyze: (force: boolean) => void;
  onCancel: () => void;
  onOpenDir: () => void;
}

function Toolbar({
  status,
  running,
  hasResult,
  stale,
  onAnalyze,
  onCancel,
  onOpenDir,
}: ToolbarProps) {
  const stage: CodeflowStage = status?.stage ?? 'idle';
  const lastAnalyzed = status?.cache?.lastAnalyzedAt;
  const lastLabel = useMemo(() => formatRelative(lastAnalyzed), [lastAnalyzed]);

  return (
    <div
      className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2"
      style={{
        background:
          'linear-gradient(180deg, var(--color-surface-2), var(--color-surface))',
      }}
    >
      <StatusBadge stage={stage} stale={stale} />
      <span className="truncate text-[11px] text-text-muted">
        {running
          ? STAGE_LABELS[stage]
          : status?.message ||
            (lastAnalyzed
              ? `Last analyzed ${lastLabel} · ${status?.cache?.fileCount ?? 0} files`
              : 'No analysis yet')}
      </span>
      <div className="flex-1" />
      {!running && (
        <button
          onClick={() => onAnalyze(false)}
          className="inline-flex h-[26px] items-center gap-1.5 rounded-[7px] px-3 text-[11.5px] font-medium text-white transition hover:brightness-110"
          style={{
            background:
              'linear-gradient(135deg, var(--color-accent), #a855f7)',
            boxShadow: '0 2px 8px var(--color-accent-glow)',
          }}
          title={
            hasResult
              ? 'Re-analyze: skips when fingerprint unchanged'
              : 'Generate codebase.md + flow-*.md with Claude Code'
          }
        >
          <Sparkles size={11.5} strokeWidth={2.2} />
          <span>{hasResult ? 'Re-analyze' : 'Generate codeflow'}</span>
        </button>
      )}
      {!running && hasResult && (
        <button
          onClick={() => onAnalyze(true)}
          className="inline-flex h-[26px] items-center gap-1.5 rounded-[7px] border border-border-subtle bg-surface-3 px-2.5 text-[11px] text-text-secondary transition hover:border-border-hi hover:bg-surface-4 hover:text-text"
          title="Force full re-analysis (ignore fingerprint cache)"
        >
          <RefreshCw size={11} />
          <span>Force</span>
        </button>
      )}
      {running && (
        <button
          onClick={onCancel}
          className="inline-flex h-[26px] items-center gap-1.5 rounded-[7px] border border-semantic-error/40 bg-semantic-error/10 px-2.5 text-[11px] text-semantic-error transition hover:bg-semantic-error/15"
          title="Stop the running Claude process"
        >
          <CircleSlash size={11} />
          <span>Cancel</span>
        </button>
      )}
      <button
        onClick={onOpenDir}
        className="inline-flex h-[26px] items-center gap-1.5 rounded-[7px] border border-border-subtle bg-surface-3 px-2.5 text-[11px] text-text-secondary transition hover:border-border-hi hover:bg-surface-4 hover:text-text"
        title="Open .claude/codeflow/ in Finder"
      >
        <FolderOpen size={11} />
      </button>
    </div>
  );
}

function StatusBadge({ stage, stale }: { stage: CodeflowStage; stale: boolean }) {
  if (stage === 'error') {
    return (
      <Pill tone="error" icon={<AlertTriangle size={10} />}>
        Error
      </Pill>
    );
  }
  if (isRunning(stage)) {
    return (
      <Pill tone="info" icon={<Loader2 size={10} className="animate-spin" />}>
        {STAGE_LABELS[stage]}
      </Pill>
    );
  }
  if (stage === 'cancelled') {
    return (
      <Pill tone="warn" icon={<CircleAlert size={10} />}>
        Cancelled
      </Pill>
    );
  }
  if (stale) {
    return (
      <Pill tone="warn" icon={<Activity size={10} />}>
        Out of date
      </Pill>
    );
  }
  if (stage === 'done') {
    return (
      <Pill tone="success" icon={<CheckCircle2 size={10} />}>
        Up to date
      </Pill>
    );
  }
  return (
    <Pill tone="muted" icon={<Sparkles size={10} />}>
      Ready
    </Pill>
  );
}

type Tone = 'info' | 'success' | 'warn' | 'error' | 'muted';

function Pill({
  tone,
  icon,
  children,
}: {
  tone: Tone;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const tones: Record<Tone, string> = {
    info: 'border-accent/40 bg-accent/10 text-accent',
    success: 'border-semantic-success/40 bg-semantic-success/10 text-semantic-success',
    warn: 'border-semantic-warning/40 bg-semantic-warning/10 text-semantic-warning',
    error: 'border-semantic-error/40 bg-semantic-error/10 text-semantic-error',
    muted: 'border-border-subtle bg-surface-3 text-text-secondary',
  };
  return (
    <span
      className={cn(
        'inline-flex h-[22px] items-center gap-1.5 rounded-[6px] border px-2 text-[10.5px] font-medium',
        tones[tone],
      )}
    >
      {icon}
      <span>{children}</span>
    </span>
  );
}

function ProgressBar({ status }: { status: CodeflowStatus | null }) {
  if (!status || !isRunning(status.stage)) return null;
  const pct = Math.max(0, Math.min(1, status.progress));
  return (
    <div className="relative h-[2px] w-full bg-surface-3">
      <div
        className="absolute inset-y-0 left-0 transition-[width] duration-200 ease-out"
        style={{
          width: `${pct * 100}%`,
          background: 'linear-gradient(90deg, var(--color-accent), #a855f7)',
        }}
      />
    </div>
  );
}

/**
 * Live activity line. Sits between the toolbar/progress bar and the docs
 * area, showing what Claude is doing right now (Read foo.ts, Grep bar, …).
 * Hidden when no run is in flight so it doesn't take up vertical space.
 */
function ActivityLine({
  status,
  running,
}: {
  status: CodeflowStatus | null;
  running: boolean;
}) {
  if (!running || !status) return null;
  const pct = Math.round(Math.max(0, Math.min(1, status.progress)) * 100);
  return (
    <div
      className="flex shrink-0 items-center gap-3 border-b border-border-subtle px-3 py-1.5"
      style={{ background: 'var(--color-surface-2)' }}
    >
      <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-text-muted">
        {pct}%
      </span>
      <span
        className="truncate font-mono text-[11px] text-text-secondary"
        title={status.message}
      >
        {status.message || 'Working…'}
      </span>
    </div>
  );
}

interface DocsTabsProps {
  docs: CodeflowDoc[];
  activeName: string | null;
  onSelect: (name: string) => void;
}

function DocsTabs({ docs, activeName, onSelect }: DocsTabsProps) {
  return (
    <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-border bg-surface-2">
      <TabButton
        active={activeName === VIZ_TAB}
        onClick={() => onSelect(VIZ_TAB)}
        title="Codeflow visualization"
      >
        <Network size={11} className="shrink-0" />
        <span>Visualization</span>
      </TabButton>
      {docs.map((doc) => {
        const active = doc.name === activeName;
        // Pretty-print: "codebase.md" -> "Codebase", "flow-auth.md" -> "Auth"
        const label =
          doc.name === 'codebase.md'
            ? 'Codebase'
            : doc.name.replace(/^flow-/, '').replace(/\.md$/, '').replace(/-/g, ' ');
        return (
          <TabButton
            key={doc.path}
            active={active}
            onClick={() => onSelect(doc.name)}
            title={doc.name}
          >
            <span className="capitalize">{label}</span>
            <span className="text-[9.5px] text-text-dim">{formatBytes(doc.size)}</span>
          </TabButton>
        );
      })}
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

interface EmptyStateProps {
  status: CodeflowStatus | null;
  running: boolean;
  onAnalyze: () => void;
}

function EmptyState({ status, running, onAnalyze }: EmptyStateProps) {
  const error = status?.error;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-10">
      <div className="flex w-full max-w-[440px] flex-col items-center gap-4 text-center">
        <div
          className="flex h-14 w-14 items-center justify-center rounded-[14px]"
          style={{
            background:
              'linear-gradient(135deg, rgba(76,141,255,0.18), rgba(168,85,247,0.18))',
            border: '1px solid var(--color-border-subtle)',
            boxShadow: '0 8px 24px rgba(76,141,255,0.12)',
          }}
        >
          <Sparkles size={22} className="text-accent" />
        </div>
        <div className="space-y-1.5">
          <div className="text-[14px] font-semibold text-text">
            {error ? 'Analysis failed' : 'No analysis yet'}
          </div>
          {error ? (
            <pre className="whitespace-pre-wrap text-left text-[11.5px] leading-relaxed text-semantic-error">
              {error}
            </pre>
          ) : (
            <div className="text-[12px] leading-relaxed text-text-muted">
              Click <strong className="text-text">Generate codeflow</strong> and
              Claude Code will read the project, then write{' '}
              <code className="rounded bg-surface-3 px-1.5 py-0.5 text-[11px]">
                codebase.md
              </code>{' '}
              + per-feature{' '}
              <code className="rounded bg-surface-3 px-1.5 py-0.5 text-[11px]">
                flow-*.md
              </code>{' '}
              into{' '}
              <code className="rounded bg-surface-3 px-1.5 py-0.5 text-[11px]">
                .claude/codeflow/
              </code>
              .
            </div>
          )}
        </div>
        {!running && (
          <button
            onClick={onAnalyze}
            className="inline-flex h-[32px] items-center gap-1.5 rounded-[8px] px-4 text-[12.5px] font-medium text-white transition hover:brightness-110"
            style={{
              background: 'linear-gradient(135deg, var(--color-accent), #a855f7)',
              boxShadow: '0 4px 14px var(--color-accent-glow)',
            }}
          >
            <Sparkles size={13} strokeWidth={2.2} />
            <span>{error ? 'Try again' : 'Generate codeflow'}</span>
          </button>
        )}
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatRelative(ms: number | null | undefined): string {
  if (!ms) return 'never';
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))}h ago`;
  return new Date(ms).toLocaleDateString();
}
