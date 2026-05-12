// ProjectProfileBuilder — v0.10 auto-detected snapshot of the project's
// design surface. Reads `package.json` + lockfiles + tsconfig + style
// signals and returns a `ProjectDesignProfile` (or `null` when no
// `package.json` is present). Cached on disk under
// `<project>/.devspace/design/profile.json`; invalidation is a cheap
// mtime check against `package.json` so unchanged projects skip the
// walk entirely.
//
// The profile gets injected into every generation prompt as a
// "## Project Context" section so the model produces output that fits
// the framework + styling stack the user already builds with.
//
// Pure-ish: the builder reads from disk but does not mutate any state
// outside of the cache file. Returns `null` for "no package.json" so
// the caller (DesignService) can simply skip injection.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createLogger } from '@shared/logger';
import type {
  DevServerKind,
  ProjectDesignProfile,
  ProjectProfileBuildInput,
  StyleAdapterKind,
} from '@shared/design';

const logger = createLogger('ProjectProfileBuilder');

// Cap walk depth + breadth so a giant monorepo can't stall startup.
// We sample a shallow slice of `src/` looking for `*.module.css` /
// plain `.css` imports — enough to fingerprint the styling stack.
const MAX_SOURCE_FILES_SCANNED = 200;
const MAX_WALK_DEPTH = 4;

// Cap the rendered summary at 2 KB so we never balloon the prompt.
const SUMMARY_MAX_BYTES = 2 * 1024;

type PackageManager = ProjectDesignProfile['packageManager'];

interface ParsedPackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  // Some projects pin a manager here (Corepack convention).
  packageManager?: string;
}

// Public ───────────────────────────────────────────────────────────────────

/**
 * Build a fresh profile, writing the result to the on-disk cache.
 * Returns `null` when no `package.json` exists at the project root —
 * profile detection only makes sense for Node projects.
 */
export async function buildProjectProfile(
  input: ProjectProfileBuildInput,
): Promise<ProjectDesignProfile | null> {
  const projectPath = path.resolve(input.projectPath);
  // When force=true, drop the cache file BEFORE rebuilding so a poisoned
  // profile.json can be evicted by the user via the "Refresh" button.
  // The contract on ProjectProfileBuildInput documents this — the
  // previous implementation accepted force but did nothing with it.
  if (input.force) {
    try {
      await fs.unlink(profileCacheFile(projectPath));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.warn(`failed to drop profile cache before rebuild: ${(err as Error).message}`);
      }
    }
  }
  const pkg = await readPackageJson(projectPath);
  if (!pkg) return null;

  const evidence: string[] = ['package.json'];

  const framework = await detectFrameworkFromDisk(projectPath, pkg, evidence);
  const styling = await detectStylingStack(projectPath, pkg, evidence);
  const packageManager = await detectPackageManager(projectPath, pkg, evidence);
  const typescript = await hasFile(projectPath, ['tsconfig.json']);
  if (typescript) evidence.push('tsconfig.json');

  const monorepo = await detectMonorepo(projectPath, evidence);

  const summary = renderSummary({
    framework,
    styling,
    typescript,
    packageManager,
    monorepo,
    notable: await collectNotableSignals(projectPath, evidence),
  });

  const profile: ProjectDesignProfile = {
    projectPath,
    framework,
    styling,
    packageManager,
    typescript,
    summary,
    evidence,
    builtAt: Date.now(),
  };

  await writeProfileCache(projectPath, profile).catch((err) => {
    logger.warn(`failed to cache profile: ${(err as Error).message}`);
  });
  return profile;
}

/**
 * Return the cached profile when valid, otherwise rebuild + cache. The
 * cache is invalidated when `package.json`'s mtime is newer than the
 * cached `builtAt`. Callers should treat `null` as "no profile available
 * (no package.json)" — they pass `null` to the prompt builder and we
 * simply don't inject a Project Context section.
 */
export async function loadCachedOrBuild(
  projectPath: string,
): Promise<ProjectDesignProfile | null> {
  const cached = await readProfileCache(projectPath).catch(() => null);
  if (cached) {
    const fresh = await isCacheFresh(projectPath, cached).catch(() => false);
    if (fresh) return cached;
  }
  return buildProjectProfile({ projectPath });
}

// Filesystem helpers ──────────────────────────────────────────────────────

function profileCacheFile(projectPath: string): string {
  return path.join(projectPath, '.devspace', 'design', 'profile.json');
}

