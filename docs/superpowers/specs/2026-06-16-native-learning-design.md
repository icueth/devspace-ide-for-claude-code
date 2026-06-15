# Sub-project 3: Native Learning — Design Spec

**Date:** 2026-06-16
**Status:** Approved (design) — build core first
**Parent:** `docs/superpowers/specs/2026-06-15-deruflo-program-design.md`
**Branch:** `feat/remove-ruflo`

## Goal
Turn captured activity into durable, **retrievable, human-curatable learnings** that visibly help
future work — the thing ruflo *claimed* but never delivered (its learning pipeline is a hardcoded
stub). This is the final de-ruflo sub-project. User wants all four consumer behaviors.

## Anti-ruflo principle (the core insight)
Learnings are **plain markdown entries in DevSpace's native memory** (`~/.devspace/.../memory/`),
distilled by **real Claude** (via the native `BackgroundClaudeRunner` = the user's own
subscription, not the Agent SDK pool, not a stub). Therefore they are:
- **Visible + editable + deletable** by the user (the Memory UI already lists/edits entries).
- **Searchable** by the semantic index from sub-project 2 (entries auto-embed on create).
- **Never a black box.** If a learning is wrong, the user prunes it. This is why it will actually
  be trusted and used, unlike ruflo's opaque (and fake) `patterns` table.

## Architecture: 1 core engine + 4 consumers

### Core — `DistillationService` (new, `src/main/services/DistillationService.ts`)
1. **Gather** recent activity for a project: chat-turn captures (the memory inbox / `proposeFromTurn`
   source), recent `diary/` entries, recent `devlog`, and recently-changed memory. Build a bounded
   "activity digest" (cap tokens; most-recent-first).
2. **Distill** via `BackgroundClaudeRunner` (`claude --bg --exec '<prompt>'`): the prompt hands Claude
   the digest and asks it to emit **structured JSON learnings** between sentinel markers, each:
   `{ type: 'lesson'|'preference'|'workflow', title, body, confidence }`. The prompt forbids inventing
   learnings (must be grounded in the digest) and asks for few, high-quality items.
3. **Parse + persist**: poll the run to completion, read its log (`~/.devspace/bg-runs/<runId>.log`),
   extract the JSON block, validate, and `MemoryService.createEntry` each as a typed memory entry.
   Entries auto-embed (sub-project 2) → immediately semantic-searchable. De-dupe against existing
   learnings (semantic similarity > threshold → skip/merge) so re-runs don't pile up duplicates.

New `MemoryType`s: add `'lesson'` and `'workflow'` to the union (preferences reuse the existing
`'feedback'` type, which already feeds the inject preamble). Update `MEMORY_TYPES`, validation, and
the Memory UI type filter/labels.

### Consumers (the four selected behaviors)
- **#3 Distill → lessons/patterns** = the core engine above (produces `lesson`/`workflow` entries).
- **#2 Preference → inject-preamble** — `buildInjectPreamble` (MemoryService ~1931 today) already
  builds the preamble; ensure distilled `feedback`/`preference` learnings are included (they will be,
  since they're normal memory entries) and ranked sensibly. Thin change.
- **#1 Auto-surface relevant past knowledge** — `buildRecallContext` (~2205) gains a semantic pass:
  given the current task/prompt text, semantic-search learnings + memory (sub-project 2) and include
  the top-K relevant as "You've dealt with something like this before: …". Surfaced via the existing
  recall path (no new UI required to start).
- **#4 Recurring workflow → shortcut** — `workflow`-type learnings are surfaced like other learnings;
  a dedicated "suggest shortcut" affordance is the **deferred tail** (fuzziest, lowest value).

### Trigger / cadence
- **Manual button** "Learn from recent work" (Settings → Memory, or a command) → runs distillation
  for the active project. Controlled, no surprise LLM cost. **Primary.**
- **Opt-in auto on session end** — a setting (default OFF) that runs distillation when a Claude
  session ends (hook into the existing chat-finalize / SessionEnd path). Off by default because each
  run is a Claude call.

## Build order (this sub-project)
1. **Core `DistillationService`** + the new memory types + manual trigger (IPC + a button) + tests of
   the *pure* parts (digest builder, JSON parse/validate, de-dupe) — LLM call mocked.
2. **#2 preference → inject-preamble** wiring (thin) + test.
3. **#1 auto-surface** in `buildRecallContext` (semantic pass) + test.
4. **#4 workflow shortcut** — deferred; ship `workflow` entries as surfaced learnings only.

## Data flow
manual button / opt-in session-end → gather digest → `BackgroundClaudeRunner` distill → parse JSON
from run log → de-dupe (semantic) → `createEntry` typed learnings (auto-embed) → consumed by
inject-preamble (#2) + recall auto-surface (#1), browsable/editable in the Memory UI.

## Error handling
- No Claude binary / run fails / unparseable output → distillation no-ops with a clear status; never
  corrupts memory. (Same additive-never-required stance as sub-project 2.)
- LLM emits junk / hallucinated learnings → the de-dupe + the user's ability to prune are the guard;
  low-confidence items can be held for review (reuse the existing memory inbox) instead of
  auto-committed.
- Distillation is always background + non-blocking; never blocks chat or the UI.

## Testing
- `DistillationService.test.ts` — pure parts only (LLM mocked): activity-digest builder (bounded,
  recent-first), JSON-learnings parse + schema validation (tolerant of surrounding log noise),
  semantic de-dupe decision. The LLM output is a fixture.
- inject-preamble test — distilled `feedback`/`preference` entries appear in the preamble.
- recall test — `buildRecallContext` semantic pass returns a related prior learning for a query that
  shares no keywords.
- **Honest limit:** the *quality* of Claude's distillation is not unit-testable (it's a judgment
  call). Tests cover the plumbing; quality is validated by a manual run + the curatable-by-user
  safety net.

## Done-criteria
`typecheck` + `vitest` green; `electron-vite build` ok; a manual "Learn from recent work" run on a
real project produces ≥1 sensible `lesson`/`preference` entry visible + editable in the Memory UI,
that entry is semantic-searchable, and a `preference` learning shows up in the next inject-preamble.

## YAGNI / deferred
#4 workflow-shortcut automation, auto-on-session-end ON by default, cross-project learning,
confidence-decay/aging, any learning "dashboard" beyond the existing Memory UI.
