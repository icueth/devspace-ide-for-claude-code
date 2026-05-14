import 'highlight.js/styles/github-dark.css';

import {
  AlertTriangle,
  ArrowDown,
  Brain,
  Check,
  CheckCircle2,
  Circle,
  CircleSlash,
  Clock,
  FileText,
  Folder,
  Globe,
  ListChecks,
  Loader2,
  MessageSquarePlus,
  Paperclip,
  Pencil,
  Plus,
  Search,
  Send,
  Terminal,
  Trash2,
  User,
  Users,
  Wrench,
  X,
  XCircle,
} from 'lucide-react';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
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
import {
  TerminalContextMenu,
  type TerminalMenuItem,
} from '@renderer/components/Dock/TerminalContextMenu';
import { api } from '@renderer/lib/api';
import { onChatPrefill } from '@renderer/lib/chatBridge';
import { cn } from '@renderer/lib/utils';
import {
  queueKey,
  useChatQueueStore,
  type QueuedMessage,
} from '@renderer/state/chatQueue';
import { useEditorStore } from '@renderer/state/editor';
import { suggestSkillSlugs, type DesignSkill } from '@shared/design';
import type {
  ChatEvent,
  ChatMessage,
  ChatMessageSegment,
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

// Stable empty-array reference for the queue selector. Returning a fresh
// `[]` literal from a zustand selector would re-trigger the consumer on
// every store change (identity mismatch); using a module-level constant
// pins identity so consumers only re-render when there's actually queue
// content.
const EMPTY_QUEUE: QueuedMessage[] = [];

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
  // Ref to the chat input textarea so the chatBridge prefill listener can
  // focus it after dropping in text from the Design pane.
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // Inline transient toast — shown for 2s after a Design prefill arrives.
  // Sits just above the input area so it doesn't fight the message scroll
  // region and stays in the user's eyeline as they review the prefill.
  const [notice, setNotice] = useState<string | null>(null);
  // Available design skills, fetched once on mount and cached for the
  // life of the panel. Used by the right-click menu to enable / disable
  // the "Generate landing page" / "Generate dashboard" entries based on
  // what the user actually has installed (built-in + project + global).
  // We use a ref instead of state so re-fetching doesn't ripple through
  // re-renders — the menu reads the latest snapshot at click time.
  const skillsRef = useRef<DesignSkill[]>([]);
  // Floating context-menu state for assistant message bubbles. `target`
  // captures the message + the user's text selection at right-click time
  // so the menu actions know what brief to send to the Design pane.
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    message: ChatMessage;
    selection: string;
  } | null>(null);

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

  // Pull the design skills catalog once on mount + whenever the project
  // changes. Cached in skillsRef so the bubble right-click menu can build
  // accurate enabled/disabled state without an IPC round trip per click.
  // Failure is non-fatal: an empty skills list just disables the
  // skill-specific menu entries (heuristic-based "Generate design" still
  // works because openDesign accepts an undefined skillSlug).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await api.design.listSkills(projectPath);
        if (!cancelled) skillsRef.current = list;
      } catch (err) {
        console.error('[chat] failed to load skills for context menu', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  // Auto-dismiss the inline prefill toast after 2s. Using setTimeout +
  // clearing on unmount / replacement prevents a stale timer from
  // closing a fresh notice early.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 2000);
    return () => clearTimeout(t);
  }, [notice]);

  // Subscribe to Design → Chat prefill bridge events. When an event for
  // OUR project arrives: optionally spin up a fresh thread, drop the
  // composed text into the input box, focus the textarea, and surface a
  // brief inline confirmation so the user knows where the text came from.
  useEffect(() => {
    return onChatPrefill((event) => {
      if (event.projectPath !== projectPath) return;
      // Attach mode: append `@<rel> ` via insertAttachment instead of
      // replacing the input. Skips thread creation + the "Design context"
      // toast — those are wrong for a file attach.
      if (event.attachPath) {
        insertAttachment(event.attachPath);
        requestAnimationFrame(() => {
          inputRef.current?.focus();
          inputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
        return;
      }
      void (async () => {
        if (event.newThread) {
          // Mirror onNewThread: create thread, prepend, switch active.
          // Done here (not via onNewThread()) so we can await the new id
          // before continuing — guarantees the input we focus belongs to
          // the new thread's panel state.
          try {
            const t = await api.chat.createThread(projectPath, 'New chat');
            setThreads((prev) => [t, ...prev]);
            setActiveId(t.id);
          } catch (err) {
            console.error('[chat] failed to create thread for prefill', err);
          }
        }
        setInput(event.text);
        // Wait for React to flush the value into the controlled textarea
        // before focusing — otherwise the cursor lands at index 0 of the
        // *previous* value and the focus ring flickers.
        requestAnimationFrame(() => {
          const el = inputRef.current;
          if (!el) return;
          el.focus();
          // Park the caret at the end so the user can immediately add
          // their question without arrow-keying past the prefill.
          const len = event.text.length;
          try {
            el.setSelectionRange(len, len);
          } catch {
            // Some textarea states (e.g. mid-IME composition) reject
            // setSelectionRange — silently ignore; focus alone is enough.
          }
          el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
        setNotice('Design context loaded — review and send.');
      })();
    });
  }, [projectPath, insertAttachment]);

  const activeThread = useMemo(
    () => threads.find((t) => t.id === activeId) ?? null,
    [threads, activeId],
  );

  // True while the active thread has at least one assistant message in
  // 'streaming' state. Drives the Send→Stop button swap AND the v0.16 queue
  // mode (typing while this is true lands in the queue instead of failing
  // the submit). Computed against current thread state — switching threads
  // mid-stream correctly flips this for the new thread's state.
  const isStreaming = !!activeThread?.messages.some(
    (m) => m.status === 'streaming',
  );

  // Did the most recent turn in this thread fail or get cancelled? Used
  // to decide whether the auto-send loop should pause the queue when
  // streaming ends. We pause on:
  //   • 'error'     — the model / network coughed; user should review
  //                   what happened before more queued sends fire.
  //   • 'cancelled' — the user explicitly hit Stop. They probably don't
  //                   want the next queued message to immediately barge in.
  // We check the LAST message specifically so an earlier transient
  // error doesn't keep the queue paused forever.
  const lastTurnFailed = useMemo(() => {
    const msgs = activeThread?.messages;
    if (!msgs || msgs.length === 0) return false;
    const last = msgs[msgs.length - 1];
    return (
      last?.role === 'assistant' &&
      (last.status === 'error' || last.status === 'cancelled')
    );
  }, [activeThread]);

  // Queue key tied to (project, thread). Re-derived on every render but
  // it's just two strings — cheap. Null when no thread is active so we
  // don't drop queue entries against a phantom key.
  const qKey = activeId ? queueKey(projectPath, activeId) : null;

  // Subscribe to the queued items for this thread. Returns a NEW array
  // reference whenever the queue changes (zustand handles equality), so
  // the pill list re-renders on enqueue/remove/update.
  const queuedItems = useChatQueueStore((s) =>
    qKey ? s.queues[qKey] ?? EMPTY_QUEUE : EMPTY_QUEUE,
  );
  const queuePaused = useChatQueueStore((s) =>
    qKey ? s.paused[qKey] ?? false : false,
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

  // Low-level send — takes the text directly, skips the input + queue
  // checks. Used by both the user-driven onSend AND the auto-send loop
  // that drains the queue once streaming completes.
  //
  // v0.16.0 review-fix: re-throws on failure so callers can decide
  // whether to surface, pause queue, or re-enqueue. The previous version
  // swallowed errors here → auto-send loop lost messages with no UI
  // signal at all. Manual onSend wraps its own catch to keep UX quiet.
  const submitText = useCallback(
    async (text: string) => {
      if (!activeId) return;
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
      } finally {
        setSending(false);
      }
    },
    [activeId, projectPath, selectedTeamId, runInNewThread, teams],
  );

  const onSend = useCallback(async () => {
    if (!activeId || !input.trim() || sending) return;
    const text = input.trim();
    // v0.16: if the assistant is mid-reply, don't refuse the submit —
    // park it in the queue and clear the textarea so the user can keep
    // typing. The auto-send effect below picks it up when streaming ends.
    if (isStreaming && qKey) {
      useChatQueueStore.getState().enqueue(qKey, { text });
      setInput('');
      setNotice('Queued — will send when current reply finishes.');
      return;
    }
    setInput('');
    try {
      await submitText(text);
    } catch (err) {
      console.error('[chat] send failed', err);
      // Restore the text so the user can retry without losing what they
      // typed. We only do this for the user-driven path; auto-drain has
      // its own re-enqueue + pause flow below.
      setInput(text);
      setNotice(
        `Send failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [activeId, input, sending, isStreaming, qKey, submitText]);

  // v0.16: auto-send loop. Watches `isStreaming` going true → false and
  // drains the head of the queue (per active thread) into a fresh send.
  //
  // Subtleties:
  //   • prevStreamingRef tracks the last seen value so we ONLY act on the
  //     true→false edge, not on every render where isStreaming === false.
  //   • drainingRef guards against React 18 StrictMode double-invoke and
  //     against a hypothetical race where two `done` events flush before
  //     the next render — we only initiate one drain at a time.
  //   • Pause condition: if the last assistant turn errored, we flip the
  //     queue into the paused state and surface a banner. No auto-send
  //     until the user clicks Resume.
  //   • Don't-fire-mid-typing rule: if the textarea has unsubmitted text,
  //     skip this turn of the drain — user is mid-thought and we don't
  //     want a queued message to barge in ahead of what they're writing.
  //     The drain will retry next time isStreaming flips (or via the
  //     manual "resume" button).
  const prevStreamingRef = useRef(isStreaming);
  const drainingRef = useRef(false);
  useEffect(() => {
    const prev = prevStreamingRef.current;
    prevStreamingRef.current = isStreaming;
    // Only react to the true → false transition.
    if (!(prev && !isStreaming)) return;
    if (drainingRef.current) return;
    if (!qKey) return;

    // If the turn that just finished errored OR was cancelled, lock the
    // queue. User has to acknowledge before more messages auto-fire.
    if (lastTurnFailed) {
      const items = useChatQueueStore.getState().list(qKey);
      if (items.length > 0) {
        useChatQueueStore.getState().setPaused(qKey, true);
      }
      return;
    }

    // Don't barge in while the user is mid-typing.
    if (input.trim().length > 0) return;

    const head = useChatQueueStore.getState().list(qKey)[0];
    if (!head) return;

    drainingRef.current = true;
    void (async () => {
      let popped: QueuedMessage | undefined;
      try {
        // Pop AFTER we've decided to send — keeps the pill visible on
        // screen until the moment it actually leaves. Pop-then-send order
        // matters: if we sent first and the send threw, the pill would
        // still be in the queue, so the next streaming transition would
        // retry — usually wrong (the send had a side effect server-side).
        popped = useChatQueueStore.getState().shift(qKey);
        if (!popped) return;
        await submitText(popped.text);
      } catch (err) {
        // v0.16.0 review-fix: re-enqueue at head + pause the queue so the
        // user can decide what to do. Without this the message is gone
        // silently — submitText used to swallow the error.
        console.error('[chat] auto-send failed', err);
        if (popped) {
          useChatQueueStore.getState().unshift(qKey, popped);
        }
        useChatQueueStore.getState().setPaused(qKey, true);
      } finally {
        drainingRef.current = false;
      }
    })();
  }, [isStreaming, lastTurnFailed, qKey, input, submitText]);

  // Manual "resume" — clears the paused flag and lets the auto-send loop
  // pick up next time streaming starts → ends. We trigger a drain
  // immediately too, since we may already be idle.
  const onResumeQueue = useCallback(() => {
    if (!qKey) return;
    useChatQueueStore.getState().setPaused(qKey, false);
    if (!isStreaming && !drainingRef.current && input.trim().length === 0) {
      const head = useChatQueueStore.getState().list(qKey)[0];
      if (head) {
        drainingRef.current = true;
        void (async () => {
          let popped: QueuedMessage | undefined;
          try {
            popped = useChatQueueStore.getState().shift(qKey);
            if (!popped) return;
            await submitText(popped.text);
          } catch (err) {
            console.error('[chat] resume drain failed', err);
            if (popped) {
              useChatQueueStore.getState().unshift(qKey, popped);
            }
            useChatQueueStore.getState().setPaused(qKey, true);
          } finally {
            drainingRef.current = false;
          }
        })();
      }
    }
  }, [qKey, isStreaming, input, submitText]);

  // Manual "discard queue" — drop everything and clear the paused flag.
  const onDiscardQueue = useCallback(() => {
    if (!qKey) return;
    useChatQueueStore.getState().clear(qKey);
  }, [qKey]);

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

  // Open the bubble context menu at click coordinates, capturing the
  // user's current text selection (if any) so the menu actions can use
  // it as the brief instead of the whole message body.
  const openBubbleMenu = useCallback(
    (x: number, y: number, message: ChatMessage) => {
      const sel = window.getSelection?.()?.toString() ?? '';
      setMenu({ x, y, message, selection: sel.trim() });
    },
    [],
  );

  // Resolve "what brief should we send to Design?" from a right-click
  // target. Selection wins when the user highlighted text inside the
  // bubble; otherwise we fall back to message.content, then to the
  // joined prose-segment text. Markdown code fences are stripped so
  // pasted code blocks don't bias the planner toward "code", and the
  // result is capped at 4KB to stay well under the design composer's
  // input limits.
  const extractBrief = useCallback(
    (message: ChatMessage, selection: string): string => {
      const raw = selection || message.content || joinProseSegments(message);
      const stripped = stripMarkdownFences(raw).trim();
      return stripped.length > MAX_BRIEF_CHARS
        ? stripped.slice(0, MAX_BRIEF_CHARS)
        : stripped;
    },
    [],
  );

  // Send the brief over to the Design pane: pick a skill (heuristic or
  // explicit override), then route through useEditorStore.openDesign,
  // which either opens a new design tab pre-filled or updates the
  // existing tab's prefill so DesignView re-hydrates the composer.
  const sendToDesign = useCallback(
    (
      message: ChatMessage,
      selection: string,
      override: 'auto' | string,
    ): void => {
      const brief = extractBrief(message, selection);
      if (!brief) return;
      const slugs = skillsRef.current.map((s) => s.slug);
      const resolved =
        override === 'auto'
          ? (suggestSkillSlugs(brief, slugs)[0] ?? undefined)
          : slugs.includes(override)
            ? override
            : undefined;
      const projectName = basename(projectPath);
      useEditorStore.getState().openDesign(projectPath, projectName, {
        brief,
        ...(resolved ? { skillSlug: resolved } : {}),
      });
    },
    [extractBrief, projectPath],
  );

  // Build the menu items snapshot for the floating menu. Memo not
  // strictly needed — this fn runs at most once per right-click — but
  // keeping it inline makes the disabled-state logic obvious.
  const buildMenuItems = useCallback(
    (message: ChatMessage, selection: string): TerminalMenuItem[] => {
      const slugs = new Set(skillsRef.current.map((s) => s.slug));
      const brief = extractBrief(message, selection);
      const hasBrief = brief.length > 0;
      return [
        {
          id: 'gen-design',
          label: selection
            ? 'Generate design from selection'
            : 'Generate design from this',
          disabled: !hasBrief,
          onSelect: () => sendToDesign(message, selection, 'auto'),
        },
        {
          id: 'gen-landing',
          label: 'Generate landing page from this',
          disabled: !hasBrief || !slugs.has('landing'),
          hint: slugs.has('landing') ? undefined : 'no skill',
          onSelect: () => sendToDesign(message, selection, 'landing'),
        },
        {
          id: 'gen-dashboard',
          label: 'Generate dashboard from this',
          disabled: !hasBrief || !slugs.has('dashboard'),
          hint: slugs.has('dashboard') ? undefined : 'no skill',
          onSelect: () => sendToDesign(message, selection, 'dashboard'),
        },
        { id: 'sep-1', label: '', separator: true },
        {
          id: 'copy',
          label: 'Copy text',
          disabled: !message.content && !joinProseSegments(message),
          onSelect: () => {
            const text = message.content || joinProseSegments(message);
            if (text) void navigator.clipboard.writeText(text);
          },
        },
      ];
    },
    [extractBrief, sendToDesign],
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
                <MessageBubble
                  key={m.id}
                  message={m}
                  onAssistantContextMenu={
                    m.role === 'assistant'
                      ? (e) => {
                          e.preventDefault();
                          openBubbleMenu(e.clientX, e.clientY, m);
                        }
                      : undefined
                  }
                />
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
        {notice && (
          // Inline transient toast — auto-fades after 2s. Lives in the
          // same footer column as the slash palette so it never collides
          // with the bubble scroll area or the design composer popover.
          <div
            role="status"
            aria-live="polite"
            className="mb-1.5 inline-flex items-center gap-1.5 rounded-[7px] border border-accent/40 bg-accent/10 px-2.5 py-1 text-[11px] text-accent"
          >
            <CheckCircle2 size={11} />
            <span>{notice}</span>
          </div>
        )}
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
        {/* v0.16 queue: pending messages typed while the assistant was
            streaming. Each pill is independently editable + deletable so
            the user can revise queued thoughts before they auto-fire. */}
        {qKey && queuedItems.length > 0 && (
          <QueuePillStrip
            items={queuedItems}
            paused={queuePaused}
            onUpdate={(id, text) =>
              useChatQueueStore.getState().update(qKey, id, text)
            }
            onRemove={(id) => useChatQueueStore.getState().remove(qKey, id)}
            onReorder={(from, to) =>
              useChatQueueStore.getState().reorder(qKey, from, to)
            }
            onResume={onResumeQueue}
            onDiscard={onDiscardQueue}
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
            ref={inputRef}
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
            // tokens into the input. Accepts two sources:
            //   1. OS file drops (Finder) via `Files` MIME
            //   2. In-app drags from the project file tree via the
            //      custom `application/x-devspace-path` MIME (payload is
            //      a JSON array of absolute paths)
            onDragOver={(e) => {
              const types = e.dataTransfer.types;
              if (
                types.includes('Files') ||
                types.includes('application/x-devspace-path')
              ) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
              }
            }}
            onDrop={(e) => {
              const inApp = e.dataTransfer.getData('application/x-devspace-path');
              if (inApp) {
                e.preventDefault();
                try {
                  const paths = JSON.parse(inApp) as unknown;
                  if (Array.isArray(paths)) {
                    for (const p of paths) {
                      if (typeof p === 'string' && p) insertAttachment(p);
                    }
                  }
                } catch {
                  /* malformed payload — ignore */
                }
                return;
              }
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
      {menu && (
        <TerminalContextMenu
          x={menu.x}
          y={menu.y}
          items={buildMenuItems(menu.message, menu.selection)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

// Cap for briefs piped into the Design composer via right-click. 4KB
// is well under the design pane's input limit and matches the spec.
const MAX_BRIEF_CHARS = 4 * 1024;

// Joins all prose-kind segments of a (possibly segmented) assistant
// message into a single plaintext blob. Used as a fallback when
// `message.content` is empty — common in segmented mode where each
// text chunk lives in its own segment instead of the legacy field.
function joinProseSegments(message: ChatMessage): string {
  const segs = message.segments;
  if (!segs || segs.length === 0) return '';
  const out: string[] = [];
  for (const s of segs) {
    if (s.kind === 'text' && s.text) out.push(s.text);
  }
  return out.join('\n').trim();
}

// Strips ```lang ... ``` fences (and their language tags) from a chunk
// of markdown so the Design planner gets the user-readable prose, not a
// dump of code that biases skill suggestion. Inline `code` is left
// alone — the noise cost is small and stripping it would mangle words.
function stripMarkdownFences(text: string): string {
  return text.replace(/```[\w-]*\n?[\s\S]*?```/g, '').replace(/\n{3,}/g, '\n\n');
}

// Project name from absolute path. ChatPanel only receives the path —
// openDesign needs a friendly tab label, so we derive it from the last
// non-empty path segment.
function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

function MessageBubble({
  message,
  onAssistantContextMenu,
}: {
  message: ChatMessage;
  // Right-click handler attached only to assistant bubbles. ChatPanel
  // owns menu state; the bubble stays dumb and just forwards the event
  // (with x/y + the message identity) up.
  onAssistantContextMenu?: (e: ReactMouseEvent<HTMLDivElement>) => void;
}) {
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
    return (
      <div onContextMenu={onAssistantContextMenu}>
        <TeamRunBubble message={message} />
      </div>
    );
  }
  return (
    <div className="flex gap-2.5" onContextMenu={onAssistantContextMenu}>
      <div
        className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
        style={{
          background: 'linear-gradient(135deg, var(--color-accent), #a855f7)',
        }}
      >
        c
      </div>
      <div className="min-w-0 flex-1 select-text space-y-2">
        {message.thinking && <ThinkingBlock text={message.thinking} />}
        {message.segments && message.segments.length > 0 ? (
          // v0.11+ segmented render: each text / tool_group chunk is its
          // own card so the chronological order of claude's output is
          // preserved (instead of the legacy "all tools, then all text"
          // flattening). Empty text segments at the very tail of a
          // streaming turn — common between two tool calls — show nothing
          // and let the next event fall into a new segment.
          <SegmentedBody message={message} />
        ) : (
          <>
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
              <TextSegmentCard text={message.content} />
            ) : message.status === 'streaming' && message.toolCalls.length === 0 ? (
              <WaitingPill message={message} />
            ) : null}
          </>
        )}
        {/* Pre-first-output pill: in segmented mode we still need the
            "Waiting for claude" indicator while the turn is in flight
            but no segments have arrived (or every segment is empty). */}
        {message.segments && message.segments.length > 0 &&
          message.status === 'streaming' &&
          isSegmentListEmpty(message.segments) && (
            <WaitingPill message={message} />
          )}
        {message.status === 'error' && (
          <div className="rounded-[7px] border border-semantic-error/40 bg-semantic-error/10 px-3 py-2 font-mono text-[10.5px] text-semantic-error">
            {message.error ?? 'unknown error'}
          </div>
        )}
        <AssistantFooter message={message} />
      </div>
    </div>
  );
}

// Renders ChatMessage.segments in order. Text segments become Markdown
// cards; tool_group segments resolve their ids back to the message's
// toolCalls[] (single source of truth) and reuse the existing
// ToolCallList component so the verb-ing aggregation behavior matches
// what users already know.
function SegmentedBody({
  message,
}: {
  message: { segments?: ChatMessageSegment[]; toolCalls: ChatMessage['toolCalls'] };
}) {
  const segs = message.segments ?? [];
  return (
    <>
      {segs.map((seg) => {
        if (seg.kind === 'text') {
          if (!seg.text) return null;
          return <TextSegmentCard key={seg.id} text={seg.text} />;
        }
        return (
          <ToolGroupSegment
            key={seg.id}
            toolUseIds={seg.toolUseIds}
            allCalls={message.toolCalls}
          />
        );
      })}
    </>
  );
}

// Memoized resolution from segment ids → ToolCall[] so we don't re-walk
// the calls array on every render. toolUseIds is identity-stable (we
// only ever push new ids — never reorder), so the dependency list is
// safe even though the contents are mutated in applyEvent's spreaded
// thread copy.
//
// memo with custom equality: applyEvent rebuilds `allCalls` (new
// array reference) on every text_delta / tool_result / usage / etc.
// event, so default shallow memo would re-render every group on every
// keystroke. We skip the re-render unless the calls THIS group actually
// references changed identity — for old groups whose tool_uses are
// long-done, that's never.
const ToolGroupSegment = memo(
  function ToolGroupSegmentInner({
    toolUseIds,
    allCalls,
  }: {
    toolUseIds: string[];
    allCalls: ChatMessage['toolCalls'];
  }) {
    const calls = useMemo(
      () => resolveCalls(toolUseIds, allCalls),
      [toolUseIds, allCalls],
    );
    if (calls.length === 0) return null;
    return <ToolCallList calls={calls} />;
  },
  (prev, next) => {
    if (prev.toolUseIds !== next.toolUseIds) return false;
    if (prev.allCalls === next.allCalls) return true;
    // allCalls reference changed but the calls referenced by this group's
    // ids may not have. Only re-render if any of OUR calls changed object
    // identity (status flip, result populated, etc.).
    const prevById = new Map(prev.allCalls.map((c) => [c.id, c] as const));
    const nextById = new Map(next.allCalls.map((c) => [c.id, c] as const));
    for (const id of next.toolUseIds) {
      if (prevById.get(id) !== nextById.get(id)) return false;
    }
    return true;
  },
);

function resolveCalls(
  toolUseIds: string[],
  allCalls: ChatMessage['toolCalls'],
): ChatMessage['toolCalls'] {
  if (toolUseIds.length === 0) return [];
  const byId = new Map(allCalls.map((c) => [c.id, c] as const));
  const out: ChatMessage['toolCalls'] = [];
  for (const id of toolUseIds) {
    const c = byId.get(id);
    if (c) out.push(c);
  }
  return out;
}

// Returns true when every segment renders to nothing — used to decide
// whether the WaitingPill should still show while streaming.
function isSegmentListEmpty(segments: ChatMessageSegment[]): boolean {
  for (const s of segments) {
    if (s.kind === 'text' && s.text) return false;
    if (s.kind === 'tool_group' && s.toolUseIds.length > 0) return false;
  }
  return true;
}

// One markdown card inside a segmented assistant turn. Visually identical
// to the legacy single-content render (same prose classes) — the only
// difference is each text-chunk gets its own block instead of being
// concatenated into one giant string. No border / padding wrapper here
// because the parent bubble already provides space-y-2 between cards.
//
// memo: default shallow equality compares the single `text` prop.
// Older finalized segments never change text → memo skips them on every
// subsequent stream event. Only the actively-streaming last text segment
// re-runs the (expensive) ReactMarkdown + rehype-highlight pipeline.
const TextSegmentCard = memo(function TextSegmentCardInner({
  text,
}: {
  text: string;
}) {
  return (
    <div className="prose prose-invert max-w-none break-words text-[12.5px] leading-relaxed prose-headings:mt-3 prose-headings:mb-1.5 prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 prose-pre:my-2 prose-pre:overflow-x-auto prose-pre:rounded-md prose-pre:bg-surface-3 prose-pre:p-2.5 prose-pre:text-[11.5px] prose-code:rounded prose-code:bg-surface-3 prose-code:px-1 prose-code:py-0.5 prose-code:text-[11.5px] prose-code:before:content-none prose-code:after:content-none prose-a:text-accent prose-a:no-underline hover:prose-a:underline">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true }]]}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

// Live-elapsed footer rendered under every assistant message. Pulsing
// dot indicates active work; turns static once status leaves
// 'streaming'. Elapsed time format matches opendesign's: sub-second
// precision under 10s, whole seconds 10-60s, "<m>m <s>s" past 1m.
function AssistantFooter({ message }: { message: ChatMessage }) {
  const elapsedMs = useLiveElapsed(
    message.createdAt,
    message.status === 'streaming',
  );
  const usage = message.usage;
  const label = (() => {
    if (message.status === 'streaming') return 'Working…';
    if (message.status === 'cancelled') return 'Cancelled';
    if (message.status === 'error') return 'Failed';
    return 'Done';
  })();
  const active = message.status === 'streaming';
  return (
    <div className="flex items-center gap-2 pt-1 text-[10.5px] text-text-dim">
      <span
        className={cn(
          'h-[6px] w-[6px] rounded-full',
          active ? 'bg-accent' : 'bg-text-dim/60',
        )}
        style={active ? { animation: 'pulse-ring 1.4s ease-in-out infinite' } : undefined}
      />
      <span>{label}</span>
      <span>·</span>
      <span className="font-mono">{formatElapsed(elapsedMs)}</span>
      {usage && (
        <>
          <span>·</span>
          <span className="font-mono">
            {usage.input} in / {usage.output} out
          </span>
        </>
      )}
    </div>
  );
}

// Pre-first-output indicator. Shown when status === 'streaming' AND
// the assistant message has no text or tool calls yet — i.e. claude
// just started and we haven't seen anything back. Gives a clearer cue
// than the previous static "thinking…" by progressing as events fire.
function WaitingPill({ message }: { message: ChatMessage }) {
  const elapsedMs = useLiveElapsed(message.createdAt, true);
  const elapsedSec = Math.floor(elapsedMs / 1000);
  const status = (() => {
    if (message.thinking) return 'Thinking';
    return elapsedSec < 2 ? 'Starting' : 'Waiting for claude';
  })();
  return (
    <div className="flex items-center gap-2 rounded-[8px] border border-border-subtle bg-surface-2/60 px-3 py-1.5 text-[11.5px] text-text-muted">
      <span
        className="h-[6px] w-[6px] rounded-full bg-accent"
        style={{ animation: 'pulse-ring 1.4s ease-in-out infinite' }}
      />
      <span>{status}…</span>
      <span className="ml-auto font-mono text-[10.5px] text-text-dim">
        {formatElapsed(elapsedMs)}
      </span>
      {elapsedSec >= 12 && (
        <span className="text-[10px] text-text-dim">— hit stop to cancel</span>
      )}
    </div>
  );
}

// Collapsible reveal for claude's thinking-block text. Closed by
// default so the bubble stays compact; clicking expands the full body
// in muted prose. Mirrors opendesign's ThinkingBlock pattern.
function ThinkingBlock({ text }: { text: string }) {
  const preview = text.replace(/\s+/g, ' ').slice(0, 140);
  return (
    <details className="group rounded-[8px] border border-border-subtle bg-surface-2/40">
      <summary className="flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-[11px] text-text-muted">
        <Brain size={11} className="text-accent/80" />
        <span className="font-medium">Thinking</span>
        <span className="truncate text-[10.5px] text-text-dim">{preview}</span>
      </summary>
      <div className="whitespace-pre-wrap border-t border-border-subtle px-2.5 py-2 text-[11.5px] italic leading-relaxed text-text-secondary">
        {text}
      </div>
    </details>
  );
}

// Tick at 1s while active so the footer shows live elapsed time. Once
// active flips false (turn finished), stop the timer — the message's
// createdAt + final-time gap is fixed and won't change again.
function useLiveElapsed(startedAt: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return Math.max(0, now - startedAt);
}

// 0–9.9s → "7.3s" (one decimal so the user sees real-time progress on
// fast turns); 10–59s → "32s"; >=1m → "2m 15s". Matches opendesign's
// format so the user has consistent eyeball-friendly time formatting.
function formatElapsed(ms: number): string {
  if (ms < 10_000) {
    const s = (ms / 1000).toFixed(1);
    return `${s}s`;
  }
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function ToolCallList({ calls }: { calls: ChatMessage['toolCalls'] }) {
  const groups = useMemo(() => groupConsecutiveByName(calls), [calls]);
  return (
    <div className="space-y-1">
      {groups.map((g) =>
        g.length === 1 ? (
          <ToolCard key={g[0]!.id} call={g[0]!} />
        ) : (
          <ToolGroupCard key={g[0]!.id} calls={g} />
        ),
      )}
    </div>
  );
}

// Bucket consecutive calls that share the same tool name into one group
// so the renderer can collapse them into a single disclosure ("Editing
// × 3 · Done"). NON-consecutive groups stay separate — interleaving
// Edit/Bash/Edit produces three rows, not one merged Edit group.
function groupConsecutiveByName(
  calls: ChatMessage['toolCalls'],
): Array<ChatMessage['toolCalls']> {
  const out: Array<ChatMessage['toolCalls']> = [];
  for (const c of calls) {
    const last = out[out.length - 1];
    if (last && last[0]!.name === c.name) {
      last.push(c);
    } else {
      out.push([c]);
    }
  }
  return out;
}

// Outer card for a run of same-tool calls. Summary head shows the
// verb-ing form ("Editing × 3"), count, aggregate status, and the most
// recent argument (so the user can see at a glance what the latest call
// touched). Expanding renders each call as a full ToolCard so the user
// can inspect inputs/results without having to ask claude.
function ToolGroupCard({ calls }: { calls: ChatMessage['toolCalls'] }) {
  const meta = toolDisplay(calls[0]!.name, calls[0]!.input);
  const total = calls.length;
  const runningCount = calls.filter((c) => c.result === undefined).length;
  const errorCount = calls.filter((c) => c.isError).length;
  const doneCount = total - runningCount;
  const lastArg = toolDisplay(
    calls[calls.length - 1]!.name,
    calls[calls.length - 1]!.input,
  ).summary;
  const aggregateStatus =
    runningCount > 0
      ? `Running · ${doneCount}/${total} done`
      : errorCount > 0
        ? `${errorCount} error${errorCount === 1 ? '' : 's'} of ${total}`
        : `Done · ${total}`;
  // Only render an aggregate chip when EVERY call in the group has
  // diffStats — otherwise the number would silently exclude untracked
  // edits and confuse the user.
  const aggregate = aggregateDiffStats(calls);
  const borderColor =
    errorCount > 0
      ? 'border-semantic-error/40'
      : runningCount > 0
        ? 'border-accent/30'
        : 'border-border-subtle';
  return (
    <details className={cn('rounded-[7px] border bg-surface-2', borderColor)}>
      <summary className="flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-[11px] text-text-secondary">
        <meta.Icon
          size={11}
          className={cn(
            errorCount > 0
              ? 'text-semantic-error'
              : runningCount > 0
                ? 'text-accent'
                : 'text-accent/80',
          )}
        />
        <span className="font-medium text-text">
          {gerund(meta.verb)} × {total}
        </span>
        <span className="text-text-muted">·</span>
        <span className="text-text-muted">{aggregateStatus}</span>
        {lastArg && (
          <span className="ml-2 truncate font-mono text-[10.5px] text-text-dim">
            {lastArg}
          </span>
        )}
        {aggregate && (
          <span className="inline-flex items-center gap-1 text-[10.5px]">
            <span className="text-text-muted">·</span>
            {aggregate.additions > 0 && (
              <span className="font-mono text-emerald-500">
                +{aggregate.additions}
              </span>
            )}
            {aggregate.deletions > 0 && (
              <span className="font-mono text-rose-500">
                -{aggregate.deletions}
              </span>
            )}
          </span>
        )}
        {runningCount > 0 && (
          <Loader2
            size={10}
            className="ml-auto shrink-0 animate-spin text-accent"
          />
        )}
      </summary>
      <div className="space-y-1 border-t border-border-subtle p-1.5">
        {calls.map((c) => (
          <ToolCard key={c.id} call={c} />
        ))}
      </div>
    </details>
  );
}

// "Edit" → "Editing", "Read" → "Reading", "Bash" → "Running", …
// Falls back to "<verb>ing" for unknown verbs.
function gerund(verb: string): string {
  switch (verb) {
    case 'Read':
      return 'Reading';
    case 'Edit':
      return 'Editing';
    case 'Write':
      return 'Writing';
    case 'Bash':
      return 'Running';
    case 'Glob':
      return 'Globbing';
    case 'Grep':
      return 'Grepping';
    case 'Todo':
      return 'Updating todos';
    case 'Dispatch':
      return 'Dispatching';
    case 'Fetch':
      return 'Fetching';
    case 'Search':
      return 'Searching';
    default:
      return verb.endsWith('e') ? `${verb.slice(0, -1)}ing` : `${verb}ing`;
  }
}

// Cursor-style inline chip showing a file-relative path with green +N
// additions / red -N deletions. Rendered inside ToolCard / ToolGroupCard
// summary rows whenever the underlying tool call carries diffStats. Skip
// rendering when both counts are 0 — the chip would be visually noisy
// without communicating anything.
type DiffStatsValue = NonNullable<
  NonNullable<ChatMessage['toolCalls'][number]['diffStats']>
>;

function DiffStatChip({
  stats,
  showPath = true,
}: {
  stats: DiffStatsValue;
  showPath?: boolean;
}) {
  if (stats.additions === 0 && stats.deletions === 0) return null;
  return (
    <span className="inline-flex items-center gap-1 text-[10.5px]">
      {showPath && (
        <span
          className="truncate font-mono text-text-muted"
          // direction:rtl + text-align:left truncates from the start so
          // the filename remains visible on overflow.
          style={{ direction: 'rtl', textAlign: 'left' }}
          title={stats.path}
        >
          {stats.path}
        </span>
      )}
      {stats.additions > 0 && (
        <span className="font-mono text-emerald-500">+{stats.additions}</span>
      )}
      {stats.deletions > 0 && (
        <span className="font-mono text-rose-500">-{stats.deletions}</span>
      )}
    </span>
  );
}

// Sum diffStats across a group of tool calls. Returns null when ANY
// call in the group is missing diffStats (we don't want a half-truthful
// summary chip).
function aggregateDiffStats(
  calls: ChatMessage['toolCalls'],
): { additions: number; deletions: number; fileCount: number } | null {
  let additions = 0;
  let deletions = 0;
  const paths = new Set<string>();
  for (const c of calls) {
    if (!c.diffStats) return null;
    additions += c.diffStats.additions;
    deletions += c.diffStats.deletions;
    paths.add(c.diffStats.path);
  }
  if (additions === 0 && deletions === 0) return null;
  return { additions, deletions, fileCount: paths.size };
}

// One card per tool invocation. Head row: tool-specific icon + verb
// + concise argument summary + status indicator. Expanding shows the
// full input JSON + tool output. Matches the "per-tool family card"
// pattern from opendesign while staying within DevSpace's existing
// details/summary disclosure idiom.
function ToolCard({ call }: { call: ChatMessage['toolCalls'][number] }) {
  const meta = toolDisplay(call.name, call.input);
  const running = call.result === undefined;
  const errored = !!call.isError;
  return (
    <details
      className={cn(
        'rounded-[7px] border bg-surface-2',
        errored
          ? 'border-semantic-error/40'
          : running
            ? 'border-accent/30'
            : 'border-border-subtle',
      )}
    >
      <summary className="flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-[11px] text-text-secondary">
        <meta.Icon
          size={11}
          className={cn(
            errored
              ? 'text-semantic-error'
              : running
                ? 'text-accent'
                : 'text-accent/80',
          )}
        />
        <span className="font-medium text-text">{meta.verb}</span>
        {meta.summary && (
          <span
            className={cn(
              'truncate font-mono text-[10.5px]',
              errored ? 'text-semantic-error/80' : 'text-text-muted',
            )}
          >
            {meta.summary}
          </span>
        )}
        {call.diffStats && (
          <DiffStatChip stats={call.diffStats} showPath={false} />
        )}
        {running && (
          <Loader2 size={10} className="ml-auto shrink-0 animate-spin text-accent" />
        )}
        {!running && !errored && (
          <CheckCircle2
            size={10}
            className="ml-auto shrink-0 text-semantic-success/70"
          />
        )}
        {errored && (
          <XCircle
            size={10}
            className="ml-auto shrink-0 text-semantic-error"
          />
        )}
      </summary>
      <div className="space-y-1.5 border-t border-border-subtle px-2.5 py-1.5">
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-surface-3 px-2 py-1 font-mono text-[10.5px] text-text-muted">
          {JSON.stringify(call.input, null, 2)}
        </pre>
        {call.result !== undefined && (
          <pre
            className={cn(
              'overflow-x-auto whitespace-pre-wrap break-words rounded px-2 py-1 font-mono text-[10.5px]',
              errored
                ? 'bg-semantic-error/10 text-semantic-error'
                : 'bg-surface-3 text-text-secondary',
            )}
          >
            {(call.result ?? '').slice(0, 2000)}
            {(call.result ?? '').length > 2000 && '\n…(truncated)'}
          </pre>
        )}
      </div>
    </details>
  );
}

// Per-tool display metadata: icon + verb ("Read", "Edit", …) +
// argument summary tuned per tool. Falling back to <Wrench/> + the
// raw tool name for tools we don't know about. Keep this table
// honest — Claude can name tools anything (custom MCP servers,
// agent.tools allow-lists) so the fallback path runs often.
function toolDisplay(
  name: string,
  input: Record<string, unknown>,
): {
  Icon: typeof Wrench;
  verb: string;
  summary: string;
} {
  switch (name) {
    case 'Read': {
      const fp = (input.file_path as string) ?? '';
      return { Icon: FileText, verb: 'Read', summary: shortPath(fp) };
    }
    case 'Edit':
    case 'MultiEdit': {
      const fp = (input.file_path as string) ?? '';
      return { Icon: Pencil, verb: 'Edit', summary: shortPath(fp) };
    }
    case 'Write': {
      const fp = (input.file_path as string) ?? '';
      return { Icon: Plus, verb: 'Write', summary: shortPath(fp) };
    }
    case 'NotebookEdit': {
      const fp = (input.notebook_path as string) ?? '';
      return { Icon: Pencil, verb: 'Notebook', summary: shortPath(fp) };
    }
    case 'Bash': {
      const cmd = (input.command as string) ?? '';
      return { Icon: Terminal, verb: 'Bash', summary: truncate(cmd, 80) };
    }
    case 'Glob': {
      const pat = (input.pattern as string) ?? '';
      return { Icon: Folder, verb: 'Glob', summary: pat };
    }
    case 'Grep': {
      const pat = (input.pattern as string) ?? '';
      return { Icon: Search, verb: 'Grep', summary: `"${truncate(pat, 60)}"` };
    }
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? (input.todos as unknown[]) : [];
      return {
        Icon: ListChecks,
        verb: 'Todo',
        summary: `${todos.length} item${todos.length === 1 ? '' : 's'}`,
      };
    }
    case 'Task': {
      const subagent = (input.subagent_type as string) ?? 'subagent';
      const desc = (input.description as string) ?? '';
      return {
        Icon: Users,
        verb: 'Dispatch',
        summary: desc ? `${subagent} · ${truncate(desc, 50)}` : subagent,
      };
    }
    case 'WebFetch': {
      const url = (input.url as string) ?? '';
      return { Icon: Globe, verb: 'Fetch', summary: truncate(url, 80) };
    }
    case 'WebSearch': {
      const q = (input.query as string) ?? '';
      return { Icon: Search, verb: 'Search', summary: `"${truncate(q, 60)}"` };
    }
    default: {
      return {
        Icon: Wrench,
        verb: name,
        summary: summarizeInput(input),
      };
    }
  }
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
      <div className="space-y-2 border-t border-border-subtle px-3 py-2 select-text">
        {step.segments && step.segments.length > 0 ? (
          // v0.11+ segmented step render — same chronological cards as
          // ChatMessage segments, scoped to this step's content/toolCalls.
          <SegmentedBody message={{ segments: step.segments, toolCalls: step.toolCalls }} />
        ) : (
          <>
            {step.toolCalls.length > 0 && <ToolCallList calls={step.toolCalls} />}
            {step.content ? (
              <TextSegmentCard text={step.content} />
            ) : null}
          </>
        )}
        {isRunning &&
          (!step.segments || step.segments.length === 0
            ? !step.content
            : isSegmentListEmpty(step.segments)) && (
            <div className="flex items-center gap-1.5 text-[11.5px] text-text-muted">
              <Loader2 size={11} className="animate-spin" />
              <span>working…</span>
            </div>
          )}
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
// Stable-ish identifier for a freshly-created segment. crypto.randomUUID
// is available in modern Electron's renderer context (Chromium 90+), but
// fall back to a timestamp+random combo to keep this defensive — the id
// only needs to be unique within one assistant turn for React keying.
function newSegmentId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `seg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

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
    // Mirror onto segments[] so the renderer can paint each text /
    // tool_group chunk as its own card in chronological order. If the
    // last segment is already text, extend it; otherwise push a new one.
    //
    // Important: when extending an existing segment we REPLACE it with a
    // new object (not mutate `lastSeg.text += ...`). That gives each
    // event a fresh segment identity so any downstream `memo` on
    // segment-keyed children can safely fast-path. Same goes for
    // `target.segments = [...]` — we rebuild the array reference per
    // event rather than `.push()` so memoized children re-render.
    const prev = target.segments ?? [];
    const lastSeg = prev[prev.length - 1];
    if (lastSeg && lastSeg.kind === 'text') {
      const updated: ChatMessageSegment = {
        kind: 'text',
        id: lastSeg.id,
        text: lastSeg.text + event.text,
      };
      target.segments = [...prev.slice(0, -1), updated];
    } else {
      target.segments = [
        ...prev,
        { kind: 'text', id: newSegmentId(), text: event.text },
      ];
    }
  } else if (event.kind === 'thinking_delta' && event.text) {
    target.thinking = (target.thinking ?? '') + event.text;
  } else if (event.kind === 'tool_use') {
    const toolUseId = event.toolUseId ?? `tu-${Date.now()}`;
    target.toolCalls = [
      ...target.toolCalls,
      {
        id: toolUseId,
        name: event.toolName ?? 'tool',
        input: event.toolInput ?? {},
        diffStats: event.diffStats,
      },
    ];
    // Same immutable replace-not-mutate pattern as text_delta.
    const prev = target.segments ?? [];
    const lastSeg = prev[prev.length - 1];
    if (lastSeg && lastSeg.kind === 'tool_group') {
      const updated: ChatMessageSegment = {
        kind: 'tool_group',
        id: lastSeg.id,
        toolUseIds: [...lastSeg.toolUseIds, toolUseId],
      };
      target.segments = [...prev.slice(0, -1), updated];
    } else {
      target.segments = [
        ...prev,
        { kind: 'tool_group', id: newSegmentId(), toolUseIds: [toolUseId] },
      ];
    }
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

// v0.16 — queued-message pill strip rendered just above the textarea.
// Each pill represents a message the user typed while a prior turn was
// streaming. They auto-fire (head first) when the current turn finishes.
//
// Interactions:
//   • Click pencil → swap to inline input, Enter saves, Esc cancels.
//   • Click X      → drop the message from the queue.
//   • Drag pill    → reorder (HTML5 native DnD, basic but enough for v1).
//
// The component is intentionally dumb / stateless wrt the queue — it
// takes callbacks for update/remove/reorder, so ChatPanel owns the
// projectId+threadId resolution and the store binding.
function QueuePillStrip({
  items,
  paused,
  onUpdate,
  onRemove,
  onReorder,
  onResume,
  onDiscard,
}: {
  items: QueuedMessage[];
  paused: boolean;
  onUpdate: (id: string, text: string) => void;
  onRemove: (id: string) => void;
  onReorder: (from: number, to: number) => void;
  onResume: () => void;
  onDiscard: () => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const startEdit = (q: QueuedMessage) => {
    setEditingId(q.id);
    setEditingText(q.text);
  };
  const commitEdit = () => {
    if (!editingId) return;
    const t = editingText.trim();
    if (t.length === 0) {
      // Empty after edit = the user effectively cleared the message.
      // Drop it rather than persisting a no-op.
      onRemove(editingId);
    } else {
      onUpdate(editingId, t);
    }
    setEditingId(null);
    setEditingText('');
  };
  const cancelEdit = () => {
    setEditingId(null);
    setEditingText('');
  };

  return (
    <div className="mb-2 space-y-1.5">
      {paused && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-[7px] border border-semantic-error/40 bg-semantic-error/10 px-2.5 py-1.5 text-[11px] text-semantic-error"
        >
          <AlertTriangle size={12} className="shrink-0" />
          <span className="flex-1">Queue paused — last reply didn&apos;t complete.</span>
          <button
            onClick={onResume}
            className="rounded border border-semantic-error/50 px-1.5 py-0.5 text-[10.5px] hover:bg-semantic-error/15"
          >
            Resume
          </button>
          <button
            onClick={onDiscard}
            className="rounded px-1.5 py-0.5 text-[10.5px] text-text-muted hover:bg-surface-3 hover:text-semantic-error"
          >
            Discard queue
          </button>
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {items.map((q, idx) => {
          const isEditing = editingId === q.id;
          const isDragging = dragIndex === idx;
          return (
            <div
              key={q.id}
              draggable={!isEditing}
              onDragStart={(e) => {
                setDragIndex(idx);
                // Use a custom MIME so OS file drops can't pretend to be
                // a queue reorder, and the textarea's `Files` /
                // `application/x-devspace-path` drop handlers ignore us.
                e.dataTransfer.setData('application/x-devspace-queue', String(idx));
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragEnd={() => setDragIndex(null)}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes('application/x-devspace-queue')) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                }
              }}
              onDrop={(e) => {
                const raw = e.dataTransfer.getData('application/x-devspace-queue');
                if (!raw) return;
                e.preventDefault();
                const from = Number(raw);
                if (Number.isInteger(from) && from !== idx) {
                  onReorder(from, idx);
                }
                setDragIndex(null);
              }}
              className={cn(
                'inline-flex max-w-[60ch] items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[11.5px] text-text',
                isDragging && 'opacity-50',
              )}
              title={isEditing ? undefined : q.text}
            >
              <Clock
                size={10}
                className="shrink-0 text-text-dim"
                aria-label="Queued message"
              />
              {isEditing ? (
                <>
                  <input
                    autoFocus
                    value={editingText}
                    onChange={(e) => setEditingText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitEdit();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        cancelEdit();
                      }
                    }}
                    className="min-w-[12ch] max-w-[50ch] flex-1 bg-transparent text-[11.5px] text-text outline-none"
                  />
                  <button
                    onClick={commitEdit}
                    title="Save"
                    className="text-text-muted hover:text-accent"
                  >
                    <Check size={11} />
                  </button>
                  <button
                    onClick={cancelEdit}
                    title="Cancel"
                    className="text-text-muted hover:text-text"
                  >
                    <X size={11} />
                  </button>
                </>
              ) : (
                <>
                  <span className="truncate font-mono">{q.text}</span>
                  <button
                    onClick={() => startEdit(q)}
                    title="Edit queued message"
                    className="text-text-muted hover:text-accent"
                  >
                    <Pencil size={10} />
                  </button>
                  <button
                    onClick={() => onRemove(q.id)}
                    title="Remove from queue"
                    className="text-text-muted hover:text-rose-500"
                  >
                    <X size={11} />
                  </button>
                </>
              )}
            </div>
          );
        })}
        {items.length > 0 && !paused && (
          <span className="self-center text-[10px] text-text-dim">
            queued · auto-sends when current reply completes
          </span>
        )}
      </div>
    </div>
  );
}
