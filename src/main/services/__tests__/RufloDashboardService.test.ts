import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 3 RufloDashboardService tests.
 *
 * We mock `electron` for the same reason the other Ruflo service tests do —
 * setupPaths imports `app` from electron. We additionally mock `child_process`
 * for the timeout/exit-code tests so no real `ruflo` binary is needed.
 *
 * Module is re-imported per test via dynamic `import()` so the install-cache
 * is reset between cases by calling `__resetForTests` in afterEach.
 */
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
}));

// ---------------------------------------------------------------------------
// Pure parsers — no spawn / fs interaction.
// ---------------------------------------------------------------------------

describe('RufloDashboardService.parseAgentList', () => {
  it('parses "name — role" format', async () => {
    const { parseAgentList } = await import(
      '@main/services/RufloDashboardService'
    );
    const out = parseAgentList(
      'researcher — code search and references\n' +
        'planner — task decomposition\n',
    );
    expect(out).toEqual([
      { name: 'researcher', role: 'code search and references' },
      { name: 'planner', role: 'task decomposition' },
    ]);
  });

  it('parses "name: role" and bullet-prefixed lines', async () => {
    const { parseAgentList } = await import(
      '@main/services/RufloDashboardService'
    );
    const out = parseAgentList(
      '- coder: writes implementations\n' +
        '• reviewer: pull-request analysis\n',
    );
    expect(out).toEqual([
      { name: 'coder', role: 'writes implementations' },
      { name: 'reviewer', role: 'pull-request analysis' },
    ]);
  });

  it('parses two-or-more-space separated table rows', async () => {
    const { parseAgentList } = await import(
      '@main/services/RufloDashboardService'
    );
    const out = parseAgentList(
      'researcher   code search\n' +
        'planner      task decomposition\n',
    );
    expect(out.map((a) => a.name)).toEqual(['researcher', 'planner']);
    expect(out[0]!.role).toBe('code search');
  });

  it('skips banners, header rows, and dividers', async () => {
    const { parseAgentList } = await import(
      '@main/services/RufloDashboardService'
    );
    const out = parseAgentList(
      'Available agent types:\n' +
        '======\n' +
        'name      role\n' +
        '---\n' +
        '\n' +
        'researcher — does research\n',
    );
    expect(out).toEqual([{ name: 'researcher', role: 'does research' }]);
  });

  it('handles bare-name lines (no role)', async () => {
    const { parseAgentList } = await import(
      '@main/services/RufloDashboardService'
    );
    const out = parseAgentList('researcher\nplanner\n');
    expect(out).toEqual([{ name: 'researcher' }, { name: 'planner' }]);
  });

  it('returns [] for empty / whitespace-only input', async () => {
    const { parseAgentList } = await import(
      '@main/services/RufloDashboardService'
    );
    expect(parseAgentList('')).toEqual([]);
    expect(parseAgentList('   \n  \n')).toEqual([]);
  });

  it('strips ANSI color codes', async () => {
    const { parseAgentList } = await import(
      '@main/services/RufloDashboardService'
    );
    // Real ruflo output when stdout is a tty: bold green for the name.
    const out = parseAgentList(
      '\x1b[1;32mresearcher\x1b[0m — code search\n',
    );
    expect(out).toEqual([{ name: 'researcher', role: 'code search' }]);
  });

  it('absorbs unknown formats — yields [] without throwing (fail-open)', async () => {
    const { parseAgentList } = await import(
      '@main/services/RufloDashboardService'
    );
    // ruflo could one day print something we don't recognise. The MUST is
    // "don't crash" — the service-level caller logs a warning and returns
    // `{ ok: true, agents: [] }`.
    expect(() => parseAgentList('!!! ??? !!!')).not.toThrow();
  });

  it('parses the v3.10.5 ASCII pipe-table (real `ruflo agent list`)', async () => {
    const { parseAgentList } = await import(
      '@main/services/RufloDashboardService'
    );
    // Real v3.10.5 output — the ID column comes back blank (too narrow), so
    // the display name falls back to Type and the role to Status.
    const out = parseAgentList(
      '\nActive Agents\n\n' +
        '+----+-------+--------+------------+--------------+\n' +
        '| ID | Type  | Status | Created    | Last Acti... |\n' +
        '+----+-------+--------+------------+--------------+\n' +
        '|    | coder | idle   | 4:44:42 PM | N/A          |\n' +
        '+----+-------+--------+------------+--------------+\n\n' +
        '[INFO] Total: 1 agents\n',
    );
    expect(out).toEqual([{ name: 'coder', role: 'idle' }]);
  });

  it('returns [] for the v3.10.5 empty agent list (no garbage from banners)', async () => {
    const { parseAgentList } = await import(
      '@main/services/RufloDashboardService'
    );
    expect(
      parseAgentList(
        '\nActive Agents\n\n[INFO] No agents found matching criteria\n',
      ),
    ).toEqual([]);
  });
});

