/**
 * Shared types for per-project Ruflo init (Settings → Setup tab).
 *
 * Phase 0 (global install) already lives in `setup.ts` as the `ruflo`
 * SetupCheck. This file covers the per-project layer: detecting whether
 * `npx ruflo init` has been run inside a given project, and driving the
 * init via a streaming progress channel.
 */

export interface RufloProjectStatus {
  projectPath: string;
  /** True when `.claude-flow/` exists at the project root. */
  initialized: boolean;
  /** Absolute path to `.claude-flow/` when found. */
  configDir?: string;
  /** True when `CLAUDE.md` exists at the project root. */
  hasClaudeMd?: boolean;
  /** True when `.claude/` exists at the project root. */
  hasClaudeDir?: boolean;
}

export type RufloInitStage = 'preflight' | 'install' | 'verify' | 'done' | 'error';

export interface RufloInitProgressEvent {
  projectPath: string;
  stage: RufloInitStage;
  message: string;
  done: boolean;
  error?: string;
}

export interface RufloInitResult {
  ok: boolean;
  status: RufloProjectStatus;
  error?: string;
}

// ---------------------------------------------------------------------------
// Phase 2: Plugin management (Settings → Ruflo tab).
//
// `claude plugin list --json` emits an array of installed plugins; each entry
// gets parsed into a RufloPlugin with the `name@marketplace` id split out so
// the renderer can render them in a structured grid + reason about which
// belong to the ruflo marketplace vs. other marketplaces the user added.
// ---------------------------------------------------------------------------

export interface RufloPlugin {
  /** Raw `name@marketplace` string from `claude plugin list`. */
  id: string;
  /** Name portion of the id (before `@`). */
  name: string;
  /** Marketplace portion of the id (after `@`). */
  marketplace: string;
  version: string;
  scope: string;
  enabled: boolean;
  installPath?: string;
  installedAt?: string;
  /** True when marketplace === 'ruflo' OR name starts with `ruflo-`. */
  isRuflo: boolean;
}

export interface RufloMarketplaceStatus {
  /**
   * True when the ruflo marketplace is registered with the Claude CLI.
   * Best-effort: when the user's claude version doesn't expose `marketplace
   * list`, we fail open (return true) so the UI doesn't badger them with an
   * Add button that does nothing.
   */
  added: boolean;
}

export type RufloCatalogCategory =
  | 'core'
  | 'memory'
  | 'intelligence'
  | 'goals'
  | 'testing'
  | 'security'
  | 'devops';

export interface RufloCatalogEntry {
  /** Plugin slug (e.g. `ruflo-core`). Used as `claude plugin install <name>@ruflo`. */
  name: string;
  /** Human-readable label shown on the card. */
  label: string;
  /** One-line description (~80 chars). */
  description: string;
  category: RufloCatalogCategory;
  /** Surface these prominently in a recommended grid above the full list. */
  recommended: boolean;
}

/**
 * Static catalog of plugins Ruflo ships. Hardcoded in shared/ so both
 * RufloPluginsService.getCatalog() and the renderer can import the exact
 * same list — no IPC round-trip needed for a list that never changes at
 * runtime.
 *
 * Ordered: recommended core/swarm/memory/goals first, then the broader
 * intelligence / testing / security / devops set.
 */
export const RUFLO_CATALOG: readonly RufloCatalogEntry[] = [
  {
    name: 'ruflo-core',
    label: 'Core',
    description: 'Foundation runtime — required by every other Ruflo plugin.',
    category: 'core',
    recommended: true,
  },
  {
    name: 'ruflo-swarm',
    label: 'Swarm',
    description: 'Multi-agent coordination with shared state and message bus.',
    category: 'intelligence',
    recommended: true,
  },
  {
    name: 'ruflo-rag-memory',
    label: 'RAG Memory',
    description: 'HNSW vector memory for semantic recall across sessions.',
    category: 'memory',
    recommended: true,
  },
  {
    name: 'ruflo-goals',
    label: 'Goals',
    description: 'GOAP A* goal planner that decomposes objectives into actions.',
    category: 'goals',
    recommended: true,
  },
  {
    name: 'ruflo-autopilot',
    label: 'Autopilot',
    description: 'Autonomous loop that drives Claude through long-running tasks.',
    category: 'intelligence',
    recommended: false,
  },
  {
    name: 'ruflo-testgen',
    label: 'TestGen',
    description: 'Auto-generates unit + integration tests from source diffs.',
    category: 'testing',
    recommended: false,
  },
  {
    name: 'ruflo-knowledge-graph',
    label: 'Knowledge Graph',
    description: 'Entity + relationship graph mined from code and conversations.',
    category: 'memory',
    recommended: false,
  },
  {
    name: 'ruflo-jujutsu',
    label: 'Jujutsu',
    description: 'Git diff risk analysis with conflict and regression scoring.',
    category: 'devops',
    recommended: false,
  },
  {
    name: 'ruflo-security-audit',
    label: 'Security Audit',
    description: 'CVE scanning and dependency vulnerability surfacing.',
    category: 'security',
    recommended: false,
  },
  {
    name: 'ruflo-observability',
    label: 'Observability',
    description: 'Logs, traces, and metrics piped from Claude tool calls.',
    category: 'devops',
    recommended: false,
  },
  {
    name: 'ruflo-cost-tracker',
    label: 'Cost Tracker',
    description: 'Token budget enforcement and per-session cost reporting.',
    category: 'devops',
    recommended: false,
  },
  {
    name: 'ruflo-intelligence',
    label: 'Intelligence',
    description: 'Pattern learning across sessions to surface recurring workflows.',
    category: 'intelligence',
    recommended: false,
  },
  {
    name: 'ruflo-rvf',
    label: 'RVF',
    description: 'Agent memory save/restore with versioned snapshots.',
    category: 'memory',
    recommended: false,
  },
  {
    name: 'ruflo-workflows',
    label: 'Workflows',
    description: 'Multi-step task templates with branching and rollback.',
    category: 'intelligence',
    recommended: false,
  },
  {
    name: 'ruflo-federation',
    label: 'Federation',
    description: 'Cross-machine agent coordination over an encrypted mesh.',
    category: 'intelligence',
    recommended: false,
  },
];

export interface RufloActionResult {
  ok: boolean;
  error?: string;
}
