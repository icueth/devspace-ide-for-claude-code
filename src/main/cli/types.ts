// Internal adapter contract for non-Claude CLI runtimes.
//
// `@shared/types` already exports the cross-process DTOs (CliId,
// CliCapabilities, CliProfile, CliDetectionResult). THIS file is the
// main-process-only adapter interface that wires those DTOs to the
// concrete spawn / config-write / stream-parse logic per CLI.
//
// One adapter per CLI runtime. The 'claude' adapter is a thin stub that
// only implements detect() — Claude uses the TmuxChatRunner path which
// is already wired through ChatService. ensureConfig / buildSpawnArgs
// throw on 'claude' so accidental misuse fails loudly.
//
// New CLIs (Codex, Gemini, …) plug in by:
//   1. Adding their CliId literal to the union in @shared/types
//   2. Creating a sibling file under src/main/cli/adapters/<name>.ts
//   3. Registering in src/main/cli/registry.ts
//   4. Adding any required spawn branch in ChatService.sendMessage

import type {
  ChatEvent,
  CliCapabilities,
  CliDetectionResult,
  CliId,
  CliProfile,
} from '@shared/types';

export interface CliSpawnArgs {
  /** Resolved absolute path to the CLI binary. */
  bin: string;
  /** Arguments to pass — argv-safe, no shell expansion. */
  args: string[];
  /**
   * Process env. Typically inherited via `...process.env` then layered
   * with adapter-specific overrides (e.g. OPENCODE_CONFIG_DIR for opencode
   * so the per-profile config dir is honored).
   */
  env: NodeJS.ProcessEnv;
}

export interface BuildSpawnArgsInput {
  /**
   * The chat prompt to deliver to the CLI. For text-on-stdin runtimes
   * the adapter writes this through stdin (preferred — avoids the
   * 32KB Windows / 128KB Linux argv cap on large prompts). Adapters
   * that put the prompt on argv keep their length capping internal.
   */
  prompt: string;
  /** Working directory the CLI should treat as project root. */
  cwd: string;
}

export interface CliAdapter {
  id: CliId;
  capabilities: CliCapabilities;

  /**
   * Probe whether the CLI is installed + reachable. Implementations
   * may shell out to a `--version` call but MUST cap the captured output
   * (256 chars) and treat any non-zero exit / spawn error as
   * `{ installed: false }`. Never throws.
   */
  detect(): Promise<CliDetectionResult>;

  /**
   * Materialize per-profile runtime config on disk so the next spawn can
   * point at it via env. Throws on `claude` (built-in, no config needed).
   * Returns the directory containing the freshly written config files —
   * callers wire that into the spawn env (e.g. OPENCODE_CONFIG_DIR=<dir>).
   *
   * Implementations MUST write atomically (tmp + rename) with 0o600 mode
   * on the credential-bearing file and 0o700 on the parent dir, matching
   * the LlmChatProfilesService pattern.
   */
  ensureConfig(profile: CliProfile): Promise<{ configDir: string }>;

  /**
   * Build the argv + env for spawning a single turn. Pure data — no I/O
   * here so unit tests can assert the exact shape without filesystem
   * fixtures. Throws on `claude`.
   */
  buildSpawnArgs(profile: CliProfile, opts: BuildSpawnArgsInput): CliSpawnArgs;

  /**
   * Optional per-line stdout parser. Wires the runtime's stream output
   * (e.g. opencode `--format json` line-delimited JSON events) into the
   * normalized ChatEvent stream the ChatService broadcaster expects.
   *
   * Returns null when the line carries no renderer-visible signal (e.g.
   * a keepalive heartbeat). Throwing is caught + logged by OpenCodeRunner
   * — a malformed line must never crash the spawn watcher.
   */
  parseStreamLine?(line: string): ChatEvent | null;
}
