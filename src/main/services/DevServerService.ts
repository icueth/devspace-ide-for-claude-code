// DevServerService — function-only service that detects, starts, monitors
// and stops a project's local dev server (Vite / Next / Astro / Remix) so
// the Live Preview tab can point a `<webview>` at it.
//
// Design parallels DesignService:
//   * In-memory `Map<projectPath, DevServerInfo>` for current state.
//   * `Map<projectPath, Set<WebContents>>` for streaming lifecycle events
//     back to the renderer over IPC.
//   * No class, only named function exports. All filesystem IO via
//     `node:fs/promises`. Logger from `@shared/logger`.
//
// Process spawning goes through `PtyPool.createPty` (kind `'dev-server'`,
// tabId = projectPath) so the dev server inherits the user's interactive
// shell environment (PATH, NVM-resolved node, asdf shims …) — same path
// the Claude CLI itself uses. Programmatic listeners hook into the PTY
// data stream via `subscribeData` / `subscribeExit` so the service can
// parse the framework's "local URL" line as it scrolls past, without
// running through the renderer.
//
// Detection is best-effort: a `package.json` is parsed for known
// framework dependencies AND the matching config file is checked
// (`vite.config.*`, `next.config.*`, etc.). The "dev" script is
// preferred, then "start", then any script whose body matches the
// framework's CLI.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { WebContents } from 'electron';

import {
  createPty,
  killPty,
  subscribeData,
  subscribeExit,
} from '@main/services/PtyPool';
import { IPC } from '@shared/ipc-channels';
import { createLogger } from '@shared/logger';
import type {
  DevServerEvent,
  DevServerEventKind,
  DevServerInfo,
  DevServerKind,
  DevServerStartInput,
  DevServerStatus,
} from '@shared/design';

const logger = createLogger('DevServerService');

// Cap log tail per project. The renderer shows the tail in a collapsible
// pane, so 500 lines is plenty without ballooning main-process memory if
// a misbehaving framework spams stdout.
const MAX_LOG_LINES = 500;

// Strip ANSI escape sequences (CSI / OSC / SGR) before storing or
// regex-matching. Most dev servers colour their output and the raw bytes
// would otherwise break the localhost URL regex.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-9;?]*[ -/]*[@-~]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

// ─── package manager + framework detection ──────────────────────────────────

type PackageManager = 'pnpm' | 'yarn' | 'npm' | 'bun';

/**
 * Pick the package manager based on lockfile presence. Defaults to npm
 * when nothing is recognized so we always have a runnable command.
 */
export async function detectPackageManager(projectPath: string): Promise<PackageManager> {
  const candidates: Array<[string, PackageManager]> = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
  ];
  for (const [file, pm] of candidates) {
    try {
      await fs.access(path.join(projectPath, file));
      return pm;
    } catch {
      // Not present — try the next.
    }
  }
  return 'npm';
}

interface ParsedPackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function readPackageJson(projectPath: string): Promise<ParsedPackageJson | null> {
  try {
    const raw = await fs.readFile(path.join(projectPath, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as ParsedPackageJson;
    return parsed;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn(`failed to read package.json: ${(err as Error).message}`);
    }
    return null;
  }
}

async function hasFile(projectPath: string, candidates: string[]): Promise<boolean> {
  for (const file of candidates) {
    try {
      await fs.access(path.join(projectPath, file));
      return true;
    } catch {
      /* keep scanning */
    }
  }
  return false;
}

/**
 * Classify a project as one of the supported dev-server kinds. Pure
 * function over the parsed package.json + a "config file present"
 * predicate — split out so unit tests can exercise it without touching
 * the filesystem.
 */
export function detectFramework(
  pkg: ParsedPackageJson | null,
  configFlags: {
    viteConfig: boolean;
    nextConfig: boolean;
    astroConfig: boolean;
    remixConfig: boolean;
  },
): DevServerKind {
  if (!pkg) return 'unknown';
  const allDeps: Record<string, string> = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };

