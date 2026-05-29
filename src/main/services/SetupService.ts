import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { shell, type WebContents } from 'electron';

import { getStatus as getMempalaceStatus } from '@main/services/MemPalaceService';
import {
  commonBinPaths,
  enrichedPath,
  getBundledRtkHookFile,
  getClaudeDir,
  getClaudeHooksDir,
  getClaudeSettingsFile,
  getInstalledRtkHookFile,
} from '@main/utils/setupPaths';
import { IPC } from '@shared/ipc-channels';
import { createLogger } from '@shared/logger';
import type {
  SetupCheck,
  SetupCheckState,
  SetupInstallResult,
  SetupProgressEvent,
  SetupStage,
  SetupStatus,
  SetupToolId,
} from '@shared/setup';

const logger = createLogger('Setup');

// ---------------------------------------------------------------------------
// Subscribers — same pattern as MemPalaceService for progress event routing.
// ---------------------------------------------------------------------------

const subscribers = new Set<WebContents>();
let installing: SetupToolId | 'all' | null = null;

export function subscribeSetup(wc: WebContents): void {
  subscribers.add(wc);
  wc.once('destroyed', () => subscribers.delete(wc));
}

function emit(event: SetupProgressEvent): void {
  for (const wc of subscribers) {
    if (wc.isDestroyed()) continue;
    wc.send(IPC.SETUP_PROGRESS, event);
  }
}

function step(
  toolId: SetupToolId | 'all',
  stage: SetupStage,
  message: string,
): void {
  logger.info(`[${toolId}/${stage}] ${message}`);
  emit({ toolId, stage, message, done: false });
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/**
 * Locate a binary by name across well-known paths. Returns the absolute path
 * if found, or null. We avoid invoking `which` so detection works the same
 * way regardless of the user's PATH / login shell.
 */
async function whichBin(name: string): Promise<string | null> {
  for (const dir of commonBinPaths()) {
    const full = path.join(dir, name);
    try {
      const st = await fsp.stat(full);
      if (st.isFile()) return full;
      // Some shells symlink — stat will follow it, so we already get the
      // resolved target. fsp.access(X_OK) double-checks executability.
      // eslint-disable-next-line no-bitwise
      await fsp.access(full, fs.constants.X_OK);
      return full;
    } catch {
      // try next
    }
  }
  return null;
}

function runCapture(
  cmd: string,
  args: string[],
  timeoutMs = 5000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, PATH: enrichedPath() },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * Stream-runner for install commands. Each chunk of stdout/stderr is forwarded
 * to subscribers as a progress event so the UI shows live output.
 */
function runStream(
  toolId: SetupToolId | 'all',
  command: string,
  args: string[],
  opts: { useBashC?: boolean } = {},
): Promise<{ code: number }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PATH: enrichedPath() };
    const child = opts.useBashC
      ? spawn('bash', ['-lc', command + (args.length ? ' ' + args.join(' ') : '')], { env })
      : spawn(command, args, { env });

    const forward = (chunk: Buffer | string): void => {
      const text = String(chunk).trimEnd();
      if (!text) return;
      // Split multi-line chunks so subscribers can render line-by-line.
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        emit({ toolId, stage: 'install', message: line, done: false });
      }
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', (err) => reject(err));
    child.on('exit', (code) => resolve({ code: code ?? -1 }));
  });
}

// ---------------------------------------------------------------------------
// Per-tool detection
// ---------------------------------------------------------------------------

async function detectBrew(): Promise<SetupCheck> {
  const base: Omit<SetupCheck, 'state'> = {
    id: 'brew',
    label: 'Homebrew',
    description: 'Package manager for tmux / rtk / jq on macOS.',
    installable: true,
  };
  if (process.platform !== 'darwin') {
    return { ...base, state: 'unsupported', installable: false };
  }
  const bin = await whichBin('brew');
  if (!bin) return { ...base, state: 'missing' };
  const v = await runCapture(bin, ['--version']);
  const version = v.stdout.split('\n')[0]?.replace(/^Homebrew\s+/, '').trim();
  return { ...base, state: 'ok', path: bin, version };
}