// Strict schema validators. The cache file is user-writable (and may be
// checked into a repo / synced via cloud), so its contents must be
// treated as untrusted input — every field that flows into a prompt or
// IPC response is validated against an explicit allowlist. A future-
// stamped builtAt is also rejected to prevent indefinite cache lock.
const VALID_FRAMEWORKS: ReadonlySet<string> = new Set([
  'vite', 'next', 'astro', 'remix', 'unknown',
]);
const VALID_STYLINGS: ReadonlySet<string> = new Set([
  'tailwind', 'vanilla-css', 'styled-components', 'css-modules', 'unknown',
]);
const VALID_PMS: ReadonlySet<string> = new Set(['pnpm', 'yarn', 'npm', 'bun']);
const CACHE_SUMMARY_MAX_BYTES = 4096;
const CACHE_EVIDENCE_MAX_ITEMS = 50;
const CACHE_EVIDENCE_ITEM_MAX_LEN = 256;

async function readProfileCache(
  projectPath: string,
): Promise<ProjectDesignProfile | null> {
  const file = profileCacheFile(projectPath);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Partial<ProjectDesignProfile>;
  if (typeof p.projectPath !== 'string') return null;
  if (typeof p.builtAt !== 'number' || !Number.isFinite(p.builtAt)) return null;
  // Reject future-stamped caches (clock skew or tampering). 1 minute
  // tolerance for legitimate clock drift across NTP syncs.
  if (p.builtAt > Date.now() + 60_000) return null;
  if (typeof p.framework !== 'string' || !VALID_FRAMEWORKS.has(p.framework)) return null;
  if (typeof p.styling !== 'string' || !VALID_STYLINGS.has(p.styling)) return null;
  if (typeof p.packageManager !== 'string' || !VALID_PMS.has(p.packageManager)) return null;
  if (typeof p.typescript !== 'boolean') return null;
  if (typeof p.summary !== 'string') return null;
  if (Buffer.byteLength(p.summary, 'utf8') > CACHE_SUMMARY_MAX_BYTES) return null;
  if (!Array.isArray(p.evidence)) return null;
  if (p.evidence.length > CACHE_EVIDENCE_MAX_ITEMS) return null;
  for (const item of p.evidence) {
    if (typeof item !== 'string') return null;
    if (item.length > CACHE_EVIDENCE_ITEM_MAX_LEN) return null;
  }
  // All fields validated — coerce to known type and return.
  return {
    projectPath: p.projectPath,
    framework: p.framework as ProjectDesignProfile['framework'],
    styling: p.styling as ProjectDesignProfile['styling'],
    packageManager: p.packageManager as ProjectDesignProfile['packageManager'],
    typescript: p.typescript,
    summary: p.summary,
    evidence: p.evidence,
    builtAt: p.builtAt,
  };
}

async function writeProfileCache(
  projectPath: string,
  profile: ProjectDesignProfile,
): Promise<void> {
  const file = profileCacheFile(projectPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await fs.writeFile(tmp, JSON.stringify(profile, null, 2));
  await fs.rename(tmp, file);
}

async function isCacheFresh(
  projectPath: string,
  cached: ProjectDesignProfile,
): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(projectPath, 'package.json'));
    return stat.mtimeMs <= cached.builtAt;
  } catch {
    return false;
  }
}

async function readPackageJson(
  projectPath: string,
): Promise<ParsedPackageJson | null> {
  try {
    const raw = await fs.readFile(path.join(projectPath, 'package.json'), 'utf8');
    return JSON.parse(raw) as ParsedPackageJson;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn(`failed to read package.json: ${(err as Error).message}`);
    }
    return null;
  }
}

async function hasFile(projectPath: string, candidates: string[]): Promise<boolean> {
  const root = path.resolve(projectPath);
  for (const file of candidates) {
    try {
      const target = path.resolve(root, file);
      // Reject path-traversal candidates and symlinks. lstat (not stat)
      // so we see the symlink itself rather than its resolution.
      if (!target.startsWith(root + path.sep) && target !== root) continue;
      const st = await fs.lstat(target);
      if (st.isSymbolicLink()) continue;
      return true;
    } catch {
      /* keep scanning */
    }
  }
  return false;
}

// Framework detection ─────────────────────────────────────────────────────

