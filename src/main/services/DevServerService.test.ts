import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// DevServerService imports `electron` (via `WebContents` type-only) and
// transitively pulls in PtyPool → ClaudeCliLauncher. Those imports are
// fine at module-load time (node-pty is lazily required inside
// `createPty`), but vitest still needs an `electron` mock because some
// transitive code path references it. Mirror DesignDiscovery.test.ts.
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
}));

import {
  detectDevServer,
  detectFramework,
  detectPackageManager,
  parseLocalUrl,
  pickScriptName,
} from '@main/services/DevServerService';

// ─── parseLocalUrl ──────────────────────────────────────────────────────────

describe('parseLocalUrl', () => {
  it('extracts the Vite "Local:" URL from a typical line', () => {
    // Vite prints `  ➜  Local:   http://localhost:5173/`. The service
    // strips the trailing slash on bare host:port URLs so the renderer's
    // `webview.src` comparison stays consistent across frameworks.
    const url = parseLocalUrl('  ➜  Local:   http://localhost:5173/', 'vite');
    expect(url).toBe('http://localhost:5173');
  });

  it('extracts the Next.js "- Local:" URL', () => {
    const url = parseLocalUrl('- Local:        http://localhost:3000', 'next');
    expect(url).toBe('http://localhost:3000');
  });

  it('extracts the Astro "Local" URL', () => {
    const url = parseLocalUrl('Local    http://localhost:4321/', 'astro');
    expect(url).toBe('http://localhost:4321');
  });

  it('extracts the Remix "💿" URL', () => {
    const url = parseLocalUrl('💿 http://localhost:3000', 'remix');
    expect(url).toBe('http://localhost:3000');
  });

  it('returns null when the line carries no URL', () => {
    expect(parseLocalUrl('VITE v5.0.0  ready in 320 ms', 'vite')).toBeNull();
    expect(parseLocalUrl('', 'vite')).toBeNull();
    expect(parseLocalUrl('warning: something happened', 'next')).toBeNull();
  });

  it('ignores 127.0.0.1 — only localhost URLs are webview-safe', () => {
    expect(parseLocalUrl('  Network: http://127.0.0.1:5173/', 'vite')).toBeNull();
  });

  it('ignores 0.0.0.0 bind notices', () => {
    expect(
      parseLocalUrl('listening on http://0.0.0.0:3000', 'next'),
    ).toBeNull();
  });

  it('prefers localhost when a line carries both localhost and 127.0.0.1', () => {
    const line =
      '  Local:   http://localhost:5173/   Network:  http://127.0.0.1:5173/';
    expect(parseLocalUrl(line, 'vite')).toBe('http://localhost:5173');
  });

  it('strips ANSI colour codes before matching the URL', () => {
    // Real vite output: green arrow + cyan URL + reset.
    const ansi =
      '\x1b[32m  ➜  Local: \x1b[36mhttp://localhost:5173/\x1b[0m';
    expect(parseLocalUrl(ansi, 'vite')).toBe('http://localhost:5173');
  });

  it('normalizes the bare host:port form by stripping the trailing slash', () => {
    // The capture stops at the port boundary (with optional trailing
    // slash) — anything past that (a path, query, hash) is not part of
    // the resolved URL the renderer uses. The normalizer then strips a
    // trailing slash on bare host:port URLs so equality checks stay
    // consistent across frameworks.
    expect(parseLocalUrl('Local:  http://localhost:3000/', 'next')).toBe(
      'http://localhost:3000',
    );
    expect(parseLocalUrl('Local:  http://localhost:3000', 'next')).toBe(
      'http://localhost:3000',
    );
  });

  it('handles Next.js "started server on … url:" format', () => {
    const line = '  ✓ started server on 0.0.0.0:3000, url: http://localhost:3000';
    expect(parseLocalUrl(line, 'next')).toBe('http://localhost:3000');
  });

  it('still extracts localhost URLs even when kind is unknown', () => {
    // Fallback path — user pointed at a script we couldn't classify.
    const url = parseLocalUrl('Listening on http://localhost:8080/', 'unknown');
    expect(url).toBe('http://localhost:8080');
  });
});

