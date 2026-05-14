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

// ─── v0.10: chat-style transcript ───────────────────────────────────────────
//
// Phase A/B used a single `brief` string per screen and re-rendered the
// design from scratch on every regenerate. v0.10 turns the brief field
// into an append-only transcript so each generation is a follow-up turn
// that carries prior conversation as context — same UX shape as
// opendesign's chat surface, but bound to a screen instead of a thread.
//
// Backward compat: screens persisted before v0.10 have no `messages`
// field. The renderer falls back to `brief` when `messages` is absent;
// the backend lazily upgrades on first follow-up by seeding a synthetic
// `{role:'user', content: brief}` message.

export type DesignMessageRole = 'user' | 'assistant' | 'system';

// v0.14: assistant turns can be split into prose + html + prose segments
// so the chat surface renders the explanation as a normal message bubble
// and the generated HTML as a compact "Generated index.html — 38 KB" card
// (with expand-to-view). Pre-v0.14 turns persisted only as `content` are
// fine — the renderer falls back to a single prose segment when this
// field is absent.
export type DesignMessageSegment =
  | { kind: 'prose'; text: string }
  | { kind: 'html'; bytes: number; preview?: string };

export interface DesignMessage {
  id: string;
  role: DesignMessageRole;
  // For user/system messages: the raw text.
  // For assistant messages: the streaming + final text claude emitted
  // (raw — UI is responsible for stripping HTML if rendering as text).
  content: string;
  // True while a streaming generation is still appending tokens. The
  // backend emits `message_updated` events with `streaming: true` until
  // generation_complete fires, at which point the final message is sent
  // with `streaming: false`.
  streaming?: boolean;
  // For assistant messages produced by a successful generation, links
  // back to the version row that was created. Lets the UI jump from a
  // transcript turn into the version's preview.
  versionId?: string;
  // v0.14: structured assistant content. Populated by the backend on
  // finalize when the response was split into prose + html + prose by
  // the new extractor. Absent on user/system turns and on legacy
  // assistant turns that pre-date 0.14 — renderer must fall back to
  // `content` in that case.
  segments?: DesignMessageSegment[];
  ts: number;
}

export interface DesignFollowUpInput {
  projectPath: string;
  screenId: string;
  // The new user message. Generation context = prior transcript + this.
  message: string;
  // When set, replaces the screen's design system (e.g. user picked a
  // different brand mid-conversation). Unchanged when omitted.
  designSystemSlug?: string;
  // v0.14: when true, the prompt builder extracts color tokens + font
  // family from the most recent ready version's HTML and prepends them
  // as a "Keep theme:" constraint. UI exposes this as a checkbox in the
  // follow-up composer; default off so users can pivot when they want.
  reuseTheme?: boolean;
}

// ─── v0.10: project design profile ──────────────────────────────────────────
//
// Auto-detected snapshot of the project's design surface (framework,
// styling stack, brand cues). Injected into every generation prompt so
// the model produces output that visually matches what the user is
// already building. Cached on disk under `.devspace/design/profile.json`
// with an mtime check against `package.json` for cheap invalidation.

// Framework variant — distinguishes e.g. Next.js App Router vs Pages
// Router, Vite-web vs Vite-electron, etc. Helps the model emit code
// that fits the actual project shape rather than guessing.
export type FrameworkVariant =
  | 'next-app-router'
  | 'next-pages-router'
  | 'vite-electron'
  | 'vite-web'
  | 'astro-static'
  | 'remix-classic'
  | 'unknown';

// Design tokens extracted from tailwind.config.* or CSS variables. Caps
// each list to keep prompt size predictable. Empty arrays = "no signal".
export interface DesignTokens {
  colors: string[];       // e.g. ['brand: #4c8dff', 'accent: var(--accent)']
  fonts: string[];        // e.g. ['sans: Inter', 'mono: JetBrains Mono']
  spacing: string[];      // notable custom scale entries
  source: 'tailwind-config' | 'css-vars' | 'mixed' | 'none';
}

