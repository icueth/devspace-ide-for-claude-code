import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { shell, type WebContents } from 'electron';

import {
  bundledUvExists,
  getBundledHooksDir,
  getBundledUvBinary,
  getBundledUvDir,
  getClaudeDir,
  getClaudeSettingsFile,
  getDefaultVaultDir,
  getInstalledHooksDir,
  getUvToolBinDir,
} from '@main/utils/mempalacePaths';
import { IPC } from '@shared/ipc-channels';
import { createLogger } from '@shared/logger';
import type {
  MemPalaceInstallInput,
  MemPalaceInstallResult,
  MemPalaceProgressEvent,
  MemPalaceStage,
  MemPalaceStatus,
  MemPalaceUninstallInput,
} from '@shared/mempalace';

const logger = createLogger('MemPalace');

const HOOK_FILES = [
  'mempalace-session-start.sh',
  'mempalace-post-commit.sh',
  'mempalace-stop-check.sh',
] as const;

const PLUGIN_KEY = 'mempalace@mempalace';
const MARKETPLACE_KEY = 'mempalace';
const PLUGIN_REPO = 'MemPalace/mempalace';

const subscribers = new Set<WebContents>();
let installing = false;

export function subscribeMempalace(wc: WebContents): void {
  subscribers.add(wc);
  wc.once('destroyed', () => subscribers.delete(wc));
}

export function unsubscribeMempalace(wc: WebContents): void {
  subscribers.delete(wc);
}

function emit(event: MemPalaceProgressEvent): void {
  for (const wc of subscribers) {
    if (wc.isDestroyed()) continue;
    wc.send(IPC.MEMPALACE_PROGRESS, event);
  }
}

function vaultPathFromSettings(settings: SettingsShape): string {
  const fromEnv =
    settings.env && typeof settings.env.MEMPAL_DIR === 'string'
      ? settings.env.MEMPAL_DIR
      : '';
  return fromEnv || getDefaultVaultDir();
}

// Settings.json shape is loose — Claude Code accepts many top-level keys we
// don't care about. We type only the fields we read or write; everything
// else is preserved as `unknown` through JSON round-trip.
interface HookEntry {
  type: 'command';
  command: string;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
}
interface SettingsShape {
  env?: Record<string, string>;
  enabledPlugins?: Record<string, boolean>;
  extraKnownMarketplaces?: Record<
    string,
    { source?: { source?: string; repo?: string } }
  >;
  hooks?: {
    SessionStart?: HookGroup[];
    PostToolUse?: HookGroup[];
    Stop?: HookGroup[];
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

async function readSettings(): Promise<SettingsShape> {
  const file = getClaudeSettingsFile();
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as SettingsShape;
    return {};
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return {};
    throw err;
  }
}

async function writeSettings(next: SettingsShape): Promise<void> {
  const file = getClaudeSettingsFile();
  await fsp.mkdir(path.dirname(file), { recursive: true });

  // Backup the existing file once per install so reverting is trivial.
  if (fs.existsSync(file)) {
    const ts = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace(/Z$/, '');
    const backup = `${file}.bak.${ts}`;
    try {
      await fsp.copyFile(file, backup);
    } catch (err) {
      logger.warn(`backup ${backup} failed: ${(err as Error).message}`);
    }
  }

  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(next, null, 2));
  await fsp.rename(tmp, file);
}

function ensureHookGroup(
  groups: HookGroup[] | undefined,
  command: string,
  matcher?: string,
): HookGroup[] {
  const arr = Array.isArray(groups) ? [...groups] : [];
  const already = arr.some((g) =>
    Array.isArray(g.hooks) && g.hooks.some((h) => h.command === command),
  );
  if (already) return arr;
  const entry: HookGroup = {
    hooks: [{ type: 'command', command }],
  };
  if (matcher) entry.matcher = matcher;
  arr.push(entry);
  return arr;
}

function stripHookGroups(
  groups: HookGroup[] | undefined,
  command: string,
): HookGroup[] {
  if (!Array.isArray(groups)) return [];
  return groups
    .map((g) => {
      if (!Array.isArray(g.hooks)) return g;
      return { ...g, hooks: g.hooks.filter((h) => h.command !== command) };
    })
    .filter((g) => !Array.isArray(g.hooks) || g.hooks.length > 0);
}

/**
 * Patch settings.json idempotently. The same call shape as the legacy
 * install-mempalace.sh: env.MEMPAL_DIR, enabledPlugins[mempalace@mempalace],
 * extraKnownMarketplaces[mempalace], and three hooks (SessionStart,
 * PostToolUse[Bash], Stop).
 */
