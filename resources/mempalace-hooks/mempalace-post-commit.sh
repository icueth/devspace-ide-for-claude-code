#!/usr/bin/env bash
# MemPalace PostToolUse hook — fires after every Bash invocation that
# contained "git commit". Injects a system reminder prompting Claude to
# write a diary entry covering what just shipped, before moving on.
#
# Why this exists:
#   The SessionStart hook tells Claude the protocol once. Across a long
#   session Claude often forgets to diary mid-stream. Anchoring the
#   reminder to git commits — a natural phase boundary — makes the
#   protocol enforced by the harness instead of memory.
#
# Output format: PostToolUse hook JSON with hookSpecificOutput.additionalContext.

set -uo pipefail

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)

# Only fire on Bash calls whose command contains the literal phrase "git commit".
# This catches both raw `git commit ...` and rtk-wrapped `rtk git commit ...`.
case "$CMD" in
  *"git commit"*) ;;
  *) exit 0 ;;
esac

# Skip --amend (those usually fix typos and don't warrant a separate diary entry).
case "$CMD" in
  *"--amend"*) exit 0 ;;
esac

cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"You just ran `git commit`. Per the MemPalace protocol — call `mempalace_diary_write` now with a short AAAK-format entry covering what changed and why, BEFORE moving to the next user request. Skip only if this was a trivial typo/whitespace fix."}}
JSON
