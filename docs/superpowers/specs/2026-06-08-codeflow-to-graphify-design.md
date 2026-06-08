# Codeflow → Graphify Migration — Design Spec

**Date:** 2026-06-08
**Status:** Draft for review
**Topic:** Replace DevSpace's in-house TypeScript "codeflow" code-analysis feature with the [graphify](https://github.com/safishamsi/graphify) Python engine, shipped as a bundled standalone binary.

---

## 1. Context & Goals

DevSpace ships a built-in **Codeflow** feature (TS/Electron): it parses a project, builds file- and function-level graphs, augments them with git churn / blast-radius / cycles, renders an interactive d3 graph, and generates `.claude/codeflow/*.md` narrative docs that Claude Code auto-loads. The user wants to replace this with **graphify** — a mature Python code-knowledge-graph engine (tree-sitter AST across 23+ languages, NetworkX graph, Leiden/Louvain communities, a `query`/`path`/`explain` engine, an MCP server, PR-impact analysis).

**Locked decisions (from brainstorming):**

| # | Decision | Rationale |
|---|----------|-----------|
| G1 | Adopt **graphify the real Python engine** (not a reimplementation) | Want graphify's features + parsing accuracy + less TS to maintain |
| G2 | Ship it as a **bundled per-OS standalone binary** (PyInstaller `--onedir`) | No Python install on user machines; works offline; source never leaves the machine |
| G3 | A **queryable graph replaces the static narrative docs** (`codebase.md`/`flow-*.md`) | graphify's value is on-demand `query`/`path`/`explain`, not pre-written prose |
| G4 | graphify replaces the **functions (symbol) view** — symbol-for-symbol onto `CodeflowFunctionGraph` | graphify is a symbol-level graph; this is its natural shape |
| G5 | Keep what graphify lacks: **git churn, FileWatcher live-sync, workspace sandbox, IPC, the d3 renderer** | No graphify equivalent; these stay in TS |

**Non-goals (YAGNI):** team/shared HTTP graph server; Obsidian export; doc/image/video semantic extraction; LLM-named communities offline; the file-level graph view (see §5, Decision D-FILEVIEW); web-tree-sitter / WASM (explicitly rejected — we run the real graphify binary).

---

## 2. Key Realization — the bundling path is already proven

DevSpace **already bundles a per-OS native binary today**: `uv`. The full pipeline exists and works:

- `scripts/fetch-uv.mjs` — fetches the per-OS binary at build time
- `package.json` `build.extraResources` — maps it into `<App>/Contents/Resources`
- `src/main/utils/mempalacePaths.ts:16-51` — `platformKey()` / `getBundledUvBinary()` / `bundledUvExists()` resolve it from `process.resourcesPath` (packaged) or `resources/` (dev)
- `scripts/after-pack.cjs` — prunes the wrong-arch copy on single-arch mac builds

**We clone this pattern for graphify.** This de-risks G2 almost entirely — the freeze itself is the only genuinely new work.

---

## 3. Feasibility Summary (verified against source)

| Area | Verdict | Notes |
|------|---------|-------|
| Freeze to binary | 🟡→🟢 | Green **if minimal**. Bundle only: tree-sitter core + 26 grammar `.so/.pyd` + `networkx` + `datasketch` + `rapidfuzz`. **Exclude** graspologic/numba/scipy/sklearn (Leiden), faster-whisper, matplotlib, boto3, tiktoken. ~60–110 MB/platform. Use networkx-**Louvain** instead of graspologic-Leiden (`cluster.py:70-76` fallback). |
| Offline structural graph | 🟢 | Code-only corpus needs **no API key, no network** (`README.md:427`; `extract.py` has zero network/LLM imports). AST-only; per-file content-hash cache; sub-second incremental. |
| Invocation seam | 🟢 | Build = one-shot `graphify extract`. Query = persistent `python -m graphify.serve` MCP-stdio child (graph stays warm; **hot-reloads on `graph.json` rewrite** — `serve.py:535-558,1021`). |
| DevSpace integration | 🟡 | graphify plugs in at exactly **two seams**; the d3 renderer is untouched via an adapter. |
| Schema mapping | 🟡 | graphify is **symbol-level**; `source_file` paths are machine-specific/inconsistent → normalization is the brittle, load-bearing step. graphify lacks `degree`/`layer`/`loc`/churn → the adapter synthesizes them. |