async function detectFrameworkFromDisk(
  projectPath: string,
  pkg: ParsedPackageJson,
  evidence: string[],
): Promise<DevServerKind> {
  const allDeps: Record<string, string> = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };
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

  if ('next' in allDeps && (nextConfig || (await hasFile(projectPath, ['app', 'pages'])))) {
    evidence.push(nextConfig ? 'next.config.*' : 'next dep');
    return 'next';
  }
  if ('astro' in allDeps && astroConfig) {
    evidence.push('astro.config.*');
    return 'astro';
  }
  if ('vite' in allDeps && viteConfig) {
    evidence.push('vite.config.*');
    return 'vite';
  }
  if (
    '@remix-run/dev' in allDeps ||
    '@remix-run/react' in allDeps ||
    '@remix-run/serve' in allDeps
  ) {
    evidence.push('@remix-run/*');
    return 'remix';
  }
  // Soft fallbacks.
  if (nextConfig && 'next' in allDeps) {
    evidence.push('next.config.*');
    return 'next';
  }
  if (viteConfig) {
    evidence.push('vite.config.*');
    return 'vite';
  }
  if (remixConfig) {
    evidence.push('remix.config.*');
    return 'remix';
  }
  return 'unknown';
}

// Styling detection ───────────────────────────────────────────────────────

async function detectStylingStack(
  projectPath: string,
  pkg: ParsedPackageJson,
  evidence: string[],
): Promise<StyleAdapterKind | 'unknown'> {
  const allDeps: Record<string, string> = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };

  // Tailwind — multiple signals (config file, dep, postcss plugin, v4 globals
  // with `@import "tailwindcss"`).
  const hasTailwindConfig = await hasFile(projectPath, [
    'tailwind.config.ts',
    'tailwind.config.js',
    'tailwind.config.mjs',
    'tailwind.config.cjs',
  ]);
  const hasTailwindDep =
    'tailwindcss' in allDeps || '@tailwindcss/postcss' in allDeps;
  const hasTailwindV4Import = await sniffTailwindV4Import(projectPath);
  if (hasTailwindConfig || hasTailwindDep || hasTailwindV4Import) {
    if (hasTailwindConfig) evidence.push('tailwind.config.*');
    else if (hasTailwindDep) evidence.push('tailwindcss dep');
    else evidence.push('@import "tailwindcss"');
    return 'tailwind';
  }

  if ('styled-components' in allDeps) {
    evidence.push('styled-components dep');
    return 'styled-components';
  }

  // CSS Modules / vanilla — shallow walk under `src/` (or project root if no
  // src) looking for `*.module.css` files first; otherwise any plain `.css`.
  const stylingSignal = await sniffSourceStyling(projectPath);
  if (stylingSignal === 'css-modules') {
    evidence.push('*.module.css present');
    return 'css-modules';
  }
  if (stylingSignal === 'vanilla-css') {
    evidence.push('plain .css present');
    return 'vanilla-css';
  }
  return 'unknown';
}

// Look for `@import "tailwindcss"` or `@import 'tailwindcss'` in common
// global-css spots. Tailwind v4 ditched the JS config; this is often the
// only signal in fresh v4 setups.
async function sniffTailwindV4Import(projectPath: string): Promise<boolean> {
  const candidates = [
    'src/app/globals.css',
    'app/globals.css',
    'src/styles/globals.css',
    'styles/globals.css',
    'src/index.css',
    'src/main.css',
  ];
  for (const rel of candidates) {
    try {
      const txt = await fs.readFile(path.join(projectPath, rel), 'utf8');
      if (/@import\s+["']tailwindcss["']/.test(txt)) return true;
    } catch {
      /* missing, continue */
    }
  }
  return false;
}

// Shallow walk for `*.module.css` (winning) vs. plain `.css` (consolation).
// Bails after MAX_SOURCE_FILES_SCANNED entries inspected so a giant monorepo
// can't stall startup. Walks `src/` first, then project root as fallback.
async function sniffSourceStyling(
  projectPath: string,
): Promise<'css-modules' | 'vanilla-css' | null> {
  const roots = ['src', 'app', 'pages', 'components', '.'];
  let scanned = 0;
  let foundPlainCss = false;
  for (const rel of roots) {
    const root = path.join(projectPath, rel);
    const result = await walkForCss(root, MAX_WALK_DEPTH, () => {
      scanned += 1;
      return scanned >= MAX_SOURCE_FILES_SCANNED;
    });
    if (result.foundModule) return 'css-modules';
    if (result.foundPlain) foundPlainCss = true;
    if (scanned >= MAX_SOURCE_FILES_SCANNED) break;
  }
  return foundPlainCss ? 'vanilla-css' : null;
}

interface WalkResult {
  foundModule: boolean;
  foundPlain: boolean;
}

async function walkForCss(
  dir: string,
  depth: number,
  onEntry: () => boolean, // returns true when caller wants to bail
): Promise<WalkResult> {
  const result: WalkResult = { foundModule: false, foundPlain: false };
  if (depth < 0) return result;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const e of entries) {
    // Skip noise.
    if (e.name.startsWith('.')) continue;
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'build') continue;
    // Skip symlinks — a malicious project containing `src/escape -> /`
    // would otherwise let us probe the host filesystem outside the
    // project root. Symlinks to legitimate same-project content are
    // rare enough that this restriction is worth the safety.
    if (e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = await walkForCss(full, depth - 1, onEntry);
      if (sub.foundModule) result.foundModule = true;
      if (sub.foundPlain) result.foundPlain = true;
      if (result.foundModule) return result;
    } else if (e.isFile()) {
      const bail = onEntry();
      if (e.name.endsWith('.module.css')) {
        result.foundModule = true;
        return result;
      }
      if (e.name.endsWith('.css')) {
        result.foundPlain = true;
      }
      if (bail) return result;
    }
  }
  return result;
}