describe('RufloDashboardService.parseSwarmSessions', () => {
  it('parses "<id>  <objective>  [<status>]" rows', async () => {
    const { parseSwarmSessions } = await import(
      '@main/services/RufloDashboardService'
    );
    const out = parseSwarmSessions(
      'sw-abc12  Refactor auth service  [running]\n' +
        'sw-xyz99  Add OAuth login  [paused]\n',
    );
    expect(out).toEqual([
      { id: 'sw-abc12', objective: 'Refactor auth service', status: 'running' },
      { id: 'sw-xyz99', objective: 'Add OAuth login', status: 'paused' },
    ]);
  });

  it('parses id-only rows without a status bracket', async () => {
    const { parseSwarmSessions } = await import(
      '@main/services/RufloDashboardService'
    );
    const out = parseSwarmSessions('sw-abc12 some objective\n');
    expect(out[0]).toMatchObject({ id: 'sw-abc12' });
    expect(out[0]!.status).toBeUndefined();
  });

  it('returns [] for empty input', async () => {
    const { parseSwarmSessions } = await import(
      '@main/services/RufloDashboardService'
    );
    expect(parseSwarmSessions('')).toEqual([]);
  });

  it('parses the v3.10.5 `session list` pipe-table', async () => {
    const { parseSwarmSessions } = await import(
      '@main/services/RufloDashboardService'
    );
    // Real v3.10.5 output (ruflo truncates long cells with a trailing "...").
    const out = parseSwarmSessions(
      '\nSessions\n\n' +
        '+----------------------+----------------------+--------+--------+-------+--------------+\n' +
        '| ID                   | Name                 | Status | Agents | Tasks | Last Updated |\n' +
        '+----------------------+----------------------+--------+--------+-------+--------------+\n' +
        '| session-178004784... | devspace-overlay-... | saved  |      0 |     0 | 0m ago       |\n' +
        '+----------------------+----------------------+--------+--------+-------+--------------+\n\n' +
        '[INFO] Showing 1 of 1 sessions\n',
    );
    expect(out).toEqual([
      {
        id: 'session-178004784...',
        objective: 'devspace-overlay-...',
        status: 'saved',
      },
    ]);
  });

  it('returns [] for the v3.10.5 empty session list', async () => {
    const { parseSwarmSessions } = await import(
      '@main/services/RufloDashboardService'
    );
    expect(
      parseSwarmSessions('\nSessions\n\n[INFO] No sessions found\n'),
    ).toEqual([]);
  });
});