**The freeze gotcha that must not be missed:** the 26 grammars load via dynamic string import (`extract.py:2159` `importlib.import_module(config.ts_module)`), invisible to PyInstaller's static analysis. A missed grammar **silently** returns `{nodes:[],edges:[],error:'… not installed'}` at runtime (not a crash). Mitigation: generate the `--hidden-import` + `--collect-binaries` list **programmatically** from the `LanguageConfig` table (`extract.py:1825-2160`), plus a CI fixture test per bundled language.

---

## 4. Target Architecture

```
FileWatcher onAnyChange
      │
      ▼
CodeflowGraphLive  (KEEP — debounce 400ms, coalescing, WeakSet teardown)
      │   swap ONLY the body of triggerRebuild()  [seam #1]
      ▼
GraphifyDriver ──spawn──▶ [graphify binary]  extract  (offline, AST-only, incremental)
      │   reads graphify-out/graph.json (NetworkX node_link)
      ▼
graphify → CodeflowFunctionGraph adapter
   • normalize node.source_file → clean project-relative path  (brittle, load-bearing)
   • symbol node → CodeflowFunctionNode {id, name, file, line, kind, className, layer, degree}
   • compute degree from links
   • map relation → kind/edge styling;  carry confidence (EXTRACTED/INFERRED)
   • merge git-churn (TS pass, key = cleaned file path; every symbol inherits its file's churn)
   • run cycles / reachability / blast on the symbol call-graph (pure graph algos)
      │   CodeflowFunctionGraph
      ▼
CODEFLOW_GRAPH_UPDATED ──▶ d3 renderer  (KEEP verbatim, functions viewMode)

Query path:
QueryPanel ──▶ CODEFLOW_QUERY/PATH/EXPLAIN  (assertInWorkspace)
      └──▶ GraphifyDriver ──▶ persistent  python -m graphify.serve  MCP-stdio child (warm)
              └──▶ result parsed to node ids ──▶ setSelected/blastTrace ──▶ canvas highlight
```

graphify enters DevSpace at exactly **two seams**: (1) `CodeflowGraphLive.triggerRebuild` (`CodeflowGraphLive.ts:77`) and (2) the `CODEFLOW_BUILD_FUNCTION_GRAPH` IPC handler. Everything downstream of the adapter (the renderer, sandbox, live-sync, git pass) is preserved.

---

## 5. Components

