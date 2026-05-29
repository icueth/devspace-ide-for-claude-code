import type { CliProfile, LlmChatProfile } from '@shared/types';

// v0.30: unified provider-picker option model. Sources:
//   1. Claude (built-in CLI, no profile) — always present, may be
//      disabled if claude binary is missing.
//   2. CLI profiles (OpenCode, future Codex/Gemini) — each profile is
//      its own option in the 'cli' group. Disabled if the matching CLI
//      binary isn't detected, with a reason chip for the tooltip.
//   3. LLM chat profiles (HTTP API bindings) — separate group.
//
// Each option carries enough metadata for the picker to render groups,
// disabled rows with reason tooltips, and a capability chip.
//
// IMPORTANT: this helper is PURE — no React, no IPC. Test-driven so the
// chat panel's render can stay dumb.

// v0.37: `action` is a non-runtime row — clicking opens a modal / dispatches
// custom behavior rather than binding the thread to a profile. Today the
// sole action is 'bg-claude' ("Run claude in background"). Renderer code
// matches on the id prefix to decide whether to mutate thread state or
// trigger an action.
export type PickerOptionGroup = 'claude' | 'cli' | 'llm' | 'action';

export type CapabilityChip = 'Full' | '~90% tools' | 'Bash only' | 'Plain text';

export interface PickerOption {
  // Stable key — used by React + for selection equality. Format:
  //   • 'claude'          for built-in Claude
  //   • 'cli:<id>'        for a CLI profile (id is CliProfile.id)
  //   • 'llm:<id>'        for an LLM chat profile (id is LlmChatProfile.id)
  // Callers map this id back to the actual profile via the lookup
  // helpers below — keeps the renderer from having to special-case the
  // group prefix every time.
  id: string;
  // Human-readable label including any "(model)" suffix.
  label: string;
  // Sub-line — model id, baseURL host, etc. Optional and renderer-dim.
  sublabel?: string;
  group: PickerOptionGroup;
  // Drives the trailing capability chip. Verbatim summaryLabel text
  // (renderer maps that to a color in the chip component).
  capabilityChip: CapabilityChip;
  // True when the option should render disabled (e.g. CLI binary
  // missing). `reason` powers the tooltip.
  disabled?: boolean;
  reason?: string;
}

// Default Claude capability — Claude is the "Full" runtime by definition.
// Kept here (not in CliCapabilities-from-backend) so the picker can paint
// before any IPC round-trip resolves the detection list.
const CLAUDE_CAP: CapabilityChip = 'Full';
// Arch H3: HONEST OpenCode capability for v0.30 — the runner only parses
// text-delta + done events; tool_use / tool_result are deferred to
// v0.30.1. Flip back to '~90% tools' the same PR that lands the parser.
const OPENCODE_CAP: CapabilityChip = 'Plain text';

/**
 * Build the full unified picker option list from current state.
 *
 * @param claudeInstalled  result of `api.cli.detect()` for cliId 'claude'.
 *                         When false, the Claude row is disabled with a
 *                         "claude binary not on PATH" reason.
 * @param cliProfiles      user-saved CliProfile[] from `api.cli.listProfiles()`.
 * @param llmProfiles      user-saved LlmChatProfile[] from `api.llm.listChatProfiles()`.
 * @param installedCliIds  set of CliIds whose binary was detected. Used
 *                         to disable CLI profile rows whose runtime
 *                         isn't installed.
 */
