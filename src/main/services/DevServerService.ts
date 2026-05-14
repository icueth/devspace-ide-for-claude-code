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
import * as fsSync from 'node:fs';
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
  DevServerInstallInput,
  DevServerInstallResult,
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

export interface FrameworkConfigFlags {
  viteConfig: boolean;
  nextConfig: boolean;
  astroConfig: boolean;
  remixConfig: boolean;
  sveltekitConfig: boolean;
  nuxtConfig: boolean;
  gatsbyConfig: boolean;
  angularConfig: boolean;
  vueCliConfig: boolean;
  storybookDir: boolean;
}

// Static-serve packages — when a project has none of the above frameworks
// but ships one of these as a dep we classify it as 'static' so the UI can
// at least offer the "run a static server" CTA.
const STATIC_SERVE_DEPS = ['serve', 'http-server', 'live-server', 'browser-sync'];

function hasAnyKey(deps: Record<string, string>, keys: string[]): boolean {
  for (const k of keys) if (k in deps) return true;
  return false;
}

function hasStorybookDep(deps: Record<string, string>): boolean {
  // Either the top-level meta package OR any @storybook/* scoped sub.
  if ('storybook' in deps) return true;
  for (const k of Object.keys(deps)) {
    if (k.startsWith('@storybook/')) return true;
  }
  return false;
}

/**
 * Classify a project as one of the supported dev-server kinds. Pure
 * function over the parsed package.json + a "config file present"
 * predicate — split out so unit tests can exercise it without touching
 * the filesystem.
 *
 * Order matters: more specific kinds first. Storybook is checked before
 * vite (Storybook 7+ uses Vite under the hood — we want the dedicated
 * "storybook" classification to win). CRA + generic 'static' are last
 * resorts so they never preempt a real framework.
 */
export function detectFramework(
  pkg: ParsedPackageJson | null,
  configFlags: FrameworkConfigFlags,
): DevServerKind {
  if (!pkg) return 'unknown';
  const allDeps: Record<string, string> = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };

  // ── Strong dep+config matches (specific frameworks) ──
  if ('next' in allDeps && configFlags.nextConfig) return 'next';
  if ('nuxt' in allDeps && configFlags.nuxtConfig) return 'nuxt';
  if ('gatsby' in allDeps && configFlags.gatsbyConfig) return 'gatsby';
  if ('@angular/core' in allDeps && configFlags.angularConfig) return 'angular';
  if ('@sveltejs/kit' in allDeps && configFlags.sveltekitConfig) return 'sveltekit';
  if ('@vue/cli-service' in allDeps && configFlags.vueCliConfig) return 'vue-cli';
  if ('astro' in allDeps && configFlags.astroConfig) return 'astro';

  // Storybook BEFORE vite — Storybook 7+ runs on Vite, but the user wants
  // "storybook dev" not "vite dev" in that case.
  if (hasStorybookDep(allDeps) && configFlags.storybookDir) return 'storybook';

  // Docusaurus + VitePress — doc-site generators with their own CLIs.
  if ('@docusaurus/core' in allDeps) return 'docusaurus';
  if ('vitepress' in allDeps) return 'vitepress';

  if ('vite' in allDeps && configFlags.viteConfig) return 'vite';
  if (
    '@remix-run/dev' in allDeps ||
    '@remix-run/react' in allDeps ||
    '@remix-run/serve' in allDeps
  ) {
    return 'remix';
  }

  // ── CRA — react-scripts alone is sufficient (no specific config file) ──
  if ('react-scripts' in allDeps) return 'cra';

  // ── Soft fallbacks (config exists without an obvious top-level dep) ──
  if (configFlags.nextConfig && ('next' in allDeps)) return 'next';
  if (configFlags.viteConfig) return 'vite';

  // ── Last resort: static-server dep ──
  if (hasAnyKey(allDeps, STATIC_SERVE_DEPS)) return 'static';

  return 'unknown';
}

// Frameworks where `start` is the PRODUCTION command, not a dev server.
// For these, falling back from `dev` → `start` would launch a script that
// requires a prior `build` step (e.g. `next start` fails without `.next/`)
// and leaves the Live Preview stuck. We return empty string instead so the
// UI can surface the "no dev script" empty state.
const PRODUCTION_START_KINDS: ReadonlySet<DevServerKind> = new Set<DevServerKind>([
  'next',
  'nuxt',
  'gatsby',
  'sveltekit',
  'docusaurus',
]);

