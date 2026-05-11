import 'highlight.js/styles/github-dark.css';

import {
  ArrowDown,
  CheckCircle2,
  Circle,
  CircleSlash,
  Loader2,
  MessageSquarePlus,
  Paperclip,
  Send,
  Trash2,
  User,
  Users,
  Wrench,
  XCircle,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

import { ChatSettingsDrawer } from '@renderer/components/Dock/ChatSettingsDrawer';
import {
  parseSlashInput,
  SlashPalette,
  type SlashCommand,
} from '@renderer/components/Dock/SlashPalette';
import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import type {
  ChatEvent,
  ChatMessage,
  ChatThread,
  TeamDef,
  TeamStep,
} from '@shared/types';

// Slash commands available in the chat input. These are UI actions —
// not pass-throughs to claude. They're the chat-mode answer to the
// CLI's `/model`, `/clear`, `/help`, etc. since `claude --print`
// doesn't parse slashes at all.
const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: 'new',
    trigger: 'new',
    description: 'Start a new chat thread',
  },
  {
    id: 'clear',
    trigger: 'clear',
    description: 'Delete this thread and start fresh',
  },
  {
    id: 'settings',
    trigger: 'settings',
    description: 'Open chat settings (model, system prompt, tools)',
  },
  {
    id: 'model',
    trigger: 'model',
    description: 'Open settings focused on model picker',
    hasArgs: true,
    argHint: '<sonnet | opus | haiku | id>',
  },
  {
    id: 'system',
    trigger: 'system',
    description: 'Open settings focused on system prompt',
    hasArgs: true,
    argHint: '<append text>',
  },
  {
    id: 'help',
    trigger: 'help',
    description: 'Show this command palette',
  },
];

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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Team mode state — when a team is selected, the next send routes
  // through ChatService's team logic (sequential or orchestrator). When
  // null, sends as a normal solo claude turn.
  const [teams, setTeams] = useState<TeamDef[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  // Opt-in "Start in new thread" — creates a fresh thread before the
  // team send so the run gets clean context. Default off because most
  // team uses are follow-ups within an ongoing conversation.
  const [runInNewThread, setRunInNewThread] = useState(false);
  // Settings drawer open-state is hoisted here so the slash palette can
  // pop it via /settings, /model, /system without needing imperative
  // refs into the drawer component.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Slash palette state — only meaningful while `input` starts with '/'.
  const [paletteHighlight, setPaletteHighlight] = useState(0);
  const slashActive = input.startsWith('/') && !input.includes('\n');
  // Sticky scroll — same pattern Slack/Discord use. The container
  // auto-scrolls to bottom on every content change BUT only while the
  // user is "near bottom". If the user scrolls up to read earlier
  // messages, sticking pauses and a "↓ jump to latest" floating button
  // appears; clicking it re-engages sticking and smooth-scrolls down.
  // Using a ref instead of state so the scroll handler doesn't trigger
  // a re-render on every wheel event.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  // Append an `@<relative-path>` token into the input. Claude Code parses
  // `@path` references in the prompt as file attachments (resolves the
  // path, reads the file, and includes its content as a tool result).
  // For images it does the equivalent — pulls the bytes in for vision.
  // This is the same UX as the CLI's native `@` syntax, just driven
  // from a button + file picker instead of typing the path manually.
  const insertAttachment = useCallback((absPath: string) => {
    const norm = absPath.replace(/^\/+/, '/');
    const rel = norm.startsWith(`${projectPath}/`)
      ? norm.slice(projectPath.length + 1)
      : norm;
    setInput((prev) => {
      const sep = prev && !prev.endsWith(' ') && !prev.endsWith('\n') ? ' ' : '';
      return `${prev}${sep}@${rel} `;
    });
  }, [projectPath]);

  const onAttachClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onFilePicked = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files) return;
      for (const f of Array.from(files)) {
        // Electron 32+ removed `File.path`; use the preload bridge that
        // calls `webUtils.getPathForFile()` instead. Empty string =
        // browser/synthesized file with no on-disk path; skip those.
        const p = api.files.getPathForFile(f);
        if (p) insertAttachment(p);
      }
      // Reset so picking the same file twice in a row still fires
      // onChange the second time.
      e.target.value = '';
    },
    [insertAttachment],
  );

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

  // Load teams whenever the project changes. Teams live at
  // <project>/.devspace/teams.json so switching folders gives a fresh
  // list; if there are no teams, the picker hides itself.
  const loadTeams = useCallback(async () => {
    const list = await api.teams.list(projectPath);
    setTeams(list);
    // If the previously-selected team no longer exists (deleted /
    // project switched), fall back to solo so we don't ghost-send to
    // a missing team.
    setSelectedTeamId((prev) =>
      prev && !list.find((t) => t.id === prev) ? null : prev,
    );
  }, [projectPath]);

  useEffect(() => {
    void loadTeams();
  }, [loadTeams]);

  // Re-fetch teams when:
  //   • another part of the renderer dispatches `devspace:teams-changed`
  //     (TeamsSettings emits this after save / delete so the chat
  //     picker updates without a window reload)
  //   • the window regains focus (covers external edits — user opens
  //     teams.json in another editor and saves)
  useEffect(() => {
    const refresh = (e?: Event) => {
      if (e instanceof CustomEvent) {
        const detail = e.detail as { projectPath?: string } | undefined;
        // Custom events carry the project they apply to; ignore changes
        // to other projects so opening Settings on workspace A doesn't
        // ping every chat panel.
        if (detail?.projectPath && detail.projectPath !== projectPath) return;
      }
      void loadTeams();
    };
    window.addEventListener('devspace:teams-changed', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener('devspace:teams-changed', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [loadTeams, projectPath]);

  const activeThread = useMemo(
    () => threads.find((t) => t.id === activeId) ?? null,
    [threads, activeId],
  );

  // Wheel/touch scroll handler — flips the stick flag based on distance
  // from bottom. 60px threshold means a small overshoot at the bottom
  // still counts as "near bottom" and keeps sticking engaged. Updates
  // the jump-button visibility via setState so we don't drop a React
  // render when the user pulls away from the bottom.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distance < 60;
    stickRef.current = nearBottom;
    setShowJump((prev) => (prev === nearBottom ? !nearBottom : prev));
  }, []);

  // Layout effect — runs synchronously after every render, BEFORE the
  // browser paints. Auto-scrolls when sticking. Critical that this is
  // useLayoutEffect (not useEffect) so the jump doesn't visibly tick
  // through an intermediate position during streaming text.
  useLayoutEffect(() => {
    if (!stickRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  });

  // Switching threads — start from the bottom and engage sticking.
  useLayoutEffect(() => {
    stickRef.current = true;
    setShowJump(false);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeId]);

  const jumpToLatest = useCallback(() => {
    stickRef.current = true;
    setShowJump(false);
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, []);

  const onSend = useCallback(async () => {
    if (!activeId || !input.trim() || sending) return;
    const text = input.trim();
    setInput('');
    setSending(true);
    try {
      // If team mode + "new thread" toggle, create a fresh thread first
      // so the run starts with empty context. Reset the toggle after
      // use — it's per-send, not sticky.
      let targetThreadId = activeId;
      if (selectedTeamId && runInNewThread) {
        const team = teams.find((t) => t.id === selectedTeamId);
        const title = team
          ? `[${team.name}] ${text.split('\n')[0]!.slice(0, 50)}`
          : text.split('\n')[0]!.slice(0, 60);
        const t = await api.chat.createThread(projectPath, title);
        setThreads((prev) => [t, ...prev]);
        setActiveId(t.id);
        targetThreadId = t.id;
        setRunInNewThread(false);
      }
      await api.chat.send({
        projectId: projectPath,
        threadId: targetThreadId,
        text,
        ...(selectedTeamId ? { teamId: selectedTeamId } : {}),
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
  }, [activeId, input, sending, projectPath, selectedTeamId, runInNewThread, teams]);

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

  // Execute a parsed slash command. Returns true if the input should be
  // cleared (command fully handled), false if the user still needs to
  // type args (e.g. picked `/model` from the palette — we autocomplete
  // to `/model ` and wait for the value).
  const executeSlash = useCallback(
    async (trigger: string, args: string): Promise<boolean> => {
      switch (trigger) {
        case 'new': {
          const t = await api.chat.createThread(projectPath, 'New chat');
          setThreads((prev) => [t, ...prev]);
          setActiveId(t.id);
          return true;
        }
        case 'clear': {
          if (!activeId) return true;
          await api.chat.deleteThread(projectPath, activeId);
          const t = await api.chat.createThread(projectPath, 'New chat');
          setThreads((prev) => [t, ...prev.filter((x) => x.id !== activeId)]);
          setActiveId(t.id);
          return true;
        }
        case 'model':
        case 'system':
        case 'settings': {
          setSettingsOpen(true);
          // /model X — we can't apply directly without re-loading the
          // drawer's project-default config, but opening the drawer
          // pre-focused is the standard claude-CLI behavior anyway.
          // Future: persist `args` as a pending override and merge into
          // the drawer's initial form state.
          void args;
          return true;
        }
        case 'help': {
          // Palette stays visible while input starts with `/`. Forcing
          // the input back to a single slash keeps every command shown.
          setInput('/');
          return false;
        }
        default:
          return false;
      }
    },
    [projectPath, activeId],
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
        <ChatSettingsDrawer
          projectPath={projectPath}
          thread={activeThread}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          onThreadConfigChanged={(updated) => {
            // Mirror the saved override into renderer state so badges /
            // future sends see the new config without a full refetch.
            setThreads((prev) =>
              prev.map((t) => (t.id === updated.id ? updated : t)),
            );
          }}
        />
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

      {/* Team picker — always rendered so the user has a visible hook
          to discover Team mode. When no teams exist, the dropdown shows
          a single hint option pointing them at Settings. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface-2 px-3 py-1.5">
        <Users size={11} className="shrink-0 text-text-muted" />
        <span className="text-[10.5px] text-text-muted">Team:</span>
        <select
          value={selectedTeamId ?? ''}
          onChange={(e) => setSelectedTeamId(e.target.value || null)}
          className="min-w-0 rounded-[5px] border border-border-subtle bg-surface-3 px-2 py-[2px] text-[11px] text-text focus:outline-none focus:ring-1 focus:ring-accent/40"
        >
          <option value="">— Solo (no team) —</option>
          {teams.length === 0 && (
            <option value="" disabled>
              (no teams yet — create one in Settings → Teams)
            </option>
          )}
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.scope === 'global' ? '🌐 ' : '📁 '}
              {t.name} ({t.mode} · {t.members.length})
            </option>
          ))}
        </select>
        {selectedTeamId && (
          <label
            className="ml-auto flex cursor-pointer items-center gap-1 text-[10.5px] text-text-muted hover:text-text"
            title="Create a fresh thread so this team run starts with clean context"
          >
            <input
              type="checkbox"
              checked={runInNewThread}
              onChange={(e) => setRunInNewThread(e.target.checked)}
              className="h-3 w-3 accent-accent"
            />
            <span>Start in new thread</span>
          </label>
        )}
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          // Explicit select-text so the bubbles inside inherit the
          // ability to be highlighted + copied. Some Electron host
          // chrome (and Tailwind's drag-region helpers) set
          // user-select:none on ancestor elements, which would
          // otherwise propagate down and lock the chat read-only.
          className="absolute inset-0 select-text overflow-y-auto px-4 py-3"
        >
          {activeThread?.messages.length ? (
            <div className="space-y-4">
              {activeThread.messages.map((m) => (
                <MessageBubble key={m.id} message={m} />
              ))}
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
        {showJump && (
          <button
            onClick={jumpToLatest}
            className="absolute bottom-3 left-1/2 inline-flex h-[28px] -translate-x-1/2 items-center gap-1.5 rounded-full border border-border-subtle bg-surface-3/95 px-3 text-[11px] text-text-secondary shadow-lg backdrop-blur transition hover:border-border-hi hover:bg-surface-4 hover:text-text"
            title="Jump to latest message"
          >
            <ArrowDown size={11} />
            <span>Jump to latest</span>
          </button>
        )}
      </div>

      <div className="shrink-0 border-t border-border bg-surface-2 px-3 py-2">
        {slashActive && (
          <SlashPalette
            query={input}
            commands={SLASH_COMMANDS}
            highlight={paletteHighlight}
            onHighlight={setPaletteHighlight}
            onPick={(cmd) => {
              // Click in the palette: complete the command. If it
              // takes args, leave the trailing space + keep palette
              // open so the user types. Otherwise execute immediately.
              if (cmd.hasArgs) {
                setInput(`/${cmd.trigger} `);
              } else {
                void executeSlash(cmd.trigger, '').then((clear) => {
                  if (clear) setInput('');
                });
              }
            }}
          />
        )}
        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            // accept everything — claude figures out by extension whether
            // it should pull bytes for a vision pass or read as text.
            className="hidden"
            onChange={onFilePicked}
          />
          <button
            onClick={onAttachClick}
            title="Attach files or images — pasted as @<path> references"
            className="inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[7px] border border-border-subtle bg-surface-3 text-text-muted transition hover:border-border-hi hover:bg-surface-4 hover:text-text"
          >
            <Paperclip size={13} />
          </button>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // Slash palette navigation takes precedence over normal
              // editing. The palette is only "live" when input starts
              // with `/` and has no newline (multi-line slash inputs
              // aren't commands).
              if (slashActive) {
                const after = input.slice(1);
                const visible = SLASH_COMMANDS.filter((c) => {
                  const spaceIdx = after.indexOf(' ');
                  return spaceIdx >= 0
                    ? c.trigger === after.slice(0, spaceIdx)
                    : c.trigger.toLowerCase().startsWith(after.toLowerCase());
                });
                if (e.key === 'ArrowDown' && visible.length > 0) {
                  e.preventDefault();
                  setPaletteHighlight((h) => (h + 1) % visible.length);
                  return;
                }
                if (e.key === 'ArrowUp' && visible.length > 0) {
                  e.preventDefault();
                  setPaletteHighlight(
                    (h) => (h - 1 + visible.length) % visible.length,
                  );
                  return;
                }
                if (e.key === 'Tab' && visible.length > 0) {
                  e.preventDefault();
                  const picked = visible[paletteHighlight] ?? visible[0]!;
                  setInput(picked.hasArgs ? `/${picked.trigger} ` : `/${picked.trigger}`);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setInput('');
                  return;
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  const parsed = parseSlashInput(input);
                  if (!parsed) return;
                  // If user only typed `/foo` and there's a match, run
                  // it; otherwise, autocomplete to the highlighted
                  // entry (Tab equivalent) so they can supply args.
                  const exact = SLASH_COMMANDS.find((c) => c.trigger === parsed.trigger);
                  if (exact) {
                    void executeSlash(exact.trigger, parsed.args).then((clear) => {
                      if (clear) setInput('');
                    });
                    return;
                  }
                  const picked = visible[paletteHighlight] ?? visible[0];
                  if (picked) {
                    setInput(picked.hasArgs ? `/${picked.trigger} ` : `/${picked.trigger}`);
                  }
                  return;
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void onSend();
              }
            }}
            // Drag-and-drop files onto the textarea — drops `@<path>`
            // tokens into the input the same way the paperclip button
            // does. Lets the user drop multiple files at once from
            // Finder.
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('Files')) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
              }
            }}
            onDrop={(e) => {
              if (!e.dataTransfer.files?.length) return;
              e.preventDefault();
              for (const f of Array.from(e.dataTransfer.files)) {
                const p = api.files.getPathForFile(f);
                if (p) insertAttachment(p);
              }
            }}
            rows={2}
            placeholder="Ask claude…  (Enter to send, Shift+Enter for newline; @path to attach, / for commands)"
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
        <div className="min-w-0 flex-1 select-text whitespace-pre-wrap break-words rounded-[10px] bg-surface-3 px-3 py-2 text-[12.5px] text-text">
          {message.content}
        </div>
      </div>
    );
  }
  // Team run: render the pipeline summary card + per-step blocks
  // instead of the standard single-bubble layout. The message-level
  // content/toolCalls are empty in this mode; everything lives inside
  // teamRun.steps[].
  if (message.teamRun) {
    return <TeamRunBubble message={message} />;
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
      <div className="min-w-0 flex-1 select-text space-y-2">
        {message.toolCalls.length > 0 && (
          <ToolCallList calls={message.toolCalls} />
        )}
        {message.content ? (
          // Render ReactMarkdown directly inline — DO NOT use the editor's
          // <MarkdownPreview> wrapper here. That component anchors content
          // via `position: absolute; inset: 0` for the split-pane case,
          // which collapses to zero height inside a natural-flow chat
          // bubble (the bubble itself has no fixed size, so `h-full` on
          // the wrapper means 100% of 0 = 0). Replies came back fine from
          // the model but visually clipped to a single line. Same fix we
          // applied to the Update dialog.
          <div className="prose prose-invert max-w-none break-words text-[12.5px] leading-relaxed prose-headings:mt-3 prose-headings:mb-1.5 prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 prose-pre:my-2 prose-pre:overflow-x-auto prose-pre:rounded-md prose-pre:bg-surface-3 prose-pre:p-2.5 prose-pre:text-[11.5px] prose-code:rounded prose-code:bg-surface-3 prose-code:px-1 prose-code:py-0.5 prose-code:text-[11.5px] prose-code:before:content-none prose-code:after:content-none prose-a:text-accent prose-a:no-underline hover:prose-a:underline">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[[rehypeHighlight, { detect: true }]]}
            >
              {message.content}
            </ReactMarkdown>
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

function TeamRunBubble({ message }: { message: ChatMessage }) {
  const run = message.teamRun!;
  const totalSteps = run.steps.length;
  const doneCount = run.steps.filter((s) => s.status === 'done').length;
  const runningStep = run.steps.find((s) => s.status === 'running');
  const elapsedMs = (() => {
    const earliest = run.steps
      .map((s) => s.startedAt)
      .filter((t): t is number => !!t)
      .reduce((a, b) => Math.min(a, b), Infinity);
    if (!isFinite(earliest)) return 0;
    const latest = run.steps
      .map((s) => s.finishedAt ?? Date.now())
      .reduce((a, b) => Math.max(a, b), 0);
    return Math.max(0, latest - earliest);
  })();

  return (
    <div className="flex gap-2.5">
      <div
        className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
        style={{
          background: 'linear-gradient(135deg, var(--color-accent), #a855f7)',
        }}
      >
        <Users size={11} />
      </div>
      <div className="min-w-0 flex-1 space-y-3">
        {/* Pipeline summary card */}
        <div className="rounded-[10px] border border-border bg-surface-2 overflow-hidden">
          <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2 text-[11.5px]">
            <Users size={12} className="text-accent" />
            <span className="font-semibold text-text">{run.teamName}</span>
            <span className="rounded-full bg-surface-3 px-2 py-[1px] text-[9.5px] uppercase tracking-wide text-text-muted">
              {run.mode}
            </span>
            <span className="ml-auto text-[10.5px] text-text-muted">
              {doneCount}/{totalSteps} steps
              {elapsedMs > 0 && ` · ${formatDuration(elapsedMs)}`}
            </span>
            {runningStep && (
              <span
                className="h-[6px] w-[6px] rounded-full bg-accent"
                style={{ boxShadow: '0 0 8px var(--color-accent)', animation: 'pulse-ring 1.4s ease-in-out infinite' }}
              />
            )}
          </div>
          <div className="py-1">
            {run.steps.map((s, i) => (
              <StepRow key={i} step={s} index={i} />
            ))}
          </div>
        </div>

        {/* Per-step details — only show steps that have output (running
            or finished) to avoid a sea of empty placeholders. */}
        {run.steps.map((s, i) =>
          s.status === 'queued' || (s.content === '' && s.toolCalls.length === 0 && s.status !== 'running') ? null : (
            <StepDetail key={i} step={s} index={i} />
          ),
        )}
      </div>
    </div>
  );
}

function StepRow({ step, index }: { step: TeamStep; index: number }) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-1 text-[11.5px]">
      <StepIcon status={step.status} />
      <span className="font-mono text-[11px] text-text" style={{ minWidth: 110 }}>
        {step.agentName}
      </span>
      <span className="flex-1 truncate text-text-muted">
        {step.status === 'queued' && 'queued'}
        {step.status === 'running' && (
          <span>
            running
            {step.toolCalls.length > 0 && ` · ${step.toolCalls.length} tool call(s)`}
          </span>
        )}
        {step.status === 'done' && (
          <span>
            {step.content
              ? `${step.content.replace(/\s+/g, ' ').slice(0, 80)}${step.content.length > 80 ? '…' : ''}`
              : `${step.toolCalls.length} tool call(s)`}
          </span>
        )}
        {step.status === 'error' && (
          <span className="text-semantic-error">{step.error || 'error'}</span>
        )}
        {step.status === 'cancelled' && <span>cancelled</span>}
      </span>
      <span className="shrink-0 text-[10px] text-text-dim">{index + 1}</span>
    </div>
  );
}

function StepIcon({ status }: { status: TeamStep['status'] }) {
  if (status === 'done') return <CheckCircle2 size={11} className="text-semantic-success" />;
  if (status === 'running') return <Loader2 size={11} className="animate-spin text-accent" />;
  if (status === 'error') return <XCircle size={11} className="text-semantic-error" />;
  if (status === 'cancelled') return <CircleSlash size={11} className="text-text-dim" />;
  return <Circle size={11} className="text-text-dim" />;
}

function StepDetail({ step, index }: { step: TeamStep; index: number }) {
  const isRunning = step.status === 'running';
  const isError = step.status === 'error';
  return (
    <details
      open={isRunning || isError}
      className={cn(
        'rounded-[8px] border bg-surface-2/40',
        isRunning ? 'border-accent/40' : 'border-border-subtle',
      )}
      style={{ borderLeftWidth: '2px' }}
    >
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[11px]">
        <StepIcon status={step.status} />
        <span className="font-mono font-medium text-text">{step.agentName}</span>
        <span className="text-text-dim">step {index + 1}</span>
        {step.usage && (
          <span className="ml-auto text-[10px] text-text-dim">
            {step.usage.input} in / {step.usage.output} out
          </span>
        )}
      </summary>
      <div className="border-t border-border-subtle px-3 py-2 select-text">
        {step.toolCalls.length > 0 && (
          <div className="mb-2">
            <ToolCallList calls={step.toolCalls} />
          </div>
        )}
        {step.content ? (
          <div className="prose prose-invert max-w-none break-words text-[12.5px] leading-relaxed prose-headings:mt-3 prose-headings:mb-1.5 prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 prose-pre:my-2 prose-pre:overflow-x-auto prose-pre:rounded-md prose-pre:bg-surface-3 prose-pre:p-2.5 prose-pre:text-[11.5px] prose-code:rounded prose-code:bg-surface-3 prose-code:px-1 prose-code:py-0.5 prose-code:text-[11.5px] prose-code:before:content-none prose-code:after:content-none prose-a:text-accent prose-a:no-underline hover:prose-a:underline">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[[rehypeHighlight, { detect: true }]]}
            >
              {step.content}
            </ReactMarkdown>
          </div>
        ) : isRunning ? (
          <div className="flex items-center gap-1.5 text-[11.5px] text-text-muted">
            <Loader2 size={11} className="animate-spin" />
            <span>working…</span>
          </div>
        ) : null}
        {step.error && (
          <div className="mt-2 rounded-[6px] border border-semantic-error/40 bg-semantic-error/10 px-3 py-2 font-mono text-[10.5px] text-semantic-error">
            {step.error}
          </div>
        )}
      </div>
    </details>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
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
 *
 * Team mode: when an event carries `stepIndex` AND the last message has
 * a `teamRun`, the event is routed into teamRun.steps[stepIndex] rather
 * than the message itself. Lets sequential pipelines render per-step
 * text and tool blocks without polluting the parent message's content.
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

  // Team-step lifecycle events update the step's status only.
  if (event.kind === 'team_step_start' && last.teamRun && event.stepIndex !== undefined) {
    const step = last.teamRun.steps[event.stepIndex];
    if (step) {
      step.status = 'running';
      step.startedAt = event.ts;
    }
    return { ...thread, messages };
  }
  if (event.kind === 'team_step_end' && last.teamRun && event.stepIndex !== undefined) {
    const step = last.teamRun.steps[event.stepIndex];
    if (step) {
      step.finishedAt = event.ts;
      if (event.message) {
        step.status = 'error';
        step.error = event.message;
      } else if (step.status === 'running') {
        step.status = 'done';
      }
    }
    return { ...thread, messages };
  }

  // Pick the target — either a team step or the message itself.
  const target: TeamStep | ChatMessage =
    last.teamRun && event.stepIndex !== undefined
      ? (last.teamRun.steps[event.stepIndex] ?? last)
      : last;

  if (event.kind === 'text_delta' && event.text) {
    target.content += event.text;
  } else if (event.kind === 'thinking_delta' && event.text) {
    target.thinking = (target.thinking ?? '') + event.text;
  } else if (event.kind === 'tool_use') {
    target.toolCalls = [
      ...target.toolCalls,
      {
        id: event.toolUseId ?? `tu-${Date.now()}`,
        name: event.toolName ?? 'tool',
        input: event.toolInput ?? {},
      },
    ];
  } else if (event.kind === 'tool_result') {
    target.toolCalls = target.toolCalls.map((c) =>
      c.id === event.toolUseId
        ? { ...c, result: event.toolResult ?? '', isError: event.toolIsError }
        : c,
    );
  } else if (event.kind === 'usage') {
    target.usage = {
      input: event.inputTokens ?? 0,
      output: event.outputTokens ?? 0,
    };
  } else if (event.kind === 'error') {
    last.status = 'error';
    last.error = event.message;
  } else if (event.kind === 'done') {
    // Backend already persisted the terminal state to disk. We mirror it
    // here so the renderer's Stop / Send button reflects reality without
    // waiting for the next listThreads refresh. If an earlier `error`
    // event already flipped status to 'error', leave it; otherwise the
    // turn ended cleanly.
    if (last.status === 'streaming') {
      last.status = 'done';
    }
  }

  return { ...thread, messages };
}
