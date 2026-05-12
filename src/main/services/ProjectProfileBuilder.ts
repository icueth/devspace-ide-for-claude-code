// ProjectProfileBuilder — auto-detected snapshot of the project's design
// surface. Reads `package.json` + lockfiles + tsconfig + style signals +
// (v0.13) README/Tailwind tokens/component inventory and returns a
// `ProjectDesignProfile` (or `null` when no `package.json` is present).
// Cached on disk under `<project>/.devspace/design/profile.json`;
// invalidation is a fingerprint comparison over every file the builder
// actually read so edits to tailwind.config / globals.css / README also
// bust the cache.
//
// The profile gets injected into every generation prompt as a
// "## Project Context" section so the model produces output that fits
// the framework + styling stack the user already builds with.
//
// Pure-ish: the builder reads from disk but does not mutate any state
// outside of the cache file. Returns `null` for "no package.json" so
// the caller (DesignService) can simply skip injection.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createLogger } from '@shared/logger';
import type {
  ComponentInventoryEntry,
  DesignTokens,
  DevServerKind,
  FrameworkVariant,
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

// v0.13: file-size caps for the new readers. We refuse anything larger
// rather than truncating — a 10 MB README is almost certainly noise
// and we'd rather have no excerpt than a meaningless one.
const TAILWIND_CONFIG_MAX_BYTES = 256 * 1024;
const GLOBAL_CSS_MAX_BYTES = 128 * 1024;
const README_MAX_BYTES = 256 * 1024;
const COMPONENT_FILE_MAX_BYTES = 64 * 1024;

// v0.13: caps on the inventory walk so a flat folder of 5,000 components
// can't stall startup. Same shape as the css-walk caps above.
const COMPONENT_WALK_MAX_DEPTH = 3;
const COMPONENT_WALK_MAX_FILES = 50;
const COMPONENT_INVENTORY_CAP = 30;

// v0.13: per-list caps for tokens + libraries. Keeps the prompt size
// predictable when a project has a massive design system.
const COMPONENT_LIBRARY_CAP = 6;
const ICON_LIBRARY_CAP = 4;
const TOKEN_LIST_CAP = 12;
const TOKEN_ENTRY_MAX_LEN = 64;

const README_MAX_CHARS = 600;
const PROJECT_DESCRIPTION_MAX_LEN = 200;

type PackageManager = ProjectDesignProfile['packageManager'];

interface ParsedPackageJson {
  name?: string;
  description?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  // Some projects pin a manager here (Corepack convention).
  packageManager?: string;
}

// Internal state passed around so detectors can record which files they
// actually touched. We hash these mtimes into the fingerprint.
interface BuilderState {
  projectPath: string;
  evidence: string[];
  // Map<relativePath, true> — set semantics on insertion order.
  readFiles: Map<string, true>;
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

  const state: BuilderState = {
    projectPath,
    evidence: ['package.json'],
    readFiles: new Map(),
  };
  // package.json itself participates in the fingerprint.
  state.readFiles.set('package.json', true);

  const framework = await detectFrameworkFromDisk(projectPath, pkg, state);
  const frameworkVariant = await detectFrameworkVariant(projectPath, framework, pkg, state);
  const styling = await detectStylingStack(projectPath, pkg, state);
  const packageManager = await detectPackageManager(projectPath, pkg, state.evidence);
  const typescript = await hasFile(projectPath, ['tsconfig.json']);
  if (typescript) {
    state.evidence.push('tsconfig.json');
    state.readFiles.set('tsconfig.json', true);
  }

  const monorepo = await detectMonorepo(projectPath, state.evidence);

  // v0.13 enrichments — every detector failure is logged + swallowed so
  // a flaky file system doesn't bring down the whole profile build.
  const projectName = pickProjectName(pkg);
  const projectDescription = pickProjectDescription(pkg);
  const readmeExcerpt = await readReadmeExcerpt(state);
  const componentLibraries = detectComponentLibraries(pkg);
  const iconLibraries = detectIconLibraries(pkg);
  const designTokens = await detectDesignTokens(state);
  const componentInventory = await buildComponentInventory(state);

  const summary = renderSummary({
    framework,
    frameworkVariant,
    styling,
    typescript,
    packageManager,
    monorepo,
    notable: await collectNotableSignals(projectPath, state.evidence),
    projectName,
    projectDescription,
    readmeExcerpt,
    componentLibraries,
    iconLibraries,
    designTokens,
    componentInventory,
  });

  // Use the same enumeration as the freshness path so the two
  // fingerprints are bit-identical when nothing has changed.
  const fingerprint = await fingerprintForCurrentState(projectPath);

  const profile: ProjectDesignProfile = {
    projectPath,
    framework,
    styling,
    packageManager,
    typescript,
    summary,
    evidence: state.evidence,
    builtAt: Date.now(),
  };
  // Attach the v0.13 optional fields only when present, so the JSON
  // payload stays minimal for plain projects. We persist the variant
  // even when it's 'unknown' so we don't have to keep re-deciding —
  // the value is meaningful relative to the resolved framework.
  profile.frameworkVariant = frameworkVariant;
  if (projectName) profile.projectName = projectName;
  if (projectDescription) profile.projectDescription = projectDescription;
  if (readmeExcerpt) profile.readmeExcerpt = readmeExcerpt;
  if (componentLibraries.length > 0) profile.componentLibraries = componentLibraries;
  if (iconLibraries.length > 0) profile.iconLibraries = iconLibraries;
  if (designTokens && designTokens.source !== 'none') profile.designTokens = designTokens;
  if (componentInventory.length > 0) profile.componentInventory = componentInventory;
  profile.fingerprint = fingerprint;

  await writeProfileCache(projectPath, profile).catch((err) => {
    logger.warn(`failed to cache profile: ${(err as Error).message}`);
  });
  return profile;
}

/**
 * Return the cached profile when valid, otherwise rebuild + cache. The
 * cache is invalidated when the fingerprint of files the builder reads
 * no longer matches the one stored in the cache. v0.10 caches without
 * a fingerprint are treated as stale.
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
const VALID_FRAMEWORK_VARIANTS: ReadonlySet<string> = new Set([
  'next-app-router', 'next-pages-router', 'vite-electron', 'vite-web',
  'astro-static', 'remix-classic', 'unknown',
]);
const VALID_STYLINGS: ReadonlySet<string> = new Set([
  'tailwind', 'vanilla-css', 'styled-components', 'css-modules', 'unknown',
]);
const VALID_PMS: ReadonlySet<string> = new Set(['pnpm', 'yarn', 'npm', 'bun']);
const VALID_TOKEN_SOURCES: ReadonlySet<string> = new Set([
  'tailwind-config', 'css-vars', 'mixed', 'none',
]);
const VALID_EXPORT_KINDS: ReadonlySet<string> = new Set(['default', 'named', 'both']);

const CACHE_SUMMARY_MAX_BYTES = 4096;
const CACHE_EVIDENCE_MAX_ITEMS = 50;
const CACHE_EVIDENCE_ITEM_MAX_LEN = 256;
const CACHE_NAME_MAX_LEN = 214;            // npm package-name spec cap
const CACHE_DESCRIPTION_MAX_LEN = PROJECT_DESCRIPTION_MAX_LEN;
const CACHE_README_MAX_LEN = README_MAX_CHARS + 64; // small headroom for trim slack
const CACHE_LIBRARY_NAME_MAX_LEN = 64;
const CACHE_TOKEN_ENTRY_MAX_LEN = TOKEN_ENTRY_MAX_LEN;
const CACHE_COMPONENT_REL_MAX_LEN = 512;
const CACHE_FINGERPRINT_MAX_LEN = 64;

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
  // v0.13 optional fields — validate when present, drop the cache when
  // malformed. All fields are optional so v0.10 caches still load.
  if (p.frameworkVariant !== undefined) {
    if (typeof p.frameworkVariant !== 'string') return null;
    if (!VALID_FRAMEWORK_VARIANTS.has(p.frameworkVariant)) return null;
  }
  if (p.projectName !== undefined) {
    if (typeof p.projectName !== 'string') return null;
    if (p.projectName.length > CACHE_NAME_MAX_LEN) return null;
  }
  if (p.projectDescription !== undefined) {
    if (typeof p.projectDescription !== 'string') return null;
    if (p.projectDescription.length > CACHE_DESCRIPTION_MAX_LEN) return null;
  }
  if (p.readmeExcerpt !== undefined) {
    if (typeof p.readmeExcerpt !== 'string') return null;
    if (p.readmeExcerpt.length > CACHE_README_MAX_LEN) return null;
  }
  if (p.componentLibraries !== undefined) {
    if (!Array.isArray(p.componentLibraries)) return null;
    if (p.componentLibraries.length > COMPONENT_LIBRARY_CAP) return null;
    for (const item of p.componentLibraries) {
      if (typeof item !== 'string') return null;
      if (item.length > CACHE_LIBRARY_NAME_MAX_LEN) return null;
    }
  }
  if (p.iconLibraries !== undefined) {
    if (!Array.isArray(p.iconLibraries)) return null;
    if (p.iconLibraries.length > ICON_LIBRARY_CAP) return null;
    for (const item of p.iconLibraries) {
      if (typeof item !== 'string') return null;
      if (item.length > CACHE_LIBRARY_NAME_MAX_LEN) return null;
    }
  }
  if (p.designTokens !== undefined) {
    if (!p.designTokens || typeof p.designTokens !== 'object') return null;
    const t = p.designTokens as Partial<DesignTokens>;
    if (!VALID_TOKEN_SOURCES.has(t.source ?? '')) return null;
    for (const key of ['colors', 'fonts', 'spacing'] as const) {
      const list = t[key];
      if (!Array.isArray(list)) return null;
      if (list.length > TOKEN_LIST_CAP) return null;
      for (const entry of list) {
        if (typeof entry !== 'string') return null;
        if (entry.length > CACHE_TOKEN_ENTRY_MAX_LEN) return null;
      }
    }
  }
  if (p.componentInventory !== undefined) {
    if (!Array.isArray(p.componentInventory)) return null;
    if (p.componentInventory.length > COMPONENT_INVENTORY_CAP) return null;
    for (const item of p.componentInventory) {
      if (!item || typeof item !== 'object') return null;
      const c = item as Partial<ComponentInventoryEntry>;
      if (typeof c.name !== 'string' || c.name.length > 128) return null;
      if (typeof c.relPath !== 'string' || c.relPath.length > CACHE_COMPONENT_REL_MAX_LEN) return null;
      if (typeof c.exportKind !== 'string' || !VALID_EXPORT_KINDS.has(c.exportKind)) return null;
    }
  }
  if (p.fingerprint !== undefined) {
    if (typeof p.fingerprint !== 'string') return null;
    if (p.fingerprint.length > CACHE_FINGERPRINT_MAX_LEN) return null;
  }
  // All fields validated — coerce to known type and return.
  const out: ProjectDesignProfile = {
    projectPath: p.projectPath,
    framework: p.framework as ProjectDesignProfile['framework'],
    styling: p.styling as ProjectDesignProfile['styling'],
    packageManager: p.packageManager as ProjectDesignProfile['packageManager'],
    typescript: p.typescript,
    summary: p.summary,
    evidence: p.evidence as string[],
    builtAt: p.builtAt,
  };
  if (p.frameworkVariant !== undefined) out.frameworkVariant = p.frameworkVariant;
  if (p.projectName !== undefined) out.projectName = p.projectName;
  if (p.projectDescription !== undefined) out.projectDescription = p.projectDescription;
  if (p.readmeExcerpt !== undefined) out.readmeExcerpt = p.readmeExcerpt;
  if (p.componentLibraries !== undefined) out.componentLibraries = p.componentLibraries;
  if (p.iconLibraries !== undefined) out.iconLibraries = p.iconLibraries;
  if (p.designTokens !== undefined) out.designTokens = p.designTokens as DesignTokens;
  if (p.componentInventory !== undefined) {
    out.componentInventory = p.componentInventory as ComponentInventoryEntry[];
  }
  if (p.fingerprint !== undefined) out.fingerprint = p.fingerprint;
  return out;
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

/**
 * Cache freshness — recompute the fingerprint from the current state of
 * disk and compare. A missing fingerprint on a cached profile (v0.10
 * shape) is treated as stale so the user gets the v0.13 enrichments on
 * the next read.
 */
async function isCacheFresh(
  projectPath: string,
  cached: ProjectDesignProfile,
): Promise<boolean> {
  if (!cached.fingerprint) return false;
  try {
    const current = await fingerprintForCurrentState(projectPath);
    return current === cached.fingerprint;
  } catch {
    return false;
  }
}

/**
 * Re-build the fingerprint inputs from disk WITHOUT running the full
 * detection pipeline. We only need to enumerate the files that the
 * builder would have read, then hash their mtimes. The list MUST stay
 * in sync with what `buildProjectProfile` actually opens — when you add
 * a new file-reading detector, add the relPath here too.
 */
async function fingerprintForCurrentState(projectPath: string): Promise<string> {
  const rels: string[] = [];
  // package.json is always read.
  if (await safeLstat(projectPath, 'package.json')) rels.push('package.json');
  // Framework + variant config files.
  const variantCandidates = [
    'tsconfig.json',
    'next.config.ts', 'next.config.js', 'next.config.mjs',
    'vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cjs',
    'electron.vite.config.ts', 'electron.vite.config.js',
    'electron.vite.config.mjs', 'electron.vite.config.cjs',
    'astro.config.ts', 'astro.config.js', 'astro.config.mjs',
    'remix.config.ts', 'remix.config.js', 'remix.config.mjs',
    'tailwind.config.ts', 'tailwind.config.js',
    'tailwind.config.mjs', 'tailwind.config.cjs',
  ];
  for (const rel of variantCandidates) {
    if (await safeLstat(projectPath, rel)) rels.push(rel);
  }
  // Global CSS — only the first one that exists, in priority order.
  for (const rel of GLOBAL_CSS_CANDIDATES) {
    if (await safeLstat(projectPath, rel)) {
      rels.push(rel);
      break;
    }
  }
  // README in case-sensitive priority order.
  for (const rel of README_CANDIDATES) {
    if (await safeLstat(projectPath, rel)) {
      rels.push(rel);
      break;
    }
  }
  // Component inventory roots — we hash directory mtimes which change
  // when a file is added or removed. Per-file mtimes inside the dir
  // would be ideal but enumerating defeats the cheap-check goal.
  for (const rel of COMPONENT_INVENTORY_ROOTS) {
    if (await safeLstat(projectPath, rel)) rels.push(rel);
  }

  return hashFingerprintEntries(projectPath, rels);
}

async function hashFingerprintEntries(
  projectPath: string,
  rels: string[],
): Promise<string> {
  // Stable sort so unrelated reorderings don't move the hash.
  const sorted = [...new Set(rels)].sort();
  const parts: string[] = [];
  for (const rel of sorted) {
    const target = resolveUnder(projectPath, rel);
    if (!target) continue;
    try {
      const st = await fs.lstat(target);
      if (st.isSymbolicLink()) continue;
      parts.push(`${rel}:${st.mtimeMs}`);
    } catch {
      // file vanished between enumeration and stat — skip
    }
  }
  const blob = parts.join('|');
  return createHash('sha1').update(blob).digest('hex').slice(0, 16);
}

async function safeLstat(projectPath: string, rel: string): Promise<boolean> {
  const target = resolveUnder(projectPath, rel);
  if (!target) return false;
  try {
    const st = await fs.lstat(target);
    if (st.isSymbolicLink()) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Path-traversal-safe resolver. Returns the absolute path if and only
 * if it sits under `projectPath`; null otherwise. The `rel === '.'`
 * case is allowed so callers can probe the project root itself.
 */
function resolveUnder(projectPath: string, rel: string): string | null {
  const target = path.resolve(projectPath, rel);
  if (target === projectPath) return target;
  if (target.startsWith(projectPath + path.sep)) return target;
  return null;
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
    const target = resolveUnder(root, file);
    if (!target) continue;
    try {
      // Reject path-traversal candidates and symlinks. lstat (not stat)
      // so we see the symlink itself rather than its resolution.
      const st = await fs.lstat(target);
      if (st.isSymbolicLink()) continue;
      return true;
    } catch {
      /* keep scanning */
    }
  }
  return false;
}

/**
 * Like `hasFile`, but returns which candidate matched so the caller can
 * record the exact relative path it touched (for the fingerprint).
 */
async function findFirstExisting(
  projectPath: string,
  candidates: string[],
): Promise<string | null> {
  for (const file of candidates) {
    if (await hasFile(projectPath, [file])) return file;
  }
  return null;
}

// Framework detection ─────────────────────────────────────────────────────

async function detectFrameworkFromDisk(
  projectPath: string,
  pkg: ParsedPackageJson,
  state: BuilderState,
): Promise<DevServerKind> {
  const allDeps = mergeDeps(pkg);
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
    state.evidence.push(nextConfig ? 'next.config.*' : 'next dep');
    return 'next';
  }
  if ('astro' in allDeps && astroConfig) {
    state.evidence.push('astro.config.*');
    return 'astro';
  }
  if ('vite' in allDeps && viteConfig) {
    state.evidence.push('vite.config.*');
    return 'vite';
  }
  if (
    '@remix-run/dev' in allDeps ||
    '@remix-run/react' in allDeps ||
    '@remix-run/serve' in allDeps
  ) {
    state.evidence.push('@remix-run/*');
    return 'remix';
  }
  // Soft fallbacks.
  if (nextConfig && 'next' in allDeps) {
    state.evidence.push('next.config.*');
    return 'next';
  }
  if (viteConfig) {
    state.evidence.push('vite.config.*');
    return 'vite';
  }
  if (remixConfig) {
    state.evidence.push('remix.config.*');
    return 'remix';
  }
  return 'unknown';
}

// v0.13: framework variant — App Router vs Pages Router, Vite-electron vs
// Vite-web. We base this on file presence first (most reliable signal)
// and dep names second.
async function detectFrameworkVariant(
  projectPath: string,
  framework: DevServerKind,
  pkg: ParsedPackageJson,
  state: BuilderState,
): Promise<FrameworkVariant> {
  try {
    const allDeps = mergeDeps(pkg);
    switch (framework) {
      case 'next': {
        const nextConfig = await findFirstExisting(projectPath, [
          'next.config.ts', 'next.config.js', 'next.config.mjs',
        ]);
        const hasApp = await hasFile(projectPath, ['app']);
        const hasPages = await hasFile(projectPath, ['pages']);
        if (hasApp && nextConfig) {
          state.readFiles.set(nextConfig, true);
          return 'next-app-router';
        }
        if (hasPages) return 'next-pages-router';
        return 'unknown';
      }
      case 'vite': {
        const isElectron =
          ('electron' in allDeps || 'electron-vite' in allDeps) &&
          (await hasFile(projectPath, [
            'electron.vite.config.ts', 'electron.vite.config.js',
            'electron.vite.config.mjs', 'electron.vite.config.cjs',
          ]));
        if (isElectron) {
          const rel = await findFirstExisting(projectPath, [
            'electron.vite.config.ts', 'electron.vite.config.js',
            'electron.vite.config.mjs', 'electron.vite.config.cjs',
          ]);
          if (rel) state.readFiles.set(rel, true);
          return 'vite-electron';
        }
        return 'vite-web';
      }
      case 'astro':
        return 'astro-static';
      case 'remix':
        return 'remix-classic';
      default:
        return 'unknown';
    }
  } catch (err) {
    logger.warn(`framework variant detection failed: ${(err as Error).message}`);
    return 'unknown';
  }
}

function mergeDeps(pkg: ParsedPackageJson): Record<string, string> {
  return {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };
}

// Styling detection ───────────────────────────────────────────────────────

async function detectStylingStack(
  projectPath: string,
  pkg: ParsedPackageJson,
  state: BuilderState,
): Promise<StyleAdapterKind | 'unknown'> {
  const allDeps = mergeDeps(pkg);

  // Tailwind — multiple signals (config file, dep, postcss plugin, v4 globals
  // with `@import "tailwindcss"`).
  const tailwindConfig = await findFirstExisting(projectPath, [
    'tailwind.config.ts',
    'tailwind.config.js',
    'tailwind.config.mjs',
    'tailwind.config.cjs',
  ]);
  const hasTailwindConfig = tailwindConfig !== null;
  const hasTailwindDep =
    'tailwindcss' in allDeps || '@tailwindcss/postcss' in allDeps;
  const hasTailwindV4Import = await sniffTailwindV4Import(projectPath, state);
  if (hasTailwindConfig || hasTailwindDep || hasTailwindV4Import) {
    if (hasTailwindConfig) {
      state.evidence.push('tailwind.config.*');
      if (tailwindConfig) state.readFiles.set(tailwindConfig, true);
    } else if (hasTailwindDep) state.evidence.push('tailwindcss dep');
    else state.evidence.push('@import "tailwindcss"');
    return 'tailwind';
  }

  if ('styled-components' in allDeps) {
    state.evidence.push('styled-components dep');
    return 'styled-components';
  }

  // CSS Modules / vanilla — shallow walk under `src/` (or project root if no
  // src) looking for `*.module.css` files first; otherwise any plain `.css`.
  const stylingSignal = await sniffSourceStyling(projectPath);
  if (stylingSignal === 'css-modules') {
    state.evidence.push('*.module.css present');
    return 'css-modules';
  }
  if (stylingSignal === 'vanilla-css') {
    state.evidence.push('plain .css present');
    return 'vanilla-css';
  }
  return 'unknown';
}

// Candidate globals.css locations. Used by both Tailwind-v4 sniffing and
// the design-tokens CSS-var fallback so both paths agree on what counts
// as "the global CSS".
const GLOBAL_CSS_CANDIDATES = [
  'src/app/globals.css',
  'app/globals.css',
  'src/styles/globals.css',
  'styles/globals.css',
  'src/index.css',
  'src/main.css',
];

// README candidates in case-sensitive priority order. Most projects ship
// uppercase README.md; Windows-origin repos sometimes use mixed case.
const README_CANDIDATES = ['README.md', 'Readme.md', 'readme.md'];

// Component inventory roots. We walk the first three; the order biases
// toward Next.js conventions, but plain CRA / Vite projects with
// `src/components` also work.
const COMPONENT_INVENTORY_ROOTS = ['src/components', 'components', 'app/components'];

// Look for `@import "tailwindcss"` or `@import 'tailwindcss'` in common
// global-css spots. Tailwind v4 ditched the JS config; this is often the
// only signal in fresh v4 setups.
async function sniffTailwindV4Import(
  projectPath: string,
  state: BuilderState,
): Promise<boolean> {
  for (const rel of GLOBAL_CSS_CANDIDATES) {
    const txt = await safeReadText(projectPath, rel, GLOBAL_CSS_MAX_BYTES);
    if (txt === null) continue;
    state.readFiles.set(rel, true);
    if (/@import\s+["']tailwindcss["']/.test(txt)) return true;
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

// v0.13: name / description / README ──────────────────────────────────────

function pickProjectName(pkg: ParsedPackageJson): string | undefined {
  const name = typeof pkg.name === 'string' ? pkg.name.trim() : '';
  if (!name) return undefined;
  if (name.length > CACHE_NAME_MAX_LEN) return name.slice(0, CACHE_NAME_MAX_LEN);
  return name;
}

function pickProjectDescription(pkg: ParsedPackageJson): string | undefined {
  const desc = typeof pkg.description === 'string' ? pkg.description.trim() : '';
  if (!desc) return undefined;
  if (desc.length <= PROJECT_DESCRIPTION_MAX_LEN) return desc;
  return desc.slice(0, PROJECT_DESCRIPTION_MAX_LEN - 1).trimEnd() + '…';
}

async function readReadmeExcerpt(state: BuilderState): Promise<string | undefined> {
  try {
    for (const rel of README_CANDIDATES) {
      const raw = await safeReadText(state.projectPath, rel, README_MAX_BYTES);
      if (raw === null) continue;
      state.readFiles.set(rel, true);
      const cleaned = cleanReadme(raw);
      if (!cleaned) return undefined;
      return cleaned;
    }
  } catch (err) {
    logger.warn(`failed to read README: ${(err as Error).message}`);
  }
  return undefined;
}

/**
 * Strip front-matter, badges, and HTML img tags from the README, then
 * grab a tidy first-paragraph excerpt for the prompt. Cheap regex
 * pipeline — we're aiming at the first non-decorative line of prose,
 * not at robust markdown parsing.
 */
export function cleanReadme(input: string): string {
  let body = input.replace(/^﻿/, ''); // strip BOM
  // Front-matter `---\n...\n---`
  body = body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  // Drop markdown image badges + HTML img tags + HTML comments. These
  // are the standard noise sources at the top of a README.
  body = body.replace(/<!--[\s\S]*?-->/g, '');
  body = body.replace(/!\[[^\]]*]\([^)]*\)/g, '');
  body = body.replace(/<img\s[^>]*>/gi, '');
  // Standalone `[![…](…)](…)` (badge wrapped in link)
  body = body.replace(/\[!\[[^\]]*]\([^)]*\)]\([^)]*\)/g, '');
  // Reduce heading markers to their text — `# Foo` -> `Foo`.
  body = body.replace(/^[#]{1,6}\s+/gm, '');
  // Trim blocks of blank lines down to one.
  body = body.replace(/\n{3,}/g, '\n\n');
  body = body.trim();
  if (!body) return '';
  // First 600 chars, then trim to end of last sentence when possible.
  let excerpt = body.slice(0, README_MAX_CHARS);
  if (body.length > README_MAX_CHARS) {
    const lastBoundary = Math.max(
      excerpt.lastIndexOf('.'),
      excerpt.lastIndexOf('!'),
      excerpt.lastIndexOf('?'),
    );
    if (lastBoundary > 120) excerpt = excerpt.slice(0, lastBoundary + 1);
  }
  return excerpt.trim();
}

// v0.13: component + icon libraries ───────────────────────────────────────

export function detectComponentLibraries(pkg: ParsedPackageJson): string[] {
  const deps = mergeDeps(pkg);
  const out = new Set<string>();
  let hasAnyRadix = false;
  for (const name of Object.keys(deps)) {
    if (name === '@radix-ui/themes') {
      out.add('Radix Themes');
      hasAnyRadix = true;
      continue;
    }
    if (name.startsWith('@radix-ui/')) {
      out.add('Radix UI');
      hasAnyRadix = true;
    }
  }
  if ('class-variance-authority' in deps && hasAnyRadix) {
    out.add('shadcn/ui (Radix + CVA)');
  }
  if ('@mui/material' in deps || '@mui/joy' in deps) out.add('Material UI');
  if ('@chakra-ui/react' in deps) out.add('Chakra UI');
  if ('antd' in deps) out.add('Ant Design');
  if ('@mantine/core' in deps) out.add('Mantine');
  if ('daisyui' in deps) out.add('daisyUI');
  if ('@nextui-org/react' in deps) out.add('NextUI');
  return [...out].sort().slice(0, COMPONENT_LIBRARY_CAP);
}

export function detectIconLibraries(pkg: ParsedPackageJson): string[] {
  const deps = mergeDeps(pkg);
  const out = new Set<string>();
  if ('lucide-react' in deps || 'lucide' in deps) out.add('lucide-react');
  if ('@heroicons/react' in deps) out.add('Heroicons');
  if ('react-icons' in deps) out.add('react-icons');
  if ('@tabler/icons-react' in deps) out.add('Tabler Icons');
  if ('@phosphor-icons/react' in deps) out.add('Phosphor');
  if ('@radix-ui/react-icons' in deps) out.add('Radix Icons');
  return [...out].sort().slice(0, ICON_LIBRARY_CAP);
}

// v0.13: design tokens ────────────────────────────────────────────────────

async function detectDesignTokens(state: BuilderState): Promise<DesignTokens> {
  const empty: DesignTokens = { colors: [], fonts: [], spacing: [], source: 'none' };
  try {
    const tailwindRel = await findFirstExisting(state.projectPath, [
      'tailwind.config.ts',
      'tailwind.config.js',
      'tailwind.config.mjs',
      'tailwind.config.cjs',
    ]);
    if (tailwindRel) {
      const raw = await safeReadText(state.projectPath, tailwindRel, TAILWIND_CONFIG_MAX_BYTES);
      if (raw !== null) {
        state.readFiles.set(tailwindRel, true);
        const tokens = extractTailwindTokens(raw);
        if (tokens.colors.length || tokens.fonts.length || tokens.spacing.length) {
          return { ...tokens, source: 'tailwind-config' };
        }
      }
    }
    // CSS-vars fallback.
    for (const rel of GLOBAL_CSS_CANDIDATES) {
      const raw = await safeReadText(state.projectPath, rel, GLOBAL_CSS_MAX_BYTES);
      if (raw === null) continue;
      state.readFiles.set(rel, true);
      const tokens = extractCssVarTokens(raw);
      if (tokens.colors.length || tokens.fonts.length || tokens.spacing.length) {
        return { ...tokens, source: 'css-vars' };
      }
    }
  } catch (err) {
    logger.warn(`design tokens detection failed: ${(err as Error).message}`);
  }
  return empty;
}

/**
 * Cheap regex extraction. We DO NOT eval or parse the JS — we walk for
 * the `theme.extend.colors|fontFamily|spacing` literal blocks and pull
 * `key: value` pairs out of the body.
 *
 * Caveats:
 *   • Nested objects (e.g. `colors: { brand: { 500: '#abc' } }`) are
 *     skipped past the first level — we only surface flat entries.
 *   • Spread members (`...require('./tokens')`) are ignored.
 *   • Both `colors:` and `colors :` with whitespace are accepted.
 */
export function extractTailwindTokens(raw: string): Omit<DesignTokens, 'source'> {
  return {
    colors: extractTailwindBlock(raw, 'colors'),
    fonts: extractTailwindBlock(raw, 'fontFamily'),
    spacing: extractTailwindBlock(raw, 'spacing'),
  };
}

function extractTailwindBlock(raw: string, key: string): string[] {
  // Find `extend: { ... key: { ... } ... }` blocks. We look for the key
  // anywhere — accepting flat top-level shapes too — because v4 configs
  // sometimes define `theme: { colors: { … } }` without an `extend`.
  const pattern = new RegExp(`${key}\\s*:\\s*\\{`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(raw))) {
    const start = m.index + m[0].length;
    const body = sliceBalanced(raw, start);
    if (body === null) continue;
    out.push(...parseFlatPairs(body));
    if (out.length >= TOKEN_LIST_CAP) break;
  }
  // Dedupe (cap first; sort stable).
  return dedupeCapped(out);
}

// Read forward from `start` returning the body inside the matching
// closing `}`. Returns null if unbalanced or runs past 4 KB (a giant
// block almost certainly means we matched something unintended).
function sliceBalanced(raw: string, start: number): string | null {
  let depth = 1;
  const limit = Math.min(raw.length, start + 4096);
  for (let i = start; i < limit; i++) {
    const ch = raw[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i);
    }
  }
  return null;
}