| Component | New/Changed | Role |
|-----------|-------------|------|
| **graphify frozen binary** (per-OS) | NEW (bundled) | PyInstaller `--onedir` freeze: CPython + tree-sitter core + 26 grammars + networkx + datasketch + rapidfuzz. Provides AST extraction, structural graph, Louvain communities, `query`/`path`/`explain`/`affected`, MCP stdio server. |
| `scripts/freeze-graphify.mjs` | NEW | Per-OS freeze driver (sibling of `fetch-uv.mjs`). Hidden-imports/collect-binaries list generated from `extract.py` `LanguageConfig` so no grammar is silently dropped. Writes `resources/graphify/<platform>/`. |
| `src/main/utils/graphifyPaths.ts` | NEW (clone of `mempalacePaths.ts`) | Resolve the bundled binary by `process.platform`/`arch` from `process.resourcesPath` (packaged) or `resources/` (dev). |
| `scripts/after-pack.cjs` | EXTEND | Also prune `resources/graphify/<wrong-arch>/` on single-arch mac builds. |
| **`GraphifyDriver`** (main service) | NEW | Owns the subprocess lifecycle: one-shot `extract` for builds (argv-only `execFile`, timeout, maxBuffer, kill-on-dispose); one persistent MCP-stdio child per project for queries (JSON-RPC `initialize`→`initialized`→`tools/call`). Surfaces size-cap `exit(1)` and `error:` / `tree_sitter_* not installed` stderr as errors, not hangs. Sets `GRAPHIFY_QUERY_LOG_DISABLE=1` in the spawn env. |
| **graphify→CodeflowFunctionGraph adapter** | NEW (in `GraphifyDriver`) | §6. |
| `CodeflowGraphLive.ts` | KEEP + adapt body | Live-sync state machine kept; only the `buildGraph()` call (line 77 + the `subscribeGraph` build branch ~159) is rewired to `GraphifyDriver`. |
| `ipc/codeflow.ts` | ADAPT | Keep `assertInWorkspace` on every handler + graph-subscribe plumbing. Delete analyze/cancel/readDoc/listDocs/openDir + 8 augment handlers. Rewire `CODEFLOW_BUILD_FUNCTION_GRAPH`. Add `CODEFLOW_QUERY/PATH/EXPLAIN/COMMUNITY/PR_IMPACT` pass-throughs. |
| `CodeflowGraph.tsx` (d3 renderer) | KEEP | Untouched, functions `viewMode`. Add a `'community'` `ColorMode` (enum at line 50). |
| **`QueryPanel`** (renderer) | NEW | Replaces the deleted `DocsTabs` + `MarkdownPreview` doc-reader pane. Query/Path/Explain modes feed `setSelected`/`blastTrace` highlight pipeline; community/PR-impact reuse the same highlight/color machinery. |
| **graphify-query Claude skill** | NEW (replaces `codeflow-context` skill) | Tells Claude to run `graphify query/explain` instead of "read codebase.md", preserving the agent-context benefit. |

---

## 6. Schema Mapping — graphify → `CodeflowFunctionGraph`

graphify `graph.json` is NetworkX `node_link` (stable across all 4 worked corpora): top-level `{directed, multigraph, graph:{}, nodes:[], links:[]}`.

- **node:** `{id, label, file_type, source_file, source_location, community}` — `id` is a **symbol slug** (`engine_value_init`), NOT a path; `source_location` is the declaration line (`"L5"`), not a line count.
- **link:** `{source, target, relation, confidence, weight, source_file, source_location}` — `relation ∈ {imports, imports_from, calls, method, contains, inherits}`; `confidence ∈ {EXTRACTED, INFERRED, AMBIGUOUS}`; `weight ∈ {0.8, 1.0}` (near-binary).

**Adapter → `CodeflowFunctionNode` `{id, name, file, line, kind, className, layer, degree}` (`types.ts:691`):**

| target field | source | transform |
|--------------|--------|-----------|
| `id` | `node.id` | direct (symbol slug) |
| `name` | `node.label` | direct |
| `file` | `node.source_file` | **normalize → clean project-relative forward-slash path** (load-bearing; see risk R-PATH) |
| `line` | `node.source_location` | parse `"L5"` → `5` |
| `kind` | `relation`/heuristic | `method`→`method`, `contains`(class member)→`class`, else `function` |
| `className` | structural | from `contains`/`inherits` parent when present |
| `layer` | derived | `detectLayer(file)` (KEEP `detectLayer`, repurpose as adapter normalizer) |
| `degree` | `links` | compute (graphify omits it) |
| `community` | `node.community` | NEW field → drives a `'community'` color mode |
| `loc`, `size` | — | `0` (graphify lacks them; functions view already renders `0` gracefully) |

**Edges → `CodeflowFunctionEdge` `{source, target, count, confidence}`:** map `relation`→edge styling; carry graphify `confidence` (EXTRACTED→solid, INFERRED→dashed). Consider extending the edge taxonomy to keep `calls`/`method`/`contains`/`inherits` meaning instead of collapsing.

**External-import stubs:** ~19% of graphify nodes are bare `{id, community}` externals (`torch`, `os`). Filter them, or bucket as a distinct `'external'` layer so they don't skew `degree`.

**Git churn (KEEP — graphify ships zero git data):** keep the TS `parseGitLogNumstat`/`computeGitIntelligence` pass (`CodeflowGraphAnalyzer.ts:444,533`). Merge `GitFileStats` onto symbol nodes keyed by the **cleaned file path** (NOT `node.id`); every symbol inherits its file's churn. To use churn/blast as color modes on the symbol graph, extend `CodeflowFunctionNode` with the relevant fields.