/**
 * Pick which package-manager script to run. Priority is:
 *   1. explicit "dev" script
 *   2. explicit "start" script (EXCEPT for frameworks where `start` is the
 *      production entry — see PRODUCTION_START_KINDS above)
 *   3. first script whose body invokes the framework CLI with a dev-ish
 *      token
 * Returns an empty string when nothing matches.
 */
export function pickScriptName(
  scripts: Record<string, string> | undefined,
  kind: DevServerKind,
): string {
  if (!scripts) return '';
  if (typeof scripts.dev === 'string' && scripts.dev.trim() !== '') return 'dev';
  // Production-start frameworks: do NOT fall back to `start`. `next start`
  // / `nuxt start` / `gatsby serve` / `svelte-kit preview` / `docusaurus
  // serve` all require a build artifact and would crash with no URL.
  if (!PRODUCTION_START_KINDS.has(kind)) {
    if (typeof scripts.start === 'string' && scripts.start.trim() !== '') {
      return 'start';
    }
  }

  // Last resort — scan script bodies for the framework's CLI keyword
  // AND a dev-ish token (so we don't pick "build" scripts as dev
  // scripts, which would launch one-shot production builds that exit
  // without ever emitting a URL and leave status stuck on 'starting').
  const keyword = frameworkKeyword(kind);
  if (!keyword) return '';
  const isProductionStart = PRODUCTION_START_KINDS.has(kind);
  // `start` is a dev token by default, but production-start frameworks
  // need it removed — otherwise body-scanning `{ start: 'next start' }`
  // would still return the production script even after we blocked the
  // direct `start` fallback above.
  const DEV_TOKENS = isProductionStart
    ? ['dev', 'watch']
    : ['dev', 'serve', 'start', 'watch'];
  for (const [name, body] of Object.entries(scripts)) {
    if (typeof body !== 'string') continue;
    if (!body.includes(keyword)) continue;
    // Skip the literal `start` name for production-start kinds — we know
    // it's the production entry point regardless of body content.
    if (isProductionStart && name === 'start') continue;
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
    case 'sveltekit':
      return 'svelte';
    case 'nuxt':
      return 'nuxt';
    case 'gatsby':
      return 'gatsby';
    case 'angular':
      return 'ng';
    case 'vue-cli':
      return 'vue-cli-service';
    case 'cra':
      return 'react-scripts';
    case 'storybook':
      return 'storybook';
    case 'vitepress':
      return 'vitepress';
    case 'docusaurus':
      return 'docusaurus';
    case 'static':
      // generic static — match common runners
      return 'serve';
    default:
      return '';
  }
}

// Dev-script regex used for `candidateScripts` discovery in
// `detectDevServer`. Same DEV_TOKENS set as `pickScriptName`'s
// fallback path so the two stay consistent.
const DEV_TOKEN_RE = /\b(dev|serve|start|watch)\b/i;
// Keywords that disqualify a script as a dev server even if its name
// happens to match dev/serve/start (e.g. "start-storybook" is fine, but
// "build", "test", "lint", "format", "preview" — most preview commands
// are production-only — should not show up in the dropdown).
const NON_DEV_TOKEN_RE = /\b(build|test|lint|format|prettier|typecheck|tsc|eslint|jest|vitest|playwright|cypress|deploy|release|publish)\b/i;
const CANDIDATE_SCRIPTS_CAP = 8;

/** Extracted helper for the unit test. */
export function pickCandidateScripts(
  scripts: Record<string, string> | undefined,
): Array<{ name: string; body: string }> {
  if (!scripts) return [];
  const out: Array<{ name: string; body: string }> = [];
  for (const [name, body] of Object.entries(scripts)) {
    if (typeof body !== 'string') continue;
    if (NON_DEV_TOKEN_RE.test(name) || NON_DEV_TOKEN_RE.test(body)) continue;
    if (!DEV_TOKEN_RE.test(name) && !DEV_TOKEN_RE.test(body)) continue;
    out.push({ name, body });
    if (out.length >= CANDIDATE_SCRIPTS_CAP) break;
  }
  return out;
}

