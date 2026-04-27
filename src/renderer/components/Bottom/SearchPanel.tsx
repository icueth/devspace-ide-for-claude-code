import {
  ChevronDown,
  ChevronRight,
  Filter,
  Regex,
  Search as SearchIcon,
  Type,
  WholeWord,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import { useEditorStore } from '@renderer/state/editor';
import type { SearchMatch, SearchResult } from '@shared/types';

interface SearchPanelProps {
  projectPath: string;
  isActive?: boolean;
}

interface GroupedMatches {
  absolutePath: string;
  relativePath: string;
  matches: SearchMatch[];
}

function groupByFile(matches: SearchMatch[]): GroupedMatches[] {
  const groups = new Map<string, GroupedMatches>();
  for (const m of matches) {
    const g = groups.get(m.absolutePath);
    if (g) g.matches.push(m);
    else
      groups.set(m.absolutePath, {
        absolutePath: m.absolutePath,
        relativePath: m.file,
        matches: [m],
      });
  }
  return [...groups.values()];
}

function splitGlobs(input: string): string[] {
  return input
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function SearchPanel({ projectPath, isActive }: SearchPanelProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState('');
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [includeGlobs, setIncludeGlobs] = useState('');
  const [excludeGlobs, setExcludeGlobs] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState(0);
  const openFile = useEditorStore((s) => s.open);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResult(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const handle = setTimeout(async () => {
      try {
        const r = await api.search.grep(projectPath, trimmed, {
          regex,
          caseSensitive,
          wholeWord,
          includeGlobs: splitGlobs(includeGlobs),
          excludeGlobs: splitGlobs(excludeGlobs),
          maxResults: 500,
        });
        setResult(r);
        setCursor(0);
      } catch (err) {
        console.error('[SearchPanel] grep failed', err);
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => clearTimeout(handle);
  }, [query, regex, caseSensitive, wholeWord, includeGlobs, excludeGlobs, projectPath]);

  useEffect(() => {
    if (isActive) inputRef.current?.focus();
  }, [isActive]);

  const grouped = useMemo(() => (result ? groupByFile(result.matches) : []), [result]);

  // Flat visible list — respects collapsed groups — so ↑/↓ can walk them.
  const flat = useMemo(() => {
    const rows: Array<
      | { kind: 'header'; group: GroupedMatches }
      | { kind: 'match'; group: GroupedMatches; match: SearchMatch }
    > = [];
    for (const g of grouped) {
      rows.push({ kind: 'header', group: g });
      if (!collapsed.has(g.absolutePath)) {
        for (const m of g.matches) rows.push({ kind: 'match', group: g, match: m });
      }
    }
    return rows;
  }, [grouped, collapsed]);

  // Keep cursor in valid range whenever the flat list changes.
  useEffect(() => {
    if (cursor >= flat.length) setCursor(Math.max(0, flat.length - 1));
  }, [flat.length, cursor]);

  const toggleGroup = useCallback((absPath: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(absPath)) next.delete(absPath);
      else next.add(absPath);
      return next;
    });
  }, []);

  const activateRow = useCallback(
    (i: number) => {
      const row = flat[i];
      if (!row) return;
      if (row.kind === 'header') {
        toggleGroup(row.group.absolutePath);
      } else {
        void openFile(row.match.absolutePath, {
          line: row.match.line,
          column: row.match.column,
        });
      }
    },
    [flat, toggleGroup, openFile],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(flat.length - 1, c + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activateRow(cursor);
    } else if (e.key === 'ArrowLeft') {
      const row = flat[cursor];
      if (row && !collapsed.has(row.group.absolutePath)) {
        e.preventDefault();
        toggleGroup(row.group.absolutePath);
      }
    } else if (e.key === 'ArrowRight') {
      const row = flat[cursor];
      if (row && collapsed.has(row.group.absolutePath)) {
        e.preventDefault();
        toggleGroup(row.group.absolutePath);
      }
    }
  };

  // Keep the selected row in view as cursor moves.
  useLayoutEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${cursor}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const fileCount = grouped.length;

  return (
    <div className="flex h-full flex-col text-[12px]" onKeyDown={onKeyDown}>
      <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-3 py-2">
        <div className="relative flex-1">
          <SearchIcon
            size={12}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search in ${projectPath.split('/').pop()}…`}
            className="h-7 w-full rounded border border-border bg-surface-raised pl-7 pr-2 text-[12px] text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded hover:bg-surface-overlay"
            >
              <X size={11} />
            </button>
          )}
        </div>
        <ToggleButton
          active={caseSensitive}
          onClick={() => setCaseSensitive((v) => !v)}
          title="Case sensitive"
        >
          <Type size={12} />
        </ToggleButton>
        <ToggleButton
          active={wholeWord}
          onClick={() => setWholeWord((v) => !v)}
          title="Whole word"
        >
          <WholeWord size={12} />
        </ToggleButton>
        <ToggleButton
          active={regex}
          onClick={() => setRegex((v) => !v)}
          title="Regular expression"
        >
          <Regex size={12} />
        </ToggleButton>
        <ToggleButton
          active={showFilters || !!includeGlobs || !!excludeGlobs}
          onClick={() => setShowFilters((v) => !v)}
          title="Include / exclude globs"
        >
          <Filter size={12} />
        </ToggleButton>
      </div>

      {showFilters && (
        <div className="flex shrink-0 flex-col gap-1.5 border-b border-border-subtle bg-surface-2/60 px-3 py-2">
          <GlobInput
            label="files to include"
            placeholder="src/**/*.ts, *.md"
            value={includeGlobs}
            onChange={setIncludeGlobs}
          />
          <GlobInput
            label="files to exclude"
            placeholder="**/node_modules, **/*.test.*"
            value={excludeGlobs}
            onChange={setExcludeGlobs}
          />
        </div>
      )}

      <div className="flex shrink-0 items-center justify-between border-b border-border-subtle px-3 py-1 text-[10px] text-text-muted">
        <span>
          {loading
            ? 'Searching…'
            : result
              ? `${result.matches.length} match${result.matches.length === 1 ? '' : 'es'} · ${fileCount} file${fileCount === 1 ? '' : 's'}${result.truncated ? ' (truncated)' : ''} · ${result.elapsedMs}ms`
              : 'Type to search the project.'}
        </span>
        {grouped.length > 0 && (
          <button
            onClick={() => {
              if (collapsed.size === grouped.length) setCollapsed(new Set());
              else setCollapsed(new Set(grouped.map((g) => g.absolutePath)));
            }}
            className="text-[10px] text-text-muted hover:text-text"
          >
            {collapsed.size === grouped.length ? 'Expand all' : 'Collapse all'}
          </button>
        )}
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
        {flat.map((row, i) => {
          if (row.kind === 'header') {
            const isCollapsed = collapsed.has(row.group.absolutePath);
            const selected = i === cursor;
            return (
              <button
                key={`h:${row.group.absolutePath}`}
                data-row={i}
                onClick={() => {
                  setCursor(i);
                  toggleGroup(row.group.absolutePath);
                }}
                className={cn(
                  'sticky top-0 z-10 flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-[11px]',
                  selected
                    ? 'bg-accent/15 text-text'
                    : 'bg-surface-sidebar text-text-secondary hover:bg-surface-3',
                )}
              >
                {isCollapsed ? (
                  <ChevronRight size={11} className="shrink-0 text-text-muted" />
                ) : (
                  <ChevronDown size={11} className="shrink-0 text-text-muted" />
                )}
                <span className="min-w-0 flex-1 truncate font-medium">
                  {row.group.relativePath}
                </span>
                <span className="shrink-0 rounded-full bg-surface-4 px-1.5 py-[1px] text-[9.5px] text-text-muted">
                  {row.group.matches.length}
                </span>
              </button>
            );
          }
          const selected = i === cursor;
          return (
            <button
              key={`m:${row.group.absolutePath}:${row.match.line}:${row.match.column}`}
              data-row={i}
              onClick={() => {
                setCursor(i);
                activateRow(i);
              }}
              className={cn(
                'flex w-full items-start gap-3 px-3 py-1 text-left font-mono text-[11px]',
                selected
                  ? 'bg-accent/20 text-text'
                  : 'text-text-secondary hover:bg-surface-raised',
              )}
            >
              <span className="w-10 shrink-0 text-right text-text-muted">
                {row.match.line}
              </span>
              <span className="min-w-0 flex-1 truncate">
                <HighlightedLine match={row.match} />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface HighlightedLineProps {
  match: SearchMatch;
}

function HighlightedLine({ match }: HighlightedLineProps) {
  const MAX = 220;
  const text = match.lineText.length > MAX ? match.lineText.slice(0, MAX) + '…' : match.lineText;
  const ranges = [...match.ranges].sort((a, b) => a.start - b.start);
  if (ranges.length === 0) return <>{text}</>;

  const parts: React.ReactNode[] = [];
  let pos = 0;
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    const start = Math.max(0, Math.min(text.length, r.start));
    const end = Math.max(start, Math.min(text.length, r.end));
    if (pos < start) parts.push(<span key={`t${i}`}>{text.slice(pos, start)}</span>);
    if (start < end) {
      parts.push(
        <span
          key={`h${i}`}
          className="rounded bg-accent/25 text-text"
          style={{ boxShadow: 'inset 0 -1px 0 rgba(76,141,255,0.5)' }}
        >
          {text.slice(start, end)}
        </span>,
      );
    }
    pos = end;
  }
  if (pos < text.length) parts.push(<span key="tail">{text.slice(pos)}</span>);
  return <>{parts}</>;
}

interface GlobInputProps {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
}

function GlobInput({ label, placeholder, value, onChange }: GlobInputProps) {
  return (
    <label className="flex items-center gap-2 text-[11px]">
      <span className="w-[110px] shrink-0 text-text-muted">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-6 flex-1 rounded border border-border bg-surface-raised px-2 text-[11px] text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
      />
    </label>
  );
}

interface ToggleButtonProps {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}

function ToggleButton({ active, onClick, title, children }: ToggleButtonProps) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        'flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-muted transition',
        active ? 'bg-accent/20 text-accent' : 'hover:bg-surface-raised hover:text-text',
      )}
    >
      {children}
    </button>
  );
}