**Cycles / reachability / blast (KEEP as adapter post-passes):** pure graph algorithms run on the adapted symbol call-graph; no graphify feature required.

---

## 7. Live-Sync Plan

Live-sync stays DevSpace-owned and **structural-only**. **Do not** use graphify's `watch()` daemon — it full-re-extracts per debounce batch with a 3 s debounce (`watch.py:881`). Instead:

1. Drive rebuilds through the existing `CodeflowGraphLive` 400 ms debounce.
2. Spawn one-shot `graphify extract <projectPath>` — automatically incremental when `manifest.json`+`graph.json` exist (`__main__.py:4007`); the per-file content-hash AST cache (`cache.py:98-143`) means only changed files re-parse (μs–low-ms/file); clustering is "sub-second at 10k nodes".
3. The real cost is the binary's CPython cold-start per spawn (tens–low-hundreds of ms for `--onedir`), bounded acceptably behind the 400 ms debounce.
4. **Fallback if spawn cost is too high on huge repos:** keep CPython warm via a persistent worker (or reuse the warm MCP child to trigger an in-process incremental rebuild). Decide after Phase 2 perf measurement.

Keep `blastHelpers.transitiveDependents/Dependencies` as the renderer-side click-to-trace fallback so interactive tracing never depends on a binary round-trip.

---

## 8. Packaging Pipeline (mirror the uv pipeline)

1. **Freeze** — `scripts/freeze-graphify.mjs` runs PyInstaller `--onedir` (not `--onefile`) on `graphify/__main__.py`, per OS/arch runner. Native C-extensions **cannot cross-compile** → 4-leg CI matrix: `macos-arm64` (macos-14), `macos-x64` (macos-13), `windows-x64`, `linux-x64` — the **same matrix the Electron wrapper already needs**. Grammar `.so/.pyd` force-collected via `--collect-binaries` using the generated `LanguageConfig`-derived list.
2. **Bundle** — write `resources/graphify/<platform>/`; add a `build.extraResources` entry alongside the existing mempalace-uv entries.
3. **Prune** — extend `after-pack.cjs` to drop the wrong-arch copy on single-arch mac builds.
4. **Resolve** — `graphifyPaths.ts` resolves the entry binary at runtime.
5. **Sign** — macOS must codesign + notarize the **embedded** `.so/.pyd` parsers (Gatekeeper), not just the app shell. Already part of the mac dist flow — verify coverage.
6. **Validate** — CI runs the frozen binary against a fixture repo covering **every bundled language**, asserting no `tree_sitter_* not installed` surfaces.
7. **Audit** — per-(os,arch) prebuilt-wheel availability for niche grammars (`swift`, `powershell`, `zig`, `verilog`, `fortran`, `objc`, `julia`, `dm` [Windows-only]) **before** committing to all 26; drop or source-compile per-platform as needed.

---

## 9. Keep / Delete / Adapt / Add Ledger

