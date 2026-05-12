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

export interface DesignScreenVersion {
  id: string;
  createdAt: number;
  brief: string;
  htmlPath: string;          // relative to <project>/.devspace/design/
  // tmux runId that produced this version, when applicable. Lets the user
  // jump from a version row to its log + prompt for debugging.
  runId?: string;
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
