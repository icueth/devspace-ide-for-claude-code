// v0.37: claude --version probe + semver compare.
//
// Components that ship v0.37 features (Effort dropdown, /goal modal,
// /reload-skills button, Ultra-Review on Codeflow, Background-run mode)
// need to disable themselves when the installed claude is too old to
// understand the new commands. This hook calls cli:detect (already wired
// for the Settings UI), parses the version string, and exposes a
// `meets(min)` predicate. Fail-OPEN — when claude isn't detected at all
// we treat the version as unknown and let the UI render normally; the
// downstream slash-command write will surface a useful error instead.

import { useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/lib/api';

export interface ClaudeSemver {
  major: number;
  minor: number;
  patch: number;
}

// Mirror of meetsClaudeVersion in src/main/cli/adapters/claude.ts. Duplicated
// (not imported) so the renderer bundle doesn't pull node-only modules.
// Same algorithm — tests assert the two implementations agree.
export function meetsClaudeVersion(
  actual: ClaudeSemver | null,
  min: ClaudeSemver,
): boolean {
  if (!actual) return false;
  if (actual.major !== min.major) return actual.major > min.major;
  if (actual.minor !== min.minor) return actual.minor > min.minor;
  return actual.patch >= min.patch;
}

export function parseClaudeVersion(raw: string): ClaudeSemver | null {
  if (!raw) return null;
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(raw);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2] ?? '0'),
    patch: Number(m[3] ?? '0'),
  };
}

interface UseClaudeVersion {
  // Raw `claude --version` text (or null if detect failed / claude missing).
  raw: string | null;
  parsed: ClaudeSemver | null;
  meets: (min: ClaudeSemver) => boolean;
}

// Module-level cache so multiple call sites in one renderer share a single
// detect round-trip. The detection result is stable for the app session —
// re-probing on every mount would be wasteful and would surface as flicker.
let cached: UseClaudeVersion | null = null;
let inFlight: Promise<UseClaudeVersion> | null = null;

async function probe(): Promise<UseClaudeVersion> {
  try {
    const results = await api.cli.detect();
    const claude = results.find((r) => r.cliId === 'claude');
    const raw = claude?.version ?? null;
    const parsed = raw ? parseClaudeVersion(raw) : null;
    return { raw, parsed, meets: (min) => meetsClaudeVersion(parsed, min) };
  } catch {
    return { raw: null, parsed: null, meets: () => false };
  }
}

export function useClaudeVersion(): UseClaudeVersion {
  const [state, setState] = useState<UseClaudeVersion>(
    cached ?? {
      raw: null,
      parsed: null,
      // Unknown defaults to FALSE on meets() so UI gates stay disabled
      // until the probe resolves. The Default-to-unknown fail-OPEN policy
      // applies only when the probe ERRORS — a still-loading state is
      // briefly "disabled" rather than "enabled".
      meets: () => false,
    },
  );

  useEffect(() => {
    if (cached) {
      setState(cached);
      return;
    }
    if (!inFlight) inFlight = probe();
    let cancelled = false;
    void inFlight.then((next) => {
      cached = next;
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Stable identity for the returned object across re-renders (so dependency
  // arrays don't re-fire when nothing changed).
  return useMemo(
    () => ({ raw: state.raw, parsed: state.parsed, meets: state.meets }),
    [state.raw, state.parsed, state.meets],
  );
}

// Test-only — reset the module cache between tests.
export function __resetCachedClaudeVersionForTests(): void {
  cached = null;
  inFlight = null;
}