**DELETE** (graphify replaces / docs retired):
- `CodeflowFunctionAnalyzer.ts` — entire file (parsing + name-based call resolution + `renderFunctionMap`/`persistFunctionGraph` writing `function-map.md`/`function-graph.json`).
- `CodeflowGraphAnalyzer.ts` — the **parsing pipeline only**: `buildGraph` (1131-1341), `walk`/`gitListFiles`, `loadAliases`/`stripJsonComments`, `resolveSpec`/`probeTarget`, the import extractors (`extractTsImports`/`extractPyImports`/`extractGenericImports`). The file-level graph view is retired (Decision D-FILEVIEW). **KEEP** the reusable helpers from this file — `parseGitLogNumstat`/`computeGitIntelligence`, `computeCycles`/`computeReachability`/`computeBlast`, `detectLayer` — they become adapter post-passes (see KEEP/ADAPT).
- `CodeflowService.ts` doc-generation: `runClaude` (658-841), `buildOverviewPrompt`/`buildFlowsPrompt`, `STAGE_BANDS`, `describeEvent`/`describeToolUse`, overview+flows stages; `writeClaudePointer` (198-244) + `CLAUDE_MD_BEGIN/END`, `writeSkill` (251-292), `listDocs`/`readDoc`, `walkWithContent` + `CodeflowFileWithContent`.
- `CodeflowGraphAugment.ts` — entire file (soft-edge Claude inference; removes 2 Claude spawns + 4 IPC channels).
- `ipc-channels.ts`: `CODEFLOW_ANALYZE/CANCEL/READ_DOC/LIST_DOCS/OPEN_DIR/GET_STATUS/PROGRESS` + all 8 AUGMENT channels.
- `types.ts`: `CodeflowStage`, `CodeflowDoc`, `CodeflowStatus.docs`+`stale`, `CodeflowAnalyzeOptions.force`.
- `CodeflowView.tsx`: `DocsTabs`/`TabButton`, `MarkdownPreview` pane, `activeDoc`/`docContent`/`readDoc` effects.
- On disk: maintained `.claude/CLAUDE.md` auto-block + `.claude/codeflow/*.md` — **delete-on-first-graphify-run** so no stale "read codebase.md" pointer misleads downstream Claude.
- `preload/api.ts`: the `notWired` codeflow doc/augment surface.

**KEEP:**
- `CodeflowGraphLive.ts` state machine (subscribe/broadcast/debounce/coalesce/WeakSet teardown).
- FileWatcher wiring; `workspace.ts` disposeProject teardowns.
- `ipc/codeflow.ts` `assertInWorkspace` gate on every handler + registration scaffolding + graph-subscribe plumbing.
- `CodeflowGraph.tsx` d3 renderer (sim, zoom/pan, color modes, NodeDetails, ToolbarOverlay) + `blastHelpers.ts`.
- `CodeflowView.tsx` shell (Toolbar/StatusBadge/ProgressBar/GraphStatsBar, synthetic-tab integration, Ultra-Review PTY button).
- TS git-churn pass; cycles/reachability/blast (now adapter post-passes on the symbol graph).

