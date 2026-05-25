# Design-as-Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the torn-down Design Studio with bundled design skills (seeded into `~/.claude/skills/` so Claude Code CLI discovers them) plus an auto-opening HTML preview tab triggered when Claude writes an `.html` artifact.

**Architecture:** Three additive subsystems on top of the clean teardown baseline (`6d74601` on `feat/design-skills`):
1. **Bundle + seed** — ship a trimmed copy of opendesign's 122 skills + 148 brand design-systems in `resources/`; a main-process `SkillSeedService` copies them into `~/.claude/skills/` (+ `~/.claude/design-systems/`) idempotently on launch, never clobbering user edits, gated by a settings toggle.
2. **Auto-preview** — the renderer chat event stream already carries `tool_use`/`tool_result`. Detect a successful `Write`/`Edit`/`MultiEdit` of an `.html` file and auto-open an `html-preview` editor tab. No new IPC.
3. **HTML preview view** — salvage the deleted `DesignPreview` Blob-URL sandboxed-iframe primitive, repointed at `api.fs.readFile`.

Live Preview (DevServerService + `<webview>`) is retained untouched. Claude (and OpenCode) gain design capability through normal chat with their own Read/Write tools — no generation pipeline, no daemon.

**Tech Stack:** Electron + electron-vite, TypeScript, React, Zustand, Vitest. opendesign skills are Apache-2.0 (per-skill `LICENSE`/`od.upstream` honored).

---

## File Structure