// Inventory of components the project already exposes — so Claude can
// reuse them instead of inventing parallel ones. Best-effort: walks
// `src/components/` (and a couple of common variants) for `.tsx/.jsx`
// files at limited depth.
export interface ComponentInventoryEntry {
  name: string;           // PascalCase component name
  relPath: string;        // path relative to projectPath
  exportKind: 'default' | 'named' | 'both';
}

export interface ProjectDesignProfile {
  projectPath: string;
  // Framework detection — reuses DevServerKind from Phase C.
  framework: DevServerKind;
  // Variant within the framework (App vs Pages Router, Vite-electron, ...).
  // Optional for backwards compat with v0.10 profiles.
  frameworkVariant?: FrameworkVariant;
  // Primary styling stack — reuses StyleAdapterKind so the profile can
  // hint write-back ergonomics later.
  styling: StyleAdapterKind | 'unknown';
  packageManager: 'pnpm' | 'yarn' | 'npm' | 'bun';
  // Whether the project is TypeScript (tsconfig.json present).
  typescript: boolean;
  // ── v0.13 extensions (all optional for backwards compat) ──────────
  // Project's package.json#name + description.
  projectName?: string;
  projectDescription?: string;
  // First ~600 chars of README.md (first non-badge prose section).
  readmeExcerpt?: string;
  // Detected component libraries (radix, shadcn, mui, chakra, antd, etc.).
  componentLibraries?: string[];
  // Detected icon libraries (lucide, heroicons, react-icons, etc.).
  iconLibraries?: string[];
  // Design tokens extracted from tailwind config or CSS vars.
  designTokens?: DesignTokens;
  // Up to 30 PascalCase components found under src/components.
  componentInventory?: ComponentInventoryEntry[];
  // Markdown blob the prompt builder injects under "## Project Context".
  // Pre-rendered so the renderer can show + edit it without re-walking
  // the project on every keystroke.
  summary: string;
  // Files / signals the detector used. Surfaced in a tooltip.
  evidence: string[];
  builtAt: number;
  // ── v0.13: cache-invalidation fingerprint ────────────────────────
  // Concatenated mtime stamps of files the builder read. v0.10 only
  // checked package.json mtime, missing tailwind/tsconfig/README edits.
  // Optional for backwards compat with v0.10 caches.
  fingerprint?: string;
}

export interface ProjectProfileBuildInput {
  projectPath: string;
  // Force a fresh rebuild even when cache is valid. Used by the
  // "Refresh project context" button in DesignSettings.
  force?: boolean;
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
  // v0.10: chat-style transcript. Optional for backward compat — screens
  // persisted before 0.10 have only `brief`; the renderer falls back to
  // `[{role:'user', content: brief}]` for display until the user sends a
  // follow-up (at which point the backend seeds the array properly).
  messages?: DesignMessage[];
  // v0.10: registry-format marker. Absent on v1 screens (pre-0.10
  // history layout where `history/<id>/` was off-by-one). v2 screens
  // write `history/<id>/index.html` at gen time, eliminating the
  // mislabel bug. Hydration tolerates v1 by falling back to `index.html`
  // for the *latest* version and treating older versions as best-effort.
  historyVersion?: 1 | 2;
  // v0.14: optional page-name hint shown in the screen list and threaded
  // through prompts ("Design the Checkout page for this project's ...").
  pageName?: string;
  // v0.15: when set, the screen belongs to a planned app (DesignAppPlan)
  // and renders under that group in the sidebar. Independent screens have
  // no appId. Cross-screen theme sharing keys off this id.
  appId?: string;
}

export interface DesignProject {
  projectPath: string;
  screens: DesignScreen[];
  // v0.15: planned multi-screen apps. Each app groups multiple screens
  // that share a brief context + theme. Empty when no apps planned.
  apps?: DesignAppPlan[];
  // v0.15: project-wide design tokens. When `lockedAt` is set the prompt
  // builder injects these tokens into every generation regardless of
  // per-screen reuseTheme. Absent until the user opens DesignSettings →
  // Project Tokens tab and either auto-extracts or hand-edits a value.
  tokens?: ProjectDesignTokens;
}