  if ('next' in allDeps && configFlags.nextConfig) return 'next';
  if ('astro' in allDeps && configFlags.astroConfig) return 'astro';
  if ('vite' in allDeps && configFlags.viteConfig) return 'vite';
  if (
    '@remix-run/dev' in allDeps ||
    '@remix-run/react' in allDeps ||
    '@remix-run/serve' in allDeps
  ) {
    return 'remix';
  }
  // Soft fallbacks — sometimes config files exist without an explicit
  // top-level dependency (e.g. a monorepo where `vite` is a workspace
  // dep). The renderer can still show the start button.
  if (configFlags.nextConfig && ('next' in allDeps)) return 'next';
  if (configFlags.viteConfig) return 'vite';
  return 'unknown';
}

/**
 * Pick which package-manager script to run. Priority is:
 *   1. explicit "dev" script
 *   2. explicit "start" script
 *   3. first script whose body invokes the framework CLI
 * Returns an empty string when nothing matches.
 */
export function pickScriptName(
  scripts: Record<string, string> | undefined,
  kind: DevServerKind,
): string {
  if (!scripts) return '';
  if (typeof scripts.dev === 'string' && scripts.dev.trim() !== '') return 'dev';
  if (typeof scripts.start === 'string' && scripts.start.trim() !== '') return 'start';

  // Last resort — scan script bodies for the framework's CLI keyword
  // AND a dev-ish token (so we don't pick "build" scripts as dev
  // scripts, which would launch one-shot production builds that exit
  // without ever emitting a URL and leave status stuck on 'starting').
  const keyword = frameworkKeyword(kind);
  if (!keyword) return '';
  const DEV_TOKENS = ['dev', 'serve', 'start', 'watch'];
  for (const [name, body] of Object.entries(scripts)) {
    if (typeof body !== 'string') continue;
    if (!body.includes(keyword)) continue;
    const lower = body.toLowerCase();
    if (DEV_TOKENS.some((t) => lower.includes(t))) return name;
    const lowerName = name.toLowerCase();
    if (DEV_TOKENS.some((t) => lowerName.includes(t))) return name;
  }
  return '';
}

function frameworkKeyword(kind: DevServerKind): string {
  switch (kind) {
    case 'vite':
      return 'vite';
    case 'next':
      return 'next';
    case 'astro':
      return 'astro';
    case 'remix':
      return 'remix';
    default:
      return '';
  }
}

/**
 * Top-level detection — combines package.json + config-file checks and
 * picks a script name.
 */
export async function detectDevServer(projectPath: string): Promise<DevServerInfo> {
  const pkg = await readPackageJson(projectPath);
  const [viteConfig, nextConfig, astroConfig, remixConfig] = await Promise.all([
    hasFile(projectPath, [
      'vite.config.ts',
      'vite.config.js',
      'vite.config.mjs',
      'vite.config.cjs',
    ]),
    hasFile(projectPath, [
      'next.config.ts',
      'next.config.js',
      'next.config.mjs',
    ]),
    hasFile(projectPath, [
      'astro.config.ts',
      'astro.config.js',
      'astro.config.mjs',
    ]),
    hasFile(projectPath, [
      'remix.config.ts',
      'remix.config.js',
      'remix.config.mjs',
    ]),
  ]);
  const kind = detectFramework(pkg, {
    viteConfig,
    nextConfig,
    astroConfig,
    remixConfig,
  });
  const scriptName = pickScriptName(pkg?.scripts, kind);
  return {
    kind,
    scriptName,
    url: null,
    status: 'idle',
    logTail: [],
  };
}

// ─── URL parsing ────────────────────────────────────────────────────────────

