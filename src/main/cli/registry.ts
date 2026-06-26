// Adapter registry. Single source of truth for which CLI runtimes
// DevSpace knows about. Keep this list narrow — adding a new CLI is a
// commit-sized change (types union + adapter file + this registry).

import { claudeAdapter } from '@main/cli/adapters/claude';
import { codexAdapter } from '@main/cli/adapters/codex';
import { geminiAdapter } from '@main/cli/adapters/gemini';
import { opencodeAdapter } from '@main/cli/adapters/opencode';
import type { CliAdapter } from '@main/cli/types';
import { createLogger } from '@shared/logger';
import type { CliDetectionResult, CliId } from '@shared/types';

const logger = createLogger('cli-registry');

// Single registered runtime: claude. (OpenCode and other alternative CLI
// runtimes were removed along with Chat mode — Terminal mode runs claude
// directly.) Detection still runs so the UI can version-gate features.
const ADAPTERS: CliAdapter[] = [
  claudeAdapter,
  opencodeAdapter,
  codexAdapter,
  geminiAdapter,
];

/**
 * Get the adapter for one CLI id. Throws on unknown ids so callers
 * surface a clear error instead of falling through to a Claude default
 * that would silently corrupt state.
 */
export function getAdapter(cliId: CliId): CliAdapter {
  const adapter = ADAPTERS.find((a) => a.id === cliId);
  if (!adapter) {
    throw new Error(`Unknown CLI id: ${cliId}`);
  }
  return adapter;
}

/** Return the full adapter list. Used by the IPC detect handler. */
export function listAdapters(): CliAdapter[] {
  return ADAPTERS.slice();
}

/**
 * Probe every registered CLI in parallel. Returns one result per
 * adapter — never throws. A single adapter's detect throwing is logged
 * and converted to `{ installed: false }` so a flaky binary on one CLI
 * doesn't blank out the others.
 */
export async function detectAll(): Promise<CliDetectionResult[]> {
  const probes = ADAPTERS.map(async (a) => {
    try {
      return await a.detect();
    } catch (err) {
      logger.warn(
        `detect(${a.id}) threw: ${(err as Error).message} — reporting uninstalled`,
      );
      return { cliId: a.id, installed: false } as CliDetectionResult;
    }
  });
  return Promise.all(probes);
}