// ─── v0.15: Multi-screen app planning ─────────────────────────────────────
//
// A "design app" is a set of screens generated from one brief
// ("Stock management app", "E-commerce checkout flow", etc.). Claude
// produces a JSON plan up front (screen list + per-screen brief + shared
// theme spec); the user reviews/edits, then the backend batches each
// screen sequentially with the shared theme injected into every prompt.
//
// Storage: <project>/.devspace/design/apps/<appId>/plan.json
// Each screen in the plan is materialized as a regular DesignScreen with
// `appId` set, so the existing screen pipeline (versions, edits, write-
// back) applies unchanged.

export type DesignAppPlanStatus =
  | 'draft'        // Claude returned plan, awaiting user approval
  | 'approved'     // user accepted, screens being / will be generated
  | 'completed'    // every planned screen reached 'ready'
  | 'cancelled';   // user dismissed before approving

export interface PlannedScreen {
  // Stable id within the plan. Becomes the screenId once materialized so
  // status of the plan row stays in sync with the underlying screen.
  id: string;
  name: string;          // shown in plan editor + sidebar (e.g. "Dashboard")
  pageName: string;      // semantic page ("Dashboard", "Add Product")
  brief: string;         // per-screen brief (Claude's plan output)
  skillSlug: string;     // resolved by the planner using suggestSkillSlugs heuristic
  // Materialization state — 'pending' until generation kicks off, then
  // mirrors the underlying DesignScreen.status.
  status: DesignScreenStatus;
  // Set once materialized. Equals PlannedScreen.id by construction.
  screenId?: string;
}

// Theme spec the planner asks Claude to return. Same shape we inject
// into every screen's prompt so the generated HTML stays visually
// consistent across the app. Validated against an allowlist before
// injection (no arbitrary CSS).
export interface AppThemeSpec {
  // Color tokens — at most 8 entries, each `name: value`. Allowed
  // values: hex (#rgb / #rrggbb / #rrggbbaa), named CSS colors,
  // rgb()/rgba()/hsl()/hsla() with literal numeric args. Anything else
  // is dropped silently.
  colors: string[];
  // Font tokens — at most 4 entries. Stripped of any url() references
  // so a hostile plan can't smuggle network calls into generations.
  fonts: string[];
  // One-line description for the user to confirm before approving the
  // plan ("clean modern dashboard, deep navy + warm accents").
  vibe: string;
}

export interface DesignAppPlan {
  appId: string;
  name: string;          // user-supplied app title (e.g. "Stock Management")
  brief: string;         // the original user brief that produced the plan
  status: DesignAppPlanStatus;
  theme: AppThemeSpec;
  screens: PlannedScreen[];
  createdAt: number;
  updatedAt: number;
  // tmux runId for the planning call. Stored so the user can inspect
  // the planner's stdout if the JSON fails to parse.
  planRunId?: string;
  // Set when status === 'draft' and parsing failed. Surfaces in the UI
  // so the user can either retry or fall back to manual screen creation.
  planError?: string;
}

export interface PlanAppInput {
  projectPath: string;
  // Free-form brief. Claude is asked to break it down into 4-8 screens
  // plus a shared theme. Caller-side validation: 8KB cap.
  brief: string;
  name?: string;         // optional explicit name; otherwise derived from brief
  // Optional cap on screens to plan. Default: Claude picks (typically 5-7).
  maxScreens?: number;
}

export interface ApprovePlanInput {
  projectPath: string;
  appId: string;
  // The (possibly user-edited) plan to commit. Backend validates the
  // shape (allowlists colors/fonts, caps screens at 12) before
  // materializing screens.
  plan: DesignAppPlan;
}

