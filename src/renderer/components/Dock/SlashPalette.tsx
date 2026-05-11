import { useEffect, useMemo, useRef } from 'react';

import { cn } from '@renderer/lib/utils';

export interface SlashCommand {
  id: string;
  // Full string the user types after `/` to invoke this. Same as `id`
  // unless there are aliases (then add them as separate entries).
  trigger: string;
  // Short one-liner shown next to the trigger in the palette.
  description: string;
  // If true, the command accepts trailing argument(s) — palette stays
  // open after the trigger is autocompleted so the user can type them.
  hasArgs?: boolean;
  // Optional placeholder shown when the command is selected and accepts
  // args.
  argHint?: string;
}

interface SlashPaletteProps {
  // Current input text (always starts with `/`). The palette reads its
  // own slice — caller doesn't need to pass a filtered substring.
  query: string;
  commands: SlashCommand[];
  // Hover/keyboard selection index. Caller owns this so the textarea's
  // keydown handler can flip it via ↑/↓ without re-rendering the
  // palette unnecessarily.
  highlight: number;
  onHighlight: (idx: number) => void;
  onPick: (cmd: SlashCommand) => void;
}

/**
 * Floating palette that appears above the chat textarea when the user
 * types `/` as the first character of their message. It does NOT send
 * the command to claude — these are client-side UI actions that mimic
 * the CLI's slash commands. The actual `--print` claude invocation
 * doesn't parse slashes at all, so this is the only way to surface
 * `/model` / `/clear` / `/settings` etc. in chat mode.
 *
 * Selection is owned by the parent so arrow-key navigation can be
 * routed through the textarea's onKeyDown without losing focus to a
 * separate listbox.
 */
export function SlashPalette({
  query,
  commands,
  highlight,
  onHighlight,
  onPick,
}: SlashPaletteProps) {
  // Match by prefix of `trigger`. If the user has already typed past
  // the command name (a space), we narrow to that exact command only
  // so the palette transitions into "arg input" mode visually.
  const filtered = useMemo(() => {
    const after = query.slice(1); // strip leading '/'
    const spaceIdx = after.indexOf(' ');
    if (spaceIdx >= 0) {
      const name = after.slice(0, spaceIdx);
      return commands.filter((c) => c.trigger === name);
    }
    const lower = after.toLowerCase();
    return commands.filter((c) => c.trigger.toLowerCase().startsWith(lower));
  }, [query, commands]);

  // Keep the highlight in range when filtering changes the list length.
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (highlight >= filtered.length) onHighlight(0);
  }, [filtered.length, highlight, onHighlight]);

  if (filtered.length === 0) return null;

  return (
    <div
      ref={listRef}
      className="mb-1 max-h-[220px] overflow-y-auto rounded-[8px] border border-border bg-surface-2 shadow-xl"
    >
      {filtered.map((cmd, idx) => {
        const isActive = idx === highlight;
        return (
          <button
            key={cmd.id}
            onMouseEnter={() => onHighlight(idx)}
            onClick={() => onPick(cmd)}
            className={cn(
              'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11.5px] transition',
              isActive
                ? 'bg-[rgba(76,141,255,0.18)] text-text'
                : 'text-text-secondary hover:bg-surface-3',
            )}
          >
            <span className="font-mono text-accent">/</span>
            <span className="font-mono font-medium">{cmd.trigger}</span>
            {cmd.hasArgs && cmd.argHint && (
              <span className="text-[10.5px] text-text-dim">{cmd.argHint}</span>
            )}
            <span className="ml-auto truncate text-[10.5px] text-text-muted">
              {cmd.description}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// Parse the input into (trigger, args). Used by ChatPanel when the user
// presses Enter on a slash command — keeps the parsing logic next to
// the palette so command additions stay localized to this file.
export function parseSlashInput(input: string): {
  trigger: string;
  args: string;
} | null {
  if (!input.startsWith('/')) return null;
  const after = input.slice(1);
  const spaceIdx = after.indexOf(' ');
  if (spaceIdx < 0) return { trigger: after, args: '' };
  return { trigger: after.slice(0, spaceIdx), args: after.slice(spaceIdx + 1).trim() };
}
