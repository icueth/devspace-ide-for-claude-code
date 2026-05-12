// ─── Design Studio (Phase A) ────────────────────────────────────────────────
//
// "Design" is a Claude-powered HTML/JSX generator pane modeled after the
// open-source `opendesign` project (Apache-2.0). Users pick a Design Skill
// (e.g. "dashboard", "landing-page", "slide-deck") and an optional Design
// System brand (e.g. "apple", "airbnb"), write a brief, and the main
// process composes those three inputs into a prompt that runs through the
// existing `TmuxChatRunner` against the user's installed `claude` binary.
// The result is written to `<project>/.devspace/design/screens/<id>/` and
// rendered in an iframe-sandboxed editor tab.
//
// Storage layout (per project):
//   <project>/.devspace/design/
//     designs.json                       — registry of screens, versions
//     screens/<id>/
//       index.html                       — current generation
//       design.json                      — per-screen meta (brief, skill,
//                                          designSystem, status, …)
//       history/<versionId>/index.html  — older versions
//
// Skill + design-system discovery scans three roots:
//   • ~/.claude/skills/                  (global, user-authored)
//   • <project>/.claude/skills/          (per-project)
//   • <appResources>/design-packs/skills/         (built-in, bundled)
// and the matching `design-systems/` subtree for brand definitions.

export type DesignScope = 'global' | 'project' | 'builtin';

export type DesignScreenStatus =
  | 'pending'      // created, not generated yet
  | 'generating'   // tmux run in flight
  | 'ready'        // index.html exists
  | 'error';       // last run failed; htmlPath may still be valid (prev version)

export interface DesignSkill {
  slug: string;
  name: string;
  description: string;
  scope: DesignScope;
  // Absolute path to SKILL.md (or equivalent). Read on demand at generation time.
  path: string;
  // Free-form tag from frontmatter (e.g. "marketing", "internal-tool") used
  // by the picker UI to group skills. Empty when unset.
  category: string;
}

export interface DesignSystem {
  slug: string;
  name: string;
  description: string;
  scope: DesignScope;
  // Absolute path to DESIGN.md (or the design-system folder root if multi-file).
  path: string;
  // Optional brand label for the picker (e.g. "Apple", "Airbnb").
  brand: string;
}

// Phase B: an inline CSS edit captured by the iframe bridge. Selectors
// are devspace-issued unique IDs (`data-devspace-id="<n>"`) assigned at
// generation time, NOT raw CSS selectors — that gives us a stable handle
// even if the user later regenerates structure.
export interface DesignEditOp {
  // Stable per-element handle. Stored on the element as
  // `data-devspace-id`. The bridge injection script tags every element
  // post-hardening so every node has one.
  elementId: string;
  // CSS property name in kebab-case (e.g. "background-color").
  property: string;
  // New value. Empty string clears the override.
  value: string;
  ts: number;
}

export type DesignVersionOrigin = 'generation' | 'edit';

export interface DesignScreenVersion {
  id: string;
  createdAt: number;
  brief: string;
  htmlPath: string;          // relative to <project>/.devspace/design/
  // tmux runId that produced this version, when applicable. Lets the user
  // jump from a version row to its log + prompt for debugging.
  runId?: string;
  // Phase B: tells the version list whether this row came from a fresh
  // generation or a manual edit save. Defaults to 'generation' on
  // historical rows; Phase A versions don't have the field.
  origin?: DesignVersionOrigin;
  // For edit versions, the ops that produced it. Captured for diff
  // display + future "replay edits onto regenerated HTML" UX.
  edits?: DesignEditOp[];
  // Optional user-supplied label (e.g. "darker hero", "tighter spacing").
  note?: string;
}

export interface DesignSaveEditsInput {
  projectPath: string;
  screenId: string;
  // Full serialized HTML after edits were applied in the iframe. Main
  // re-hardens this before writing (same pipeline as generation output).
  html: string;
  ops: DesignEditOp[];
  note?: string;
}