// ─── v0.15: Project-wide design tokens ────────────────────────────────────
//
// Optional shared tokens that apply to every screen in the project.
// When `lockedAt` is set, the prompt builder injects these as a hard
// constraint into every generation. The user can hand-edit, auto-
// extract from a chosen screen version, or unlock to let each
// generation pick freely.

export interface ProjectDesignTokens {
  // Same shape as AppThemeSpec for consistency / easy promotion.
  colors: string[];
  fonts: string[];
  vibe: string;
  // Set when the user clicked "Lock theme for project". When unset
  // these values are advisory hints only (shown in DesignSettings but
  // NOT injected into prompts).
  lockedAt?: number;
  // When auto-extracted, the source screen+version for traceability.
  // Empty when hand-edited.
  source?: { screenId: string; versionId: string };
}

export interface SetProjectTokensInput {
  projectPath: string;
  tokens: ProjectDesignTokens | null;     // null clears
}

export interface ExtractProjectTokensInput {
  projectPath: string;
  // The screen + version to extract from. Pre-selected by the UI from a
  // dropdown of ready versions.
  screenId: string;
  versionId: string;
  // When true, also set `lockedAt` to now so the result is immediately
  // injected into future prompts. Default: false (extract preview only,
  // user must click "Lock" to commit).
  lock?: boolean;
}

// ─── v0.15: Bridge actions (Main chat ↔ Design) ───────────────────────────
//
// Two-way handoffs between the main chat panel and the design pane.
// These are pure UI actions (renderer-side openDesign / openChat with
// pre-filled state) — there is no IPC because no backend state changes
// until the user clicks Generate / Send. Types live here so renderer
// + editor store agree on the shape.

export interface OpenDesignFromChatInput {
  projectPath: string;
  // Excerpt of the assistant message the user right-clicked. Pre-fills
  // the brief composer in DesignToolbar but leaves the rest blank so
  // the user picks skill / page-name explicitly.
  initialBrief: string;
  // Suggested skill (from heuristic on the brief). User can override
  // before clicking Generate. Empty when no good match.
  suggestedSkillSlug?: string;
}

export interface OpenChatFromDesignInput {
  projectPath: string;
  screenId: string;
  // Pre-filled chat input. Renderer composes:
  //   "Working on design screen \"<name>\" (<relPath> v<n>).\n\nBrief: ...\n\n"
  // Optionally appended with the latest version's HTML excerpt (≤8KB).
  // Returned to the renderer so it can drop the text into the chat
  // panel's input box for the user to review before sending.
  prefill: string;
}

export interface CreateDesignInput {
  projectPath: string;
  name: string;
  skillSlug: string;
  designSystemSlug?: string;
  brief: string;
  // v0.14: optional page-name hint (e.g. "Checkout", "Product detail").
  // Prepended to the brief inside the prompt so Claude knows which page
  // of a larger app this design represents. Stored on the screen for
  // display in the screen list and for follow-ups.
  pageName?: string;
}

export interface RegenerateDesignInput {
  projectPath: string;
  screenId: string;
  // When provided, replaces the screen's stored brief before regenerating.
  brief?: string;
  // When provided, replaces the screen's stored design system.
  designSystemSlug?: string;
  // v0.14: same semantics as DesignFollowUpInput.reuseTheme — extract
  // the prior version's tokens and lock them into the prompt before
  // regenerating.
  reuseTheme?: boolean;
}