function parseFlatPairs(body: string): string[] {
  // Match `key: 'value'`, `key: "value"`, `'key': value`, etc.
  // Skip entries where the value is `{`, `[` (nested) or starts with `(`.
  const out: string[] = [];
  const re =
    /(?:["']([\w-]+)["']|([\w-]+))\s*:\s*(?:["']([^"']{1,128})["']|(\d+(?:\.\d+)?(?:[a-z%]+)?))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const key = (m[1] ?? m[2] ?? '').trim();
    const val = (m[3] ?? m[4] ?? '').trim();
    if (!key || !val) continue;
    const entry = clampEntry(`${key}: ${val}`);
    out.push(entry);
    if (out.length >= TOKEN_LIST_CAP * 2) break;
  }
  return out;
}

export function extractCssVarTokens(raw: string): Omit<DesignTokens, 'source'> {
  const colors: string[] = [];
  const fonts: string[] = [];
  const spacing: string[] = [];
  const re = /--([a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const key = m[1].trim();
    const val = m[2].trim();
    if (!key || !val) continue;
    const entry = clampEntry(`${key}: ${val}`);
    const lower = key.toLowerCase();
    if (looksLikeColor(lower, val)) colors.push(entry);
    else if (lower.includes('font') || lower.includes('family')) fonts.push(entry);
    else if (
      lower.includes('space') ||
      lower.includes('gap') ||
      lower.includes('radius') ||
      lower.includes('padding') ||
      lower.includes('margin')
    ) {
      spacing.push(entry);
    }
  }
  return {
    colors: dedupeCapped(colors),
    fonts: dedupeCapped(fonts),
    spacing: dedupeCapped(spacing),
  };
}

function looksLikeColor(key: string, val: string): boolean {
  if (
    key.includes('color') ||
    key.includes('background') ||
    key.includes('foreground') ||
    key.includes('accent') ||
    key.includes('primary') ||
    key.includes('secondary') ||
    key.includes('muted') ||
    key.includes('border')
  ) return true;
  return /^#[0-9a-fA-F]{3,8}$/.test(val) || /^(rgb|hsl|hwb|oklab|oklch)/.test(val);
}

function clampEntry(entry: string): string {
  if (entry.length <= TOKEN_ENTRY_MAX_LEN) return entry;
  return entry.slice(0, TOKEN_ENTRY_MAX_LEN - 1) + '…';
}

function dedupeCapped(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of list) {
    if (seen.has(e)) continue;
    seen.add(e);
    out.push(e);
    if (out.length >= TOKEN_LIST_CAP) break;
  }
  return out;
}

// v0.13: component inventory ──────────────────────────────────────────────

async function buildComponentInventory(state: BuilderState): Promise<ComponentInventoryEntry[]> {
  const out: ComponentInventoryEntry[] = [];
  let inspected = 0;
  try {
    for (const root of COMPONENT_INVENTORY_ROOTS) {
      if (inspected >= COMPONENT_WALK_MAX_FILES) break;
      if (out.length >= COMPONENT_INVENTORY_CAP) break;
      const absRoot = resolveUnder(state.projectPath, root);
      if (!absRoot) continue;
      try {
        const st = await fs.lstat(absRoot);
        if (st.isSymbolicLink()) continue;
        if (!st.isDirectory()) continue;
      } catch {
        continue;
      }
      await walkComponents(absRoot, COMPONENT_WALK_MAX_DEPTH, async (filePath) => {
        if (inspected >= COMPONENT_WALK_MAX_FILES) return false;
        inspected += 1;
        const rel = path.relative(state.projectPath, filePath);
        // Guard against any path that escapes the project root via odd
        // dirent shapes (shouldn't be possible — defense in depth).
        if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
        const raw = await safeReadText(state.projectPath, rel, COMPONENT_FILE_MAX_BYTES);
        if (raw === null) return true;
        const parsed = parseComponentExports(raw);
        if (parsed) {
          out.push({ name: parsed.name, relPath: rel, exportKind: parsed.exportKind });
          state.readFiles.set(rel, true);
        }
        return out.length < COMPONENT_INVENTORY_CAP;
      });
    }
  } catch (err) {
    logger.warn(`component inventory failed: ${(err as Error).message}`);
  }
  return out.slice(0, COMPONENT_INVENTORY_CAP);
}

async function walkComponents(
  dir: string,
  depth: number,
  visit: (filePath: string) => Promise<boolean>, // returns false to stop
): Promise<boolean> {
  if (depth < 0) return true;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return true;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'build') continue;
    if (e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const keepGoing = await walkComponents(full, depth - 1, visit);
      if (!keepGoing) return false;
    } else if (e.isFile() && (e.name.endsWith('.tsx') || e.name.endsWith('.jsx'))) {
      const keepGoing = await visit(full);
      if (!keepGoing) return false;
    }
  }
  return true;
}

