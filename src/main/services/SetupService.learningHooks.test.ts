import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hermetic sandbox: redirect ~ to a temp dir so SetupService writes its
// ~/.claude/hooks + ~/.claude/settings.json under test isolation, and stub
// electron (app for resource resolution, shell for openExternal) + spawn so
// no real child processes run during the trailing getStatus() recheck.
// ---------------------------------------------------------------------------

let tmpHome = '';

// getAppPath() is read lazily (per call) by setupPaths.resourcesRoot(), so
// returning a tmpHome-relative dir keeps the bundled resources/ tree writable.
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => path.join(tmpHome, 'app'),
  },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
}));

// homedir() is read by both mempalacePaths (getClaudeDir) and setupPaths
// (commonBinPaths). Pointing it at the temp dir keeps every ~/.claude write
// and every binary-scan path inside the sandbox.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
});

// Any incidental spawn (brew --version, etc.) during getStatus() resolves
// immediately with a non-zero exit and no output — detection treats the tool
// as missing rather than hanging on a real process.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: () => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => undefined;
      // Defer exit so listeners are attached first.
      setImmediate(() => child.emit('exit', -1));
      return child;
    },
  };
});

// Imported after mocks so the module picks up the stubbed os.homedir.
const { installTool, getStatus } = await import('@main/services/SetupService');

const SETTINGS = () => path.join(tmpHome, '.claude', 'settings.json');
const HOOKS_DIR = () => path.join(tmpHome, '.claude', 'hooks');

async function readSettings(): Promise<Record<string, unknown>> {
  return JSON.parse(await fsp.readFile(SETTINGS(), 'utf8')) as Record<
    string,
    unknown
  >;
}

interface HookGroup {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
}
function groupsOf(s: Record<string, unknown>, key: string): HookGroup[] {
  const hooks = (s.hooks ?? {}) as Record<string, unknown>;
  return (Array.isArray(hooks[key]) ? hooks[key] : []) as HookGroup[];
}
function commandsOf(groups: HookGroup[]): string[] {
  return groups.flatMap((g) => (g.hooks ?? []).map((h) => h.command ?? ''));
}

beforeEach(async () => {
  tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'devspace-lh-'));
  // The bundled scripts must exist where setupPaths resolves them in dev:
  // <app.getAppPath()>/resources/learning-hooks. app.getAppPath() is mocked
  // to <tmpHome>/app, so create the source files there.
  const srcDir = path.join(tmpHome, 'app', 'resources', 'learning-hooks');
  await fsp.mkdir(srcDir, { recursive: true });
  await fsp.writeFile(
    path.join(srcDir, 'devspace-learnings.mjs'),
    '// learnings hook\n',
  );
  await fsp.writeFile(
    path.join(srcDir, 'devspace-distill-stop.mjs'),
    '// distill hook\n',
  );
});

afterEach(async () => {
  await fsp.rm(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('installLearningHooks (via installTool)', () => {
  it('copies both scripts and registers SessionStart + Stop groups', async () => {
    const res = await installTool('learningHooks');
    expect(res.ok).toBe(true);

    // Scripts copied into ~/.claude/hooks
    expect(fs.existsSync(path.join(HOOKS_DIR(), 'devspace-learnings.mjs'))).toBe(
      true,
    );
    expect(
      fs.existsSync(path.join(HOOKS_DIR(), 'devspace-distill-stop.mjs')),
    ).toBe(true);

    const s = await readSettings();
    const ss = commandsOf(groupsOf(s, 'SessionStart'));
    const stop = commandsOf(groupsOf(s, 'Stop'));
    expect(ss).toContain('node "$HOME/.claude/hooks/devspace-learnings.mjs"');
    expect(stop).toContain(
      'node "$HOME/.claude/hooks/devspace-distill-stop.mjs"',
    );

    // timeout is set on the registered SessionStart entry
    const learnEntry = groupsOf(s, 'SessionStart')
      .flatMap((g) => g.hooks ?? [])
      .find((h) => (h.command ?? '').includes('devspace-learnings.mjs'));
    expect(learnEntry?.timeout).toBe(5000);
  });

  it('is idempotent — re-running does not duplicate groups', async () => {
    await installTool('learningHooks');
    await installTool('learningHooks');
    const s = await readSettings();
    const ss = commandsOf(groupsOf(s, 'SessionStart')).filter((c) =>
      c.includes('devspace-learnings.mjs'),
    );
    const stop = commandsOf(groupsOf(s, 'Stop')).filter((c) =>
      c.includes('devspace-distill-stop.mjs'),
    );
    expect(ss).toHaveLength(1);
    expect(stop).toHaveLength(1);
  });

  it('never clobbers pre-existing unrelated SessionStart / Stop hooks', async () => {
    await fsp.mkdir(path.dirname(SETTINGS()), { recursive: true });
    await fsp.writeFile(
      SETTINGS(),
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              { hooks: [{ type: 'command', command: 'other-session.sh' }] },
            ],
            Stop: [{ hooks: [{ type: 'command', command: 'other-stop.sh' }] }],
          },
        },
        null,
        2,
      ),
    );

    await installTool('learningHooks');
    const s = await readSettings();
    const ss = commandsOf(groupsOf(s, 'SessionStart'));
    const stop = commandsOf(groupsOf(s, 'Stop'));
    // Original hooks preserved
    expect(ss).toContain('other-session.sh');
    expect(stop).toContain('other-stop.sh');
    // Ours appended
    expect(ss).toContain('node "$HOME/.claude/hooks/devspace-learnings.mjs"');
    expect(stop).toContain(
      'node "$HOME/.claude/hooks/devspace-distill-stop.mjs"',
    );

    // A timestamped backup of the prior settings was created.
    const dir = await fsp.readdir(path.dirname(SETTINGS()));
    expect(dir.some((f) => f.startsWith('settings.json.bak.'))).toBe(true);
  });
});

describe('detectLearningHooks (via getStatus)', () => {
  it('reports learningHooks ok only after install', async () => {
    const before = await getStatus();
    const lhBefore = before.checks.find((c) => c.id === 'learningHooks');
    expect(lhBefore).toBeDefined();
    // claude is detected via the stubbed spawn as missing → blocked, else missing
    expect(['missing', 'blocked']).toContain(lhBefore?.state);

    await installTool('learningHooks');

    const after = await getStatus();
    const lhAfter = after.checks.find((c) => c.id === 'learningHooks');
    expect(lhAfter?.state).toBe('ok');
    expect(lhAfter?.path).toBe(
      path.join(HOOKS_DIR(), 'devspace-learnings.mjs'),
    );
  });
});