export interface DesignScreen {
  id: string;
  name: string;
  skillSlug: string;
  designSystemSlug?: string;
  brief: string;
  status: DesignScreenStatus;
  // Relative path under .devspace/design/ — null until first generation
  // succeeds. Always points to the LATEST ready version, never history.
  htmlPath: string | null;
  createdAt: number;
  updatedAt: number;
  versions: DesignScreenVersion[];
  // Surfaced in the UI when status === 'error'.
  errorMessage?: string;
  // Active tmux run metadata while status === 'generating'. Cleared on
  // terminal state. Mirrors ChatActiveRun's shape so resume-on-boot
  // logic stays consistent.
  activeRun?: {
    runId: string;
    sessionName: string;
    runDir: string;
    startedAt: number;
  };
}

export interface DesignProject {
  projectPath: string;
  screens: DesignScreen[];
}

export interface CreateDesignInput {
  projectPath: string;
  name: string;
  skillSlug: string;
  designSystemSlug?: string;
  brief: string;
}

export interface RegenerateDesignInput {
  projectPath: string;
  screenId: string;
  // When provided, replaces the screen's stored brief before regenerating.
  brief?: string;
  // When provided, replaces the screen's stored design system.
  designSystemSlug?: string;
}

// Streamed by main → renderer during + after a generation. The renderer
// subscribes per-project (DESIGN_SUBSCRIBE) and routes events into screen
// state by `screenId`.
export type DesignEventKind =
  | 'screen_created'
  | 'screen_updated'
  | 'screen_deleted'
  | 'generation_started'
  | 'generation_progress'   // free-form status line (tail of stdout)
  | 'generation_complete'
  | 'generation_error';

export interface DesignEvent {
  kind: DesignEventKind;
  projectPath: string;
  screenId: string;
  // Populated for *_complete / *_error / *_updated events.
  screen?: DesignScreen;
  // Free-form progress / error text.
  message?: string;
  ts: number;
}

// ─── Phase B: iframe bridge protocol ────────────────────────────────────────
//
// The preview iframe runs sandboxed (no allow-same-origin) and loads its
// HTML via a Blob URL. The HTML carries an inline bridge script (injected
// by the main process at generation/save time) that talks to the renderer
// via window.postMessage. Both sides are constrained to this protocol —
// any message with a `type` outside this set is dropped on the floor.
//
// Security invariants (must hold on BOTH ends):
//  1. Renderer validates `event.source === iframeEl.contentWindow` before
//     touching any message body. The Blob-URL iframe origin reports as
//     "null", so renderer cannot validate by origin string; identity of
//     the source window is the only trusted check.
//  2. Bridge script validates `event.source === window.parent` for the
//     same reason — denies cross-frame chatter from other windows.
//  3. The bridge NEVER eval/Function-constructs incoming strings. CSS
//     property/value are passed to `element.style.setProperty` which
//     itself validates against the CSS grammar.
//  4. Selectors are devspace-issued `data-devspace-id` attribute values,
//     not raw CSS — so injection of `[onclick=…]` cannot smuggle script.

export const DESIGN_BRIDGE_PROTOCOL_VERSION = 1;

export type DesignBridgeMode = 'view' | 'inspect' | 'edit';

// Renderer → iframe
export type DesignBridgeOutbound =
  | { type: 'devspace:setMode'; mode: DesignBridgeMode }
  | { type: 'devspace:applyEdit'; elementId: string; property: string; value: string }
  | { type: 'devspace:clearOverrides' }
  | { type: 'devspace:requestSnapshot'; requestId: string }
  | { type: 'devspace:focusElement'; elementId: string };

