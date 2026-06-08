import { Loader2, Search } from 'lucide-react';
import { useCallback, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';

type Mode = 'query' | 'path' | 'explain';

const MODES: Array<{ id: Mode; label: string; hint: string }> = [
  { id: 'query', label: 'Query', hint: 'Natural-language question → scoped subgraph' },
  { id: 'explain', label: 'Explain', hint: 'A node and its neighbours' },
  { id: 'path', label: 'Path', hint: 'Shortest path between two nodes' },
];

interface QueryPanelProps {
  projectPath: string;
}

/**
 * Queryable-graph panel — graphify answers from the code knowledge graph
 * (query / path / explain) instead of static narrative docs. Runs one-shot
 * against the cached graph.json the Functions view already built.
 */
export function QueryPanel({ projectPath }: QueryPanelProps) {
  const [mode, setMode] = useState<Mode>('query');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [result, setResult] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canRun = from.trim().length > 0 && (mode !== 'path' || to.trim().length > 0);

  const run = useCallback(() => {
    if (!canRun) return;
    const args = mode === 'path' ? [from, to] : [from];
    setLoading(true);
    setError(null);
    void api.codeflow
      .query(projectPath, mode, args)
      .then((text) => setResult(text))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [projectPath, mode, from, to, canRun]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      run();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2">
        {MODES.map((m) => (
          <button
            key={m.id}
            onClick={() => {
              setMode(m.id);
              setResult('');
              setError(null);
            }}
            title={m.hint}
            className={cn(
              'h-[24px] rounded-[6px] px-2.5 text-[11px] font-medium transition',
              mode === m.id
                ? 'border border-accent/40 bg-accent/15 text-accent'
                : 'border border-border-subtle bg-surface-3 text-text-secondary hover:text-text',
            )}
          >
            {m.label}
          </button>
        ))}
        <span className="ml-1 truncate text-[10.5px] text-text-muted">
          {MODES.find((m) => m.id === mode)?.hint}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-3 py-2">
        <Search size={13} className="shrink-0 text-text-muted" />
        <input
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            mode === 'path' ? 'from node' : mode === 'explain' ? 'node name' : 'ask about the codebase…'
          }
          className="h-[28px] flex-1 rounded-[7px] border border-border-subtle bg-surface-2 px-2.5 text-[12px] text-text outline-none focus:border-accent/60"
        />
        {mode === 'path' && (
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="to node"
            className="h-[28px] flex-1 rounded-[7px] border border-border-subtle bg-surface-2 px-2.5 text-[12px] text-text outline-none focus:border-accent/60"
          />
        )}
        <button
          onClick={run}
          disabled={loading || !canRun}
          className="inline-flex h-[28px] items-center gap-1.5 rounded-[7px] px-3 text-[11.5px] font-medium text-white transition hover:brightness-110 disabled:opacity-40"
          style={{ background: 'linear-gradient(135deg, var(--color-accent), #a855f7)' }}
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
          <span>Run</span>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {error ? (
          <pre className="whitespace-pre-wrap text-[11.5px] leading-relaxed text-semantic-error">
            {error}
          </pre>
        ) : result ? (
          <pre className="whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-text-secondary">
            {result}
          </pre>
        ) : (
          <div className="flex h-full items-center justify-center text-center text-[12px] text-text-muted">
            <div className="max-w-[420px] space-y-1.5">
              <div className="text-[13px] font-medium text-text">Query the graph</div>
              <p>
                graphify answers from the code knowledge graph — no docs to read. Ask a question,
                explain a symbol, or trace a path between two. (Open the graph first so it’s built.)
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