async function patchSettings(opts: {
  vaultPath: string;
  hooksDir: string;
}): Promise<void> {
  const current = await readSettings();
  const next: SettingsShape = { ...current };

  next.env = { ...(next.env ?? {}), MEMPAL_DIR: opts.vaultPath };
  next.enabledPlugins = {
    ...(next.enabledPlugins ?? {}),
    [PLUGIN_KEY]: true,
  };
  next.extraKnownMarketplaces = {
    ...(next.extraKnownMarketplaces ?? {}),
    [MARKETPLACE_KEY]: {
      source: { source: 'github', repo: PLUGIN_REPO },
    },
  };

  const hooks = { ...(next.hooks ?? {}) };
  hooks.SessionStart = ensureHookGroup(
    hooks.SessionStart,
    path.join(opts.hooksDir, 'mempalace-session-start.sh'),
  );
  hooks.PostToolUse = ensureHookGroup(
    hooks.PostToolUse,
    path.join(opts.hooksDir, 'mempalace-post-commit.sh'),
    'Bash',
  );
  hooks.Stop = ensureHookGroup(
    hooks.Stop,
    path.join(opts.hooksDir, 'mempalace-stop-check.sh'),
  );
  next.hooks = hooks;

  await writeSettings(next);
}

async function unpatchSettings(hooksDir: string): Promise<void> {
  const current = await readSettings();
  const next: SettingsShape = { ...current };

  if (next.env) {
    const { MEMPAL_DIR: _drop, ...rest } = next.env;
    next.env = rest;
    if (Object.keys(next.env).length === 0) delete next.env;
  }

  if (next.enabledPlugins) {
    const { [PLUGIN_KEY]: _drop, ...rest } = next.enabledPlugins;
    next.enabledPlugins = rest;
    if (Object.keys(next.enabledPlugins).length === 0) {
      delete next.enabledPlugins;
    }
  }

  if (next.extraKnownMarketplaces) {
    const { [MARKETPLACE_KEY]: _drop, ...rest } = next.extraKnownMarketplaces;
    next.extraKnownMarketplaces = rest;
    if (Object.keys(next.extraKnownMarketplaces).length === 0) {
      delete next.extraKnownMarketplaces;
    }
  }

  if (next.hooks) {
    const hooks = { ...next.hooks };
    for (const file of HOOK_FILES) {
      const full = path.join(hooksDir, file);
      if (file === 'mempalace-session-start.sh') {
        hooks.SessionStart = stripHookGroups(hooks.SessionStart, full);
      } else if (file === 'mempalace-post-commit.sh') {
        hooks.PostToolUse = stripHookGroups(hooks.PostToolUse, full);
      } else {
        hooks.Stop = stripHookGroups(hooks.Stop, full);
      }
    }
    for (const k of ['SessionStart', 'PostToolUse', 'Stop'] as const) {
      const arr = hooks[k];
      if (Array.isArray(arr) && arr.length === 0) delete hooks[k];
    }
    if (Object.keys(hooks).length === 0) {
      delete next.hooks;
    } else {
      next.hooks = hooks;
    }
  }

  await writeSettings(next);
}

function runUv(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const bin = getBundledUvBinary();
    if (!fs.existsSync(bin)) {
      reject(
        new Error(
          `Bundled uv binary missing: ${bin}. Run \`node scripts/fetch-uv.mjs --all\` before packaging.`,
        ),
      );
      return;
    }
    const child = spawn(bin, args, {
      env: {
        ...process.env,
        // Pin uv's data dir under the user's home so an `app.asar`-relative
        // binary doesn't try to write next to the bundled file.
        UV_NO_PROGRESS: '1',
      },
    });
    const errOut: string[] = [];
    child.stderr.on('data', (d) => errOut.push(String(d)));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`uv ${args.join(' ')} exited ${code}: ${errOut.join('')}`));
    });
  });
}

function vaultYaml(): string {
  return [
    'wing: memory_vault',
    'rooms:',
    '- name: general',
    '  description: All project files',
    '  keywords: []',
    '',
  ].join('\n');
}

async function ensureVault(vaultPath: string): Promise<void> {
  await fsp.mkdir(vaultPath, { recursive: true });
  const yamlFile = path.join(vaultPath, 'mempalace.yaml');
  try {
    await fsp.stat(yamlFile);
  } catch {
    await fsp.writeFile(yamlFile, vaultYaml());
  }
}

async function installHooks(): Promise<string> {
  const src = getBundledHooksDir();
  const dest = getInstalledHooksDir();
  await fsp.mkdir(dest, { recursive: true });
  for (const file of HOOK_FILES) {
    const from = path.join(src, file);
    const to = path.join(dest, file);
    await fsp.copyFile(from, to);
    // Hooks must be executable for Claude Code to invoke them.
    if (process.platform !== 'win32') {
      await fsp.chmod(to, 0o755);
    }
  }
  return dest;
}