// Package manager detection ───────────────────────────────────────────────

export async function detectPackageManager(
  projectPath: string,
  pkg: ParsedPackageJson | null,
  evidence: string[],
): Promise<PackageManager> {
  // Honor a Corepack-style hint when present.
  if (pkg?.packageManager) {
    const hint = pkg.packageManager.split('@')[0];
    if (hint === 'pnpm' || hint === 'yarn' || hint === 'npm' || hint === 'bun') {
      evidence.push(`packageManager: ${hint}`);
      return hint;
    }
  }
  const candidates: Array<[string, PackageManager]> = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
    ['package-lock.json', 'npm'],
  ];
  for (const [file, pm] of candidates) {
    if (await hasFile(projectPath, [file])) {
      evidence.push(file);
      return pm;
    }
  }
  return 'npm';
}

async function detectMonorepo(projectPath: string, evidence: string[]): Promise<boolean> {
  for (const file of ['pnpm-workspace.yaml', 'turbo.json', 'nx.json', 'lerna.json']) {
    if (await hasFile(projectPath, [file])) {
      evidence.push(file);
      return true;
    }
  }
  return false;
}

async function collectNotableSignals(
  projectPath: string,
  evidence: string[],
): Promise<string[]> {
  const notable: string[] = [];
  if (await hasFile(projectPath, ['pnpm-workspace.yaml'])) {
    notable.push('monorepo (pnpm workspace)');
  } else if (await hasFile(projectPath, ['turbo.json'])) {
    notable.push('Turborepo monorepo');
  } else if (await hasFile(projectPath, ['nx.json'])) {
    notable.push('Nx monorepo');
  }
  if (await hasFile(projectPath, ['biome.json', 'biome.jsonc'])) {
    notable.push('Biome linter');
    evidence.push('biome.json');
  } else if (await hasFile(projectPath, ['.eslintrc', '.eslintrc.json', '.eslintrc.js', 'eslint.config.js', 'eslint.config.mjs'])) {
    notable.push('ESLint');
  }
  if (await hasFile(projectPath, ['prettier.config.js', '.prettierrc', '.prettierrc.json'])) {
    notable.push('Prettier');
  }
  return notable;
}

// Summary rendering ───────────────────────────────────────────────────────

interface SummaryInput {
  framework: DevServerKind;
  styling: StyleAdapterKind | 'unknown';
  typescript: boolean;
  packageManager: PackageManager;
  monorepo: boolean;
  notable: string[];
}

function frameworkLabel(kind: DevServerKind): string {
  switch (kind) {
    case 'next':
      return 'Next.js';
    case 'vite':
      return 'Vite';
    case 'astro':
      return 'Astro';
    case 'remix':
      return 'Remix';
    default:
      return 'Unknown framework';
  }
}

function stylingLabel(s: StyleAdapterKind | 'unknown'): string {
  switch (s) {
    case 'tailwind':
      return 'Tailwind CSS';
    case 'vanilla-css':
      return 'Plain CSS';
    case 'styled-components':
      return 'styled-components';
    case 'css-modules':
      return 'CSS Modules';
    default:
      return 'Unknown';
  }
}

function renderSummary(input: SummaryInput): string {
  const lines: string[] = [];
  lines.push(`- Framework: ${frameworkLabel(input.framework)}`);
  lines.push(`- Styling: ${stylingLabel(input.styling)}`);
  lines.push(`- Language: ${input.typescript ? 'TypeScript' : 'JavaScript'}`);
  lines.push(`- Package manager: ${input.packageManager}`);
  if (input.notable.length > 0) {
    lines.push(`- Notable: ${input.notable.join(', ')}`);
  }
  const out = lines.join('\n');
  if (Buffer.byteLength(out, 'utf8') <= SUMMARY_MAX_BYTES) return out;
  // Hard cap — slice as bytes (truncate at boundary).
  return out.slice(0, SUMMARY_MAX_BYTES - 16) + '\n…[truncated]';
}