// Iframe → renderer
export interface DesignElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Reserved for Phase C: when the previewed HTML is the output of a real
// dev-server (Vite/Next/etc) rather than a standalone generation, every
// element can carry a source pointer back to the JSX/TSX that emitted
// it. Phase B always emits `{ kind: 'generated' }` — the field is
// populated unconditionally so Phase C can extend without breaking the
// protocol. Renderers ignoring the field stay forward-compatible.
export interface DesignElementSource {
  kind: 'generated' | 'user-jsx';
  // For 'user-jsx', a Phase C–populated source ref (e.g.
  // 'src/components/Hero.tsx:42:7'). Empty for 'generated'.
  ref?: string;
  // Phase 0.8/0.9 forward-compat fields. All optional so a bridge that
  // doesn't populate them stays valid; populating them lets the
  // style-adapter pick the right write-back strategy without a protocol
  // bump.
  //
  // Anchor of the nearest enclosing function-component declaration.
  // Used to resolve cva / tw-merge / styled-components call sites that
  // live above the JSX-consumer in the source.
  ownerRef?: string;
  // Literal className prop at inspect time. Empty when not present on
  // the element. The adapter diffs this against the desired class list.
  className?: string;
  // Tells the adapter whether `className` is a plain string literal or
  // computed (e.g. `cn(buttonVariants({variant}))`). When 'computed' the
  // adapter writes a `style={}` prop instead of attempting a swap.
  classOrigin?: 'literal' | 'computed' | 'absent';
  // When the JSX is a styled-components / Emotion call site, the
  // adapter writes to the styled-component declaration instead of the
  // consumer. Bridge populates `displayName` from fiber.type and
  // `ref` from `_debugSource` of the declaration fiber.
  styledComponent?: { displayName: string; ref: string };
  // CSS-modules class names match the `<name>__<class>--<hash>` pattern.
  // The adapter resolves these back to their source `*.module.css` file.
  cssModuleClasses?: string[];
}

export interface DesignElementInfo {
  elementId: string;
  tagName: string;
  classes: string[];
  innerTextPreview: string;          // first 80 chars, no newlines
  rect: DesignElementRect;
  source?: DesignElementSource;
  // Pre-computed subset that the property panel renders without an extra
  // round-trip. Keep this list short — full getComputedStyle is huge.
  computedStyles: {
    color?: string;
    backgroundColor?: string;
    fontSize?: string;
    fontFamily?: string;
    fontWeight?: string;
    padding?: string;
    margin?: string;
    borderRadius?: string;
    border?: string;
    display?: string;
    textAlign?: string;
  };
}

export type DesignBridgeInbound =
  | { type: 'devspace:bridgeReady'; version: number }
  | { type: 'devspace:elementHover'; info: DesignElementInfo | null }
  | { type: 'devspace:elementSelect'; info: DesignElementInfo }
  | { type: 'devspace:editApplied'; elementId: string; property: string; value: string }
  | { type: 'devspace:snapshot'; requestId: string; html: string; ops: DesignEditOp[] }
  | { type: 'devspace:bridgeError'; message: string };

// ─── Phase C: Live preview against real project dev-server ──────────────────
//
// The Live Preview tab points a `<webview>` at a locally-spawned dev server
// (Vite / Next / Astro / Remix). The main process detects the framework,
// runs the user's `dev` script through the existing PtyPool, parses the
// emitted local URL, and exposes lifecycle events. The renderer mounts a
// `<webview>` with that URL + injects a Phase-C bridge script via
// `webview.executeJavaScript` — same protocol as Phase B but with `source`
// always populated.
//
// Constraint: Phase C is read+inspect+edit-style only. Write-back to JSX
// arrives in 0.8 (Tailwind) and 0.9 (vanilla CSS / styled-components /
// CSS Modules). The 0.7 build streams `source` pointers from the React
// devtools-style bridge so the renderer can SHOW which file:line every
// element came from, even though it cannot yet WRITE to it.

export type DevServerKind =
  | 'vite'      // detected: vite in dependencies + vite.config.*
  | 'next'      // detected: next in dependencies + next.config.*
  | 'astro'     // detected: astro in dependencies + astro.config.*
  | 'remix'     // detected: @remix-run/* in dependencies + remix.config.*
  | 'unknown';  // fallback — user can still point at a manual URL

export type DevServerStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'stopped'
  | 'error';

export interface DevServerInfo {
  // Detection result, even when the server isn't running. Used to decide
  // which "Start dev server" button to show.
  kind: DevServerKind;
  // Resolved package manager script name to run (e.g. "dev" or "start").
  // Empty when no recognizable script exists.
  scriptName: string;
  // Resolved URL once the dev server emits one (e.g. "http://localhost:5173").
  // Null while starting or stopped.
  url: string | null;
  status: DevServerStatus;
  // Captured stdout lines (last ~500). UI shows in a collapsible log pane.
  logTail: string[];
  // Populated when status === 'error'. UI surfaces in the empty-state.
  errorMessage?: string;
  // Set while a run is alive. PTY id used to terminate the process on tab
  // close or app quit. Renderers should never touch this directly — it's
  // here so the main process can kill orphaned servers on shutdown.
  ptyId?: string;
  // Set once the server emits its URL. Lets the UI compute uptime.
  startedAt?: number;
}