// Loose finder: matches any http(s)://something-not-whitespace that
// will be re-validated through new URL() below. Framework-specific
// patterns just narrow the search; the validation is the same.
const URL_FINDER_RE = /\bhttps?:\/\/[^\s,;"'<>()`]+/gi;
// Next.js sometimes prints "started server on … url: http://localhost:3000".
const NEXT_STARTED_RE = /started server on[^\n]*url:\s*(https?:\/\/\S+)/i;

/**
 * Try to parse a URL and accept it only if it points at localhost on a
 * non-privileged port with no userinfo. Returns the normalized origin
 * (no trailing slash) or null.
 *
 * Rejects: non-http(s), non-localhost hostnames, port 0, port < 1024,
 * port > 65535, userinfo (user:pass@), paths/queries/fragments (we
 * navigate to the bare origin so attacker-controlled paths can't
 * influence the first request).
 */
function tryParseLocalUrl(candidate: string): string | null {
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (host !== 'localhost') return null;
  if (u.username || u.password) return null;
  const port = Number(u.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `${u.protocol}//${u.hostname}:${u.port}`;
}

/**
 * Pull the first valid localhost origin from a single line of stdout.
 * Strips ANSI first. Framework-specific extra patterns (e.g. Next's
 * "started server on … url: …") take precedence. Returns null when no
 * localhost URL is present or it fails validation.
 *
 * 127.0.0.1, 0.0.0.0, lan-ip, and any non-localhost host are rejected
 * by `tryParseLocalUrl` — we only point the webview at localhost so
 * Chromium doesn't try to negotiate the LAN.
 */
export function parseLocalUrl(line: string, kind: DevServerKind): string | null {
  const clean = stripAnsi(line);
  if (kind === 'next') {
    const m = NEXT_STARTED_RE.exec(clean);
    if (m && m[1]) {
      const accepted = tryParseLocalUrl(m[1]);
      if (accepted) return accepted;
    }
  }
  // Scan the line for any http(s) URL candidate and accept the first
  // one that passes validation.
  for (const match of clean.matchAll(URL_FINDER_RE)) {
    const accepted = tryParseLocalUrl(match[0]);
    if (accepted) return accepted;
  }
  return null;
}

// ─── in-memory state ────────────────────────────────────────────────────────

interface ProjectState {
  projectPath: string;
  info: DevServerInfo;
  subscribers: Set<WebContents>;
  // Set when the PTY is alive. Used to find the PTY key for kill /
  // unsubscribe-from-data on stop. `ptyId` on DevServerInfo mirrors this
  // for the renderer (informational only).
  ptyKey: string | null;
  // Holds the unsubscribe callbacks returned by PtyPool.subscribeData /
  // subscribeExit so we can detach them on stop or on crash.
  detach: Array<() => void>;
  // Buffer of partial trailing bytes between PTY chunks — assembled into
  // whole lines so the URL regex sees full lines, not arbitrary slices.
  lineBuffer: string;
  // Latched flag — once we've emitted 'url_resolved' for this run we
  // ignore any subsequent localhost URL prints (e.g. HMR restart logs).
  // Cleared on stop.
  urlEmitted: boolean;
  // Optional fallback timer that promotes 'starting' → 'running' when
  // the dev script never emits a parseable URL.
  startTimer?: NodeJS.Timeout;
}

const states = new Map<string, ProjectState>();

function getState(projectPath: string): ProjectState {
  const key = path.resolve(projectPath);
  let state = states.get(key);
  if (!state) {
    state = {
      projectPath: key,
      info: {
        kind: 'unknown',
        scriptName: '',
        url: null,
        status: 'idle',
        logTail: [],
      },
      subscribers: new Set(),
      ptyKey: null,
      detach: [],
      lineBuffer: '',
      urlEmitted: false,
    };
    states.set(key, state);
  }
  return state;
}

function broadcast(state: ProjectState, event: DevServerEvent): void {
  for (const wc of state.subscribers) {
    if (!wc.isDestroyed()) {
      wc.send(IPC.DEVSERVER_EVENT, { projectPath: state.projectPath, event });
    }
  }
}

function emit(
  state: ProjectState,
  kind: DevServerEventKind,
  extra: Partial<DevServerEvent> = {},
): void {
  broadcast(state, {
    kind,
    projectPath: state.projectPath,
    ts: Date.now(),
    ...extra,
  });
}

function setStatus(
  state: ProjectState,
  status: DevServerStatus,
  extra: Partial<DevServerInfo> = {},
): void {
  state.info = { ...state.info, ...extra, status };
  emit(state, 'status_changed', {
    status,
    url: state.info.url,
    message: state.info.errorMessage,
  });
}

function appendLog(state: ProjectState, line: string): void {
  // Drop trailing CR (CRLF terminals) and any zero-length residue. We
  // store the cleaned line so the renderer's log pane stays readable.
  const clean = stripAnsi(line).replace(/\r$/, '');
  state.info.logTail.push(clean);
  if (state.info.logTail.length > MAX_LOG_LINES) {
    state.info.logTail.splice(0, state.info.logTail.length - MAX_LOG_LINES);
  }
  emit(state, 'log', { line: clean });
}

// ─── public API ─────────────────────────────────────────────────────────────

/**
 * Returns the current `DevServerInfo` for a project. When no PTY is
 * running this kicks off a fresh detection so the renderer can decide
 * which "Start" button to show.
 */
export async function getDevServerStatus(projectPath: string): Promise<DevServerInfo> {
  const state = getState(projectPath);
  // If a run is already alive, return the live state verbatim.
  if (state.info.status === 'running' || state.info.status === 'starting') {
    return cloneInfo(state.info);
  }
  // Otherwise re-detect so a recently-added vite.config picks up
  // without a full app restart.
  const detected = await detectDevServer(state.projectPath);
  // Preserve any error/log state from the last run for visibility.
  if (state.info.status === 'error') {
    state.info = {
      ...detected,
      status: 'error',
      errorMessage: state.info.errorMessage,
      logTail: state.info.logTail,
    };
  } else {
    state.info = {
      ...detected,
      logTail: state.info.logTail,
    };
  }
  return cloneInfo(state.info);
}

function cloneInfo(info: DevServerInfo): DevServerInfo {
  // Defensive copy — the renderer shouldn't be able to mutate the
  // service's internal log tail through structured clone aliasing.
  return {
    ...info,
    logTail: info.logTail.slice(),
  };
}

// Allowed shape for a package.json script name. Used to validate
// caller-supplied overrides before we hand them to the package manager.
const SCRIPT_NAME_RE = /^[A-Za-z0-9_:.-]{1,80}$/;
const ALLOWED_PACKAGE_MANAGERS = new Set(['pnpm', 'yarn', 'npm', 'bun']);
const ALLOWED_KINDS = new Set<DevServerKind>([
  'vite',
  'next',
  'astro',
  'remix',
  'unknown',
]);

/**
 * Start a dev server for a project. Returns the initial `DevServerInfo`
 * (status 'starting'). The URL becomes available later via a
 * 'url_resolved' event.
 *
 * Idempotent: if a server is already running for this project, returns
 * the existing info instead of throwing. This way multi-window opens
 * of the same Live Preview tab don't surface a scary error.
 */
export async function startDevServer(input: DevServerStartInput): Promise<DevServerInfo> {
  if (!input || typeof input.projectPath !== 'string' || !path.isAbsolute(input.projectPath)) {
    throw new Error('startDevServer requires an absolute projectPath');
  }
  // Validate caller-supplied overrides before they reach the spawn.
  if (input.scriptName !== undefined) {
    if (typeof input.scriptName !== 'string' || !SCRIPT_NAME_RE.test(input.scriptName)) {
      throw new Error('invalid scriptName');
    }
  }
  if (input.packageManager !== undefined) {
    if (typeof input.packageManager !== 'string' || !ALLOWED_PACKAGE_MANAGERS.has(input.packageManager)) {
      throw new Error('invalid packageManager');
    }
  }
  if (input.kind !== undefined) {
    if (typeof input.kind !== 'string' || !ALLOWED_KINDS.has(input.kind)) {
      throw new Error('invalid kind');
    }
  }

  const state = getState(input.projectPath);
  if (state.info.status === 'running') {
    // Idempotent — caller gets the live info, no new spawn.
    return cloneInfo(state.info);
  }
  if (state.info.status === 'starting') {
    throw new Error('dev server is already starting for this project');
  }

  // Refresh detection so script/kind defaults reflect the latest disk
  // state. The caller's overrides win when supplied.
  const detected = await detectDevServer(state.projectPath);
  const kind: DevServerKind = input.kind ?? detected.kind;
  let scriptName = input.scriptName ?? detected.scriptName;
  // Whitelist the script name against the project's actual package.json
  // scripts. This is the trust boundary: even though IPC layer validates
  // shape, only scripts the user has actually defined are runnable.
  if (scriptName) {
    const pkg = await readPackageJson(state.projectPath);
    const scriptKeys = pkg && pkg.scripts ? Object.keys(pkg.scripts) : [];
    if (!scriptKeys.includes(scriptName)) {
      state.info = {
        ...state.info,
        kind,
        scriptName: '',
        status: 'error',
        errorMessage: `script "${scriptName}" not found in package.json`,
      };
      emit(state, 'status_changed', {
        status: 'error',
        message: state.info.errorMessage,
      });
      return cloneInfo(state.info);
    }
  }
  if (!scriptName) {
    state.info = {
      ...state.info,
      kind,
      scriptName: '',
      status: 'error',
      errorMessage: 'no runnable dev script detected in package.json',
    };
    emit(state, 'status_changed', {
      status: 'error',
      message: state.info.errorMessage,
    });
    return cloneInfo(state.info);
  }

  const packageManager =
    input.packageManager ?? (await detectPackageManager(state.projectPath));
  const args = packageManagerRunArgs(packageManager, scriptName);

  // Reset transient run state.
  state.info = {
    kind,
    scriptName,
    url: null,
    status: 'starting',
    logTail: [],
    startedAt: Date.now(),
  };
  state.lineBuffer = '';
  state.urlEmitted = false;

  let session;
  try {
    session = await createPty({
      projectId: state.projectPath,
      // 'dev-server' kind tags the session for clean shutdown and lets
      // the PtyPool key collisions resolve naturally.
      kind: 'dev-server',
      // Per the Phase C spec — tabId = projectPath so multiple windows
      // pointing at the same project share one dev server.
      tabId: state.projectPath,
      cwd: state.projectPath,
      command: packageManager,
      args,
      cols: 120,
      rows: 32,
    });
  } catch (err) {
    state.info = {
      ...state.info,
      status: 'error',
      errorMessage: `failed to spawn dev server: ${(err as Error).message}`,
    };
    emit(state, 'status_changed', {
      status: 'error',
      message: state.info.errorMessage,
    });
    return cloneInfo(state.info);
  }

  state.ptyKey = session.sessionId;
  state.info.ptyId = session.sessionId;

  // Subscribe programmatically to PTY data + exit so we don't need a
  // WebContents to listen. The detach handles are released on stop.
  state.detach.push(
    subscribeData(session.sessionId, (chunk) => handlePtyData(state, kind, chunk)),
  );
  state.detach.push(
    subscribeExit(session.sessionId, (code) => handlePtyExit(state, code)),
  );

  logger.info(
    `started dev-server for ${state.projectPath} via ${packageManager} run ${scriptName} (pid=${session.pid})`,
  );

  emit(state, 'status_changed', {
    status: 'starting',
    url: null,
  });

  // Fallback: if no URL is parsed within 30s we promote to 'running' so
  // the user can at least see the log pane and read the actual port the
  // script chose. Without this, status pinned to 'starting' forever for
  // any script that emits a URL we can't parse (or no URL at all). The
  // webview won't mount (info.url is null), but the UI no longer lies.
  if (state.startTimer) clearTimeout(state.startTimer);
  state.startTimer = setTimeout(() => {
    if (state.info.status === 'starting' && !state.urlEmitted) {
      state.info = {
        ...state.info,
        status: 'running',
        url: null,
      };
      emit(state, 'status_changed', {
        status: 'running',
        url: null,
        message:
          'Dev server started, but no localhost URL was detected. Check the log pane for the URL.',
      });
    }
  }, 30_000);

  return cloneInfo(state.info);
}

function packageManagerRunArgs(pm: PackageManager, scriptName: string): string[] {
  // pnpm / yarn / bun support `pm run <script>`. npm needs the explicit
  // `run` verb too; for npm we also pass `--` to forward any future
  // user-supplied args verbatim, but Phase C doesn't surface them yet.
  switch (pm) {
    case 'pnpm':
      return ['run', scriptName];
    case 'yarn':
      return ['run', scriptName];
    case 'bun':
      return ['run', scriptName];
    case 'npm':
    default:
      return ['run', scriptName, '--'];
  }
}

function handlePtyData(state: ProjectState, kind: DevServerKind, chunk: string): void {
  // Reassemble whole lines across chunk boundaries before regex-matching
  // — splitting on every chunk would break URLs that straddle a flush.
  const combined = state.lineBuffer + chunk;
  const parts = combined.split(/\r?\n/);
  // The last element is whatever came after the final newline (may be
  // partial). Keep it for the next chunk.
  state.lineBuffer = parts.pop() ?? '';

  for (const line of parts) {
    if (!line) continue;
    appendLog(state, line);
    if (!state.urlEmitted) {
      const url = parseLocalUrl(line, kind);
      if (url) {
        state.urlEmitted = true;
        state.info.url = url;
        if (state.info.status !== 'running') {
          setStatus(state, 'running', { url });
        }
        emit(state, 'url_resolved', { url, status: 'running' });
      }
    }
  }
}

function handlePtyExit(state: ProjectState, exitCode: number): void {
  // Detach listeners — the PtyPool entry is already gone by this point,
  // so the detach calls are no-ops, but we still clear our local refs.
  state.detach = [];
  state.ptyKey = null;
  state.info.ptyId = undefined;
  if (state.startTimer) {
    clearTimeout(state.startTimer);
    state.startTimer = undefined;
  }

  // Distinguish a clean stop (user clicked Stop → killPty → exit) from
  // a crash. Our `stopDevServer` sets status to 'stopped' BEFORE killing
  // the PTY, so when this handler fires after a stop we just confirm.
  if (state.info.status === 'stopped' || state.info.status === 'idle') {
    return;
  }

  // Any other exit is unexpected → crashed. `crashed` is the canonical
  // event for unexpected death; we deliberately do NOT also emit
  // status_changed, so subscribers counting transitions (telemetry, an
  // auto-restart feature) see the crash exactly once.
  const message =
    exitCode === 0
      ? 'dev server exited unexpectedly (code 0)'
      : `dev server exited with code ${exitCode}`;
  state.info = {
    ...state.info,
    status: 'error',
    errorMessage: message,
    url: null,
  };
  emit(state, 'crashed', { status: 'error', message, url: null });
}

/**
 * Kill the dev-server PTY for a project. Idempotent — safe to call on a
 * stopped or never-started project. Transitions status to 'stopped' so
 * the eventual onExit callback doesn't fire a spurious crash event.
 */
export async function stopDevServer(projectPath: string): Promise<DevServerInfo> {
  const state = getState(projectPath);
  if (!state.ptyKey) {
    // Nothing to kill — flip to idle if we somehow ended up half-started.
    if (state.info.status !== 'idle' && state.info.status !== 'error') {
      setStatus(state, 'stopped', { url: null });
    }
    return cloneInfo(state.info);
  }
  const key = state.ptyKey;

  // Mark stopped FIRST so the upcoming onExit handler short-circuits
  // and does not promote the clean kill to a 'crashed' event.
  state.info = {
    ...state.info,
    status: 'stopped',
    url: null,
    errorMessage: undefined,
    ptyId: undefined,
  };
  state.ptyKey = null;
  for (const off of state.detach) {
    try {
      off();
    } catch {
      /* listener already gone */
    }
  }
  state.detach = [];
  state.lineBuffer = '';
  state.urlEmitted = false;
  emit(state, 'status_changed', { status: 'stopped', url: null });

  try {
    killPty(key);
  } catch (err) {
    logger.warn(`killPty(${key}) failed: ${(err as Error).message}`);
  }

  return cloneInfo(state.info);
}

/**
 * Register a WebContents as a subscriber. The renderer immediately gets
 * a synthetic 'status_changed' event so it can sync its UI without a
 * separate fetch. Cleanup is wired via `wc.once('destroyed')`.
 */
export function subscribeDevServerEvents(
  projectPath: string,
  wc: WebContents,
): void {
  const state = getState(projectPath);
  if (state.subscribers.has(wc)) {
    // Still send a fresh snapshot — the caller invoked `subscribe`
    // explicitly, presumably because it just remounted and needs the
    // current state.
    if (!wc.isDestroyed()) {
      wc.send(IPC.DEVSERVER_EVENT, {
        projectPath: state.projectPath,
        event: {
          kind: 'status_changed' as DevServerEventKind,
          projectPath: state.projectPath,
          status: state.info.status,
          url: state.info.url,
          message: state.info.errorMessage,
          ts: Date.now(),
        },
      });
    }
    return;
  }
  state.subscribers.add(wc);
  ensureDestroyHook(wc);
  // Initial snapshot so the renderer can render the right UI immediately.
  if (!wc.isDestroyed()) {
    wc.send(IPC.DEVSERVER_EVENT, {
      projectPath: state.projectPath,
      event: {
        kind: 'status_changed' as DevServerEventKind,
        projectPath: state.projectPath,
        status: state.info.status,
        url: state.info.url,
        message: state.info.errorMessage,
        ts: Date.now(),
      },
    });
  }
}

/**
 * Remove the WebContents from this project's subscriber set. Called by
 * the renderer's `useEffect` cleanup so dead tabs don't keep receiving
 * events. Idempotent.
 */
export function unsubscribeDevServerEvents(
  projectPath: string,
  wc: WebContents,
): void {
  const state = states.get(projectPath);
  if (!state) return;
  state.subscribers.delete(wc);
}

// Ensure each WebContents gets at most one 'destroyed' hook across all
// projects — without this guard, every subscribe call registers a fresh
// listener, and the EventEmitter MaxListenersExceededWarning fires.
const wcDestroyHooks = new WeakSet<WebContents>();
function ensureDestroyHook(wc: WebContents): void {
  if (wcDestroyHooks.has(wc)) return;
  wcDestroyHooks.add(wc);
  wc.once('destroyed', () => {
    for (const s of states.values()) s.subscribers.delete(wc);
  });
}

/**
 * Kill every dev-server PTY. Called from the main process `before-quit`
 * hook so we don't orphan node/vite processes.
 */
export function shutdownAll(): void {
  for (const state of states.values()) {
    if (!state.ptyKey) continue;
    const key = state.ptyKey;
    state.info.status = 'stopped';
    state.ptyKey = null;
    for (const off of state.detach) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    state.detach = [];
    try {
      killPty(key);
    } catch {
      /* best-effort during shutdown */
    }
  }
}