// v0.14: pure heuristic — return a list of skill slugs that look like
// reasonable matches for the user's brief, in confidence order. Used
// by the toolbar's auto-suggest chip below the brief input. Skill
// authors can opt in to specific keywords by adding `keywords:` to
// the SKILL.md frontmatter; the heuristic uses both the explicit
// keywords (when present) and a built-in synonym map as a fallback.
//
// Stays pure + side-effect free so it can run in the renderer on every
// keystroke without crossing the IPC boundary. Empty brief returns [].
export function suggestSkillSlugs(
  brief: string,
  availableSlugs: string[],
): string[] {
  if (!brief || availableSlugs.length === 0) return [];
  const text = brief.toLowerCase();
  const slugSet = new Set(availableSlugs);
  const matches: { slug: string; score: number }[] = [];
  // Built-in synonym map — extend cautiously. Each entry is
  // [skill-slug, [trigger words, ...]]. Skills not present in
  // `availableSlugs` are silently skipped, so adding entries here
  // is safe regardless of the user's installed skill pack.
  const SYNONYMS: Array<[string, string[]]> = [
    ['dashboard', ['dashboard', 'admin', 'analytics', 'metrics', 'kpi', 'stats', 'monitor', 'console']],
    ['landing', ['landing', 'hero', 'promote', 'marketing', 'launch', 'product page', 'homepage', 'home page', 'splash']],
    ['slide-deck', ['slide', 'deck', 'pitch', 'presentation', 'keynote']],
    ['e-guide', ['guide', 'tutorial', 'walkthrough', 'how-to', 'manual']],
    ['app-shell', ['app shell', 'shell', 'navigation', 'sidebar', 'layout']],
    ['checkout', ['checkout', 'payment', 'cart', 'order', 'billing', 'ชำระเงิน']],
    ['product-detail', ['product detail', 'pdp', 'product page']],
    ['settings', ['settings', 'preferences', 'config']],
    ['profile', ['profile', 'account']],
    ['signup', ['signup', 'sign up', 'register', 'registration', 'sign-up']],
    ['login', ['login', 'sign in', 'sign-in', 'auth']],
    ['blog-post', ['blog', 'article', 'post']],
    ['pricing', ['pricing', 'plans', 'tiers']],
  ];
  for (const [slug, triggers] of SYNONYMS) {
    if (!slugSet.has(slug)) continue;
    let score = 0;
    for (const t of triggers) {
      if (text.includes(t)) score += t.length;
    }
    if (score > 0) matches.push({ slug, score });
  }
  matches.sort((a, b) => b.score - a.score);
  return matches.map((m) => m.slug).slice(0, 3);
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
  | 'generation_error'
  // v0.10: streamed transcript turn deltas. `message_appended` fires when
  // a new assistant message is created (turn started). `message_updated`
  // carries the cumulative streaming content. `message_finalized` fires
  // once the turn settles (success OR cancel) with the final content.
  | 'message_appended'
  | 'message_updated'
  | 'message_finalized'
  // v0.15: app planning lifecycle
  | 'app_plan_started'
  | 'app_plan_ready'
  | 'app_plan_error'
  | 'app_plan_updated'      // status / screen state changed
  | 'app_plan_deleted'
  // v0.15: project tokens
  | 'tokens_changed';

export interface DesignEvent {
  kind: DesignEventKind;
  projectPath: string;
  // For app_plan_* / tokens_changed events, screenId is empty string
  // ('') — those events are project-level. Existing screen-level
  // handlers must guard with `if (e.screenId)` before lookup.
  screenId: string;
  // Populated for *_complete / *_error / *_updated events.
  screen?: DesignScreen;
  // Free-form progress / error text.
  message?: string;
  // v0.10: populated on message_* events. The renderer routes by id
  // (append → push; updated → patch in place; finalized → mark complete).
  designMessage?: DesignMessage;
  // v0.15: populated on app_plan_* events.
  appPlan?: DesignAppPlan;
  // v0.15: populated on tokens_changed events.
  tokens?: ProjectDesignTokens | null;
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
  | 'vite'        // vite in deps + vite.config.*
  | 'next'        // next in deps + next.config.*
  | 'astro'       // astro in deps + astro.config.*
  | 'remix'       // @remix-run/* in deps + remix.config.*
  | 'sveltekit'   // @sveltejs/kit in deps + svelte.config.*
  | 'nuxt'        // nuxt in deps + nuxt.config.*
  | 'gatsby'      // gatsby in deps + gatsby-config.*
  | 'angular'     // @angular/cli in deps + angular.json
  | 'vue-cli'     // @vue/cli-service in deps + vue.config.*
  | 'cra'         // react-scripts in deps
  | 'storybook'   // storybook in deps + .storybook/ dir
  | 'vitepress'   // vitepress in deps
  | 'docusaurus'  // @docusaurus/core in deps
  | 'static'      // serve/http-server/live-server/browser-sync — generic static
  | 'unknown';    // fallback — user can supply manual URL or custom command

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
  // Preflight check populated by detectDevServer. UI shows "Install
  // dependencies" CTA when hasNodeModules is false — avoids the cryptic
  // "exit code 127" that npm/pnpm produce on a fresh clone.
  preflight?: {
    hasNodeModules: boolean;
    packageManager: 'pnpm' | 'yarn' | 'npm' | 'bun';
  };
  // Detected dev scripts the user can pick between. Surfaced as a dropdown
  // when more than one is plausible (turbo/nx monorepo, multiple targets).
  candidateScripts?: Array<{ name: string; body: string }>;
  // True when the user explicitly entered a URL (manual override mode).
  // Skips PTY spawn — webview points at user-supplied URL directly.
  manualUrl?: boolean;
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
  // Manual URL mode — skips PTY spawn entirely. User entered the URL of
  // an already-running dev server. Validated against the same localhost
  // allowlist as auto-detected URLs.
  manualUrl?: string;
}

export interface DevServerInstallInput {
  projectPath: string;
  // Defaults to detection from lockfiles. Surfaced so the user can pick
  // a different manager if detection is wrong (e.g., pnpm-lock.yaml but
  // user wants yarn).
  packageManager?: 'pnpm' | 'yarn' | 'npm' | 'bun';
}

export interface DevServerInstallResult {
  ok: boolean;
  // Captured tail of stdout/stderr if install failed.
  errorMessage?: string;
  // Wallclock duration in ms.
  durationMs: number;
}

export type DevServerEventKind =
  | 'status_changed'
  | 'log'
  | 'url_resolved'
  | 'crashed'
  // Emitted while `pnpm/npm install` is running. Renderer shows a progress
  // pill in the empty-state CTA. Payload uses `line` for log lines, `status`
  // = 'starting' on begin, 'running' on success, 'error' on fail.
  | 'install_progress';

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
  // When true the service computes the diff/summary but DOES NOT write
  // to disk. Returns the same `applied[]` shape with `summary` populated
  // so the UI can render a "Preview" before the user confirms.
  dryRun?: boolean;
}