async function detectClaude(): Promise<SetupCheck> {
  const base: Omit<SetupCheck, 'state'> = {
    id: 'claude',
    label: 'Claude Code CLI',
    description: 'The Anthropic Claude Code agent — required to run chats.',
    installable: true,
  };
  const bin = await whichBin('claude');
  if (!bin) return { ...base, state: 'missing' };
  const v = await runCapture(bin, ['--version']);
  const version = v.stdout.trim() || undefined;
  return { ...base, state: 'ok', path: bin, version };
}

async function detectTool(
  id: 'tmux' | 'rtk' | 'jq',
  meta: { label: string; description: string },
  brewState: SetupCheckState,
): Promise<SetupCheck> {
  const bin = await whichBin(id);
  const base: Omit<SetupCheck, 'state'> = {
    id,
    label: meta.label,
    description: meta.description,
    installable: process.platform === 'darwin',
  };
  if (bin) {
    const v = await runCapture(bin, id === 'tmux' ? ['-V'] : ['--version']);
    const version = v.stdout.split('\n')[0]?.trim() || undefined;
    return { ...base, state: 'ok', path: bin, version };
  }
  if (brewState !== 'ok' && process.platform === 'darwin') {
    return { ...base, state: 'blocked', blockedBy: 'brew' };
  }
  return { ...base, state: 'missing' };
}