**ADAPT:**
- `CodeflowGraphLive.triggerRebuild` (77) + `subscribeGraph` build branch (~159) → `GraphifyDriver.build()` + adapter. [seam #1]
- `ipc/codeflow.ts`: rewire `CODEFLOW_BUILD_FUNCTION_GRAPH` → `GraphifyDriver`; add query channels. [seam #2]
- `types.ts`: `CodeflowFunctionGraph`/Node/Edge become the adapter target; add `community`; extend node with churn/blast fields if those color modes are wanted; extend edge taxonomy.
- `detectLayer` (`CodeflowGraphAnalyzer.ts:656`): repurpose as adapter normalizer.
- `FileWatcherService.markStale`: retarget to "graph stale".
- `CodeflowService.disposeProject`: retarget kill-on-dispose to graphify children (one-shot + MCP child).
- `preload/api.ts` + `preload/index.ts`: add query/path/explain/community/prImpact bridge methods.

**ADD:** `freeze-graphify.mjs`, `graphifyPaths.ts`, `GraphifyDriver` + adapter, `CODEFLOW_QUERY/PATH/EXPLAIN/COMMUNITY/PR_IMPACT` IPC, `QueryPanel`, graphify-query skill, `package.json` extraResources entry, CI 4-leg freeze matrix + per-language fixture validation.

---

## 10. Phased Delivery

| Phase | Goal | Deliverable |
|-------|------|-------------|
| **0 — Freeze spike** | De-risk the only yellow before touching TS | Minimal `--onedir` freeze on all 4 (os,arch); bundle like uv; CI fixture test per language; niche-grammar wheel audit |
| **1 — Delete doc + augment layer** | Low-risk clean cut (no renderer-data dependents) | Doc-gen + `writeClaudePointer`/`writeSkill`/`listDocs` removed; `CodeflowGraphAugment.ts` + `CodeflowFunctionAnalyzer` doc writers removed; 8 AUGMENT + doc IPC channels removed; `DocsTabs`/`MarkdownPreview` removed; on-disk migration + graphify-query skill landed |
| **2 — Wire graphify behind the seams + adapter** | Swap graphify in; renderer untouched | `GraphifyDriver` (one-shot extract, lifecycle, size-cap handling) + adapter to `CodeflowFunctionGraph`; KEEP git-churn merge + cycles/blast post-passes; live-sync via incremental extract; **verify perf under 400ms debounce on a large repo** before deleting TS analyzer helpers |
| **3 — Persistent query child + QueryPanel** | The net-new queryable-graph capability | Persistent `graphify.serve` MCP-stdio child (warm, hot-reload); `CODEFLOW_QUERY/PATH/EXPLAIN/COMMUNITY/PR_IMPACT`; `QueryPanel` feeding `setSelected`/`blastTrace`; `'community'` color mode; PR-impact highlight (gate `gh`-dependent tools when `gh` absent) |
| **4 — Verified deletes + cleanup** | Remove RISKY-DELETE helpers only after proven | After confirming coverage, delete orphaned analyzer helpers; remove dead types/channels; end-to-end test on the DevSpace repo itself |

---

## 11. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **R-GRAMMAR** Silent per-language drop (dynamic imports invisible to PyInstaller) | Generate hidden-imports/collect-binaries from `LanguageConfig`; CI fixture test per language |
| **R-BLOAT** Over-bundling (graspologic→numba/llvmlite, 200–400 MB, fragile) | Ship minimal; networkx-Louvain; if Leiden truly needed, prefer light `igraph+leidenalg` over graspologic |
| **R-LATENCY** Spawn cold-start regresses live-sync | Incremental cache means only changed files re-parse; measure in Phase 2; fallback warm worker |
| **R-PATH** `source_file` machine/corpus-specific & inconsistent (absolute vs `worked/httpx/raw/`) | Focused normalization unit-test suite over real `graph.json` fixtures; **never** use `node.id` as the git merge key |
| **R-RISKYDELETE** Deleting git-churn or cycles/blast breaks color modes + inspector | KEEP both as adapter passes by default; delete only after proven equivalents (Phase 4) |
| **R-SIGN** macOS Gatekeeper on embedded `.so/.pyd` | Verify codesign/notarize covers embedded binaries, not just app shell |
| **R-PROSE** MCP tool outputs are text, not JSON (`serve.py:1026`) | Read `graph.json` directly for exact fields; use MCP child only for NL/traversal queries |
| **R-COSMETIC** `weight` near-binary; `relation→kind` lossy | Low severity; extend edge taxonomy if structural styling matters |

---

## 12. Open Items (recommendations baked in; confirm at spec review)

- **D-FILEVIEW (confirm):** "Functions view only" + "delete TS analyzers" → **recommend retiring the file-level graph view** entirely; the Codeflow tab shows the graphify-backed symbol graph. (A file view could be re-added later by collapsing symbols by `source_file` — no TS parser needed. YAGNI for now.)
- **Leiden vs Louvain:** ship **Louvain** (green freeze, offline). ✅
- **Community labels / PR-impact (LLM/`gh`):** name communities on-demand via DevSpace's existing Claude plumbing (Node side); offline = numbered-only; hide PR tools when `gh` absent. ✅
- **On-disk migration:** delete-on-first-graphify-run + replace `codeflow-context` skill with graphify-query skill. ✅
- **Query log side effect:** set `GRAPHIFY_QUERY_LOG_DISABLE=1` in the spawn env. ✅
- **`[mcp]` extra in the freeze:** include it (stdio query child needs the `mcp` dep); HTTP transport (starlette/uvicorn) excluded.

---

## 13. Success Criteria

1. DevSpace ships per-OS without any Python install; `graphify --version` runs from the bundled binary on all 4 (os,arch).
2. Opening Codeflow on a multi-language repo produces a symbol graph with **tree-sitter-grade** edges for non-JS/TS languages (better than the old regex).
3. Live-sync repaints on file save within an acceptable budget behind the 400 ms debounce (measured Phase 2).
4. QueryPanel answers query/path/explain against the warm MCP child; results highlight on the canvas.
5. Git-churn color mode still works (merged onto symbol nodes).
6. No `.claude/codeflow` stale-doc pointer remains after migration.