// ─── detectFramework ────────────────────────────────────────────────────────

describe('detectFramework', () => {
  it('detects vite when "vite" is a dep and vite.config is present', () => {
    const kind = detectFramework(
      { dependencies: {}, devDependencies: { vite: '^5.0.0' } },
      { viteConfig: true, nextConfig: false, astroConfig: false, remixConfig: false },
    );
    expect(kind).toBe('vite');
  });

  it('detects next when "next" is a dep and next.config is present', () => {
    const kind = detectFramework(
      { dependencies: { next: '^14.0.0' } },
      { viteConfig: false, nextConfig: true, astroConfig: false, remixConfig: false },
    );
    expect(kind).toBe('next');
  });

  it('detects astro when "astro" is a dep and astro.config is present', () => {
    const kind = detectFramework(
      { dependencies: { astro: '^4.0.0' } },
      { viteConfig: false, nextConfig: false, astroConfig: true, remixConfig: false },
    );
    expect(kind).toBe('astro');
  });

  it('detects remix purely from @remix-run/* deps (no config required)', () => {
    // Modern Remix projects often have no remix.config — they use the
    // Vite plugin instead. The detector recognises any @remix-run/* dep
    // as a strong signal.
    const kind = detectFramework(
      { dependencies: { '@remix-run/dev': '^2.0.0' } },
      { viteConfig: false, nextConfig: false, astroConfig: false, remixConfig: false },
    );
    expect(kind).toBe('remix');
  });

  it('returns "unknown" when package.json is null', () => {
    expect(
      detectFramework(null, {
        viteConfig: true,
        nextConfig: true,
        astroConfig: true,
        remixConfig: true,
      }),
    ).toBe('unknown');
  });

  it('returns "unknown" when deps are empty', () => {
    expect(
      detectFramework(
        { dependencies: {}, devDependencies: {} },
        {
          viteConfig: false,
          nextConfig: false,
          astroConfig: false,
          remixConfig: false,
        },
      ),
    ).toBe('unknown');
  });

  it('prefers next over vite when both deps + both configs exist (nx mono)', () => {
    // A monorepo can carry both `next` and `vite` (Storybook uses vite).
    // The implementation checks `next` first.
    const kind = detectFramework(
      { dependencies: { next: '^14', vite: '^5' } },
      { viteConfig: true, nextConfig: true, astroConfig: false, remixConfig: false },
    );
    expect(kind).toBe('next');
  });

  it('falls back to vite when only vite.config exists (no top-level vite dep)', () => {
    // The detector has a soft-fallback path for workspaces where `vite`
    // is a transitive workspace dep.
    const kind = detectFramework(
      { dependencies: {} },
      { viteConfig: true, nextConfig: false, astroConfig: false, remixConfig: false },
    );
    expect(kind).toBe('vite');
  });

  it('does not detect vite when ONLY the vite dep is present (no config)', () => {
    // Vite alone in deps without a config file likely means a tooling
    // dep (e.g. vitest pulls in vite). We require a config to claim it.
    const kind = detectFramework(
      { devDependencies: { vite: '^5.0.0' } },
      { viteConfig: false, nextConfig: false, astroConfig: false, remixConfig: false },
    );
    expect(kind).toBe('unknown');
  });

  it('treats devDependencies the same as dependencies for framework detection', () => {
    const kind = detectFramework(
      { devDependencies: { next: '^14.0.0' } },
      { viteConfig: false, nextConfig: true, astroConfig: false, remixConfig: false },
    );
    expect(kind).toBe('next');
  });
});

// ─── pickScriptName ─────────────────────────────────────────────────────────