export function parseComponentExports(
  raw: string,
): { name: string; exportKind: ComponentInventoryEntry['exportKind'] } | null {
  // v0.13 MED fix: strip line + block comments before scanning so a
  // commented-out `// export default function Foo` doesn't pollute the
  // inventory. Cheap pre-pass — doesn't need to be JS-grammar accurate,
  // only to defeat the obvious cases. We also strip string literals
  // (single/double/backtick) because they can legitimately contain
  // sequences like `"export function X"`.
  const src = stripCommentsAndStrings(raw);

  // Regex (no TS parser) — pick the first PascalCase export. Tracking
  // both shapes lets us upgrade to `'both'` when a file has each.
  const defaultMatch = src.match(
    /export\s+default\s+(?:async\s+)?function\s+([A-Z][A-Za-z0-9_]+)/,
  );
  // Negative-lookahead so we don't double-count `export default function`.
  const namedMatch = src.match(
    /export\s+(?!default\b)(?:async\s+)?function\s+([A-Z][A-Za-z0-9_]+)/,
  );
  // Also accept `export const Foo = …` arrow components — common in
  // shadcn / Radix-style sources.
  const namedConst = src.match(
    /export\s+(?:const|let|var)\s+([A-Z][A-Za-z0-9_]+)\s*=/,
  );

  if (defaultMatch && (namedMatch || namedConst)) {
    return { name: defaultMatch[1], exportKind: 'both' };
  }
  if (defaultMatch) {
    return { name: defaultMatch[1], exportKind: 'default' };
  }
  if (namedMatch) {
    return { name: namedMatch[1], exportKind: 'named' };
  }
  if (namedConst) {
    return { name: namedConst[1], exportKind: 'named' };
  }
  return null;
}