async function uninstallHooks(): Promise<void> {
  const dir = getInstalledHooksDir();
  for (const file of HOOK_FILES) {
    try {
      await fsp.unlink(path.join(dir, file));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

async function mempalacePackageInstalled(): Promise<boolean> {
  // uv tool install drops a `mempalace` console script into the tool bin
  // dir. Presence of that file is the cheapest signal that doesn't require
  // launching a subprocess.
  const exe = process.platform === 'win32' ? 'mempalace.exe' : 'mempalace';
  try {
    await fsp.access(path.join(getUvToolBinDir(), exe), fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function hookFilesPresent(): Promise<boolean> {
  const dir = getInstalledHooksDir();
  for (const f of HOOK_FILES) {
    try {
      await fsp.access(path.join(dir, f), fs.constants.F_OK);
    } catch {
      return false;
    }
  }
  return true;
}

async function pluginEnabledInSettings(): Promise<boolean> {
  const s = await readSettings();
  return s.enabledPlugins?.[PLUGIN_KEY] === true;
}

async function vaultPresent(p: string): Promise<boolean> {
  try {
    const st = await fsp.stat(p);
    if (!st.isDirectory()) return false;
    await fsp.access(path.join(p, 'mempalace.yaml'));
    return true;
  } catch {
    return false;
  }
}

export async function getStatus(): Promise<MemPalaceStatus> {
  const hostSupported = bundledUvExists();
  const settings = await readSettings();
  const vaultPath = vaultPathFromSettings(settings);

  const checks: MemPalaceStatus['checks'] = {
    uv: hostSupported ? 'ok' : 'unsupported',
    mempalacePackage: (await mempalacePackageInstalled()) ? 'ok' : 'missing',
    vault: (await vaultPresent(vaultPath)) ? 'ok' : 'missing',
    hooks: (await hookFilesPresent()) ? 'ok' : 'missing',
    plugin: (await pluginEnabledInSettings()) ? 'ok' : 'missing',
  };

  const installed = Object.values(checks).every((v) => v === 'ok');

  return {
    installed,
    checks,
    vaultPath,
    hooksDir: getInstalledHooksDir(),
    settingsFile: getClaudeSettingsFile(),
    hostSupported,
  };
}

function stepBegin(stage: MemPalaceStage, message: string): void {
  logger.info(`[${stage}] ${message}`);
  emit({ stage, message, done: false });
}

export async function install(
  input: MemPalaceInstallInput,
): Promise<MemPalaceInstallResult> {
  if (installing) {
    return {
      ok: false,
      status: await getStatus(),
      error: 'Install already running',
    };
  }
  installing = true;
  const vaultPath = input.vaultPath?.trim() || getDefaultVaultDir();

  try {
    stepBegin('preflight', 'Checking bundled resources…');
    if (!bundledUvExists()) {
      throw new Error(
        `No bundled uv for this platform (${process.platform}-${process.arch}). ` +
          `Expected at ${getBundledUvDir()}.`,
      );
    }

    stepBegin('install-package', 'Installing mempalace via uv…');
    // `--force` is intentionally omitted — if the user already installed
    // mempalace by other means we don't want to clobber it. uv treats
    // re-install of an already-present tool as a no-op + version check.
    await runUv(['tool', 'install', 'mempalace']);

    stepBegin('vault', `Creating memory vault at ${vaultPath}…`);
    await ensureVault(vaultPath);

    stepBegin('hooks', 'Installing Claude Code hooks…');
    const hooksDir = await installHooks();

    stepBegin('settings', 'Patching ~/.claude/settings.json (backup created)…');
    await patchSettings({ vaultPath, hooksDir });

    const status = await getStatus();
    emit({
      stage: 'done',
      message:
        'MemPalace installed. Restart Claude Code to load the new plugin + hooks.',
      done: true,
    });
    return { ok: true, status };
  } catch (err) {
    const message = (err as Error).message;
    logger.error(`install failed: ${message}`);
    emit({ stage: 'error', message, done: true, error: message });
    return { ok: false, status: await getStatus(), error: message };
  } finally {
    installing = false;
  }
}

export async function uninstall(
  input: MemPalaceUninstallInput,
): Promise<MemPalaceInstallResult> {
  const keepVault = input.keepVault !== false;
  try {
    stepBegin('settings', 'Removing MemPalace entries from settings.json…');
    await unpatchSettings(getInstalledHooksDir());

    stepBegin('hooks', 'Removing hook scripts…');
    await uninstallHooks();

    if (!keepVault) {
      const settings = await readSettings();
      const vaultPath = vaultPathFromSettings(settings) || getDefaultVaultDir();
      stepBegin('vault', `Deleting vault at ${vaultPath}…`);
      try {
        await fsp.rm(vaultPath, { recursive: true, force: true });
      } catch (err) {
        logger.warn(`vault rm failed: ${(err as Error).message}`);
      }
    }

    // We intentionally don't `uv tool uninstall mempalace` — the user may
    // be running MemPalace from another tool. They can run `uv tool
    // uninstall mempalace` manually if desired.

    const status = await getStatus();
    emit({
      stage: 'done',
      message: 'MemPalace removed. Restart Claude Code to deactivate.',
      done: true,
    });
    return { ok: true, status };
  } catch (err) {
    const message = (err as Error).message;
    logger.error(`uninstall failed: ${message}`);
    emit({ stage: 'error', message, done: true, error: message });
    return { ok: false, status: await getStatus(), error: message };
  }
}

export async function openVault(): Promise<void> {
  const status = await getStatus();
  await fsp.mkdir(status.vaultPath, { recursive: true });
  await shell.openPath(status.vaultPath);
}

export function getClaudeDirPath(): string {
  return getClaudeDir();
}
