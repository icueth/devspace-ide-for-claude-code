import { app } from 'electron';

import { createLogger } from '@shared/logger';
import type { UpdateInfo } from '@shared/types';

const logger = createLogger('Update');

// Hard-coded — DevSpace is its own product, not a generic shell. If we ever
// need to make this configurable we can move it to settings; until then a
// constant keeps the failure mode deterministic.
const REPO = 'icueth/devspace-ide-for-claude-code';
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

// Cache the last successful check for 10 minutes. The renderer re-asks on
// focus / startup; without a cache that's one GitHub API request per focus
// flip and we'd burn through the 60-req/hr unauthenticated rate limit on
// any window-flicker-happy user.
const CACHE_TTL_MS = 10 * 60 * 1000;
let cache: { fetchedAt: number; info: UpdateInfo } | null = null;

interface GitHubRelease {
  tag_name: string;
  name: string;
  html_url: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
    size: number;
  }>;
}

/**
 * Strip the leading "v" from tag names ("v0.3.18" → "0.3.18") and split
 * into a numeric tuple so we can do a real comparison instead of relying
 * on lexicographic order (which would say 0.3.10 < 0.3.9). Pre-release
 * suffixes ("-rc.1") get dropped — DevSpace doesn't ship them today and
 * if it ever does, ignoring suffixes errs on the side of "show update
 * available" which is the safer default.
 */
function parseVersion(raw: string): number[] {
  const cleaned = raw.replace(/^v/i, '').split(/[-+]/)[0]!;
  return cleaned.split('.').map((p) => {
    const n = parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  const len = Math.max(va.length, vb.length);
  for (let i = 0; i < len; i++) {
    const da = va[i] ?? 0;
    const db = vb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

/**
 * Pick the macOS arm64 DMG asset out of the release. We bias toward the
 * filename pattern we actually publish (`devspace-X.Y.Z-arm64.dmg`) but
 * fall back to any `.dmg` so a release with a different naming convention
 * still resolves. Returns the direct download URL or null.
 */
function pickAsset(release: GitHubRelease): string | null {
  // Prefer arm64 .dmg first since that's what DevSpace ships today.
  const armDmg = release.assets.find(
    (a) => a.name.endsWith('.dmg') && /arm64/i.test(a.name),
  );
  if (armDmg) return armDmg.browser_download_url;
  const anyDmg = release.assets.find((a) => a.name.endsWith('.dmg'));
  return anyDmg?.browser_download_url ?? null;
}

export async function checkForUpdate(force = false): Promise<UpdateInfo> {
  const now = Date.now();
  if (!force && cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.info;
  }

  const current = app.getVersion();

  let res: Response;
  try {
    res = await fetch(RELEASES_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `DevSpace/${current}`,
      },
    });
  } catch (err) {
    const info: UpdateInfo = {
      current,
      latest: null,
      hasUpdate: false,
      releaseUrl: null,
      downloadUrl: null,
      releaseNotes: null,
      error: `Network error: ${(err as Error).message}`,
      checkedAt: now,
    };
    return info;
  }

  if (!res.ok) {
    // 403 = rate limit, 404 = no releases yet (private repo etc). Don't
    // cache an error response so the next manual click can retry.
    const text = await res.text().catch(() => '');
    return {
      current,
      latest: null,
      hasUpdate: false,
      releaseUrl: null,
      downloadUrl: null,
      releaseNotes: null,
      error: `GitHub API ${res.status}: ${text.slice(0, 200) || res.statusText}`,
      checkedAt: now,
    };
  }

  const release = (await res.json()) as GitHubRelease;
  if (release.draft || release.prerelease) {
    // Skip drafts/pre-releases — users on stable shouldn't get nudged into
    // those. If we ever ship beta channels this becomes a setting.
    const info: UpdateInfo = {
      current,
      latest: null,
      hasUpdate: false,
      releaseUrl: null,
      downloadUrl: null,
      releaseNotes: null,
      error: null,
      checkedAt: now,
    };
    cache = { fetchedAt: now, info };
    return info;
  }

  const latest = release.tag_name;
  const hasUpdate = compareVersions(latest, current) > 0;
  const downloadUrl = pickAsset(release);
  const info: UpdateInfo = {
    current,
    latest,
    hasUpdate,
    releaseUrl: release.html_url,
    downloadUrl,
    releaseNotes: release.body || null,
    error: null,
    checkedAt: now,
  };
  cache = { fetchedAt: now, info };
  logger.info(
    `update check: current=${current} latest=${latest} hasUpdate=${hasUpdate}`,
  );
  return info;
}

export function getCachedUpdate(): UpdateInfo | null {
  return cache?.info ?? null;
}