describe('RufloDashboardService.parseMemoryResults', () => {
  it('parses "[ns] score=N text…" format', async () => {
    const { parseMemoryResults } = await import(
      '@main/services/RufloDashboardService'
    );
    const out = parseMemoryResults(
      '[notes] score=0.87 The auth service uses JWT\n' +
        '[plans] score=0.71 Migration to Postgres pending\n',
    );
    expect(out).toEqual([
      {
        namespace: 'notes',
        score: 0.87,
        text: 'The auth service uses JWT',
      },
      {
        namespace: 'plans',
        score: 0.71,
        text: 'Migration to Postgres pending',
      },
    ]);
  });

  it('handles results without a score', async () => {
    const { parseMemoryResults } = await import(
      '@main/services/RufloDashboardService'
    );
    const out = parseMemoryResults('[notes] just text\nplain line\n');
    expect(out[0]).toEqual({
      namespace: 'notes',
      score: undefined,
      text: 'just text',
    });
    expect(out[1]).toEqual({
      namespace: undefined,
      score: undefined,
      text: 'plain line',
    });
  });

  it('returns [] for empty input', async () => {
    const { parseMemoryResults } = await import(
      '@main/services/RufloDashboardService'
    );
    expect(parseMemoryResults('')).toEqual([]);
  });

  it('skips v3.10.5 search chatter — a no-hit search yields [] (not garbage)', async () => {
    const { parseMemoryResults } = await import(
      '@main/services/RufloDashboardService'
    );
    // Real v3.10.5 `memory search` output when nothing matches. The
    // [INFO]/✅/Search-time/[WARN]/Try: lines must NOT become results.
    const out = parseMemoryResults(
      '[INFO] Searching: "auth jwt" (semantic)\n\n' +
        '✅ Using sql.js (WASM SQLite, no build tools required)\n' +
        '  Search time: 3ms\n\n' +
        '[WARN] No results found\n' +
        'Try: claude-flow memory store -k "key" --value "data"\n',
    );
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Integration-ish: spawn + timeout + install cache.
//
// We mock `node:child_process` so a fake child process can be driven without
// a real binary on PATH. Each test installs its own mock implementation so
// the spawn return value is deterministic.
// ---------------------------------------------------------------------------

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  ee.stdout = new EventEmitter();
  ee.stderr = new EventEmitter();
  ee.kill = vi.fn();
  return ee;
}

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

// `fs/promises` is hit by whichRuflo() — we point it at a stat that
// pretends `/fakebin/ruflo` exists & is executable. Without this the
// service falls back to "ruflo not installed" before the spawn mock fires.
vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual<typeof import('node:fs/promises')>(
    'node:fs/promises',
  );
  return {
    ...real,
    stat: vi.fn(async (p: string) => {
      if (p.endsWith('/ruflo')) {
        return { isFile: () => true } as Awaited<ReturnType<typeof real.stat>>;
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }),
    access: vi.fn(async () => undefined),
  };
});

describe('RufloDashboardService.listAgents (spawn integration)', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(async () => {
    const { __resetForTests } = await import(
      '@main/services/RufloDashboardService'
    );
    __resetForTests();
  });

  it('returns parsed agents on a successful spawn', async () => {
    spawnMock.mockImplementationOnce(() => {
      const child = makeFakeChild();
      // Microtask flush so the caller's listeners attach first.
      queueMicrotask(() => {
        child.stdout.emit(
          'data',
          Buffer.from('researcher — code search\nplanner — planning\n'),
        );
        child.emit('exit', 0);
      });
      return child;
    });

    const { listAgents } = await import(
      '@main/services/RufloDashboardService'
    );
    const res = await listAgents();
    expect(res.ok).toBe(true);
    expect(res.agents).toHaveLength(2);
    expect(res.agents[0]!.name).toBe('researcher');
  });

  it('surfaces a 5s timeout via { ok: false, error: "Command timed out (5s)" }', async () => {
    vi.useFakeTimers();
    try {
      spawnMock.mockImplementationOnce(() => {
        // Child never exits — pure wedge to exercise the timeout branch.
        return makeFakeChild();
      });

      const { listAgents } = await import(
        '@main/services/RufloDashboardService'
      );
      const pending = listAgents();
      // Advance past the 5s timeout — the service should SIGTERM the child
      // and resolve with the timeout sentinel.
      await vi.advanceTimersByTimeAsync(5_001);
      const res = await pending;
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/timed out/i);
      expect(res.agents).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns { ok: false } when ruflo exits non-zero', async () => {
    spawnMock.mockImplementationOnce(() => {
      const child = makeFakeChild();
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('agent backend unavailable'));
        child.emit('exit', 2);
      });
      return child;
    });

    const { listAgents } = await import(
      '@main/services/RufloDashboardService'
    );
    const res = await listAgents();
    expect(res.ok).toBe(false);
    expect(res.error).toContain('agent backend unavailable');
  });
});

describe('RufloDashboardService.isRufloInstalled (cache)', () => {
  afterEach(async () => {
    const { __resetForTests } = await import(
      '@main/services/RufloDashboardService'
    );
    __resetForTests();
  });

  it('returns true when ruflo resolves on PATH', async () => {
    const { isRufloInstalled } = await import(
      '@main/services/RufloDashboardService'
    );
    expect(await isRufloInstalled()).toBe(true);
  });

  it('caches the install-check result for 30s — second call does not re-stat', async () => {
    const fsp = await import('node:fs/promises');
    const statSpy = fsp.stat as unknown as ReturnType<typeof vi.fn>;
    statSpy.mockClear();

    const { isRufloInstalled } = await import(
      '@main/services/RufloDashboardService'
    );

    expect(await isRufloInstalled()).toBe(true);
    const firstCallCount = statSpy.mock.calls.length;
    // The first call walks PATH until it hits a hit — should have stat'd
    // at least once.
    expect(firstCallCount).toBeGreaterThan(0);

    // Second call within the 30s TTL — must hit the cache, NOT stat again.
    expect(await isRufloInstalled()).toBe(true);
    expect(statSpy.mock.calls.length).toBe(firstCallCount);
  });
});