interface SettingsShape {
  hooks?: {
    PreToolUse?: Array<{
      matcher?: string;
      hooks?: Array<{ type?: string; command?: string }>;
    }>;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

async function readSettings(): Promise<SettingsShape> {
  try {
    const raw = await fsp.readFile(getClaudeSettingsFile(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as SettingsShape;
    return {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

async function writeSettings(next: SettingsShape): Promise<void> {
  const file = getClaudeSettingsFile();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const ts = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace(/Z$/, '');
    try {
      await fsp.copyFile(file, `${file}.bak.${ts}`);
    } catch (err) {
      logger.warn(`backup failed: ${(err as Error).message}`);
    }
  }
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(next, null, 2));
  await fsp.rename(tmp, file);
}

async function detectRtkHook(rtkState: SetupCheckState): Promise<SetupCheck> {
  const base: Omit<SetupCheck, 'state'> = {
    id: 'rtkHook',
    label: 'RTK Claude Code hook',
    description:
      'Bash hook (~/.claude/hooks/rtk-rewrite.sh) + PreToolUse entry that auto-rewrites bash commands to use rtk.',
    installable: true,
  };

  const hookFile = getInstalledRtkHookFile();
  const fileExists = fs.existsSync(hookFile);

  // Settings must reference the same absolute path under PreToolUse[Bash].
  let inSettings = false;
  try {
    const s = await readSettings();
    const groups = Array.isArray(s.hooks?.PreToolUse) ? s.hooks.PreToolUse : [];
    for (const g of groups) {
      const hooks = Array.isArray(g.hooks) ? g.hooks : [];
      if (hooks.some((h) => h.command === hookFile)) {
        inSettings = true;
        break;
      }
    }
  } catch {
    // ignore; treated as missing
  }

  if (fileExists && inSettings) {
    return { ...base, state: 'ok', path: hookFile };
  }
  if (rtkState !== 'ok') {
    return { ...base, state: 'blocked', blockedBy: 'rtk' };
  }
  return { ...base, state: 'missing' };
}

async function detectRuflo(): Promise<SetupCheck> {
  const base: Omit<SetupCheck, 'state'> = {
    id: 'ruflo',
    label: 'Ruflo',
    description:
      'Multi-agent orchestration for Claude — 100+ agents, swarm coordination, RAG memory, GOAP goal planner. Run `npx ruflo init` in any project to wire it up.',
    installable: true,
  };
  const bin = await whichBin('ruflo');
  if (!bin) return { ...base, state: 'missing' };
  // ruflo --version typically prints "ruflo X.Y.Z" on the first line.
  const v = await runCapture(bin, ['--version']);
  const version = v.stdout.split('\n')[0]?.trim() || undefined;
  return { ...base, state: 'ok', path: bin, version };
}

async function detectMempalace(): Promise<SetupCheck> {
  const base: Omit<SetupCheck, 'state'> = {
    id: 'mempalace',
    label: 'MemPalace',
    description: 'Persistent memory plugin + ~/.claude/ hooks (Memory tab).',
    installable: true,
  };
  try {
    const s = await getMempalaceStatus();
    return s.installed
      ? { ...base, state: 'ok', path: s.vaultPath }
      : { ...base, state: 'missing' };
  } catch (err) {
    logger.warn(`mempalace status failed: ${(err as Error).message}`);
    return { ...base, state: 'missing' };
  }
}

// ---------------------------------------------------------------------------
// Status — single roll-up used by getStatus / re-checks after install
// ---------------------------------------------------------------------------

export async function getStatus(): Promise<SetupStatus> {
  const platform = process.platform;
  const brew = await detectBrew();
  const claude = await detectClaude();
  const tmux = await detectTool(
    'tmux',
    {
      label: 'tmux',
      description: 'Terminal multiplexer — backs team/multi-agent runners.',
    },
    brew.state,
  );
  const rtk = await detectTool(
    'rtk',
    {
      label: 'rtk (Rust Token Killer)',
      description: 'Filters verbose CLI output to cut Claude token usage 60-90%.',
    },
    brew.state,
  );
  const jq = await detectTool(
    'jq',
    {
      label: 'jq',
      description: 'JSON CLI — required by the rtk Claude hook.',
    },
    brew.state,
  );
  const rtkHook = await detectRtkHook(rtk.state);
  const mempalace = await detectMempalace();
  const ruflo = await detectRuflo();

  const checks: SetupCheck[] = [
    brew,
    claude,
    tmux,
    rtk,
    jq,
    rtkHook,
    mempalace,
    ruflo,
  ];

  // "complete" treats unsupported platforms as a pass for tools that simply
  // don't apply (Homebrew on Linux), but on macOS every entry must be 'ok'.
  const complete = checks.every(
    (c) => c.state === 'ok' || c.state === 'unsupported',
  );

  return { complete, platform, checks };
}

// ---------------------------------------------------------------------------
// Installers — one per tool, exposed individually and through installAll.
// ---------------------------------------------------------------------------

async function installBrew(): Promise<void> {
  // Homebrew's installer needs sudo + an interactive terminal. We delegate to
  // the user by opening the official page; running curl|bash inside Electron
  // is both unsafe and unlikely to succeed without TTY.
  step('brew', 'configure', 'Opening Homebrew installer page in browser…');
  await shell.openExternal('https://brew.sh');
}

async function installClaude(): Promise<void> {
  // The Anthropic CLI installer is non-interactive and exits cleanly.
  step('claude', 'install', 'Running official Claude Code installer…');
  const { code } = await runStream(
    'claude',
    'curl -fsSL https://claude.ai/install.sh | bash',
    [],
    { useBashC: true },
  );
  if (code !== 0) throw new Error(`Claude installer exited ${code}`);
  step('claude', 'verify', 'Claude Code installed. Run `claude` once to sign in.');
}

async function installBrewPkg(toolId: SetupToolId, pkg: string): Promise<void> {
  const brewBin = await whichBin('brew');
  if (!brewBin) {
    throw new Error(
      'Homebrew is required to install this tool. Install Homebrew first.',
    );
  }
  step(toolId, 'install', `brew install ${pkg}…`);
  const { code } = await runStream(toolId, brewBin, ['install', pkg]);
  if (code !== 0) throw new Error(`brew install ${pkg} exited ${code}`);
}

async function installRtk(): Promise<void> {
  const brewBin = await whichBin('brew');
  if (!brewBin) throw new Error('Homebrew is required to install rtk.');
  // rtk lives in the rtk-ai/rtk tap. Tapping is idempotent.
  step('rtk', 'configure', 'Tapping rtk-ai/rtk…');
  await runStream('rtk', brewBin, ['tap', 'rtk-ai/rtk']);
  step('rtk', 'install', 'brew install rtk…');
  const { code } = await runStream('rtk', brewBin, ['install', 'rtk']);
  if (code !== 0) {
    // Fall back to the fully-qualified tap form in case the tap isn't visible
    // to the unqualified install (rare, but reported on first-tap on some
    // macOS builds).
    const retry = await runStream('rtk', brewBin, ['install', 'rtk-ai/rtk/rtk']);
    if (retry.code !== 0) throw new Error('brew install rtk failed');
  }
}

async function installRtkHook(): Promise<void> {
  const src = getBundledRtkHookFile();
  const dest = getInstalledRtkHookFile();
  step('rtkHook', 'configure', `Writing ${dest}…`);
  await fsp.mkdir(getClaudeHooksDir(), { recursive: true });
  await fsp.copyFile(src, dest);
  if (process.platform !== 'win32') await fsp.chmod(dest, 0o755);

  step('rtkHook', 'configure', 'Patching ~/.claude/settings.json (backup created)…');
  const current = await readSettings();
  const next: SettingsShape = { ...current };
  const hooks = { ...(next.hooks ?? {}) };
  const pre = Array.isArray(hooks.PreToolUse) ? [...hooks.PreToolUse] : [];

  // Reuse an existing Bash matcher group if present; otherwise append a new
  // one. Either way we de-dupe on `command` so reruns don't multiply entries.
  let bashGroup = pre.find((g) => g.matcher === 'Bash');
  if (!bashGroup) {
    bashGroup = { matcher: 'Bash', hooks: [] };
    pre.push(bashGroup);
  }
  if (!Array.isArray(bashGroup.hooks)) bashGroup.hooks = [];
  const already = bashGroup.hooks.some((h) => h.command === dest);
  if (!already) {
    bashGroup.hooks.push({ type: 'command', command: dest });
  }
  hooks.PreToolUse = pre;
  next.hooks = hooks;
  await writeSettings(next);
}

async function installRuflo(): Promise<void> {
  const npmBin = await whichBin('npm');
  if (!npmBin) {
    throw new Error(
      'npm is required to install Ruflo (comes with Node.js — install Node first).',
    );
  }
  step('ruflo', 'install', 'npm install -g ruflo@latest…');
  const { code } = await runStream('ruflo', npmBin, [
    'install',
    '-g',
    'ruflo@latest',
  ]);
  if (code !== 0) throw new Error(`npm install -g ruflo exited ${code}`);
  step(
    'ruflo',
    'verify',
    'Ruflo installed. Run `npx ruflo init` in any project to wire up agents.',
  );
}

async function uninstallRtkHook(): Promise<void> {
  const dest = getInstalledRtkHookFile();
  step('rtkHook', 'configure', 'Removing rtk hook from settings.json…');
  const current = await readSettings();
  const next: SettingsShape = { ...current };
  if (next.hooks?.PreToolUse) {
    const pruned = next.hooks.PreToolUse.map((g) => {
      if (!Array.isArray(g.hooks)) return g;
      return { ...g, hooks: g.hooks.filter((h) => h.command !== dest) };
    }).filter(
      (g) => !Array.isArray(g.hooks) || g.hooks.length > 0,
    );
    if (pruned.length === 0) {
      const { PreToolUse: _drop, ...rest } = next.hooks;
      next.hooks = rest;
      if (Object.keys(next.hooks).length === 0) delete next.hooks;
    } else {
      next.hooks = { ...next.hooks, PreToolUse: pruned };
    }
    await writeSettings(next);
  }

  try {
    await fsp.unlink(dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

// ---------------------------------------------------------------------------
// Public install dispatcher
// ---------------------------------------------------------------------------

export async function installTool(toolId: SetupToolId): Promise<SetupInstallResult> {
  if (installing) {
    return {
      ok: false,
      status: await getStatus(),
      error: `Already installing ${installing}`,
    };
  }
  installing = toolId;
  try {
    step(toolId, 'preflight', `Starting install: ${toolId}…`);
    switch (toolId) {
      case 'brew':
        await installBrew();
        break;
      case 'claude':
        await installClaude();
        break;
      case 'tmux':
        await installBrewPkg('tmux', 'tmux');
        break;
      case 'rtk':
        await installRtk();
        break;
      case 'jq':
        await installBrewPkg('jq', 'jq');
        break;
      case 'rtkHook':
        await installRtkHook();
        break;
      case 'mempalace':
        // MemPalace has its own dedicated installer in MemPalaceService;
        // Setup tab uses it as a read-only roll-up and points users at the
        // Memory tab for the actual install button.
        throw new Error(
          'Install MemPalace from the Memory tab (it has its own dedicated wizard).',
        );
      case 'ruflo':
        await installRuflo();
        break;
    }
    const status = await getStatus();
    emit({ toolId, stage: 'done', message: 'Done.', done: true });
    return { ok: true, status };
  } catch (err) {
    const message = (err as Error).message;
    logger.error(`install ${toolId} failed: ${message}`);
    emit({ toolId, stage: 'error', message, done: true, error: message });
    return { ok: false, status: await getStatus(), error: message };
  } finally {
    installing = null;
  }
}

export async function uninstallRtkHookPublic(): Promise<SetupInstallResult> {
  if (installing) {
    return {
      ok: false,
      status: await getStatus(),
      error: `Busy installing ${installing}`,
    };
  }
  installing = 'rtkHook';
  try {
    await uninstallRtkHook();
    emit({ toolId: 'rtkHook', stage: 'done', message: 'Removed.', done: true });
    return { ok: true, status: await getStatus() };
  } catch (err) {
    const message = (err as Error).message;
    emit({
      toolId: 'rtkHook',
      stage: 'error',
      message,
      done: true,
      error: message,
    });
    return { ok: false, status: await getStatus(), error: message };
  } finally {
    installing = null;
  }
}

/**
 * Install every tool that's currently 'missing' on macOS (Homebrew is the
 * external prerequisite — we surface a clear "Install Homebrew first" error
 * rather than try to script sudo curl|bash). Skips MemPalace; the user is
 * pointed at the Memory tab.
 */
export async function installAllMissing(): Promise<SetupInstallResult> {
  if (installing) {
    return {
      ok: false,
      status: await getStatus(),
      error: `Already installing ${installing}`,
    };
  }
  installing = 'all';

  try {
    const initial = await getStatus();
    if (initial.platform !== 'darwin') {
      throw new Error(
        `Install All is only supported on macOS in this version (host: ${initial.platform}).`,
      );
    }

    const order: SetupToolId[] = [
      'brew',
      'jq',
      'tmux',
      'rtk',
      'claude',
      'rtkHook',
    ];

    for (const toolId of order) {
      const current = await getStatus();
      const c = current.checks.find((x) => x.id === toolId);
      if (!c) continue;
      if (c.state === 'ok' || c.state === 'unsupported') continue;

      if (toolId === 'brew') {
        // External — open the browser and stop; we can't continue without
        // brew on macOS. User reruns Install All after they finish.
        step('all', 'configure', 'Homebrew is missing — opening installer page.');
        await installBrew();
        emit({
          toolId: 'all',
          stage: 'error',
          message:
            'Install Homebrew from brew.sh, then click Install All again.',
          done: true,
          error: 'Homebrew required',
        });
        return {
          ok: false,
          status: await getStatus(),
          error: 'Homebrew required — see your browser tab.',
        };
      }

      step('all', 'install', `Installing ${toolId}…`);
      try {
        switch (toolId) {
          case 'jq':
            await installBrewPkg('jq', 'jq');
            break;
          case 'tmux':
            await installBrewPkg('tmux', 'tmux');
            break;
          case 'rtk':
            await installRtk();
            break;
          case 'claude':
            await installClaude();
            break;
          case 'rtkHook':
            await installRtkHook();
            break;
        }
      } catch (err) {
        const message = (err as Error).message;
        emit({
          toolId: 'all',
          stage: 'error',
          message: `Step ${toolId} failed: ${message}`,
          done: true,
          error: message,
        });
        return { ok: false, status: await getStatus(), error: message };
      }
    }

    const status = await getStatus();
    emit({
      toolId: 'all',
      stage: 'done',
      message: 'Setup complete. Restart Claude Code to pick up new hooks.',
      done: true,
    });
    return { ok: true, status };
  } catch (err) {
    const message = (err as Error).message;
    return { ok: false, status: await getStatus(), error: message };
  } finally {
    installing = null;
  }
}

export async function openSettingsDir(): Promise<void> {
  await shell.openPath(getClaudeDir());
}
