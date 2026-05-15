#!/usr/bin/env bash
# MemPalace SessionStart hook — injects protocol reminder so Claude
# uses the memory palace from the start of every session.
#
# Output format: Claude Code SessionStart hook JSON with
# hookSpecificOutput.additionalContext, which is merged into the model's
# context at session start.

cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"MemPalace is ACTIVE. Protocol — follow ON EVERY SESSION:\n\n1. WAKE-UP: Call mcp__plugin_mempalace_mempalace__mempalace_status as your FIRST tool call to load palace overview (wings, rooms, drawer counts, AAAK spec).\n\n2. BEFORE RESPONDING about any person, project, past event, or fact you might have seen earlier: call mcp__plugin_mempalace_mempalace__mempalace_search or mcp__plugin_mempalace_mempalace__mempalace_kg_query FIRST. Never guess from training data. Wrong is worse than slow.\n\n3. AFTER MEANINGFUL WORK (finishing a feature, making a decision, learning something): call mcp__plugin_mempalace_mempalace__mempalace_diary_write to record what happened, what you learned, what matters.\n\n4. WHEN FACTS CHANGE: call mcp__plugin_mempalace_mempalace__mempalace_kg_invalidate on the old fact, then mcp__plugin_mempalace_mempalace__mempalace_kg_add for the new one.\n\nStorage ≠ memory. Storage + this protocol = memory."}}
JSON