describe('pickScriptName', () => {
  it('returns "dev" when scripts.dev exists', () => {
    expect(
      pickScriptName({ dev: 'vite', start: 'vite preview' }, 'vite'),
    ).toBe('dev');
  });

  it('falls back to "start" when scripts.dev is absent', () => {
    expect(pickScriptName({ start: 'next start' }, 'next')).toBe('start');
  });

  it('returns "" when no dev/start script exists and no body matches the framework keyword', () => {
    // Implementation note: with no dev/start, the picker scans bodies
    // for the framework's CLI keyword. So "build: vite build" WOULD be
    // picked up as a last-resort match — that's deliberate best-effort
    // behaviour. The pure "no match" path uses a script body that
    // contains no framework keyword.
    expect(pickScriptName({ build: 'tsc -p .' }, 'vite')).toBe('');
    expect(pickScriptName({ lint: 'eslint .' }, 'next')).toBe('');
  });

  it('rejects build-only scripts even when they invoke the framework CLI', () => {
    // The fallback scan requires a "dev"-ish token in either the script
    // name or body, so `{ build: 'vite build' }` is NOT picked up. This
    // prevents the Live Preview from launching one-shot production
    // builds that exit immediately without ever serving a URL.
    expect(pickScriptName({ build: 'vite build' }, 'vite')).toBe('');
  });

  it('picks up a non-standard script name when its body invokes the framework dev/watch command', () => {
    expect(pickScriptName({ serve: 'vite serve' }, 'vite')).toBe('serve');
    expect(pickScriptName({ watch: 'vite' }, 'vite')).toBe('watch');
  });

  it('returns "" for an empty scripts object', () => {
    expect(pickScriptName({}, 'vite')).toBe('');
  });

  it('returns "" when scripts is undefined', () => {
    expect(pickScriptName(undefined as unknown as Record<string, string>, 'vite')).toBe('');
  });

  it('falls back to a body-keyword match as a last resort', () => {
    // When no `dev`/`start` exists, the picker scans script bodies for
    // the framework's CLI keyword. "develop" carries "next" → matches.
    expect(
      pickScriptName({ develop: 'next dev --turbo' }, 'next'),
    ).toBe('develop');
  });

  it('treats whitespace-only "dev" as missing and tries "start" next', () => {
    expect(
      pickScriptName({ dev: '   ', start: 'vite preview' }, 'vite'),
    ).toBe('start');
  });
});

// ─── detectPackageManager (integration via tmpdir) ──────────────────────────
//
// The real signature is `detectPackageManager(projectPath: string)` — it
// touches the filesystem looking for lockfiles. We exercise it through a
// real temp directory so the test mirrors how the service runs in main.

describe('detectPackageManager', () => {
  let tmp = '';

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'devspace-devserver-pm-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('returns pnpm when pnpm-lock.yaml exists', async () => {
    await writeFile(path.join(tmp, 'pnpm-lock.yaml'), '', 'utf8');
    await writeFile(path.join(tmp, 'package.json'), '{}', 'utf8');
    expect(await detectPackageManager(tmp)).toBe('pnpm');
  });

  it('returns yarn when yarn.lock exists', async () => {
    await writeFile(path.join(tmp, 'yarn.lock'), '', 'utf8');
    await writeFile(path.join(tmp, 'package.json'), '{}', 'utf8');
    expect(await detectPackageManager(tmp)).toBe('yarn');
  });

  it('returns bun when bun.lockb exists', async () => {
    await writeFile(path.join(tmp, 'bun.lockb'), '', 'utf8');
    await writeFile(path.join(tmp, 'package.json'), '{}', 'utf8');
    expect(await detectPackageManager(tmp)).toBe('bun');
  });

  it('returns npm when only package.json is present (no lockfile)', async () => {
    await writeFile(path.join(tmp, 'package.json'), '{}', 'utf8');
    expect(await detectPackageManager(tmp)).toBe('npm');
  });

  it('returns npm when package-lock.json is present', async () => {
    await writeFile(path.join(tmp, 'package-lock.json'), '{}', 'utf8');
    await writeFile(path.join(tmp, 'package.json'), '{}', 'utf8');
    expect(await detectPackageManager(tmp)).toBe('npm');
  });

  it('prefers pnpm over yarn when both lockfiles coexist', async () => {
    // Lockfile shouldn't BOTH exist in practice, but a monorepo with
    // legacy yarn migration can leave both. The detector picks the
    // first match in priority order (pnpm wins).
    await writeFile(path.join(tmp, 'pnpm-lock.yaml'), '', 'utf8');
    await writeFile(path.join(tmp, 'yarn.lock'), '', 'utf8');
    expect(await detectPackageManager(tmp)).toBe('pnpm');
  });
});