export function buildCliPickerOptions(
  claudeInstalled: boolean,
  cliProfiles: ReadonlyArray<CliProfile>,
  llmProfiles: ReadonlyArray<LlmChatProfile>,
  installedCliIds: ReadonlySet<string> = new Set(['claude']),
): PickerOption[] {
  const options: PickerOption[] = [];

  // 1. Claude — always first, always present.
  const claudeOpt: PickerOption = {
    id: 'claude',
    label: 'Claude (default)',
    group: 'claude',
    capabilityChip: CLAUDE_CAP,
  };
  if (!claudeInstalled) {
    claudeOpt.disabled = true;
    claudeOpt.reason =
      'claude binary not detected on PATH — install Claude Code CLI';
  }
  options.push(claudeOpt);

  // 2. CLI profiles — grouped together after Claude.
  for (const p of cliProfiles) {
    const installed = installedCliIds.has(p.cliId);
    const opt: PickerOption = {
      id: `cli:${p.id}`,
      label: p.name,
      sublabel: `${p.cliId} · ${p.provider.model}`,
      group: 'cli',
      capabilityChip: p.cliId === 'opencode' ? OPENCODE_CAP : 'Plain text',
    };
    if (!installed) {
      opt.disabled = true;
      opt.reason = `${p.cliId} binary not detected on PATH`;
    }
    options.push(opt);
  }

  // 3. LLM chat profiles — straight HTTP, no CLI binary involved so
  // they're never gated on detection.
  for (const p of llmProfiles) {
    options.push({
      id: `llm:${p.id}`,
      label: p.name,
      sublabel: `${p.provider} · ${p.model}`,
      group: 'llm',
      // LLM chat profiles never spawn a CLI so they can't run tools at
      // all — the chip reflects that.
      capabilityChip: 'Plain text',
    });
  }

  // 4. v0.37 action row — opens the background-run modal. Only emitted when
  // the claude binary is detected (we'd be spawning it). Disabled with a
  // reason chip when claude is missing so the user sees why it's greyed.
  options.push({
    id: 'action:bg-claude',
    label: 'Run claude in background',
    sublabel: 'spawn claude --bg --exec …',
    group: 'action',
    capabilityChip: 'Full',
    disabled: !claudeInstalled,
    reason: claudeInstalled
      ? undefined
      : 'claude binary not detected on PATH — install Claude Code CLI',
  });

  return options;
}

/**
 * Tailwind class for the capability chip's color. The chip itself is
 * rendered by the consuming component; this helper just maps the chip
 * label to its color family per the v0.30 spec.
 *
 *   • Full       → green
 *   • ~90% tools → blue
 *   • Bash only  → amber
 *   • Plain text → gray
 */
export function capabilityChipClassName(chip: CapabilityChip): string {
  switch (chip) {
    case 'Full':
      return 'border-semantic-success/40 bg-semantic-success/10 text-semantic-success';
    case '~90% tools':
      return 'border-accent/40 bg-accent/10 text-accent';
    case 'Bash only':
      return 'border-semantic-warning/40 bg-semantic-warning/10 text-semantic-warning';
    case 'Plain text':
    default:
      return 'border-border-subtle bg-surface-3 text-text-muted';
  }
}

/**
 * Resolve which picker option id maps to a given thread's provider lock.
 * Mirror of resolveProfileSelection() but for the unified id space.
 * Returns 'claude' when nothing's bound (default), 'cli:<id>' for CLI
 * profiles, 'llm:<id>' for LLM profiles, falling back to 'claude' when
 * the id is stale.
 */
export function resolveCliPickerSelection(
  thread:
    | {
        cliProfileId?: string;
        llmProfileId?: string;
      }
    | null
    | undefined,
  cliProfiles: ReadonlyArray<Pick<CliProfile, 'id'>>,
  llmProfiles: ReadonlyArray<Pick<LlmChatProfile, 'id'>>,
): string {
  if (!thread) return 'claude';
  if (thread.cliProfileId) {
    return cliProfiles.some((p) => p.id === thread.cliProfileId)
      ? `cli:${thread.cliProfileId}`
      : 'claude';
  }
  if (thread.llmProfileId) {
    return llmProfiles.some((p) => p.id === thread.llmProfileId)
      ? `llm:${thread.llmProfileId}`
      : 'claude';
  }
  return 'claude';
}
