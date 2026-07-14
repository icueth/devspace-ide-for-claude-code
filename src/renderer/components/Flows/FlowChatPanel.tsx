import { Eraser, SendHorizontal } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { cn } from '@renderer/lib/utils';
import { useFlowChatStore } from '@renderer/state/flowChat';
import { type FlowRunEvent, useFlowEventsStore } from '@renderer/state/flowEvents';
import type { FlowChatMessage } from '@shared/flowTypes';

/**
 * The lead chat. This is the ONLY place a flow can be started: the user talks
 * to the lead, the lead picks a flow and calls run_flow. The canvas designs and
 * monitors — there is no Run button anywhere, by design.
 *
 * The transcript interleaves two independent streams: chat messages (from main,
 * persisted) and run events (derived renderer-side by diffing run snapshots).
 * Both carry a timestamp, so the merge is a plain sort.
 */

interface Props {
  projectPath: string;
}

type Entry =
  | { kind: 'msg'; at: number; key: string; msg: FlowChatMessage }
  | { kind: 'evt'; at: number; key: string; evt: FlowRunEvent };

export function FlowChatPanel({ projectPath }: Props) {
  const messages = useFlowChatStore((s) => s.messages);
  const busy = useFlowChatStore((s) => s.busy);
  const error = useFlowChatStore((s) => s.error);
  const loadHistory = useFlowChatStore((s) => s.loadHistory);
  const events = useFlowEventsStore((s) => s.events);

  const [text, setText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadHistory(projectPath);
  }, [projectPath, loadHistory]);

  const timeline = useMemo<Entry[]>(() => {
    const entries: Entry[] = [
      ...messages.map((m) => ({ kind: 'msg' as const, at: m.at, key: m.id, msg: m })),
      ...events.map((e) => ({ kind: 'evt' as const, at: e.at, key: e.id, evt: e })),
    ];
    return entries.sort((a, b) => a.at - b.at);
  }, [messages, events]);

  // Pin to the bottom on anything new — including the typing indicator, which
  // is the thing the user is waiting on.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [timeline.length, busy]);

  const submit = async (): Promise<void> => {
    const body = text.trim();
    if (!body || busy) return;
    setText('');
    const ok = await useFlowChatStore.getState().send(body);
    // Main refused the turn — hand the text back rather than eating it.
    if (!ok) setText(body);
  };

  return (
    <aside className="flex w-80 shrink-0 flex-col border-r border-border bg-surface-2">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <span
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            busy
              ? 'bg-semantic-success shadow-[0_0_6px_var(--color-accent)]'
              : 'bg-text-dim',
          )}
        />
        <h2 className="flex-1 text-[12.5px] font-semibold text-text">Chat — lead</h2>
        <span className="shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-[9px] text-text-dim">
          claude -p
        </span>
        <button
          type="button"
          onClick={() => void useFlowChatStore.getState().clear()}
          title="Clear the transcript"
          aria-label="Clear chat history"
          className="flex h-5 w-5 items-center justify-center rounded text-text-muted transition hover:bg-accent/10 hover:text-accent"
        >
          <Eraser size={12} />
        </button>
      </header>

      <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto p-3">
        {timeline.length === 0 && !busy && <ChatEmptyState />}

        {timeline.map((e) =>
          e.kind === 'msg' ? (
            <Bubble key={e.key} msg={e.msg} />
          ) : (
            <EventChip key={e.key} evt={e.evt} />
          ),
        )}

        {busy && <TypingIndicator />}
      </div>

      {error && (
        <div className="border-t border-semantic-error/30 bg-semantic-error/10 px-3 py-1.5 text-[11px] text-semantic-error">
          {error}
        </div>
      )}

      <div className="border-t border-border p-2.5">
        <div className="flex items-end gap-1.5 rounded-lg border border-border bg-surface px-2 py-1.5 transition focus-within:border-accent">
          <textarea
            rows={1}
            value={text}
            disabled={busy}
            placeholder={busy ? 'The lead is working…' : 'Ask the lead to do the work…'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter is a newline — the convention every
              // chat in this app already uses.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            className="max-h-28 min-h-[20px] flex-1 resize-none bg-transparent text-[12.5px] leading-relaxed text-text outline-none placeholder:text-text-dim disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !text.trim()}
            title="Send (Enter)"
            aria-label="Send message"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-accent transition hover:bg-accent/10 disabled:cursor-not-allowed disabled:text-text-dim disabled:hover:bg-transparent"
          >
            <SendHorizontal size={13} />
          </button>
        </div>
        <p className="mt-1.5 px-0.5 text-[10px] text-text-dim">
          The lead picks a flow by its description and starts it. Enter to send.
        </p>
      </div>
    </aside>
  );
}

