import { ChevronDown, ChevronUp } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { cn } from '@renderer/lib/utils';
import {
  type FlowEventKind,
  type FlowRunEvent,
  eventsForRun,
  useFlowEventsStore,
} from '@renderer/state/flowEvents';
import type { FlowRun } from '@shared/flowTypes';

/**
 * The run log strip: a dense timestamped view of the derived run timeline,
 * scoped to the run the canvas is visualizing — the log is about the flow in
 * front of you, not about the project as a whole.
 *
 * Collapsible and local to FlowsView (NOT a global console): it is part of
 * reading the canvas, and it must not follow the user to another view.
 */

const TAG: Record<FlowEventKind, { tag: string; cls: string }> = {
  'run-started': { tag: 'run', cls: 'text-accent' },
  'node-started': { tag: 'run', cls: 'text-accent' },
  'node-done': { tag: 'done', cls: 'text-semantic-success' },
  'node-failed': { tag: 'fail', cls: 'text-semantic-error' },
  'node-retry': { tag: 'retry', cls: 'text-semantic-warning' },
  'gate-pass': { tag: 'gate', cls: 'text-semantic-success' },
  'gate-fail': { tag: 'gate', cls: 'text-semantic-error' },
  'run-done': { tag: 'end', cls: 'text-accent' },
  'run-failed': { tag: 'end', cls: 'text-semantic-error' },
  'run-stopped': { tag: 'end', cls: 'text-text-muted' },
};

interface Props {
  run: FlowRun | null;
}

export function FlowRunLog({ run }: Props) {
  const [open, setOpen] = useState(true);
  const events = useFlowEventsStore((s) => s.events);
  const lines = eventsForRun(events, run?.id ?? null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, open]);

  const done = run?.nodes.filter((n) => n.status === 'done').length ?? 0;
  const total = run?.nodes.length ?? 0;

  return (
    <section
      aria-label="Run log"
      className={cn(
        'flex shrink-0 flex-col border-t border-border bg-surface-2',
        open && 'h-36',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex shrink-0 items-center gap-2 px-3 py-1.5 text-left transition hover:bg-surface-3"
      >
        <span className="text-[10px] font-semibold uppercase tracking-wider text-text-dim">
          Run log
        </span>
        {run ? (
          <span className="font-mono text-[10px] text-text-muted">
            {run.flowName} · {run.status} · {done}/{total} done
          </span>
        ) : (
          <span className="font-mono text-[10px] text-text-dim">no runs yet</span>
        )}
        <span className="flex-1" />
        {open ? (
          <ChevronDown size={13} className="text-text-dim" />
        ) : (
          <ChevronUp size={13} className="text-text-dim" />
        )}
      </button>

      {open && (
        <div
          ref={bodyRef}
          className="flex-1 overflow-y-auto px-3 pb-2 font-mono text-[10.5px] leading-relaxed"
        >
          {lines.length === 0 ? (
            <p className="pt-1 text-text-dim">
              Ask your claude tab in the dock to start this flow — every node
              transition lands here.
            </p>
          ) : (
            lines.map((e) => <LogLine key={e.id} evt={e} />)
          )}
        </div>
      )}
    </section>
  );
}

function LogLine({ evt }: { evt: FlowRunEvent }) {
  const { tag, cls } = TAG[evt.kind];
  return (
    <div className="flex gap-2">
      <span className="shrink-0 text-text-dim">{stamp(evt.at)}</span>
      <span className={cn('w-11 shrink-0', cls)}>[{tag}]</span>
      <span className="min-w-0 flex-1 truncate text-text-muted" title={evt.text}>
        {evt.text}
      </span>
      {evt.tokens !== undefined && (
        <span className="shrink-0 text-text-dim">≈{fmtTokens(evt.tokens)}</span>
      )}
    </div>
  );
}

function fmtTokens(t: number): string {
  return t >= 1000 ? `${(t / 1000).toFixed(1)}k tok` : `${t} tok`;
}

function stamp(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
