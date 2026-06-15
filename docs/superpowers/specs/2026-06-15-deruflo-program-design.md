# De-Ruflo Program — Design Spec

**Date:** 2026-06-15
**Status:** Approved (design) — executing sub-project 1
**Decision:** Remove the ruflo dependency from DevSpace and reimplement its genuinely-useful
capabilities natively, integrated with DevSpace + the Claude Code CLI. ruflo is MIT, so good
ideas can be re-expressed natively.

## Why

A 5-agent live sweep of ruflo v3.10.46 against its USERGUIDE found:
- **Logging + HNSW semantic search work**; memory store/retrieve/export work.
- **The "learning/intelligence" layer is an upstream stub** — `runConsolidateWorker()` returns
  hardcoded zeros, nothing inserts into the SQLite `patterns`/`reasoning_patterns` tables, and
  `neural import` doesn't write them either. Every learning table is 0 rows despite ~1500
  `memory_entries`. The statusline "patternsLearned" is a meaningless counter.
- Many documented commands don't exist (`config list`, `route explain`, `issues accept`,
  `hive-mind sessions/metrics`, `ruflo statusline`); config schema + RVF docs are stale.

Crucially, **DevSpace already has native equivalents** for almost everything good in ruflo:
- `MemoryService.ts` — file-based per-project + global memory, capture, diary, inbox, keyword search.
- `CodeflowGraphAnalyzer` + Graphify (vendored) — code graph + LLM augmentation.
- `PtyPool` / `TmuxChatRunner` / `BackgroundClaudeRunner` — native Claude CLI integration.
- DevSpace-native hooks-independent capture (chat-turn → memory).

The ONLY genuinely-working ruflo capability DevSpace lacks is **semantic/vector search** over
memory. ruflo's headline "learning" is a stub — so "porting" it means **building it for real**.

## Program decomposition (3 sub-projects, each its own spec→plan→build)

1. **Rip-out** (this spec, executing now) — remove all ruflo coupling from DevSpace code +
   uninstall ruflo from the machine; preserve captured data for migration.
2. **Native semantic memory** — add local embeddings (ONNX MiniLM, 384-dim) + a vector index
   (HNSW) to the existing `MemoryService`; migrate the archived `.swarm/memory.db` entries.
3. **Native learning** — distill captured activity (chat turns, edits, commands, diary) into
   durable, retrievable patterns/insights — the differentiator ruflo faked. Net-new build on 1+2.

Decided scope: all three (user: "Rip-out + Semantic + Native learning"). Sequence: 1 → 2 → 3.

---

# Sub-project 1: Rip-out ruflo

## Approach
Staged removal on branch `feat/remove-ruflo` (off `prod`; the obsolete `feat/ruflo-stack-installer`
branch is abandoned). Delete in stages that each keep `tsc` + `vitest` green: UI → IPC/preload →
services → types. Two tracks: **(A) repo code** (committed) and **(B) local machine state** (not
committed — it's the user's machine).

## (A) Repo code changes (committed)

**DELETE (files):**
- `src/main/services/RufloService.ts`
- `src/main/services/RufloDashboardService.ts`
- `src/main/services/RufloPluginsService.ts`
- `src/main/services/__tests__/RufloService.test.ts`
- `src/main/services/__tests__/RufloDashboardService.test.ts`
- `src/main/services/__tests__/RufloPluginsService.test.ts`
- `src/renderer/components/Settings/__tests__/rufloCatalog.test.ts`
- `src/main/ipc/ruflo.ts`
- `src/renderer/components/Settings/RufloSettings.tsx`
- `src/renderer/components/Settings/RufloProjectCard.tsx`
- `src/renderer/components/Dock/RufloOverlay.tsx`
- `src/shared/ruflo.ts`

**EDIT (remove ruflo references):**
- `src/main/index.ts` — drop `import { registerRufloIpc }` + the `registerRufloIpc()` call.
- `src/preload/index.ts` — drop the `ruflo: { … }` namespace (both the impl block and any type block).
- `src/renderer/lib/api.ts` — drop ruflo type exports/namespace.
- `src/shared/ipc-channels.ts` — delete the 14 `RUFLO_*` channel constants.
- `src/renderer/components/Settings/SettingsPage.tsx` — remove the `'ruflo'` tab (TabSwitch array + `Tab` union + `<TabContainer>` case) and the `RufloSettings` import.
- `src/renderer/state/cliTabs.ts` — remove the RufloOverlay mount/show state slice.
- `src/main/services/SetupService.ts` — remove the `ruflo` `SetupCheck` (Phase 0 global-install check) and any ruflo-specific detection.
- `src/main/services/ClaudeSetupRunner.ts` — remove any ruflo-stack additions if present (the
  installer spec was never built into code; the existing brew/claude/tmux/rtk/jq setup stays).
- Any remaining imports of `@shared/ruflo` / deleted services — fix or remove.

**Verification per stage:** `rtk tsc -p tsconfig.json --noEmit` clean; `rtk vitest run` green
(the deleted ruflo tests are expected to vanish; no other suite should break).

## (B) Local machine uninstall (NOT committed — user machine state)
Performed as shell steps, reported but not in git:
- `brew uninstall ruflo`
- unload + remove `~/Library/LaunchAgents/io.ruv.ruflo.daemon.plist` (`launchctl bootout` / `unload` then delete)
- remove `~/.claude/plugins/marketplaces/ruflo` (or `claude plugin marketplace remove ruflo`)
- `rm -rf ~/.npm/_npx`
- remove the ruflo hooks from the local (git-ignored) `.claude/settings.json`, delete the ruflo
  `.claude/helpers/*` scripts, and delete the `claude-flow` entry from the local `.mcp.json`.
- remove the `statusLine` config from `.claude/settings.json` (the ruflo statusline.cjs goes away;
  Claude Code prompt returns to default — a native statusline is a later option).

## (C) Data preservation (for sub-project 2 migration)
Before uninstall, **archive** (move, don't delete) the captured ruflo data:
- `.swarm/memory.db` (≈1500 entries) and `ruvector.db` → `~/.devspace/ruflo-archive/`.
This is the migration source for native semantic memory. `.claude-flow/` may be archived too.

## (D) Explicitly NOT touched (DevSpace-native, keep working)
`MemoryService`, `CodeflowGraphAnalyzer`/Graphify, `PtyPool`/`TmuxChatRunner`/`BackgroundClaudeRunner`,
MemPalace integration, Devlog/Forge/Skills/Agents/MCP/LLM/Git/FS infrastructure.

## (E) Testing / done-criteria
- `rtk tsc --noEmit` clean, `rtk vitest run` green, app builds.
- Smoke: app launches; Settings has **no Ruflo tab**; Setup has **no ruflo init card**; dock has
  **no ruflo overlay**; native **memory + codeflow still work**.
- `which ruflo` → not found; `~/Library/LaunchAgents/io.ruv.ruflo.daemon.plist` gone; archive exists.
- No remaining `@shared/ruflo` / `registerRufloIpc` / `RUFLO_` references in `src/`.

## Out of scope (later sub-projects)
Semantic search, embeddings, vector index, data migration, native learning — all in 2 & 3.