**Bundle (committed to repo):**
- `resources/design-skills/skills/<slug>/SKILL.md` (+ `references/`, `templates/`, `assets/template.html` only) — trimmed from opendesign `skills/`
- `resources/design-skills/design-systems/<brand>/DESIGN.md` — all 148 brands
- `resources/design-skills/ATTRIBUTION.md` + `LICENSE` — Apache-2.0 notice + per-skill upstream list
- `resources/design-skills/brand-design-systems/SKILL.md` — NEW umbrella skill (the design-system discovery convention that replaces opendesign's daemon injection)
- `resources/design-skills/manifest.json` — generated: `{ version, skills: [{slug, sha}], systems: [{slug, sha}] }`

**Main process:**
- Create `src/main/services/SkillSeedService.ts` — seed logic (resolve bundle dir dev/packaged, copy missing/outdated into `~/.claude`, no-clobber, write seed-manifest)
- Create `src/main/services/__tests__/SkillSeedService.test.ts`
- Create `src/main/ipc/skillSeed.ts` — `SKILL_SEED_STATUS` / `SKILL_SEED_RUN` / `SKILL_SEED_SET_ENABLED`
- Modify `src/main/index.ts` — call `seedOnLaunch()` after app ready (non-blocking)
- Modify `src/shared/ipc-channels.ts` — add `SKILL_SEED_*`
- Modify `src/shared/types.ts` — `SkillSeedStatus`, `SkillSeedSettings`
- Modify `package.json` (or `electron-builder.yml`) — add `resources/design-skills` to `extraResources`

**Renderer:**
- Create `src/renderer/components/Editor/HtmlPreviewView.tsx` — salvaged Blob primitive (view-only)
- Create `src/renderer/components/Editor/__tests__/htmlArtifact.test.ts` — pure detection helper tests
- Create `src/renderer/lib/htmlArtifact.ts` — pure `detectHtmlArtifact(toolName, toolInput)` helper
- Modify `src/renderer/state/editor.ts` — add `'html-preview'` kind + `htmlPreviewPath` + `reloadKey` + `openHtmlPreview()`
- Modify `src/renderer/components/Editor/EditorArea.tsx` — render `HtmlPreviewView` for `kind === 'html-preview'`
- Modify `src/renderer/components/Dock/ChatPanel.tsx` — on successful `.html` write tool_result, call `openHtmlPreview`
- Modify `src/renderer/lib/api.ts` + `src/preload/index.ts` — expose `skillSeed.*`
- Modify `src/renderer/components/Settings/SettingsPage.tsx` — small "Design skills" panel (status + re-seed + enable toggle)

---

## Task 0: Measure + trim the skill bundle (decision gate)

**Files:**
- Create: `resources/design-skills/` tree
- Create: `scripts/bundle-design-skills.mjs`

- [ ] **Step 1: Write the bundling script**

`scripts/bundle-design-skills.mjs` copies from `/Users/icue/Code/opendesign/open-design`:
- For each `skills/<slug>/`: copy `SKILL.md`, `references/**`, `templates/**`, `assets/template.html`, and per-skill `LICENSE` if present. **Skip** `examples/**`, image binaries (`*.png|jpg|jpeg|gif|webp|mp4`), `scripts/**`, `docs/**`.
- Copy all `design-systems/<brand>/DESIGN.md`.
- Copy root `LICENSE` → `resources/design-skills/LICENSE`.
- Emit `manifest.json` with sha256 of each seeded file.

- [ ] **Step 2: Run + measure**

Run: `node scripts/bundle-design-skills.mjs && du -sh resources/design-skills && find resources/design-skills -name SKILL.md | wc -l`
Expected: 122 SKILL.md, bundle size printed.

**DECISION GATE:** If trimmed bundle > ~12 MB, report the number and the heaviest skills before committing — confirm "all skills, trimmed" vs a curated subset with the user. (User chose "all skills"; this gate honors that while surfacing true size.)

- [ ] **Step 3: Write ATTRIBUTION.md**

List Apache-2.0 source (`opendesign`, Copyright 2026 Open Design contributors) + any per-skill `od.upstream` URLs found (e.g. `html-ppt` → github.com/lewislulu/html-ppt-skill).

- [ ] **Step 4: Commit**

```bash
git add resources/design-skills scripts/bundle-design-skills.mjs
git commit -m "feat(design): bundle trimmed opendesign skills + design-systems"
```

---

## Task 1: `brand-design-systems` umbrella skill (injection replacement)

**Files:**
- Create: `resources/design-skills/brand-design-systems/SKILL.md`

- [ ] **Step 1: Author the umbrella skill**

Frontmatter `name: brand-design-systems`, `description:` triggers on "brand", "design system", "make it look like <brand>", "<brand> style". Body instructs Claude:
> Available brand design systems are seeded at `~/.claude/design-systems/<brand>/DESIGN.md`. When a brief names a brand or asks to match a visual style, **Read** the matching `DESIGN.md` and treat its color/typography/spacing tokens as authoritative — do not invent tokens outside it. Bind tokens into the generated HTML's `:root` before laying out. Available brands: <generated list of 148 slugs>.

This replaces opendesign's daemon-side DESIGN.md injection with on-demand Read (skills-native).

- [ ] **Step 2: Generate the brand list** into the body from `design-systems/*/`.

- [ ] **Step 3: Commit**

```bash
git add resources/design-skills/brand-design-systems/SKILL.md
git commit -m "feat(design): add brand-design-systems umbrella skill"
```

---

## Task 2: `SkillSeedService` — idempotent, no-clobber seeding

**Files:**
- Create: `src/main/services/SkillSeedService.ts`
- Test: `src/main/services/__tests__/SkillSeedService.test.ts`

Contract (define in this task, referenced by later tasks):

```ts
// src/shared/types.ts additions
export interface SkillSeedStatus {
  enabled: boolean;
  bundleVersion: string;       // from manifest.json
  seededVersion: string | null;// from ~/.claude/.devspace-seed-manifest.json
  skillsSeeded: number;
  systemsSeeded: number;
  skipped: number;             // present-and-user-modified, left untouched
  lastRun: string | null;      // ISO
}
export interface SkillSeedSettings { enabled: boolean }
```

Behavior:
- `resolveBundleDir()` — dev: `<repo>/resources/design-skills`; packaged: `process.resourcesPath/design-skills`.
- `seedOnLaunch()` — no-op if disabled (read `~/.devspace/skill-seed.json`, default enabled). Compare bundle `manifest.json.version` vs `~/.claude/.devspace-seed-manifest.json`. For each bundled file: if absent → copy. If present AND its sha matches the *previously seeded* sha (unmodified by user) AND bundle sha differs → overwrite (update). If present AND differs from previously-seeded sha → **user-modified, skip** (record in `skipped`). Write fresh seed-manifest.
- Targets: skills → `~/.claude/skills/<slug>/`; design-systems → `~/.claude/design-systems/<brand>/`.
- All writes via `fs.mkdir(...,{recursive}) + fs.writeFile`; `lstat` guard to refuse following a symlink target (reuse `urlSafety`/pathScope discipline). Never delete user files.

- [ ] **Step 1: Write failing test** — seeds into a temp `HOME`, asserts: fresh seed copies all; second run is a no-op (same version); user-modified file is skipped not clobbered; bundle-version bump updates unmodified files.
- [ ] **Step 2: Run test, verify fails** — `rtk pnpm test SkillSeedService` → FAIL (module missing).
- [ ] **Step 3: Implement `SkillSeedService.ts`.**
- [ ] **Step 4: Run test, verify passes.**
- [ ] **Step 5: Commit** — `feat(design): SkillSeedService seeds skills to ~/.claude idempotently`.

---

## Task 3: Seed IPC + launch wiring + settings toggle

**Files:**
- Create: `src/main/ipc/skillSeed.ts`
- Modify: `src/main/index.ts`, `src/shared/ipc-channels.ts`, `src/preload/index.ts`, `src/renderer/lib/api.ts`, `src/renderer/components/Settings/SettingsPage.tsx`

- [ ] **Step 1** — add `SKILL_SEED_STATUS|RUN|SET_ENABLED` channels + register handlers (`getStatus`, `runSeed`, `setEnabled`).
- [ ] **Step 2** — `src/main/index.ts`: after app ready + window shown, `void seedOnLaunch()` (fire-and-forget, never block startup; log result).
- [ ] **Step 3** — preload + `api.ts`: expose `skillSeed.status()/run()/setEnabled(bool)`.
- [ ] **Step 4** — SettingsPage: small panel showing `SkillSeedStatus` + "Re-seed now" button + enable toggle.
- [ ] **Step 5** — `rtk pnpm typecheck` clean; **Commit** — `feat(design): seed IPC + launch wiring + settings panel`.

---

## Task 4: `html-preview` editor tab kind + Blob view

**Files:**
- Modify: `src/renderer/state/editor.ts`
- Create: `src/renderer/components/Editor/HtmlPreviewView.tsx`
- Modify: `src/renderer/components/Editor/EditorArea.tsx`

- [ ] **Step 1** — `editor.ts`: add `'html-preview'` to `EditorTabKind`; add `htmlPreviewPath?: string` + `reloadKey?: number` to `EditorTab`; add action:

```ts
openHtmlPreview(absPath: string, name: string) {
  const tabPath = `html-preview:${absPath}`;
  const existing = get().tabs.find((t) => t.path === tabPath);
  if (existing) {
    // re-fire (Claude edited the file again) → bump reloadKey + focus
    set((s) => ({
      activeTabPath: tabPath,
      tabs: s.tabs.map((t) =>
        t.path === tabPath ? { ...t, reloadKey: (t.reloadKey ?? 0) + 1 } : t),
    }));
    return;
  }
  set((s) => ({
    tabs: [...s.tabs, { path: tabPath, name: `${name} (preview)`, kind: 'html-preview',
      content: '', savedContent: '', loading: false, htmlPreviewPath: absPath, reloadKey: 0 }],
    activeTabPath: tabPath,
  }));
}
```
Add `openHtmlPreview` to the `EditorState` interface.

- [ ] **Step 2** — `HtmlPreviewView.tsx`: salvage the recovered `DesignPreview` Blob pattern, repointed at `api.fs.readFile(htmlPreviewPath)` → `new Blob([html],{type:'text/html'})` → `URL.createObjectURL` → `<iframe sandbox="allow-scripts">` (NO `allow-same-origin`, NO `allow-popups`). Re-run the effect on `[htmlPreviewPath, reloadKey]`; `revokeObjectURL` on cleanup. Keep loading/error/empty states. No design-bridge imports.
- [ ] **Step 3** — `EditorArea.tsx`: add `tab.kind === 'html-preview' ? <HtmlPreviewView path={tab.htmlPreviewPath!} reloadKey={tab.reloadKey} /> : ...` branch (mirror the `live-preview`/`devlog` branches; lazy-import + Suspense like the others).
- [ ] **Step 4** — `rtk pnpm typecheck` clean; **Commit** — `feat(design): html-preview tab kind + sandboxed Blob view`.

---

## Task 5: Tool-event auto-preview detection

**Files:**
- Create: `src/renderer/lib/htmlArtifact.ts`
- Test: `src/renderer/components/Editor/__tests__/htmlArtifact.test.ts`
- Modify: `src/renderer/components/Dock/ChatPanel.tsx`

- [ ] **Step 1: Write failing test** for the pure helper:

```ts
import { detectHtmlArtifact } from '@renderer/lib/htmlArtifact';
// Write of .html → returns absolute path
expect(detectHtmlArtifact('Write', { file_path: '/p/index.html', content: '<x>' })).toBe('/p/index.html');
// MultiEdit/Edit of .html → path
expect(detectHtmlArtifact('Edit', { file_path: '/p/a.HTM' })).toBe('/p/a.HTM');
// non-html write → null
expect(detectHtmlArtifact('Write', { file_path: '/p/x.ts' })).toBeNull();
// non-write tool → null
expect(detectHtmlArtifact('Read', { file_path: '/p/x.html' })).toBeNull();
// missing/garbage input → null (no throw)
expect(detectHtmlArtifact('Write', {})).toBeNull();
```

- [ ] **Step 2: Run test, verify fails.**
- [ ] **Step 3: Implement** `detectHtmlArtifact(toolName, toolInput)` — returns `file_path` string when `toolName ∈ {Write,Edit,MultiEdit,NotebookEdit?}` (Write/Edit/MultiEdit only) and `typeof input.file_path === 'string'` and it ends with `.html`/`.htm` (case-insensitive); else null.
- [ ] **Step 4: Run test, verify passes.**
- [ ] **Step 5: Wire into ChatPanel** — correlate by toolUseId: on `tool_use` event, if `detectHtmlArtifact(toolName, toolInput)` non-null, record `pendingHtml.set(toolUseId, path)`. On `tool_result` event with `!toolIsError` and a matching pending id, call `useEditorStore.getState().openHtmlPreview(path, basename(path))` then delete the pending entry. (Fire on success only — avoids previewing a write that errored. Re-fires on subsequent edits bump the existing tab's reloadKey from Task 4.)
- [ ] **Step 6** — `rtk pnpm test htmlArtifact` passes + `rtk pnpm typecheck` clean; **Commit** — `feat(design): auto-open html preview on successful Write/Edit of .html`.

---

## Task 6: Verify + ship

- [ ] **Step 1** — `rtk pnpm typecheck` clean.
- [ ] **Step 2** — `rtk pnpm test` — all pass (≥ 815 + new).
- [ ] **Step 3** — `rtk pnpm build` — electron-vite build clean (confirm extraResources bundle present).
- [ ] **Step 4** — bump version + CHANGELOG entry.
- [ ] **Step 5** — `rtk pnpm dist:mac:arm64` (background) → verify `~/.claude/skills` would receive the bundle (smoke: run `seedOnLaunch` against a temp HOME pointing at packaged resources).
- [ ] **Step 6** — commit + (per verification gate) leave on `feat/design-skills` for user testing; do NOT merge to main / tag / GH release until user verifies.

---

## Self-Review

**Spec coverage:**
- "Tear down Design Studio" → done (baseline `6d74601`). ✓
- "Claude has design skills/tools" → Task 0/1/2/3 (bundle 122 skills + 148 systems seeded to `~/.claude`). ✓
- "Seed to ~/.claude" → Task 2/3. ✓
- "Auto-preview on tool event" → Task 4/5. ✓
- "Live Preview retained" → untouched (no task removes it). ✓

**Gaps / decisions surfaced (not placeholders — explicit gates):**
- Bundle size (Task 0 decision gate) — true trimmed size is empirical; gate confirms before commit.
- Design-system injection replaced by `brand-design-systems` umbrella skill (Task 1) — sound because Claude has Read tool.
- Some opendesign skill bodies say "read the DESIGN.md injected above" — the umbrella skill + on-demand Read covers the common path; per-skill body patching is out of scope for v1 (skills still function for layout; brand binding works via umbrella). Note at handoff.

**Type consistency:** `openHtmlPreview(absPath, name)`, `htmlPreviewPath`, `reloadKey`, `detectHtmlArtifact(toolName, toolInput)`, `SkillSeedStatus`, `SkillSeedSettings` — names consistent across Tasks 2–5.

**Risk notes:**
- Seeding writes to `~/.claude` — Task 2 is no-clobber + symlink-guarded + toggle-gated; tests pin the no-clobber invariant.
- iframe is `allow-scripts` only (opaque origin) — generated HTML cannot reach renderer state.