// ─── detectDevServer (integration via tmpdir) ───────────────────────────────

describe('detectDevServer', () => {
  let tmp = '';

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'devspace-devserver-detect-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('detects a Vite project (package.json + vite.config.ts + pnpm lockfile)', async () => {
    await writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        name: 'demo',
        scripts: { dev: 'vite', build: 'vite build' },
        devDependencies: { vite: '^5.0.0' },
      }),
      'utf8',
    );
    await writeFile(path.join(tmp, 'vite.config.ts'), '', 'utf8');
    await writeFile(path.join(tmp, 'pnpm-lock.yaml'), '', 'utf8');

    const info = await detectDevServer(tmp);
    expect(info.kind).toBe('vite');
    expect(info.scriptName).toBe('dev');
    expect(info.status).toBe('idle');
    expect(info.url).toBeNull();
    expect(info.logTail).toEqual([]);
  });

  it('detects a Next.js project from package.json + next.config.mjs', async () => {
    await writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        name: 'demo-next',
        scripts: { dev: 'next dev', start: 'next start', build: 'next build' },
        dependencies: { next: '^14.0.0' },
      }),
      'utf8',
    );
    await writeFile(path.join(tmp, 'next.config.mjs'), 'export default {}', 'utf8');

    const info = await detectDevServer(tmp);
    expect(info.kind).toBe('next');
    expect(info.scriptName).toBe('dev');
    expect(info.status).toBe('idle');
  });

  it('detects an Astro project', async () => {
    await writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        name: 'demo-astro',
        scripts: { dev: 'astro dev', build: 'astro build' },
        dependencies: { astro: '^4.0.0' },
      }),
      'utf8',
    );
    await writeFile(path.join(tmp, 'astro.config.mjs'), '', 'utf8');

    const info = await detectDevServer(tmp);
    expect(info.kind).toBe('astro');
    expect(info.scriptName).toBe('dev');
  });

  it('detects a Remix project from @remix-run/dev alone', async () => {
    await writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        name: 'demo-remix',
        scripts: { dev: 'remix vite:dev', build: 'remix vite:build' },
        dependencies: { '@remix-run/dev': '^2.0.0' },
      }),
      'utf8',
    );

    const info = await detectDevServer(tmp);
    expect(info.kind).toBe('remix');
    expect(info.scriptName).toBe('dev');
  });

  it('returns "unknown" + empty scriptName for an unrecognised project', async () => {
    await writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        name: 'no-framework',
        scripts: { build: 'tsc -p .' },
        dependencies: {},
      }),
      'utf8',
    );

    const info = await detectDevServer(tmp);
    expect(info.kind).toBe('unknown');
    expect(info.scriptName).toBe('');
    expect(info.status).toBe('idle');
    expect(info.url).toBeNull();
  });

  it('returns "unknown" when package.json is missing entirely', async () => {
    const info = await detectDevServer(tmp);
    expect(info.kind).toBe('unknown');
    expect(info.scriptName).toBe('');
    expect(info.status).toBe('idle');
  });

  it('falls back from "dev" to "start" when only start exists', async () => {
    await writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        name: 'start-only',
        scripts: { start: 'next start' },
        dependencies: { next: '^14.0.0' },
      }),
      'utf8',
    );
    await writeFile(path.join(tmp, 'next.config.js'), 'module.exports = {}', 'utf8');

    const info = await detectDevServer(tmp);
    expect(info.kind).toBe('next');
    expect(info.scriptName).toBe('start');
  });
});