/** Best-effort preflight: does node_modules/ exist at the project root? */
export function hasNodeModulesSync(projectPath: string): boolean {
  // `lstatSync` so we don't follow symlinks blindly — pnpm uses a content
  // store, but pnpm's workspace `node_modules/` is still a real directory
  // (or a directory-symlink) at the project root. Either way `lstat`
  // succeeds if the entry exists at all. We don't care if it's a dir or
  // a symlink — the install command would have created exactly one of
  // those, so existence is the signal.
  try {
    fsSync.lstatSync(path.join(projectPath, 'node_modules'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Top-level detection — combines package.json + config-file checks and
 * picks a script name. Also computes preflight info (node_modules
 * presence + detected package manager) and a list of candidate dev
 * scripts the UI can offer in a dropdown for monorepos.
 */
export async function detectDevServer(projectPath: string): Promise<DevServerInfo> {
  const pkg = await readPackageJson(projectPath);
  const [
    viteConfig,
    nextConfig,
    astroConfig,
    remixConfig,
    sveltekitConfig,
    nuxtConfig,
    gatsbyConfig,
    angularConfig,
    vueCliConfig,
    storybookDir,
  ] = await Promise.all([
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
    hasFile(projectPath, [
      'svelte.config.js',
      'svelte.config.ts',
      'svelte.config.mjs',
    ]),
    hasFile(projectPath, [
      'nuxt.config.ts',
      'nuxt.config.js',
      'nuxt.config.mjs',
    ]),
    hasFile(projectPath, [
      'gatsby-config.ts',
      'gatsby-config.js',
      'gatsby-config.mjs',
    ]),
    hasFile(projectPath, ['angular.json']),
    hasFile(projectPath, [
      'vue.config.ts',
      'vue.config.js',
      'vue.config.mjs',
    ]),
    // .storybook is a directory — `fs.access` works on dirs too.
    hasFile(projectPath, ['.storybook']),
  ]);
  const kind = detectFramework(pkg, {
    viteConfig,
    nextConfig,
    astroConfig,
    remixConfig,
    sveltekitConfig,
    nuxtConfig,
    gatsbyConfig,
    angularConfig,
    vueCliConfig,
    storybookDir,
  });
  const scriptName = pickScriptName(pkg?.scripts, kind);
  const candidateScripts = pickCandidateScripts(pkg?.scripts);
  const packageManager = await detectPackageManager(projectPath);
  const hasNodeModules = hasNodeModulesSync(projectPath);
  return {
    kind,
    scriptName,
    url: null,
    status: 'idle',
    logTail: [],
    preflight: { hasNodeModules, packageManager },
    candidateScripts: candidateScripts.length > 0 ? candidateScripts : undefined,
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
 * Try to parse a URL and accept it only if it points at the loopback
 * interface (localhost OR 127.0.0.1) on a non-privileged port with no
 * userinfo. Returns the normalized origin with the hostname rewritten to
 * "localhost" so downstream renderer code can do a single string compare.
 *
 * Rejects: non-http(s), 0.0.0.0, any non-loopback IPv4/IPv6, port 0,
 * port > 65535, userinfo (user:pass@), and paths/queries/fragments —
 * we navigate to the bare origin so attacker-controlled paths can't
 * influence the first webview request.
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
  // Accept both literal "localhost" and the IPv4 loopback. We deliberately
  // do NOT accept ::1 (IPv6 loopback) — Chromium's <webview> mounts the
  // hostname verbatim, and some users have IPv6 disabled on the loopback
  // interface, so accepting ::1 would silently break those installs.
  const isLoopback = host === 'localhost' || host === '127.0.0.1';
  if (!isLoopback) return null;
  if (u.username || u.password) return null;
  const port = Number(u.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  // Rewrite to "localhost" so the rest of the app sees a single canonical
  // form (so equality checks and cache keys stay stable).
  return `${u.protocol}//localhost:${u.port}`;
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

// Track in-flight `pm install` PTYs separately from the dev-server map —
// we need to kill them on workspace close / app quit, but they aren't
// part of the DevServerInfo lifecycle the renderer subscribes to.
const installSessions = new Map<string, { ptyKey: string; detach: Array<() => void> }>();

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
// Permits `/`, `:`, `.`, `@` so monorepo conventions like `apps/web:dev`,
// `@app/web:dev`, and `web/dev` work. The package.json whitelist below
// is the real trust boundary — this regex just kills obviously hostile
// shell metacharacters (spaces, quotes, $, `, ;, |, &, etc.).
const SCRIPT_NAME_RE = /^[A-Za-z0-9_:.@/-]{1,120}$/;
const ALLOWED_PACKAGE_MANAGERS = new Set(['pnpm', 'yarn', 'npm', 'bun']);
const ALLOWED_KINDS = new Set<DevServerKind>([
  'vite',
  'next',
  'astro',
  'remix',
  'sveltekit',
  'nuxt',
  'gatsby',
  'angular',
  'vue-cli',
  'cra',
  'storybook',
  'vitepress',
  'docusaurus',
  'static',
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

  // ── Manual URL mode: user supplied a URL of an already-running server. ──
  // Skip PTY spawn entirely. Validate against the SAME loopback allowlist
  // as the auto-detected URLs so a misbehaving renderer can't point the
  // webview at a LAN address or external host.
  if (typeof input.manualUrl === 'string' && input.manualUrl !== '') {
    const accepted = tryParseLocalUrl(input.manualUrl);
    if (!accepted) {
      state.info = {
        ...state.info,
        status: 'error',
        errorMessage:
          'manual URL must be a localhost or 127.0.0.1 origin (no path, no LAN IP)',
      };
      emit(state, 'status_changed', {
        status: 'error',
        message: state.info.errorMessage,
      });
      return cloneInfo(state.info);
    }
    // Refresh detection so kind / preflight are populated for the UI.
    const detected = await detectDevServer(state.projectPath);
    state.info = {
      ...state.info,
      kind: detected.kind,
      scriptName: detected.scriptName,
      preflight: detected.preflight,
      candidateScripts: detected.candidateScripts,
      url: accepted,
      status: 'running',
      manualUrl: true,
      errorMessage: undefined,
      startedAt: Date.now(),
      logTail: [],
      ptyId: undefined,
    };
    state.ptyKey = null;
    state.lineBuffer = '';
    state.urlEmitted = true; // suppress the 30s fallback timer logic
    if (state.startTimer) {
      clearTimeout(state.startTimer);
      state.startTimer = undefined;
    }
    emit(state, 'status_changed', {
      status: 'running',
      url: accepted,
    });
    emit(state, 'url_resolved', { url: accepted, status: 'running' });
    return cloneInfo(state.info);
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

  // Reset transient run state. `manualUrl` is explicitly cleared — a
  // PTY spawn is the opposite of manual mode, even if the previous run
  // for this project was manual.
  state.info = {
    kind,
    scriptName,
    url: null,
    status: 'starting',
    logTail: [],
    startedAt: Date.now(),
    manualUrl: false,
    preflight: state.info.preflight,
    candidateScripts: state.info.candidateScripts,
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
 *
 * Manual-URL mode has no PTY to kill; in that case we just clear state
 * and emit a 'stopped' transition so the UI can collapse the webview.
 */
export async function stopDevServer(projectPath: string): Promise<DevServerInfo> {
  const state = getState(projectPath);
  // Manual URL: just clear state — there's no PTY to terminate.
  if (state.info.manualUrl) {
    state.info = {
      ...state.info,
      status: 'stopped',
      url: null,
      manualUrl: false,
      errorMessage: undefined,
    };
    emit(state, 'status_changed', { status: 'stopped', url: null });
    return cloneInfo(state.info);
  }
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
    await killPty(key);
  } catch (err) {
    logger.warn(`killPty(${key}) failed: ${(err as Error).message}`);
  }

  return cloneInfo(state.info);
}

/**
 * Re-run detection only — does NOT touch a running PTY. Used by the
 * toolbar "Refresh" button when the user has added a config file or
 * installed dependencies in another terminal and wants the UI to catch
 * up without restarting the server.
 *
 * For a running/starting server we update detection-derived fields only
 * (kind, scriptName, candidateScripts, preflight). Status, url, ptyId,
 * logTail are all preserved so the live state survives the refresh.
 */
export async function refreshDevServer(projectPath: string): Promise<DevServerInfo> {
  if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)) {
    throw new Error('refreshDevServer requires an absolute projectPath');
  }
  if (projectPath.split(/[\\/]/).some((seg) => seg === '..')) {
    throw new Error('projectPath must not contain ..');
  }
  const state = getState(projectPath);
  const detected = await detectDevServer(state.projectPath);
  if (state.info.status === 'running' || state.info.status === 'starting') {
    // Preserve live fields. Only update what detection produces.
    state.info = {
      ...state.info,
      kind: detected.kind,
      // Don't clobber a running scriptName — the user may have manually
      // picked a script and we shouldn't second-guess that.
      scriptName: state.info.scriptName || detected.scriptName,
      candidateScripts: detected.candidateScripts,
      preflight: detected.preflight,
    };
  } else {
    // Idle/stopped/error — merge fresh detection in, but preserve user
    // intent that detection can't reproduce: previous logTail (so the
    // failure that led them to refresh is still visible), the manualUrl
    // flag (user explicitly pasted a URL — that doesn't get unset by a
    // detection run), and the user-picked scriptName when it differs
    // from what detection would suggest. v0.16.0 review-fix.
    const preservedScript =
      state.info.scriptName &&
      state.info.scriptName !== detected.scriptName &&
      !!detected.candidateScripts?.some((c) => c.name === state.info.scriptName);
    state.info = {
      ...detected,
      logTail: state.info.logTail,
      errorMessage: state.info.status === 'error' ? state.info.errorMessage : undefined,
      status: state.info.status === 'error' ? 'error' : detected.status,
      // Preserve user-picked script only when it's still valid (exists in
      // the fresh candidateScripts list). If they renamed it in
      // package.json since last pick, fall through to detected default.
      scriptName: preservedScript ? state.info.scriptName : detected.scriptName,
      // Preserve manualUrl flag — detection has no way to express it.
      ...(state.info.manualUrl ? { manualUrl: state.info.manualUrl } : {}),
    };
  }
  emit(state, 'status_changed', {
    status: state.info.status,
    url: state.info.url,
    message: state.info.errorMessage,
  });
  return cloneInfo(state.info);
}

/**
 * Run `<pm> install` in a managed PTY. Used by the "Install dependencies"
 * CTA in the Live Preview empty state when the preflight check finds no
 * `node_modules/`. Streams `install_progress` events with each line of
 * output so the UI can show a progress pill, and resolves once the
 * underlying PTY exits.
 *
 * Validation: `projectPath` must be absolute and free of `..` segments.
 * `packageManager` (when supplied) must be in the allowlist. Resolves
 * with `{ ok: false, errorMessage }` on non-zero exit instead of
 * throwing — the renderer should surface the message, not blow up.
 */
export async function installDependencies(
  input: DevServerInstallInput,
): Promise<DevServerInstallResult> {
  if (!input || typeof input !== 'object') {
    throw new Error('installDependencies requires an input object');
  }
  const { projectPath } = input;
  if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)) {
    throw new Error('installDependencies requires an absolute projectPath');
  }
  if (projectPath.split(/[\\/]/).some((seg) => seg === '..')) {
    throw new Error('projectPath must not contain ..');
  }
  // Normalize + verify it exists. We don't want to spawn `pm install` in
  // a directory the user no longer has — pm tools would happily create a
  // package.json in an empty parent and clutter the filesystem.
  const resolved = path.resolve(projectPath);
  try {
    const st = fsSync.lstatSync(resolved);
    if (!st.isDirectory() && !st.isSymbolicLink()) {
      throw new Error(`projectPath is not a directory: ${resolved}`);
    }
  } catch (err) {
    throw new Error(`projectPath does not exist: ${resolved} (${(err as Error).message})`);
  }
  if (input.packageManager !== undefined) {
    if (
      typeof input.packageManager !== 'string' ||
      !ALLOWED_PACKAGE_MANAGERS.has(input.packageManager)
    ) {
      throw new Error('invalid packageManager');
    }
  }
  // Reject parallel installs for the same project — pm tools serialize
  // poorly on the same lockfile and the second invocation would clobber
  // node_modules mid-extract. v0.16.0 review-fix: claim the slot
  // SYNCHRONOUSLY before any await so two concurrent calls (e.g. a
  // double-clicked Install button) can't both pass the `.has()` check.
  if (installSessions.has(resolved)) {
    throw new Error('install already in progress for this project');
  }
  installSessions.set(resolved, { ptyKey: '__pending__', detach: [] });

  let packageManager: 'pnpm' | 'yarn' | 'npm' | 'bun';
  let state: ProjectState;
  let session: Awaited<ReturnType<typeof createPty>>;
  const startedAt = Date.now();

  try {
    packageManager = input.packageManager ?? (await detectPackageManager(resolved));
    state = getState(resolved);
    emit(state, 'install_progress', { status: 'starting' });

    session = await createPty({
      projectId: resolved,
      // 'install' kind keeps it separate from the dev-server PTY so the
      // pool key collision logic doesn't conflate the two.
      kind: 'install',
      // tabId disambiguates from the dev-server tabId which is `resolved`
      // alone. Using a `#install` suffix means the PtyPool key is unique.
      tabId: `${resolved}#install`,
      cwd: resolved,
      command: packageManager,
      args: ['install'],
      cols: 120,
      rows: 32,
    });
  } catch (err) {
    installSessions.delete(resolved);
    const message = `failed to spawn install: ${(err as Error).message}`;
    try {
      emit(getState(resolved), 'install_progress', { status: 'error', message });
    } catch {
      /* state might not exist yet; nothing to emit to */
    }
    return {
      ok: false,
      errorMessage: message,
      durationMs: Date.now() - startedAt,
    };
  }

  const tailLines: string[] = [];
  const TAIL_MAX = 40;
  let lineBuffer = '';

  return new Promise<DevServerInstallResult>((resolve) => {
    const detachData = subscribeData(session.sessionId, (chunk) => {
      const combined = lineBuffer + chunk;
      const parts = combined.split(/\r?\n/);
      lineBuffer = parts.pop() ?? '';
      for (const raw of parts) {
        if (!raw) continue;
        const clean = stripAnsi(raw).replace(/\r$/, '');
        if (!clean) continue;
        tailLines.push(clean);
        if (tailLines.length > TAIL_MAX) tailLines.shift();
        emit(state, 'install_progress', { status: 'running', line: clean });
      }
    });
    const detachExit = subscribeExit(session.sessionId, (code) => {
      try {
        detachData();
      } catch {
        /* ignore */
      }
      installSessions.delete(resolved);
      const ok = code === 0;
      const durationMs = Date.now() - startedAt;
      if (ok) {
        emit(state, 'install_progress', { status: 'running', message: 'install complete' });
        // Recompute preflight so the UI immediately reflects the fresh
        // node_modules/ without an explicit refresh call.
        state.info = {
          ...state.info,
          preflight: {
            hasNodeModules: hasNodeModulesSync(resolved),
            packageManager,
          },
        };
        emit(state, 'status_changed', {
          status: state.info.status,
          url: state.info.url,
          message: state.info.errorMessage,
        });
        resolve({ ok: true, durationMs });
      } else {
        const errorMessage =
          tailLines.length > 0
            ? `${packageManager} install failed (code ${code}):\n${tailLines.join('\n')}`
            : `${packageManager} install failed (code ${code})`;
        emit(state, 'install_progress', { status: 'error', message: errorMessage });
        resolve({ ok: false, errorMessage, durationMs });
      }
    });
    installSessions.set(resolved, {
      ptyKey: session.sessionId,
      detach: [detachData, detachExit],
    });
  });
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
 * Kill every dev-server + install PTY for a single project. Used when a
 * workspace is closed — we don't want stale `pm install` or `vite dev`
 * processes outliving the workspace that owns them.
 */
export async function shutdownProject(projectPath: string): Promise<void> {
  if (typeof projectPath !== 'string') return;
  const resolved = path.resolve(projectPath);
  const kills: Array<Promise<void>> = [];
  const state = states.get(resolved);
  if (state && state.ptyKey) {
    const key = state.ptyKey;
    state.info = { ...state.info, status: 'stopped', url: null, ptyId: undefined };
    state.ptyKey = null;
    if (state.startTimer) {
      clearTimeout(state.startTimer);
      state.startTimer = undefined;
    }
    for (const off of state.detach) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    state.detach = [];
    kills.push(killPty(key).catch(() => undefined));
  }
  const inst = installSessions.get(resolved);
  if (inst) {
    installSessions.delete(resolved);
    for (const off of inst.detach) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    kills.push(killPty(inst.ptyKey).catch(() => undefined));
  }
  await Promise.all(kills);
}

/**
 * Kill every dev-server PTY. Called from the main process `before-quit`
 * hook so we don't orphan node/vite processes. Awaits each kill so the
 * caller can block until the entire dev-server tree is gone (or its
 * per-kill timeout lapses). Also tears down in-flight install PTYs.
 */
export async function shutdownAll(): Promise<void> {
  const kills: Array<Promise<void>> = [];
  for (const state of states.values()) {
    if (!state.ptyKey) continue;
    const key = state.ptyKey;
    state.info.status = 'stopped';
    state.ptyKey = null;
    if (state.startTimer) {
      clearTimeout(state.startTimer);
      state.startTimer = undefined;
    }
    for (const off of state.detach) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    state.detach = [];
    kills.push(killPty(key).catch(() => undefined));
  }
  for (const [resolved, inst] of installSessions.entries()) {
    for (const off of inst.detach) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    kills.push(killPty(inst.ptyKey).catch(() => undefined));
    installSessions.delete(resolved);
  }
  await Promise.all(kills);
}