export interface DevServerStartInput {
  projectPath: string;
  // Optional override — when the auto-detected script is wrong (monorepo,
  // custom pm-aliases). When absent, DevServerService picks based on
  // `kind` + package.json scripts.
  scriptName?: string;
  // Optional override — when the framework can't be auto-detected.
  kind?: DevServerKind;
  // Optional override of the package manager. Defaults to detection
  // (pnpm-lock.yaml → pnpm, yarn.lock → yarn, else npm).
  packageManager?: 'pnpm' | 'yarn' | 'npm' | 'bun';
}

export type DevServerEventKind =
  | 'status_changed'
  | 'log'
  | 'url_resolved'
  | 'crashed';

export interface DevServerEvent {
  kind: DevServerEventKind;
  projectPath: string;
  status?: DevServerStatus;
  url?: string | null;
  // For 'log' events, a single line of stdout/stderr.
  line?: string;
  message?: string;
  ts: number;
}

// Phase C bridge protocol — extends Phase B with source-pointer extraction.
// Lives in the webview context (not the iframe). Same `type` namespace so
// the renderer can multiplex preview implementations through one handler.

export type DesignWebviewMode = DesignBridgeMode;

// Renderer → webview (executed via webview.executeJavaScript or postMessage)
export type DevPreviewOutbound =
  | { type: 'devspace:dev:setMode'; mode: DesignWebviewMode }
  | { type: 'devspace:dev:requestSnapshot'; requestId: string }
  // Phase C-future: apply a transient style override. Lands in the DOM
  // only; persistence comes via Phase 0.8 write-back path.
  | { type: 'devspace:dev:applyPreviewEdit'; elementId: string; property: string; value: string };

// Webview → renderer
export type DevPreviewInbound =
  | { type: 'devspace:dev:bridgeReady'; version: number; framework: DevServerKind }
  | { type: 'devspace:dev:elementHover'; info: DesignElementInfo | null }
  | { type: 'devspace:dev:elementSelect'; info: DesignElementInfo }
  | { type: 'devspace:dev:bridgeError'; message: string };

// Phase 0.8 write-back payload. The renderer captures the user's edits in
// the Inspect/Edit panel and sends them as a batch — main resolves each
// edit through the appropriate StyleAdapter (Tailwind in 0.8; vanilla
// CSS / styled-components / CSS Modules in 0.9) and writes atomically.
export interface DesignWriteBackEdit {
  // Source anchor returned by the Phase C bridge for the selected
  // element. The adapter picks its write strategy from this — Tailwind
  // adapter swaps the className literal, vanilla-CSS adapter looks up
  // the resolved selector, styled-components adapter rewrites the
  // declaration site, CSS-modules adapter writes the .module.css rule.
  source: DesignElementSource;
  property: string;            // CSS property in kebab-case
  value: string;               // raw value the user picked
  // Optional — when the user chose a Tailwind class via the picker, the
  // adapter can prefer the class swap over a style-prop write.
  tailwindClass?: string;
}

export type StyleAdapterKind =
  | 'tailwind'
  | 'vanilla-css'
  | 'styled-components'
  | 'css-modules'
  | 'unknown';

export interface DesignWriteBackInput {
  projectPath: string;
  // Pre-flight detection. The UI shows the adapter name + a "preview
  // diff" before the user confirms.
  preferredAdapter?: StyleAdapterKind;
  edits: DesignWriteBackEdit[];
}

export interface DesignWriteBackResult {
  ok: boolean;
  // One entry per edit. Same length and order as `input.edits`.
  applied: Array<{
    sourceRef: string;
    adapter: StyleAdapterKind;
    filePath: string;       // absolute path of the file that was touched
    // Human-readable summary the UI shows in the "applied" toast.
    summary: string;
    error?: string;         // populated when this single edit failed
  }>;
  // Aggregate error when the whole batch failed before any edit landed.
  errorMessage?: string;
}
