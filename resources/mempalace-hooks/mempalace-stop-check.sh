#!/usr/bin/env bash
# MemPalace Stop hook — runs when Claude finishes responding to a turn.
# Inspects the session transcript and, if 5+ tool uses have happened
# since the most recent mempalace_diary_write (or no diary at all),
# injects a reminder for the next turn.
#
# Why this exists:
#   Catches sessions where Claude is buried in implementation flow and
#   never paused to write. Threshold-based so trivial chats don't spam.

set -uo pipefail

INPUT=$(cat)
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null)
[[ -z "$SESSION_ID" ]] && exit 0

# Locate the transcript JSONL. Claude Code stores it under
# ~/.claude/projects/<sanitized-cwd>/<session>.jsonl, but the path layout
# can shift across versions — search broadly.
TRANSCRIPT=$(find "$HOME/.claude/projects" -name "${SESSION_ID}.jsonl" -type f 2>/dev/null | head -1)
[[ -z "$TRANSCRIPT" || ! -f "$TRANSCRIPT" ]] && exit 0

# Find the line number of the LAST diary write in this session.
# Use the actual tool-call signature (`"name":"...mempalace_diary_write"`)
# rather than a bare substring — the tool name also appears in system
# prompts, deferred_tools_delta listings, and SessionStart context, which
# would otherwise fool the cutoff. If there hasn't been one yet, treat
# the whole transcript as "since".
LAST_DIARY_LINE=$(grep -n '"name":"mcp__plugin_mempalace_mempalace__mempalace_diary_write"' "$TRANSCRIPT" 2>/dev/null | tail -1 | cut -d: -f1)
LAST_DIARY_LINE=${LAST_DIARY_LINE:-0}

# Count tool_use blocks after the last diary write (or from start if none).
TOOL_USES_SINCE=$(tail -n "+$((LAST_DIARY_LINE + 1))" "$TRANSCRIPT" 2>/dev/null \
    | grep -c '"type":"tool_use"' || echo 0)

# 5+ tool uses since last diary = meaningful work happened.
#
# Stop hooks do NOT accept `hookSpecificOutput.additionalContext` —
# Claude Code's hook schema allows that field only on UserPromptSubmit /
# PostToolUse / PostToolBatch. The previous version of this script
# emitted it anyway and every turn ended with
#   "Hook JSON output validation failed — (root): Invalid input"
# which spammed the user without ever delivering the nudge.
#
# Valid Stop-hook outputs are `decision:"block"` with `reason` (forces
# another agent turn — too aggressive for a soft reminder) or a plain
# empty object. Neither matches the original "invisible per-turn nudge"
# intent. The MemPalace plugin's own Python Stop hook already triggers a
# proper auto-save block every N exchanges, so this companion script
# now just logs to stderr for the user to audit and emits no JSON.
if [[ "$TOOL_USES_SINCE" -ge 5 ]]; then
  printf '[mempalace-stop-check] %s tool uses since last diary write\n' \
    "$TOOL_USES_SINCE" >&2
fi

exit 0
