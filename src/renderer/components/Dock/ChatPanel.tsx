import {
  CircleSlash,
  Loader2,
  MessageSquarePlus,
  Send,
  Trash2,
  User,
  Wrench,
} from 'lucide-react';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import type { ChatEvent, ChatMessage, ChatThread } from '@shared/types';

const MarkdownPreview = lazy(() =>
  import('@renderer/components/Editor/MarkdownPreview').then((m) => ({
    default: m.MarkdownPreview,
  })),
);

interface ChatPanelProps {
  projectPath: string;
}

/**
 * Beta chat surface — claude --print stream-json output rendered as
 * conversation bubbles. Alternative to the existing PTY-backed dock pane;
 * trades per-tool TTY approvals (we run `--permission-mode bypassPermissions`)
 * for a structured UI that can group tool calls, scroll cleanly, and
 * persist threads as JSON on disk.
 */
export function ChatPanel({ projectPath }: ChatPanelProps) {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Initial load + subscribe for streaming events. The hook also creates
  // a first thread automatically so the panel never opens to an empty
  // "pick a thread" placeholder.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const initial = await api.chat.listThreads(projectPath);
      if (cancelled) return;
      if (initial.length === 0) {
        const t = await api.chat.createThread(projectPath, 'New chat');
        if (!cancelled) {
          setThreads([t]);
          setActiveId(t.id);
        }
      } else {
        setThreads(initial);
        setActiveId(initial[0]!.id);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  // Apply streaming events into the matching thread / message. The
  // backend already persists to disk; we mirror in renderer state so the
  // UI updates immediately rather than waiting for a re-fetch.
  useEffect(() => {
    return api.chat.onEvent(projectPath, (threadId, event) => {
      setThreads((prev) => prev.map((t) => applyEvent(t, threadId, event)));
    });
  }, [projectPath]);

  // Auto-scroll to bottom on streaming chunks unless the user has
  // scrolled up to read. Implemented naively — every event scrolls; if
  // it gets annoying we add an "auto-follow" toggle.
  const activeThread = useMemo(
    () => threads.find((t) => t.id === activeId) ?? null,
    [threads, activeId],
  );
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [activeThread?.messages.length, activeThread?.messages.at(-1)?.content]);

  const onSend = useCallback(async () => {
    if (!activeId || !input.trim() || sending) return;
    const text = input.trim();
    setInput('');
    setSending(true);
    try {
      await api.chat.send({
        projectId: projectPath,
        threadId: activeId,
        text,
      });
      // Refresh thread list once after submit so the new user+assistant
      // pair shows even before the first stream event arrives.
      const next = await api.chat.listThreads(projectPath);
      setThreads(next);
    } catch (err) {
      console.error('[chat] send failed', err);
    } finally {
      setSending(false);
    }
  }, [activeId, input, sending, projectPath]);

  const onCancel = useCallback(() => {
    void api.chat.cancel(projectPath);
  }, [projectPath]);

  const onNewThread = useCallback(async () => {
    const t = await api.chat.createThread(projectPath, 'New chat');
    setThreads((prev) => [t, ...prev]);
    setActiveId(t.id);
  }, [projectPath]);

  const onDeleteThread = useCallback(
    async (id: string) => {
      await api.chat.deleteThread(projectPath, id);
      setThreads((prev) => prev.filter((t) => t.id !== id));
      if (activeId === id) {
        const next = threads.find((t) => t.id !== id);
        setActiveId(next?.id ?? null);
      }
    },
    [projectPath, activeId, threads],
  );

  const isStreaming = activeThread?.messages.some(
    (m) => m.status === 'streaming',
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-surface">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface-2 px-3 py-2">
        <select
          value={activeId ?? ''}
          onChange={(e) => setActiveId(e.target.value)}
          className="min-w-0 flex-1 truncate rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-1 text-[11.5px] text-text focus:outline-none focus:ring-1 focus:ring-accent/40"
        >
          {threads.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>
        <button
          onClick={onNewThread}
          title="New chat thread"
          className="rounded p-1.5 text-text-muted transition hover:bg-surface-3 hover:text-text"
        >
          <MessageSquarePlus size={13} />
        </button>
        {activeId && (
          <button
            onClick={() => void onDeleteThread(activeId)}
            title="Delete this thread"
            className="rounded p-1.5 text-text-muted transition hover:bg-surface-3 hover:text-semantic-error"
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {activeThread?.messages.length ? (
          <div className="space-y-4">
            {activeThread.messages.map((m) => (
              <MessageBubble key={m.id} message={m} />
            ))}
            <div ref={messagesEndRef} />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-center text-[12px] text-text-muted">
            <div>
              <div className="text-text">Empty thread.</div>
              <div className="mt-1">Send a message to start chatting with claude.</div>
            </div>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border bg-surface-2 px-3 py-2">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void onSend();
              }
            }}
            rows={2}
            placeholder="Ask claude…  (Enter to send, Shift+Enter for newline)"
            className="min-h-0 flex-1 resize-none rounded-[7px] border border-border-subtle bg-surface-3 px-3 py-2 text-[12.5px] text-text placeholder:text-text-dim focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40"
          />
          {isStreaming ? (
            <button
              onClick={onCancel}
              className="inline-flex h-[34px] shrink-0 items-center gap-1 rounded-[7px] border border-semantic-error/40 bg-semantic-error/10 px-3 text-[11.5px] text-semantic-error transition hover:bg-semantic-error/15"
              title="Stop the running turn"
            >
              <CircleSlash size={11} />
              <span>Stop</span>
            </button>
          ) : (
            <button
              onClick={() => void onSend()}
              disabled={!input.trim() || sending}
              className="inline-flex h-[34px] shrink-0 items-center gap-1.5 rounded-[7px] px-3 text-[11.5px] font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
              style={{
                background:
                  'linear-gradient(135deg, var(--color-accent), #a855f7)',
                boxShadow: '0 2px 8px var(--color-accent-glow)',
              }}
            >
              {sending ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <Send size={11} />
              )}
              <span>Send</span>
            </button>
          )}
        </div>
        <div className="mt-1 text-[10px] text-text-dim">
          Beta · runs `claude --print --permission-mode bypassPermissions` per
          turn. Tool actions auto-approve.
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex gap-2.5">
        <div className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-surface-4">
          <User size={12} className="text-text-muted" />
        </div>
        <div className="min-w-0 flex-1 whitespace-pre-wrap break-words rounded-[10px] bg-surface-3 px-3 py-2 text-[12.5px] text-text">
          {message.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-2.5">
      <div
        className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
        style={{
          background: 'linear-gradient(135deg, var(--color-accent), #a855f7)',
        }}
      >
        c
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        {message.toolCalls.length > 0 && (
          <ToolCallList calls={message.toolCalls} />
        )}
        {message.content ? (
          <div className="prose prose-invert max-w-none text-[12.5px] leading-relaxed prose-headings:mt-3 prose-headings:mb-1.5 prose-p:my-1.5 prose-pre:my-2 prose-pre:rounded-md prose-pre:bg-surface-3 prose-pre:p-2.5 prose-pre:text-[11.5px] prose-code:rounded prose-code:bg-surface-3 prose-code:px-1 prose-code:py-0.5 prose-code:text-[11.5px] prose-code:before:content-none prose-code:after:content-none prose-a:text-accent">
            <Suspense
              fallback={
                <div className="text-[12px] text-text-muted">Rendering…</div>
              }
            >
              <MarkdownPreview markdown={message.content} />
            </Suspense>
          </div>
        ) : message.status === 'streaming' ? (
          <div className="flex items-center gap-1.5 text-[11.5px] text-text-muted">
            <Loader2 size={11} className="animate-spin" />
            <span>thinking…</span>
          </div>
        ) : null}
        {message.status === 'error' && (
          <div className="rounded-[7px] border border-semantic-error/40 bg-semantic-error/10 px-3 py-2 font-mono text-[10.5px] text-semantic-error">
            {message.error ?? 'unknown error'}
          </div>
        )}
        {message.usage && (
          <div className="text-[10px] text-text-dim">
            {message.usage.input} in / {message.usage.output} out tokens
          </div>
        )}
      </div>
    </div>
  );
}

function ToolCallList({ calls }: { calls: ChatMessage['toolCalls'] }) {
  return (
    <div className="space-y-1">
      {calls.map((c) => (
        <details
          key={c.id}
          className="rounded-[7px] border border-border-subtle bg-surface-2"
        >
          <summary className="flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-[11px] text-text-secondary">
            <Wrench size={10} className="text-accent" />
            <span className="font-mono">{c.name}</span>
            <span className="truncate text-text-muted">
              {summarizeInput(c.input)}
            </span>
            {c.result === undefined && (
              <Loader2 size={10} className="ml-auto shrink-0 animate-spin" />
            )}
            {c.isError && (
              <span className="ml-auto shrink-0 text-semantic-error">!</span>
            )}
          </summary>
          <div className="space-y-1.5 border-t border-border-subtle px-2.5 py-1.5">
            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-surface-3 px-2 py-1 font-mono text-[10.5px] text-text-muted">
              {JSON.stringify(c.input, null, 2)}
            </pre>
            {c.result !== undefined && (
              <pre
                className={cn(
                  'overflow-x-auto whitespace-pre-wrap break-words rounded px-2 py-1 font-mono text-[10.5px]',
                  c.isError
                    ? 'bg-semantic-error/10 text-semantic-error'
                    : 'bg-surface-3 text-text-secondary',
                )}
              >
                {(c.result ?? '').slice(0, 2000)}
                {(c.result ?? '').length > 2000 && '\n…(truncated)'}
              </pre>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}

function summarizeInput(input: Record<string, unknown>): string {
  const fp = (input.file_path as string) || (input.path as string) || '';
  const cmd = (input.command as string) || '';
  const pat = (input.pattern as string) || (input.query as string) || '';
  if (fp) return shortPath(fp);
  if (cmd) return truncate(cmd, 80);
  if (pat) return `"${truncate(pat, 60)}"`;
  return '';
}

function shortPath(p: string): string {
  const segs = p.split('/');
  return segs.length > 4 ? `…/${segs.slice(-3).join('/')}` : p;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Fold a streaming ChatEvent into a thread's last assistant message.
 * Keeps the renderer state shape identical to what the backend persists,
 * so re-fetching on send (which we do after every turn) is a no-op when
 * events have already arrived.
 */
function applyEvent(
  thread: ChatThread,
  threadId: string,
  event: ChatEvent,
): ChatThread {
  if (thread.id !== threadId) return thread;
  const messages = [...thread.messages];
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return thread;

  if (event.kind === 'text_delta' && event.text) {
    last.content += event.text;
  } else if (event.kind === 'thinking_delta' && event.text) {
    last.thinking = (last.thinking ?? '') + event.text;
  } else if (event.kind === 'tool_use') {
    last.toolCalls = [
      ...last.toolCalls,
      {
        id: event.toolUseId ?? `tu-${Date.now()}`,
        name: event.toolName ?? 'tool',
        input: event.toolInput ?? {},
      },
    ];
  } else if (event.kind === 'tool_result') {
    last.toolCalls = last.toolCalls.map((c) =>
      c.id === event.toolUseId
        ? { ...c, result: event.toolResult ?? '', isError: event.toolIsError }
        : c,
    );
  } else if (event.kind === 'usage') {
    last.usage = {
      input: event.inputTokens ?? 0,
      output: event.outputTokens ?? 0,
    };
  } else if (event.kind === 'error') {
    last.status = 'error';
    last.error = event.message;
  } else if (event.kind === 'done') {
    // Backend already determined the terminal state and persisted it.
    // We don't override here; subsequent listThreads refreshes will sync.
  }

  return { ...thread, messages };
}