export interface DesignAdapterDetectInput {
  projectPath: string;
}

export interface DesignAdapterDetectResult {
  // The single adapter the project prefers, based on its style stack.
  preferred: StyleAdapterKind;
  // All adapters that *could* be applied. Tailwind + CSS Modules can
  // coexist (e.g. Next.js app); the UI offers a dropdown when this list
  // has more than one entry.
  available: StyleAdapterKind[];
  // Files / features the detector used to make the call. Surfaced in a
  // "?" tooltip so users understand why a particular adapter was picked.
  evidence: string[];
}

export interface DesignWriteBackApplied {
  // The original source.ref the renderer sent (echoed for matching).
  sourceRef: string;
  adapter: StyleAdapterKind;
  // Absolute path of the file that was touched (or would be touched on
  // dryRun). Empty when the adapter failed before resolving a file.
  filePath: string;
  // Human-readable summary the UI shows in the "applied" / "preview" toast
  // (e.g. "swap bg-red-500 → bg-blue-500" or "added style={{color}}").
  summary: string;
  // Optional unified diff for the preview panel (one hunk per edit).
  // Format: `--- a/<rel>\n+++ b/<rel>\n@@ ... @@\n-…\n+…`. Renderer can
  // pass this to its existing diff viewer.
  diff?: string;
  error?: string;
}

export interface DesignWriteBackResult {
  ok: boolean;
  // One entry per edit. Same length and order as `input.edits`.
  applied: DesignWriteBackApplied[];
  // Aggregate error when the whole batch failed before any edit landed.
  errorMessage?: string;
}
