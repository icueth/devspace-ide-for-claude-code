import { mkdtemp, mkdir, writeFile, rm, utimes, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The module under test depends only on `node:fs` + `@shared/logger`; the
// logger transitively imports `electron` in some build configs, so stub it.
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
}));

import {
  buildProjectProfile,
  loadCachedOrBuild,
} from '@main/services/ProjectProfileBuilder';

describe('ProjectProfileBuilder', () => {
  let tmp = '';

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'devspace-profile-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function writeProject(files: Record<string, string>): Promise<void> {
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(tmp, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, body, 'utf8');
    }
  }

  it('detects Next.js + Tailwind + TS + pnpm from canonical signals', async () => {
    await writeProject({
      'package.json': JSON.stringify({
        name: 't',
        dependencies: { next: '^14.0.0', tailwindcss: '^3.4.0' },
      }),
      'next.config.js': 'module.exports = {}',
      'tailwind.config.js': 'module.exports = {}',
      'tsconfig.json': '{}',
      'pnpm-lock.yaml': '',
    });

    const profile = await buildProjectProfile({ projectPath: tmp });
    expect(profile).not.toBeNull();
    expect(profile?.framework).toBe('next');
    expect(profile?.styling).toBe('tailwind');
    expect(profile?.typescript).toBe(true);
    expect(profile?.packageManager).toBe('pnpm');
    expect(profile?.summary).toContain('Next.js');
    expect(profile?.summary).toContain('Tailwind CSS');
    expect(profile?.summary).toContain('TypeScript');
    expect(profile?.summary).toContain('pnpm');
  });

  it('detects Vite + styled-components + JS + npm', async () => {
    await writeProject({
      'package.json': JSON.stringify({
        name: 't',
        dependencies: { vite: '^5.0.0', 'styled-components': '^6.0.0' },
      }),
      'vite.config.js': 'export default {}',
      'package-lock.json': '{}',
    });

    const profile = await buildProjectProfile({ projectPath: tmp });
    expect(profile).not.toBeNull();
    expect(profile?.framework).toBe('vite');
    expect(profile?.styling).toBe('styled-components');
    expect(profile?.typescript).toBe(false);
    expect(profile?.packageManager).toBe('npm');
  });

  it('detects CSS Modules from a *.module.css presence under src/', async () => {
    await writeProject({
      'package.json': JSON.stringify({ name: 't', dependencies: { vite: '^5' } }),
      'vite.config.js': 'export default {}',
      'src/components/Button.module.css': '.btn { color: red; }',
    });

    const profile = await buildProjectProfile({ projectPath: tmp });
    expect(profile?.styling).toBe('css-modules');
  });

  it('detects vanilla CSS when no module.css but plain .css exists', async () => {
    await writeProject({
      'package.json': JSON.stringify({ name: 't', dependencies: { vite: '^5' } }),
      'vite.config.js': 'export default {}',
      'src/styles/main.css': 'body { margin: 0 }',
    });

    const profile = await buildProjectProfile({ projectPath: tmp });
    expect(profile?.styling).toBe('vanilla-css');
  });

  it('detects Tailwind v4 from `@import "tailwindcss"` even without config file', async () => {
    await writeProject({
      'package.json': JSON.stringify({ name: 't', dependencies: { next: '^15' } }),
      'next.config.js': 'module.exports = {}',
      'app/globals.css': '@import "tailwindcss";\n.body{}',
    });

    const profile = await buildProjectProfile({ projectPath: tmp });
    expect(profile?.styling).toBe('tailwind');
  });

  it('returns null when there is no package.json', async () => {
    // Empty tmp dir — no package.json present.
    const profile = await buildProjectProfile({ projectPath: tmp });
    expect(profile).toBeNull();
  });

  it('caches and reuses the profile on second call when package.json is unchanged', async () => {
    await writeProject({
      'package.json': JSON.stringify({
        name: 't',
        dependencies: { vite: '^5' },
      }),
      'vite.config.js': 'export default {}',
    });

    const first = await loadCachedOrBuild(tmp);
    // Verify the on-disk cache file exists.
    const cacheFile = path.join(tmp, '.devspace', 'design', 'profile.json');
    const cacheStat = await stat(cacheFile);
    expect(cacheStat.isFile()).toBe(true);

    // Roll package.json mtime backwards so it's stale relative to cache.
    const past = new Date(first!.builtAt - 60_000);
    await utimes(path.join(tmp, 'package.json'), past, past);

    const second = await loadCachedOrBuild(tmp);
    // Same builtAt → cache hit (not rebuilt).
    expect(second?.builtAt).toBe(first?.builtAt);
  });

  it('rebuilds the profile when package.json mtime is newer than cached builtAt', async () => {
    await writeProject({
      'package.json': JSON.stringify({
        name: 't',
        dependencies: { vite: '^5' },
      }),
      'vite.config.js': 'export default {}',
    });

    const first = await loadCachedOrBuild(tmp);
    expect(first).not.toBeNull();

    // Push package.json mtime into the future so it's newer than builtAt.
    const future = new Date(first!.builtAt + 60_000);
    await utimes(path.join(tmp, 'package.json'), future, future);

    const second = await loadCachedOrBuild(tmp);
    expect(second).not.toBeNull();
    // builtAt must move forward — a fresh build wrote a new timestamp.
    expect(second!.builtAt).toBeGreaterThan(first!.builtAt);
  });

  it('records evidence signals used during detection', async () => {
    await writeProject({
      'package.json': JSON.stringify({
        name: 't',
        dependencies: { next: '^14.0.0', tailwindcss: '^3' },
      }),
      'next.config.js': 'module.exports = {}',
      'tailwind.config.js': 'module.exports = {}',
      'tsconfig.json': '{}',
      'pnpm-lock.yaml': '',
    });

    const profile = await buildProjectProfile({ projectPath: tmp });
    expect(profile?.evidence).toContain('package.json');
    expect(profile?.evidence).toContain('tsconfig.json');
    expect(profile?.evidence).toContain('pnpm-lock.yaml');
    expect(profile?.evidence.some((e) => e.includes('tailwind'))).toBe(true);
    expect(profile?.evidence.some((e) => e.includes('next'))).toBe(true);
  });
});