// Minimal pre-scrubber: removes `// …` line comments, `/* … */` block
// comments, and string literals (`'…'`, `"…"`, `` `…` ``). Not a parser
// — we don't try to handle every JS edge case (regex literals, template
// expressions, etc.). Goal is just to keep an `export …` token from
// matching inside comments/strings. Length-preserving (replaces with
// spaces) so reported offsets stay roughly meaningful.
function stripCommentsAndStrings(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    // Line comment
    if (c === '/' && c2 === '/') {
      out += '  ';
      i += 2;
      while (i < n && src[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    // Block comment
    if (c === '/' && c2 === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    // String literal
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += ' ';
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) {
          out += '  ';
          i += 2;
          continue;
        }
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out += ' ';
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Safe file reader ────────────────────────────────────────────────────────

/**
 * Resolve `rel` under `projectPath`, refuse symlinks + oversized files,
 * and return the file contents as a UTF-8 string. Returns null on any
 * miss (missing, oversized, symlink, IO error) — never throws.
 */
async function safeReadText(
  projectPath: string,
  rel: string,
  maxBytes: number,
): Promise<string | null> {
  const target = resolveUnder(projectPath, rel);
  if (!target) return null;
  try {
    const st = await fs.lstat(target);
    if (st.isSymbolicLink()) return null;
    if (!st.isFile()) return null;
    if (st.size > maxBytes) {
      logger.warn(`skipping ${rel}: ${st.size} bytes exceeds cap ${maxBytes}`);
      return null;
    }
    return await fs.readFile(target, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code && code !== 'ENOENT') {
      logger.warn(`failed to read ${rel}: ${(err as Error).message}`);
    }
    return null;
  }
}

// Summary rendering ───────────────────────────────────────────────────────

interface SummaryInput {
  framework: DevServerKind;
  frameworkVariant: FrameworkVariant;
  styling: StyleAdapterKind | 'unknown';
  typescript: boolean;
  packageManager: PackageManager;
  monorepo: boolean;
  notable: string[];
  projectName?: string;
  projectDescription?: string;
  readmeExcerpt?: string;
  componentLibraries: string[];
  iconLibraries: string[];
  designTokens: DesignTokens;
  componentInventory: ComponentInventoryEntry[];
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

function frameworkVariantLabel(v: FrameworkVariant): string {
  switch (v) {
    case 'next-app-router': return 'Next.js App Router';
    case 'next-pages-router': return 'Next.js Pages Router';
    case 'vite-electron': return 'Vite (Electron)';
    case 'vite-web': return 'Vite (web)';
    case 'astro-static': return 'Astro (static)';
    case 'remix-classic': return 'Remix';
    default: return 'unknown';
  }
}

function firstLine(s: string): string {
  const line = s.split(/\r?\n/, 1)[0] ?? '';
  if (line.length <= 140) return line;
  return line.slice(0, 137) + '…';
}

function renderSummary(input: SummaryInput): string {
  const lines: string[] = [];
  lines.push(`- Framework: ${frameworkLabel(input.framework)}`);
  if (input.frameworkVariant !== 'unknown') {
    lines.push(`- Variant: ${frameworkVariantLabel(input.frameworkVariant)}`);
  }
  lines.push(`- Styling: ${stylingLabel(input.styling)}`);
  lines.push(`- Language: ${input.typescript ? 'TypeScript' : 'JavaScript'}`);
  lines.push(`- Package manager: ${input.packageManager}`);
  if (input.notable.length > 0) {
    lines.push(`- Notable: ${input.notable.join(', ')}`);
  }
  if (input.projectName) {
    const tail = input.projectDescription ? ` — ${input.projectDescription}` : '';
    lines.push(`- Project: ${input.projectName}${tail}`);
  }
  if (input.componentLibraries.length > 0) {
    lines.push(`- Component libraries: ${input.componentLibraries.join(', ')}`);
  }
  if (input.iconLibraries.length > 0) {
    lines.push(`- Icon libraries: ${input.iconLibraries.join(', ')}`);
  }
  if (input.designTokens.source !== 'none') {
    const dt = input.designTokens;
    const bits: string[] = [];
    if (dt.colors.length) bits.push(`${dt.colors.length} colors`);
    if (dt.fonts.length) bits.push(`${dt.fonts.length} fonts`);
    if (dt.spacing.length) bits.push(`${dt.spacing.length} spacing`);
    const fromLabel =
      dt.source === 'tailwind-config' ? 'tailwind config'
      : dt.source === 'css-vars' ? 'CSS vars'
      : dt.source;
    if (bits.length) {
      lines.push(`- Design tokens: ${bits.join(', ')} from ${fromLabel}`);
    }
  }
  if (input.componentInventory.length > 0) {
    const sample = input.componentInventory
      .slice(0, 3)
      .map((c) => c.name)
      .join(', ');
    lines.push(`- Components: ${input.componentInventory.length} found (e.g., ${sample})`);
  }
  if (input.readmeExcerpt) {
    lines.push(`- README excerpt: ${firstLine(input.readmeExcerpt)}`);
  }
  const out = lines.join('\n');
  if (Buffer.byteLength(out, 'utf8') <= SUMMARY_MAX_BYTES) return out;
  // Hard cap — slice as bytes (truncate at boundary).
  return out.slice(0, SUMMARY_MAX_BYTES - 16) + '\n…[truncated]';
}