function ChatEmptyState() {
  return (
    <div className="mt-6 px-2 text-center">
      <p className="text-[12px] font-medium text-text-muted">Ask for the work.</p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-text-dim">
        “Add a CSV export button to the reports page, with tests.” The lead reads
        your flows, picks the one that fits, and runs it — you can keep talking
        while it goes.
      </p>
    </div>
  );
}

function Bubble({ msg }: { msg: FlowChatMessage }) {
  const mine = msg.role === 'user';
  return (
    <div className={cn('flex flex-col', mine ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'max-w-[85%] whitespace-pre-wrap break-words rounded-xl px-2.5 py-1.5 text-[12px] leading-relaxed',
          mine
            ? 'rounded-br-sm bg-accent/15 text-text'
            : msg.error
              ? 'rounded-bl-sm border border-semantic-error/40 bg-semantic-error/10 text-semantic-error'
              : 'rounded-bl-sm border border-border bg-surface-3 text-text',
        )}
      >
        {msg.text}
      </div>
      <span className="mt-0.5 px-1 font-mono text-[9px] text-text-dim">
        {mine ? 'you' : 'lead'} · {clock(msg.at)}
      </span>
    </div>
  );
}

// Run events are centered chips, not bubbles: they come from the machinery, not
// from either party in the conversation.
const CHIP_TONE: Record<string, string> = {
  'run-started': 'border-accent/40 bg-accent/10 text-accent',
  'node-done': 'border-semantic-success/30 bg-semantic-success/5 text-semantic-success',
  'gate-pass': 'border-semantic-success/40 bg-semantic-success/10 text-semantic-success',
  'gate-fail': 'border-semantic-error/40 bg-semantic-error/10 text-semantic-error',
  'node-failed': 'border-semantic-error/40 bg-semantic-error/10 text-semantic-error',
  'node-retry': 'border-semantic-warning/40 bg-semantic-warning/10 text-semantic-warning',
  'run-failed': 'border-semantic-error/40 bg-semantic-error/10 text-semantic-error',
  'run-stopped': 'border-border bg-surface-3 text-text-muted',
  'run-done': 'border-accent/40 bg-accent/10 text-accent',
};

function EventChip({ evt }: { evt: FlowRunEvent }) {
  return (
    <div className="flex justify-center py-0.5">
      <span
        className={cn(
          'max-w-full truncate rounded-full border px-2.5 py-1 text-[10.5px]',
          CHIP_TONE[evt.kind] ?? 'border-border bg-surface-3 text-text-muted',
        )}
        title={evt.text}
      >
        {evt.text}
        {evt.tokens !== undefined && (
          <span className="ml-1.5 font-mono opacity-70">≈{fmtTokens(evt.tokens)}</span>
        )}
      </span>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex items-center gap-1.5 px-1 pt-0.5">
      <span className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent"
            style={{ animationDelay: `${i * 140}ms` }}
          />
        ))}
      </span>
      <span className="text-[10.5px] text-text-dim">lead is thinking…</span>
    </div>
  );
}

export function fmtTokens(t: number): string {
  return t >= 1000 ? `${(t / 1000).toFixed(1)}k tok` : `${t} tok`;
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}
